"use client";

// ============================================================================
// Background Task Execution Framework — FR-1.1 serialization pipeline.
//
// Builds the `TaskPayload` (protocol.ts) that travels with every
// TaskTriggerRequest: a budget-capped text-only slice of the conversation
// seed history + a manifest of the user's OPFS workspace files (content
// inlined as utf8 text or base64, sha256-pinned for FR-4.1 mount
// verification in the sandbox).
//
// Budgets (TASK_PAYLOAD_BUDGET) are GUARDS, not reports: anything beyond a
// cap is skipped silently so a trigger can never fail because the user has
// "too much" state — the run simply starts with the newest / first-walked
// subset.
// ============================================================================

import { conversationService } from "@/lib/services";
import { isOPFSAvailable } from "@/lib/storage/opfs";
import { stripUploadTags } from "@/lib/uploads/registry";
import {
  TASK_PAYLOAD_BUDGET,
  type PayloadMessage,
  type TaskPayload,
  type TaskPayloadFile,
} from "@/lib/tasks/protocol";

// ---------------------------------------------------------------------------
// Small binary helpers (chunk-safe — no stack overflow on 1MB files).
// ---------------------------------------------------------------------------

/** Base64-encode bytes in 32KB chunks (btoa alone blows the stack on big
 *  Array-likes; same approach as uploads/registry's sandbox mirror). */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Hex sha256 of the decoded bytes (FR-4.1 manifest / mount verification). */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource);
  const view = new Uint8Array(digest);
  let hex = "";
  for (const b of view) {
    hex += b.toString(16).padStart(2, "0");
  }
  return hex;
}

/** Extensions mounted as utf8 text (everything else travels as base64). */
const TEXT_EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "json", "md", "txt", "py", "sh", "html", "css",
  "csv", "yml", "yaml", "xml", "svg", "toml", "env", "log",
]);

function fileExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "";
  return name.slice(dot + 1).toLowerCase();
}

// ---------------------------------------------------------------------------
// Workspace walk (bounded — never enumerates more than the file budget).
// ---------------------------------------------------------------------------

interface WalkedFile {
  /** Path relative to the workspace root (== the sandbox /home/user path). */
  path: string;
  handle: FileSystemFileHandle;
}

/**
 * Recursively collect files under a directory handle, stopping the moment
 * `budget` entries have been gathered (OPFS has no bounded listing; a plain
 * walkFiles over a huge workspace would enumerate everything before we could
 * cap it). Mirrors opfs.ts walkFiles, with the early-exit bound.
 */
async function walkBounded(
  dir: FileSystemDirectoryHandle,
  basePath: string,
  budget: number,
  out: WalkedFile[],
): Promise<void> {
  if (out.length >= budget) return;
  // @ts-expect-error — `values()` is in the OPFS spec but missing from some TS lib defs.
  for await (const entry of dir.values()) {
    if (out.length >= budget) return;
    const childPath = basePath ? `${basePath}/${entry.name}` : entry.name;
    if (entry.kind === "file") {
      out.push({ path: childPath, handle: entry as FileSystemFileHandle });
    } else {
      await walkBounded(entry as FileSystemDirectoryHandle, childPath, budget, out);
    }
  }
}

/** Get the user's `users/<userId>/workspace` directory handle WITHOUT creating
 *  it (a trigger must not materialize an empty workspace). Null when absent. */
async function getWorkspaceDir(userId: string): Promise<FileSystemDirectoryHandle | null> {
  try {
    const root = await navigator.storage.getDirectory();
    const usersDir = await root.getDirectoryHandle("users");
    const userDir = await usersDir.getDirectoryHandle(userId);
    return await userDir.getDirectoryHandle("workspace");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Conversation slice (text-only seed history).
// ---------------------------------------------------------------------------

/** Per-message char cap — mirrors the detached-run seed budget
 *  (SEED_MAX_MESSAGE_CHARS in agent/detached-run.ts) so one bloated message
 *  can't crowd out the rest of the payload. */
const SEED_MESSAGE_MAX_CHARS = 12_000;

function capMessageText(text: string): string {
  if (text.length <= SEED_MESSAGE_MAX_CHARS) return text;
  return `${text.slice(0, SEED_MESSAGE_MAX_CHARS)}\n…[truncated]`;
}

/**
 * Text-only seed slice of a conversation: last maxSeedMessages rows, upload
 * tags stripped, empty rows dropped, roles mapped to user/assistant. A
 * `system` row survives ONLY when it is the very first message of the
 * conversation (a persisted system prompt) — mid-history system rows are
 * meaningless out of order and skipped.
 */
async function buildConversationSlice(
  conversationId: string,
  userId: string,
): Promise<TaskPayload["conversation"]> {
  const [conv, messages] = await Promise.all([
    conversationService.get(conversationId, userId),
    conversationService.getMessages(conversationId, userId),
  ]);
  const recent = messages.slice(-TASK_PAYLOAD_BUDGET.maxSeedMessages);
  const firstMessageId = messages[0]?.id ?? null;
  const out: PayloadMessage[] = [];
  for (const m of recent) {
    if (m.role === "system") {
      if (firstMessageId && m.id === firstMessageId) {
        const sys = capMessageText(stripUploadTags(m.content).trim());
        if (sys) out.push({ role: "system", content: sys });
      }
      continue;
    }
    const text = capMessageText(stripUploadTags(m.content).trim());
    if (!text) continue;
    out.push({ role: m.role, content: text });
  }
  return {
    id: conversationId,
    title: conv?.title ?? null,
    messages: out,
  };
}

// ---------------------------------------------------------------------------
// Public API.
// ---------------------------------------------------------------------------

export interface BuildTaskPayloadOptions {
  userId: string;
  conversationId?: string | null;
  /** Include the OPFS workspace manifest (default true). */
  includeWorkspace?: boolean;
  /** Override the per-trigger file cap (≤ TASK_PAYLOAD_BUDGET.maxFiles). */
  maxFiles?: number;
}

/**
 * Build the full TaskPayload for a trigger:
 *   · conversation slice — text-only seed history (last 30 messages),
 *   · workspace manifest — every file under `users/<uid>/workspace/**`
 *     inlined (utf8 for text extensions, base64 otherwise), sha256-pinned,
 *     with paths STRIPPED of the `users/<uid>/workspace/` prefix so they
 *     mount at /home/user/<relative> (uploads/ subdir included).
 *
 * Budget enforcement (silent skips, guards-not-reports):
 *   · maxFiles            — walk bound,
 *   · maxFileBytes        — per-file ceiling (oversize → skipped),
 *   · maxTotalFileBytes   — decoded-content running total,
 *   · maxBytes            — ENCODED payload ceiling (conversation text +
 *                          file content, with headroom for the JSON frame).
 */
export async function buildTaskPayload(
  opts: BuildTaskPayloadOptions,
): Promise<TaskPayload> {
  const maxFiles = Math.min(
    Math.max(1, opts.maxFiles ?? TASK_PAYLOAD_BUDGET.maxFiles),
    TASK_PAYLOAD_BUDGET.maxFiles,
  );

  // -- conversation slice ----------------------------------------------------
  const conversation: TaskPayload["conversation"] = opts.conversationId
    ? await buildConversationSlice(opts.conversationId, opts.userId)
    : { id: null, title: null, messages: [] };

  // -- encoded-size accounting ------------------------------------------------
  // maxBytes covers the SERIALIZED payload; reserve headroom for the JSON
  // frame (keys, hashes, escapes) so the final JSON.stringify stays under.
  const encodedBudget = TASK_PAYLOAD_BUDGET.maxBytes - 512 * 1024;
  let encodedTotal = 0;
  for (const m of conversation.messages) {
    encodedTotal += m.content.length; // utf16 ≈ utf8 for this guard's purpose
  }

  // -- workspace manifest -----------------------------------------------------
  const files: TaskPayloadFile[] = [];
  if (opts.includeWorkspace !== false && isOPFSAvailable()) {
    const wsDir = await getWorkspaceDir(opts.userId);
    if (wsDir) {
      const walked: WalkedFile[] = [];
      await walkBounded(wsDir, "", maxFiles, walked);

      let decodedTotal = 0;
      for (const entry of walked) {
        if (files.length >= maxFiles) break;
        try {
          const file = await entry.handle.getFile();
          if (file.size > TASK_PAYLOAD_BUDGET.maxFileBytes) continue; // oversize → skip
          const bytes = new Uint8Array(await file.arrayBuffer());
          const decodedSize = bytes.byteLength;
          if (decodedTotal + decodedSize > TASK_PAYLOAD_BUDGET.maxTotalFileBytes) continue;
          const isText = TEXT_EXTENSIONS.has(fileExtension(entry.path));
          const encodedSize = isText
            ? bytes.byteLength
            : Math.ceil(decodedSize / 3) * 4;
          if (encodedTotal + encodedSize > encodedBudget) continue;
          const sha256 = await sha256Hex(bytes);
          const content = isText
            ? new TextDecoder().decode(bytes)
            : bytesToBase64(bytes);
          decodedTotal += decodedSize;
          encodedTotal += encodedSize;
          files.push({
            // OPFS workspace path → sandbox path (strip nothing here: walk
            // paths are already relative to the workspace root, so
            // `uploads/foo.png` mounts at /home/user/uploads/foo.png).
            path: entry.path,
            content,
            encoding: isText ? "utf8" : "base64",
            size: decodedSize,
            sha256,
            source: "opfs",
            ...(file.type ? { mimeType: file.type } : {}),
          });
        } catch {
          // unreadable file → skip silently (budgets are guards)
        }
      }
    }
  }

  return { version: 1, conversation, files };
}

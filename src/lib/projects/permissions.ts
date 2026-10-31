"use client";

/**
 * Permission policy resolution for the Projects data layer (PRD §8, §13).
 *
 * Three sources of truth, in order:
 *
 *   1. DEFAULT SENSITIVITY (`SENSITIVE_TOOL_DEFAULTS`) — argument-aware:
 *      the SAME tool can be a read (allowed) or a write (approval_required),
 *      matched against the REAL registered tool names/arg shapes
 *      (`manage_env_var` actions, `delete_file`/`delete_folder`,
 *      `composio_execute_tool`).
 *   2. GLOBAL POLICY — the user's explicit per-tool tri-state stored in
 *      `user_settings.extra.approval_policies` (Record<toolName, permission>).
 *      An explicit entry REPLACES the default for that tool (the settings UI
 *      is the user's override surface).
 *   3. PROJECT RULES — `project.resources` (ProjectResourceRule[]). The
 *      EFFECTIVE permission is the STRICTEST of global and project: a
 *      project can tighten but NEVER LOOSEN a stricter global rule
 *      (PRD §8.2/§13.2). With no project (general chat) only global applies.
 *
 * The pure core (`resolvePermission`) is synchronous and side-effect free so
 * the execution layer can call it at every dispatch site; the Dexie/auth
 * wrappers (`resolveToolPermission`, `loadGlobalPolicy`, `saveGlobalPolicy`)
 * are thin loaders.
 *
 * Also owns `canonicalParamsHash` — the sha256 of the canonical (sorted-key)
 * JSON of a tool call's parameters. Approvals are bound to the EXACT params:
 * any change invalidates the approval (PRD §13.6).
 */

import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import type {
  Project,
  ProjectResourceRule,
  ProjectResourceType,
  ResourcePermission,
} from "@/types";
import { getProject } from "./service";

// Re-exported for consumers (Settings → Approvals imports it from here).
export type { ResourcePermission } from "@/types";

// ---------------------------------------------------------------------------
// Default sensitivity — argument-aware, matched to the REAL registered tools
// ---------------------------------------------------------------------------

/**
 * The out-of-the-box policy (USER DIRECTIVE: "remove approval — only
 * approval on task docs, not on tool calls"):
 *
 *   - EVERY tool call is ALLOWED by default — zero interactive approval
 *     gates on tool execution.
 *   - Users can still tighten any tool themselves via the global policy
 *     (Settings → Tools approval policies) or per-project rules; explicit
 *     user entries REPLACE these defaults (see resolvePermission).
 *
 * The argument-aware buckets below are kept ONLY so the settings UI and
 * `defaultPermissionFor` keep their shape (and so an explicit user policy
 * still composes correctly) — every default now resolves to "allowed".
 */
export const SENSITIVE_TOOL_DEFAULTS = {
  composioExecute: {
    tools: ["composio_execute_tool"] as readonly string[],
    permission: "allowed" as ResourcePermission,
    rationale: "Executes actions on external apps — allowed by default (user directive: no tool-call approvals).",
  },
  envVarWrites: {
    tool: "manage_env_var",
    writeActions: ["add", "set", "edit", "delete"] as readonly string[],
    legacyWriteTools: ["add_env_var", "set_env_var", "edit_env_var", "delete_env_var"] as readonly string[],
    readActions: ["list", "get"] as readonly string[],
    permission: "allowed" as ResourcePermission,
    rationale: "Writes or deletes sandbox environment variables — allowed by default.",
  },
  e2bDeletes: {
    tools: ["delete_file", "delete_folder"] as readonly string[],
    permission: "allowed" as ResourcePermission,
    rationale: "Permanently removes workspace files or folders — allowed by default.",
  },
  fallback: {
    permission: "allowed" as ResourcePermission,
    rationale: "No default rule — the global policy or project rules decide.",
  },
} as const;

const ENV_VAR_TOOL_NAMES: ReadonlySet<string> = new Set([
  "manage_env_var",
  "add_env_var",
  "set_env_var",
  "edit_env_var",
  "delete_env_var",
  "get_env_var",
  "list_env_vars",
]);

/** Strictness ordering — used to pick the strictest of two permissions. */
export const PERMISSION_STRICTNESS: Record<ResourcePermission, number> = {
  allowed: 0,
  approval_required: 1,
  denied: 2,
};

/**
 * The DEFAULT (argument-aware) permission for a tool call, before any user
 * or project policy applies.
 */
export function defaultPermissionFor(
  toolName: string,
  args?: Record<string, unknown> | null,
): ResourcePermission {
  // Composio execution — external side effects by definition.
  if (SENSITIVE_TOOL_DEFAULTS.composioExecute.tools.includes(toolName)) {
    return SENSITIVE_TOOL_DEFAULTS.composioExecute.permission;
  }
  // Env-var management — write/delete actions only (list/get are reads).
  if (ENV_VAR_TOOL_NAMES.has(toolName)) {
    if (toolName === "manage_env_var") {
      const action = typeof args?.action === "string" ? args.action : "";
      return SENSITIVE_TOOL_DEFAULTS.envVarWrites.writeActions.includes(action)
        ? SENSITIVE_TOOL_DEFAULTS.envVarWrites.permission
        : "allowed";
    }
    // Legacy pre-merge tool names: write/delete by name.
    return SENSITIVE_TOOL_DEFAULTS.envVarWrites.legacyWriteTools.includes(toolName)
      ? SENSITIVE_TOOL_DEFAULTS.envVarWrites.permission
      : "allowed";
  }
  // E2B file/folder deletion — destructive.
  if (SENSITIVE_TOOL_DEFAULTS.e2bDeletes.tools.includes(toolName)) {
    return SENSITIVE_TOOL_DEFAULTS.e2bDeletes.permission;
  }
  return SENSITIVE_TOOL_DEFAULTS.fallback.permission;
}

/** The stricter of two permissions (a project can never loosen a global rule). */
export function strictestPermission(
  a: ResourcePermission,
  b: ResourcePermission,
): ResourcePermission {
  return PERMISSION_STRICTNESS[a] >= PERMISSION_STRICTNESS[b] ? a : b;
}

// ---------------------------------------------------------------------------
// Project resource-rule lookup
// ---------------------------------------------------------------------------

/**
 * Find the project rule that governs `toolName`, if any.
 *
 * Matching (most specific first):
 *   1. any rule whose `resource_id` IS the tool name (tool / connector /
 *      skill rules, and mcp_tool rules that store the bare tool name),
 *   2. an `mcp_tool` rule stored as `"serverId:toolName"` (suffix match).
 *
 * Terminal/browser rules are stored under their capability id ("terminal",
 * "browser") — the execution layer maps those to the concrete tool names
 * before calling the resolver.
 */
export function findApplicableRule(
  toolName: string,
  rules: ProjectResourceRule[] | null | undefined,
): ProjectResourceRule | undefined {
  if (!rules || rules.length === 0) return undefined;
  return (
    rules.find((r) => r.resource_id === toolName) ??
    rules.find(
      (r) =>
        r.resource_type === "mcp_tool" &&
        r.resource_id.endsWith(`:${toolName}`),
    )
  );
}

// ---------------------------------------------------------------------------
// Pure resolution core (synchronous — call at every dispatch site)
// ---------------------------------------------------------------------------

export interface PermissionContext {
  /** Explicit user-level policy (`user_settings.extra.approval_policies`).
   *  Missing keys fall back to the argument-aware defaults. */
  globalPolicy?: Record<string, ResourcePermission> | null;
  /** The conversation's project (its `resources` rules apply). null/omitted
   *  → general chat: global policy only. */
  project?: Pick<Project, "id" | "resources"> | null;
}

/**
 * Resolve the effective permission for a tool call:
 *
 *   effective = strictest(global entry ?? default sensitivity, project rule)
 *
 * - An explicit GLOBAL entry replaces the default for that tool (the user's
 *   override surface in Settings → Tools).
 * - A PROJECT rule can only TIGHTEN (strictest wins) — never loosen.
 * - No project → global only.
 */
export function resolvePermission(
  toolName: string,
  args: Record<string, unknown> | null | undefined,
  ctx: PermissionContext = {},
): ResourcePermission {
  const global =
    ctx.globalPolicy?.[toolName] ?? defaultPermissionFor(toolName, args);
  const rule = ctx.project
    ? findApplicableRule(toolName, ctx.project.resources)
    : undefined;
  if (!rule) return global;
  return strictestPermission(global, rule.permission);
}

// ---------------------------------------------------------------------------
// Global policy persistence (user_settings.extra.approval_policies)
// ---------------------------------------------------------------------------

/** Key inside `user_settings.extra` where the global policy record lives. */
export const APPROVAL_POLICIES_KEY = "approval_policies";

/** A policy write: a permission per tool name; `null` REMOVES the entry
 *  (falling that tool back to the argument-aware default). */
export type GlobalPolicyEntries = Record<string, ResourcePermission | null>;

const VALID_PERMISSIONS: ReadonlySet<string> = new Set([
  "allowed",
  "approval_required",
  "denied",
]);

/** Coerce an unknown stored value into a clean policy record (drops junk). */
export function sanitizePolicyRecord(
  stored: unknown,
): Record<string, ResourcePermission> {
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return {};
  const out: Record<string, ResourcePermission> = {};
  for (const [tool, permission] of Object.entries(
    stored as Record<string, unknown>,
  )) {
    if (typeof permission === "string" && VALID_PERMISSIONS.has(permission)) {
      out[tool] = permission as ResourcePermission;
    }
  }
  return out;
}

/** Load the user's global approval policy (empty record when unset). */
export async function loadGlobalPolicy(
  userId: string,
): Promise<Record<string, ResourcePermission>> {
  const row = await db.user_settings.where("user_id").equals(userId).first();
  return sanitizePolicyRecord(row?.extra?.[APPROVAL_POLICIES_KEY]);
}

/**
 * MERGE `entries` into the user's global policy (a `null` value removes the
 * tool's entry). Returns the resulting record.
 */
export async function saveGlobalPolicy(
  userId: string,
  entries: GlobalPolicyEntries,
): Promise<Record<string, ResourcePermission>> {
  let row = await db.user_settings.where("user_id").equals(userId).first();
  if (!row) {
    // Lazy-create the settings row (same shape settingsService.get uses).
    const ts = new Date().toISOString();
    row = {
      id: nanoid(),
      user_id: userId,
      system_prompt: null,
      system_prompt_enabled: false,
      e2b_api_key_encrypted: null,
      tavily_api_key_encrypted: null,
      embeddings_api_key_encrypted: null,
      env_vars: {},
      extra: {},
      created_at: ts,
      updated_at: ts,
    };
    await db.user_settings.add(row);
  }
  const current = sanitizePolicyRecord(row.extra?.[APPROVAL_POLICIES_KEY]);
  for (const [tool, permission] of Object.entries(entries)) {
    if (permission === null) {
      delete current[tool];
    } else if (typeof permission === "string" && VALID_PERMISSIONS.has(permission)) {
      current[tool] = permission;
    }
  }
  const extra = { ...(row.extra ?? {}), [APPROVAL_POLICIES_KEY]: current };
  await db.user_settings.update(row.id, {
    extra,
    updated_at: new Date().toISOString(),
  });
  return current;
}

/** Auth-store-aware wrapper: persist global policy entries for the CURRENT
 *  user. Throws when nobody is signed in. */
export async function setGlobalPolicy(
  entries: GlobalPolicyEntries,
): Promise<Record<string, ResourcePermission>> {
  const { useAuthStore } = await import("@/stores");
  const userId = useAuthStore.getState().user?.id;
  if (!userId) {
    throw new Error("You must be signed in to change approval policies.");
  }
  return saveGlobalPolicy(userId, entries);
}

/**
 * Auth-store-aware wrapper for the execution layer: resolve the effective
 * permission for a tool call in the CURRENT user's context, optionally
 * scoped to a project conversation.
 */
export async function resolveToolPermission(
  toolName: string,
  args: Record<string, unknown> | null | undefined,
  projectId: string | null,
): Promise<ResourcePermission> {
  const { useAuthStore } = await import("@/stores");
  const userId = useAuthStore.getState().user?.id;
  if (!userId) {
    // No signed-in user → no settings row, no project rows: defaults only.
    return resolvePermission(toolName, args, { globalPolicy: null, project: null });
  }
  const globalPolicy = await loadGlobalPolicy(userId);
  const project = projectId ? await getProject(projectId) : null;
  return resolvePermission(toolName, args, { globalPolicy, project });
}

// ---------------------------------------------------------------------------
// Canonical params hashing (approval binding)
// ---------------------------------------------------------------------------

/**
 * Canonical JSON for a params object: object keys sorted RECURSIVELY (so
 * key order never changes the hash), `undefined` values dropped, arrays
 * kept in order.
 */
export function canonicalizeParams(params: Record<string, unknown>): string {
  const walk = (value: unknown): unknown => {
    if (value === null || typeof value !== "object") return value === undefined ? null : value;
    if (Array.isArray(value)) return value.map(walk);
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      if (source[key] === undefined) continue;
      out[key] = walk(source[key]);
    }
    return out;
  };
  return JSON.stringify(walk(params));
}

/**
 * sha256 (hex) of the canonical JSON of `params` — the value approvals are
 * bound to. Prefers WebCrypto `crypto.subtle` (browser secure contexts,
 * Node 18+); falls back to the pure `sha256Sync` implementation otherwise
 * (non-secure contexts, odd runtimes).
 */
export async function canonicalParamsHash(
  params: Record<string, unknown>,
): Promise<string> {
  const canonical = canonicalizeParams(params);
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    const bytes = new TextEncoder().encode(canonical);
    const digest = await subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }
  return sha256Sync(canonical);
}

// ---------------------------------------------------------------------------
// sha256Sync — small pure implementation (fallback + tests)
// ---------------------------------------------------------------------------

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** Pure sha256 hex digest — no WebCrypto dependency. Matches the FIPS
 *  180-4 test vectors (pinned in service.test.ts). */
export function sha256Sync(input: string): string {
  const bytes = new TextEncoder().encode(input);
  // Pre-processing: pad to 56 mod 64, append 64-bit big-endian bit length.
  const bitLength = bytes.length * 8;
  const paddedLength = (((bytes.length + 8) >> 6) + 1) << 6;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(paddedLength - 4, bitLength >>> 0, false);
  dv.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000), false);

  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = dv.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < 64; i++) {
      const w15 = w[i - 15]!,
        w2 = w[i - 2]!,
        w16 = w[i - 16]!,
        w7 = w[i - 7]!;
      const s0 =
        ((w15 >>> 7) | (w15 << 25)) ^ ((w15 >>> 18) | (w15 << 14)) ^ (w15 >>> 3);
      const s1 =
        ((w2 >>> 17) | (w2 << 15)) ^ ((w2 >>> 19) | (w2 << 13)) ^ (w2 >>> 10);
      w[i] = (w16 + s0 + w7 + s1) >>> 0;
    }

    // `h` is a fixed-length-8 Uint32Array and `SHA256_K`/`w` are length-64 —
    // the `!` reads are index-safe by construction (loop bounds below).
    let a = h[0]!,
      b = h[1]!,
      c = h[2]!,
      d = h[3]!,
      e = h[4]!,
      f = h[5]!,
      g = h[6]!,
      hh = h[7]!;
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const temp1 = (hh + S1 + ch + SHA256_K[i]! + w[i]!) >>> 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    h[0] = (h[0]! + a) >>> 0;
    h[1] = (h[1]! + b) >>> 0;
    h[2] = (h[2]! + c) >>> 0;
    h[3] = (h[3]! + d) >>> 0;
    h[4] = (h[4]! + e) >>> 0;
    h[5] = (h[5]! + f) >>> 0;
    h[6] = (h[6]! + g) >>> 0;
    h[7] = (h[7]! + hh) >>> 0;
  }

  return Array.from(h, (x) => x.toString(16).padStart(8, "0")).join("");
}

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

export const RESOURCE_TYPE_LABELS: Record<ProjectResourceType, string> = {
  tool: "Tool",
  mcp_server: "MCP server",
  mcp_tool: "MCP tool",
  skill: "Skill",
  directory: "Directory",
  terminal: "Terminal",
  browser: "Browser",
  connector: "Connector",
};

export const PERMISSION_LABELS: Record<ResourcePermission, string> = {
  allowed: "Allowed",
  approval_required: "Approval required",
  denied: "Denied",
};

/** Human label for a resource rule, e.g. `MCP tool "slack:send_message" —
 *  Approval required`. Used by the project settings UI and inspector. */
export function describeResourceRule(rule: ProjectResourceRule): string {
  const kind = RESOURCE_TYPE_LABELS[rule.resource_type] ?? rule.resource_type;
  const permission = PERMISSION_LABELS[rule.permission] ?? rule.permission;
  return `${kind} "${rule.resource_id}" — ${permission}`;
}

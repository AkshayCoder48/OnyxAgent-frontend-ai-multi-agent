// ============================================================================
// Scheduled-task management API (action-based, mirrors /api/sandbox style).
//
// POST /api/scheduler/tasks
//   Headers: X-OnyxBase-Key: <vault key>   (browser ops; env key as fallback)
//   Body: { action, ...payload }
//
// Actions: create | update | delete | pause | resume | run_now | list |
//          get_history | sync_chat | pull_chat
//
// CHAT-ONLY: `create` always yields a task with exactly one dedicated chat
// (the given chatId or a server-created chat record).
//
// Responses NEVER include credentials — task records are sanitized
// (runtime → { hasProvider, providerModel }).
// ============================================================================

import { NextRequest, NextResponse } from "next/server";
import { SchedulerKV, cachedSchedulerKv, resolveSchedulerKey } from "@/lib/scheduler/server-kv";
import {
  createTask,
  deleteTask,
  getTaskHistory,
  listTasksSafe,
  runTaskNow,
  setTaskEnabled,
  updateTask,
} from "@/lib/scheduler/engine";
import { pullChatUpdates, writeChatMirror } from "@/lib/scheduler/chat-store";
import type { ChatTurnMessage, SafeScheduledTask } from "@/lib/scheduler/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

// ── LIST MEMO (the scheduler request-storm / navigation-lag fix) ──────────
// "list" is the hottest action (every mounted sidebar converges the link
// registry on mount + every 60s; with several open clients that is a call
// every few seconds — each one used to re-walk the whole schedule: KV
// namespace + per-task version records, 2-5s apiece). A short per-key memo
// + in-flight sharing makes the storm cheap; ANY mutating action on this
// route invalidates it immediately. Mutations and reads share the
// CachedSchedulerKV read cache, so even a cold "list" is a few roundtrips.
const LIST_MEMO_MS = 8_000;
const listMemos = new Map<string, { at: number; tasks: SafeScheduledTask[] }>();
const listInFlight = new Map<string, Promise<SafeScheduledTask[]>>();

function invalidateListMemo(key: string): void {
  listMemos.delete(key);
}

async function listTasksMemoized(key: string, kv: SchedulerKV): Promise<SafeScheduledTask[]> {
  const memo = listMemos.get(key);
  if (memo && Date.now() - memo.at < LIST_MEMO_MS) return memo.tasks;
  const inFlight = listInFlight.get(key);
  if (inFlight) return inFlight;
  const p = (async () => {
    const tasks = await listTasksSafe(kv);
    listMemos.set(key, { at: Date.now(), tasks });
    return tasks;
  })();
  listInFlight.set(key, p);
  try {
    return await p;
  } finally {
    listInFlight.delete(key);
  }
}

function auth(req: NextRequest): { key: string; kv: SchedulerKV } | { error: NextResponse } {
  const key = resolveSchedulerKey(req.headers.get("x-onyxbase-key"));
  if (!key) {
    return {
      error: NextResponse.json(
        {
          ok: false,
          error: "NOT_CONFIGURED",
          message: "Cloud scheduling isn't configured yet. Add your OnyxBase API key in Settings → Cloud Workspace.",
        },
        { status: 503 },
      ),
    };
  }
  return { key, kv: cachedSchedulerKv(key) };
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const a = auth(req);
  if ("error" in a) return a.error;
  const kv = a.kv;
  const apiKey = a.key;

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: "BAD_REQUEST", message: "Invalid JSON body" }, { status: 400 });
  }
  const action = String(body.action ?? "");
  const STRIP = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
  const parseChatContext = (
    v: unknown,
  ): { systemPrompt?: string; title?: string; messages: ChatTurnMessage[] } | null | undefined => {
    if (v == null) return undefined;
    if (typeof v !== "object") return null;
    const ctx = v as { systemPrompt?: unknown; title?: unknown; messages?: unknown };
    const messages = Array.isArray(ctx.messages)
      ? (ctx.messages as unknown[])
          .filter(
            (m): m is ChatTurnMessage =>
              !!m && typeof (m as ChatTurnMessage).id === "string" &&
              ((m as ChatTurnMessage).role === "user" || (m as ChatTurnMessage).role === "assistant") &&
              typeof (m as ChatTurnMessage).content === "string",
          )
          .map((m) => ({
            id: m.id,
            role: m.role,
            content: m.content,
            createdAt: typeof m.createdAt === "string" ? m.createdAt : new Date().toISOString(),
          }))
      : [];
    return {
      ...(typeof ctx.systemPrompt === "string" && ctx.systemPrompt ? { systemPrompt: ctx.systemPrompt } : {}),
      ...(typeof ctx.title === "string" && ctx.title ? { title: ctx.title } : {}),
      messages,
    };
  };

  try {
    switch (action) {
      case "create": {
        const r = await createTask(kv, {
          name: String(body.name ?? ""),
          description: STRIP(body.description),
          instructions: String(body.instructions ?? ""),
          schedule: body.schedule as never,
          workspaceId: STRIP(body.workspaceId),
          enabled: body.enabled !== false,
          chatId: typeof body.chatId === "string" ? body.chatId : body.chatId === null ? null : undefined,
          chatContext: parseChatContext(body.chatContext),
          runtime: body.runtime as never,
        });
        invalidateListMemo(apiKey);
        return NextResponse.json({ ok: true, task: r.task, ...(r.warning ? { warning: r.warning } : {}) });
      }

      case "update": {
        const r = await updateTask(kv, body as never);
        invalidateListMemo(apiKey);
        return NextResponse.json({ ok: true, task: r.task, ...(r.warning ? { warning: r.warning } : {}) });
      }

      case "delete": {
        await deleteTask(kv, String(body.id ?? ""));
        invalidateListMemo(apiKey);
        return NextResponse.json({ ok: true });
      }

      case "pause": {
        const task = await setTaskEnabled(kv, String(body.id ?? ""), false);
        invalidateListMemo(apiKey);
        return NextResponse.json({ ok: true, task });
      }

      case "resume": {
        const task = await setTaskEnabled(kv, String(body.id ?? ""), true);
        invalidateListMemo(apiKey);
        return NextResponse.json({ ok: true, task });
      }

      case "run_now": {
        const r = await runTaskNow(kv, String(body.id ?? ""));
        invalidateListMemo(apiKey);
        return NextResponse.json({ ok: true, run: r.run, task: r.task });
      }

      case "list": {
        const tasks = await listTasksMemoized(apiKey, kv);
        return NextResponse.json({ ok: true, tasks });
      }

      case "get_history": {
        const runs = await getTaskHistory(kv, String(body.id ?? ""), Number(body.limit ?? 20) || 20);
        return NextResponse.json({ ok: true, runs });
      }

      // ── UNIFIED CHAT RECORDS ─────────────────────────────────────────────
      // sync_chat: browser → KV mirror snapshot (immutable version record).
      case "sync_chat": {
        const chatId = String(body.chatId ?? "").trim();
        if (!chatId) {
          return NextResponse.json({ ok: false, error: "BAD_REQUEST", message: "chatId is required" }, { status: 400 });
        }
        const messages = Array.isArray(body.messages) ? (body.messages as ChatTurnMessage[]) : [];
        const r = await writeChatMirror(kv, {
          chatId,
          ...(typeof body.title === "string" && body.title ? { title: body.title } : {}),
          ...(typeof body.systemPrompt === "string" && body.systemPrompt ? { systemPrompt: body.systemPrompt } : {}),
          messages,
        });
        return NextResponse.json({ ok: true, durable: r.ok });
      }

      // pull_chat: KV server-appended messages → browser merge poller.
      case "pull_chat": {
        const updates = Array.isArray(body.updates)
          ? (body.updates as Array<{ chatId?: unknown; after?: unknown }>)
              .map((u) => ({
                chatId: typeof u?.chatId === "string" ? u.chatId : "",
                after: typeof u?.after === "string" ? u.after : undefined,
              }))
              .filter((u) => u.chatId)
          : [];
        const r = await pullChatUpdates(kv, updates);
        return NextResponse.json({ ok: true, ...r });
      }

      default:
        return NextResponse.json({ ok: false, error: "UNKNOWN_ACTION", message: `Unknown action: ${action}` }, { status: 400 });
    }
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: "ACTION_FAILED", message: e instanceof Error ? e.message : "action failed" },
      { status: 400 },
    );
  }
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const a = auth(req);
  if ("error" in a) return a.error;
  const tasks = await listTasksMemoized(a.key, a.kv);
  return NextResponse.json({ ok: true, tasks });
}

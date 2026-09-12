// ============================================================================
// Scheduled-task management API (action-based, mirrors /api/sandbox style).
//
// POST /api/scheduler/tasks
//   Headers: X-OnyxBase-Key: <vault key>   (browser ops; env key as fallback)
//   Body: { action, ...payload }
//
// Actions: create | update | delete | pause | resume | run_now | list |
//          get_history | get_run | status | sync_chat | pull_chat
//
// Responses NEVER include credentials — task records are sanitized
// (runtime → { hasProvider, providerModel, hasTelegram }).
// ============================================================================

import { NextRequest, NextResponse } from "next/server";
import { SchedulerKV, resolveSchedulerKey } from "@/lib/scheduler/server-kv";
import {
  createTask,
  deleteTask,
  getRun,
  getTaskHistory,
  listTasksSafe,
  runTaskNow,
  setTaskEnabled,
  updateTask,
} from "@/lib/scheduler/engine";
import { pullChatUpdates, writeChatMirror } from "@/lib/scheduler/chat-store";
import type { ChatTurnMessage } from "@/lib/scheduler/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

function auth(req: NextRequest): { kv: SchedulerKV } | { error: NextResponse } {
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
  return { kv: new SchedulerKV(key) };
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const a = auth(req);
  if ("error" in a) return a.error;
  const kv = a.kv;

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
          notifyTelegram: body.notifyTelegram !== false,
          chatId: typeof body.chatId === "string" ? body.chatId : body.chatId === null ? null : undefined,
          chatContext: parseChatContext(body.chatContext),
          runtime: body.runtime as never,
        });
        return NextResponse.json({ ok: true, task: r.task, ...(r.warning ? { warning: r.warning } : {}) });
      }

      case "update": {
        const r = await updateTask(kv, body as never);
        return NextResponse.json({ ok: true, task: r.task, ...(r.warning ? { warning: r.warning } : {}) });
      }

      case "delete": {
        await deleteTask(kv, String(body.id ?? ""));
        return NextResponse.json({ ok: true });
      }

      case "pause": {
        const task = await setTaskEnabled(kv, String(body.id ?? ""), false);
        return NextResponse.json({ ok: true, task });
      }

      case "resume": {
        const task = await setTaskEnabled(kv, String(body.id ?? ""), true);
        return NextResponse.json({ ok: true, task });
      }

      case "run_now": {
        const run = await runTaskNow(kv, String(body.id ?? ""));
        return NextResponse.json({ ok: true, run });
      }

      case "list": {
        const tasks = await listTasksSafe(kv);
        return NextResponse.json({ ok: true, tasks });
      }

      case "get_history": {
        const runs = await getTaskHistory(kv, String(body.id ?? ""), Number(body.limit ?? 20) || 20);
        return NextResponse.json({ ok: true, runs });
      }

      case "get_run": {
        const run = await getRun(kv, String(body.id ?? ""), String(body.runId ?? ""));
        return NextResponse.json({ ok: true, run });
      }

      case "status": {
        const [tasks, tickRaw] = await Promise.all([
          listTasksSafe(kv),
          kv.get("schedule:tick").catch(() => null),
        ]);
        let tickInfo: Record<string, unknown> | null = null;
        try {
          tickInfo = tickRaw ? (JSON.parse(tickRaw) as Record<string, unknown>) : null;
        } catch {
          tickInfo = null;
        }
        return NextResponse.json({ ok: true, tasks: tasks.length, tick: tickInfo });
      }

      // ── UNIFIED CHAT RECORDS ──────────────────────────────────────────
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
  const tasks = await listTasksSafe(a.kv);
  return NextResponse.json({ ok: true, tasks });
}

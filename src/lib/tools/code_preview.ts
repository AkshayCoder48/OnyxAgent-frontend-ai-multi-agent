"use client";

import { registerTool } from "./registry";
import { getE2BClient } from "@/lib/e2b/client";
import { ensureFreshSandboxForCtx } from "@/lib/e2b/sandbox-rotation";
import { getScaffold, normalizeAppName } from "@/lib/code/scaffolds";
import {
  NO_KEY_ERROR,
  detectScaffold,
  getInflightPreviewStart,
  isUrlServing,
  startPreview,
  startPreviewExclusive,
  stopPreviewSession,
} from "@/lib/code/preview-ops";
import { findPreviewSession, usePreviewSessionStore } from "@/stores/preview-session-store";

/**
 * OnyxCode preview tools (OnyxCode PRD §6 + Runtime PRD §2-8) —
 * `start_preview` and the multi-action `manage_preview` (one tool +
 * `action`, the established pattern). They install dependencies when
 * needed, start the dev server as a detached sandbox process, and return
 * the PUBLIC preview URL (https://{sandboxId}-{port}.e2b.dev) which the
 * Preview panel embeds.
 *
 * ONE CODE CHAT = ONE APP: every action is scoped to the ACTIVE
 * conversation (ctx.conversationId — the id the runtime stamps on the
 * turn). The session record is keyed deterministically as
 * pv-<conversationId> in the shared preview-session store, so the chat owns
 * exactly one preview record, `list` only ever returns THIS chat's session,
 * and starts are mutually exclusive per conversation (never double-start).
 */

async function doStart(
  args: Record<string, unknown>,
  ctx: import("./registry").ToolContext,
): Promise<Record<string, unknown>> {
  const appName = normalizeAppName(args.name as string | undefined);
  const conversationId = ctx.conversationId ?? null;
  const apiKey = await ensureFreshSandboxForCtx(ctx);
  if (!apiKey) {
    return { ok: false, error: NO_KEY_ERROR };
  }

  // Resolve the scaffold: explicit framework → the project files on disk
  // (detected) → this conversation's session history → static. Detecting
  // matters: serving a Next.js/Vite project with a plain static server (the
  // old default) rendered a broken or placeholder page instead of the real
  // app the agent built.
  const explicit = getScaffold(args.framework as string | undefined);
  let scaffold = explicit;
  if (!scaffold) {
    const client = getE2BClient(apiKey, null, "shared");
    scaffold = await detectScaffold(client, appName);
    ctx.onToolOutput?.(
      "",
      `Detected ${scaffold.label} project for "${appName}".`,
      "stdout",
    );
  }
  // History is scoped to THIS conversation only — the model may not adopt
  // another chat's framework (one app per chat).
  const sessions = usePreviewSessionStore.getState().sessions;
  const lastSession = conversationId ? findPreviewSession(sessions, conversationId) : null;
  if (!explicit && lastSession && lastSession.name === appName) {
    const fromHistory = getScaffold(lastSession.framework);
    if (fromHistory && fromHistory.key === "cli") scaffold = fromHistory;
  }

  // Mutually exclusive per conversation: if a start is already in flight
  // (auto-start on entering the chat, a second tool call, the panel's Start
  // button), await ITS result instead of booting a second dev server.
  const result = await startPreviewExclusive(conversationId, () =>
    startPreview({
      apiKey,
      appName,
      scaffold,
      port: (args.port as number | undefined) ?? undefined,
      conversationId: conversationId ?? undefined,
      onProgress: (line) => ctx.onToolOutput?.("", line, "stdout"),
    }),
  );

  if (!result.ok || !result.session) {
    return { ok: false, error: result.error ?? "Failed to start the preview." };
  }
  const s = result.session;
  return {
    kind: "preview",
    ok: true,
    action: "start",
    sessionId: s.id,
    name: s.name,
    framework: s.framework,
    frameworkLabel: s.frameworkLabel,
    url: s.url,
    port: s.port,
    status: s.status,
    message:
      s.status === "running"
        ? `Preview is live at ${s.url} — it is embedded in the Web preview panel (MonitorPlay button in the chat sub-header) and the user can open it in a new tab.`
        : `Preview server started at ${s.url} but it is still booting — tell the user to check the Web preview panel in a moment.`,
  };
}

registerTool(
  "start_preview",
  "Start (or restart) the live preview for an app in the E2B sandbox: detects the project's framework from its files (or uses the explicit framework argument), installs dependencies when needed, starts the dev server in the background, waits for the public URL to respond, and returns it. The URL is embedded in the Web preview panel (the MonitorPlay button beside the chat title) — one app per chat, so this reuses/updates the chat's single preview session. Use after create_app — IMPORTANT: only after you have written the REAL app content into projects/<name>/ (the scaffold ships a placeholder landing page; replace it with the actual site the user asked for BEFORE previewing).",
  {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "App name exactly as passed to create_app (e.g. my-next-app).",
      },
      framework: {
        type: "string",
        description: "Optional framework key (nextjs, vite-react, fastapi, node, static). Auto-detected from the project files when omitted.",
      },
      port: { type: "number", description: "Optional port (default 3000)." },
    },
    required: ["name"],
    additionalProperties: false,
  },
  async (args, ctx) => doStart(args, ctx),
  false,
  "code",
);

registerTool(
  "manage_preview",
  "Manage OnyxCode live previews for THIS conversation (one app per chat). Actions: `start` (same as start_preview — install deps, start dev server, return the public URL), `stop` (stop this chat's preview server), `list` (list this conversation's preview session with its status), `check` (check whether this chat's preview URL is currently serving).",
  {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["start", "stop", "list", "check"],
        description: "The preview operation to perform.",
      },
      name: { type: "string", description: "App name (for start/stop/check)." },
      framework: { type: "string", description: "Optional framework key (for start)." },
      port: { type: "number", description: "Optional port (for start)." },
    },
    required: ["action"],
    additionalProperties: false,
  },
  async (args, ctx) => {
    const action = String(args.action ?? "");
    const store = usePreviewSessionStore.getState();
    const appName = args.name ? normalizeAppName(args.name as string) : null;
    // ONE APP PER CHAT: every action resolves the ACTIVE conversation's
    // single session record — other chats' previews are invisible here.
    const session = findPreviewSession(store.sessions, ctx.conversationId);

    if (action === "start") {
      if (!appName) return { ok: false, error: "name is required for start." };
      return doStart(args, ctx);
    }

    if (action === "stop") {
      if (!session) {
        return {
          ok: false,
          error: `No preview session found for this conversation${appName ? ` (asked for "${appName}")` : ""}.`,
        };
      }
      if (appName && session.name !== appName) {
        return {
          ok: false,
          error: `This conversation's preview app is "${session.name}", not "${appName}".`,
        };
      }
      // A start still in flight would re-mark the record "running" the
      // moment it lands — await it first, then stop what it started, so the
      // "stopped" answer stays honest (PRD §7/§122).
      const inflight = ctx.conversationId
        ? getInflightPreviewStart(ctx.conversationId)
        : null;
      if (inflight) {
        try {
          await inflight;
        } catch {
          /* the start failed — nothing extra to stop */
        }
      }
      const fresh = findPreviewSession(
        usePreviewSessionStore.getState().sessions,
        ctx.conversationId,
      );
      const target = fresh ?? session;
      const apiKey = await ensureFreshSandboxForCtx(ctx);
      await stopPreviewSession(target, apiKey ?? undefined);
      return {
        kind: "preview",
        ok: true,
        action: "stop",
        sessionId: target.id,
        name: target.name,
        status: "stopped",
        message: `Preview for ${target.name} stopped.`,
      };
    }

    if (action === "list") {
      // Scoped: THIS conversation's session only (0 or 1 entries — one app
      // per chat; no cross-chat listing).
      const sessions = session
        ? [
            {
              sessionId: session.id,
              name: session.name,
              framework: session.framework,
              url: session.url,
              status: session.status,
              createdAt: session.createdAt,
            },
          ]
        : [];
      return {
        kind: "preview",
        ok: true,
        action: "list",
        sessions,
        count: sessions.length,
      };
    }

    if (action === "check") {
      if (!session) {
        return {
          ok: false,
          error: `No preview session found for this conversation${appName ? ` (asked for "${appName}")` : ""}.`,
        };
      }
      if (appName && session.name !== appName) {
        return {
          ok: false,
          error: `This conversation's preview app is "${session.name}", not "${appName}".`,
        };
      }
      const serving = session.url ? await isUrlServing(session.url) : false;
      return {
        kind: "preview",
        ok: true,
        action: "check",
        sessionId: session.id,
        name: session.name,
        url: session.url ?? undefined,
        serving,
        status: session.status,
      };
    }

    return { ok: false, error: `Unknown action "${action}". Use start, stop, list, or check.` };
  },
  false,
  "code",
);

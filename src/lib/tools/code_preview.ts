"use client";

import { registerTool } from "./registry";
import { ensureFreshSandboxForCtx } from "@/lib/e2b/sandbox-rotation";
import { getScaffold, normalizeAppName } from "@/lib/code/scaffolds";
import { startPreview, stopPreviewSession, isUrlServing } from "@/lib/code/preview-ops";
import { usePreviewSessionStore } from "@/stores/preview-session-store";

const NO_KEY_ERROR =
  "Previews require an E2B Sandbox API key. Add one in Settings → Config → E2B Sandbox.";

/**
 * OnyxCode preview tools (OnyxCode PRD §6) — `start_preview` and the
 * multi-action `manage_preview` (one tool + `action`, the established
 * pattern). They install dependencies when needed, start the dev server as
 * a detached sandbox process, and return the PUBLIC preview URL
 * (https://{sandboxId}-{port}.e2b.dev) which the Preview tab embeds.
 * Session records land in the shared preview-session store, so the Preview
 * tab updates live and everything survives refreshes.
 */

async function doStart(
  args: Record<string, unknown>,
  ctx: import("./registry").ToolContext,
): Promise<Record<string, unknown>> {
  const appName = normalizeAppName(args.name as string | undefined);
  // Resolve the scaffold: explicit framework, or infer from the session
  // history (the app the agent just created with create_app), or default
  // to a static server over the existing project directory.
  const scaffold = getScaffold(args.framework as string | undefined);
  const sessions = usePreviewSessionStore.getState().sessions;
  const lastSession = sessions.find((s) => s.name === appName);

  const apiKey = await ensureFreshSandboxForCtx(ctx);
  if (!apiKey) {
    return { ok: false, error: NO_KEY_ERROR };
  }

  const result = await startPreview({
    apiKey,
    appName,
    scaffold:
      scaffold ??
      (lastSession
        ? {
            // Restart an existing app whose framework we already know.
            ...getScaffold(lastSession.framework)!,
          }
        : getScaffold("static")!),
    port: (args.port as number | undefined) ?? undefined,
    conversationId: ctx.conversationId ?? undefined,
    onProgress: (line) => ctx.onToolOutput?.("", line, "stdout"),
  });

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
        ? `Preview is live at ${s.url} — it is embedded in the Preview tab (/code/preview) and the user can open it in a new tab.`
        : `Preview server started at ${s.url} but it is still booting — tell the user to check the Preview tab in a moment.`,
  };
}

registerTool(
  "start_preview",
  "Start (or restart) the live preview for an app in the E2B sandbox: installs dependencies when needed, starts the dev server in the background, waits for the public URL to respond, and returns it. The URL is embedded in the Code Mode Preview tab. Use after create_app, or to restart a stopped preview.",
  {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "App name exactly as passed to create_app (e.g. my-next-app).",
      },
      framework: {
        type: "string",
        description: "Optional framework key (nextjs, vite-react, fastapi, node, static). Inferred from the app's history when omitted.",
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
  "Manage OnyxCode live previews. Actions: `start` (same as start_preview — install deps, start dev server, return the public URL), `stop` (stop a running preview server), `list` (list all preview sessions with status), `check` (check whether a preview URL is currently serving).",
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

    if (action === "start") {
      if (!appName) return { ok: false, error: "name is required for start." };
      return doStart(args, ctx);
    }

    if (action === "stop") {
      const session = appName
        ? store.sessions.find((s) => s.name === appName)
        : store.sessions[0];
      if (!session) return { ok: false, error: `No preview session found for "${appName ?? "(any)"}".` };
      const apiKey = await ensureFreshSandboxForCtx(ctx);
      await stopPreviewSession(session, apiKey ?? undefined);
      return {
        kind: "preview",
        ok: true,
        action: "stop",
        sessionId: session.id,
        name: session.name,
        status: "stopped",
        message: `Preview for ${session.name} stopped.`,
      };
    }

    if (action === "list") {
      const sessions = store.sessions.map((s) => ({
        sessionId: s.id,
        name: s.name,
        framework: s.framework,
        url: s.url,
        status: s.status,
        createdAt: s.createdAt,
      }));
      return {
        kind: "preview",
        ok: true,
        action: "list",
        sessions,
        count: sessions.length,
      };
    }

    if (action === "check") {
      const session = appName
        ? store.sessions.find((s) => s.name === appName)
        : store.sessions[0];
      if (!session) return { ok: false, error: `No preview session found for "${appName ?? "(any)"}".` };
      const serving = await isUrlServing(session.url);
      return {
        kind: "preview",
        ok: true,
        action: "check",
        sessionId: session.id,
        name: session.name,
        url: session.url,
        serving,
        status: session.status,
      };
    }

    return { ok: false, error: `Unknown action "${action}". Use start, stop, list, or check.` };
  },
  false,
  "code",
);

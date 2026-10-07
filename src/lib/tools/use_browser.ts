"use client";

// use_browser — THE ONE AI-facing browser tool (CloakBrowser PRD).
//
// Every browser capability (navigation, interaction, screenshots, DOM
// inspection, JS evaluation, forms, tabs, downloads, uploads) rides this
// single action-based tool. The runtime underneath (CloakBrowser with
// humanize=True, standard-Chromium fallback) executes INSIDE the E2B
// sandbox and is an implementation detail the model never sees — there
// are no separate browser_navigate / browser_click / … tools.
//
// The SAME tool name is implemented natively inside the sandbox runner
// (bg-agent-script.ts) so background turns get the identical surface.

import { registerTool } from "./registry";
import { chatSandboxForCtx } from "@/lib/e2b/sandbox-rotation";
import { sendBrowserCommand, type BrowserCommandResult } from "@/lib/e2b/browser-session";

const NO_KEY_ERROR =
  "The browser requires an E2B Sandbox API key. Add one in Settings → Config → E2B Sandbox.";

const ACTIONS = [
  "navigate",
  "click",
  "type",
  "press",
  "scroll",
  "wait",
  "read",
  "snapshot",
  "screenshot",
  "screen_record",
  "inspect",
  "evaluate",
  "back",
  "forward",
  "reload",
  "get_page",
  "get_elements",
  "select",
  "upload",
  "download",
  "new_tab",
  "switch_tab",
  "close_tab",
  "go_back",
  "go_forward",
  "refresh",
] as const;

const USE_BROWSER_DESCRIPTION = `Browse and interact with websites in a real browser running INSIDE the sandbox — one persistent session (cookies/localStorage kept), multiple tabs, screenshots, page snapshots, screen recording, page inspection, forms, uploads and downloads. Pass \`action\` plus only the fields that action needs:

- "navigate" (url) — open a URL (https://… or http://localhost:PORT for sandbox-local servers).
- "click" (target) — click a link/button/element.
- "type" (target, text, submit?, clear?) — fill an input; submit:true presses Enter after typing.
- "press" (key) — press a keyboard key (e.g. "Enter", "Control+a").
- "scroll" (direction?, amount?) — scroll the page (down/up/left/right).
- "wait" (ms? | selector? | text?) — wait for a moment / element / text.
- "read" () — compact page summary: URL, title, visible text.
- "snapshot" (filter?, limit?) — STRUCTURED page snapshot for reasoning: visible text + every interactive element with refs + roles/ARIA + form field state, in one machine-readable payload. The returned "ref" (e.g. "e12") or selector works in subsequent actions.
- "screenshot" (fullPage?) — capture the current page as an image (returned inline, full page where supported).
- "screen_record" (operation) — screen recording: operation "start" begins capturing the active tab (keeps recording while you continue working), "stop" finishes and returns the playable video file, "status" reports the current recording state. Recording NEVER starts automatically — only when you explicitly request it.
- "inspect" (filter?, limit?) — the interactive elements (buttons, links, inputs) with refs + selectors.
- "evaluate" (code) — run JavaScript in the page and get the result.
- "select" (target, value) — choose an option in a <select> dropdown.
- "upload" (target, files) — upload WORKSPACE files (paths like "uploads/report.pdf") to a file input.
- "download" (url? | target?) — capture a download into the workspace (~/downloads), returns the file path.
- "new_tab" (url?) / "switch_tab" (tab: index or id) / "close_tab" (tab?) — tab management.
- "back" / "forward" / "reload" — history navigation (aliases: go_back / go_forward / refresh).

TARGETING (prefer semantic): a target is EITHER a string selector (CSS like "#id", "button.primary", or Playwright forms "text=Sign in", "xpath=//a[3]", "ref=e12") OR an object like {"role":"button","name":"Sign in"}, {"text":"Sign in"}, {"label":"Email"}, {"placeholder":"Search…"}, {"css":"#submit"}, {"xpath":"//button[1]"}, {"ref":"e12"}.

DOCUMENTATION SITES: for AI agents a documentation index is often available at llms.txt — fetch it first when you need docs, and use .md for canonical markdown pages (.mdx is kept as a backwards-compatible alias on supported URL paths).

The browser session persists across calls — navigate, then click, then type, all on the same session. First use in a fresh sandbox installs the browser runtime (can take a couple of minutes; consider telling the user).`;

registerTool(
  "use_browser",
  USE_BROWSER_DESCRIPTION,
  {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: [...ACTIONS],
        description: "The browser operation to perform.",
      },
      operation: {
        type: "string",
        enum: ["start", "stop", "status"],
        description: "Sub-operation for the screen_record action: 'start' begins recording the active tab, 'stop' finishes and returns the video file, 'status' reports the recording state.",
      },
      url: { type: "string", description: "URL to open (navigate / new_tab / download)." },
      target: {
        description:
          "Element to act on (click / type / select / upload / download): a selector string or a semantic object ({role,name} / {text} / {label} / {placeholder} / {css} / {xpath} / {ref}).",
      },
      text: { type: "string", description: "Text to type (type action)." },
      submit: { type: "boolean", description: "Press Enter after typing (type action)." },
      clear: { type: "boolean", description: "Clear the field before typing (default true)." },
      key: { type: "string", description: "Key to press (press action), e.g. 'Enter'." },
      code: { type: "string", description: "JavaScript to evaluate in the page (evaluate action)." },
      direction: { type: "string", enum: ["down", "up", "left", "right"], description: "Scroll direction (default down)." },
      amount: { type: "number", description: "Scroll distance in px (default 600)." },
      ms: { type: "number", description: "Milliseconds to wait (wait action, default 1000)." },
      selector: { type: "string", description: "Selector to wait for (wait action)." },
      fullPage: { type: "boolean", description: "Capture the full page (screenshot action)." },
      filter: { type: "string", description: "Substring filter for get_elements." },
      limit: { type: "number", description: "Max elements for get_elements (default 60)." },
      value: { type: "string", description: "Option value to select (select action)." },
      files: {
        type: "array",
        items: { type: "string" },
        description: "Workspace file paths to upload (upload action).",
      },
      tab: { description: "Tab index (number) or tab id like 'tab_2' (switch_tab / close_tab)." },
    },
    required: ["action"],
    additionalProperties: false,
  },
  async (args, ctx) => {
    const action = String(args.action ?? "");
    if (!ACTIONS.includes(action as (typeof ACTIONS)[number])) {
      return { error: `Unknown action: ${action}` };
    }

    // ── required-arg validation (fail fast with actionable messages) ──
    const need = (cond: boolean, message: string) => {
      if (!cond) return { error: message };
      return null;
    };
    if (action === "navigate" || action === "download") {
      if (action === "navigate" && !args.url) {
        return { error: "url is required for action 'navigate'." };
      }
      if (action === "download" && !args.url && !args.target) {
        return { error: "url or target is required for action 'download'." };
      }
    }
    if (action === "type" && (args.text === undefined || args.text === null) && !args.target) {
      return need(!!args.target, "target is required for action 'type'.");
    }
    if (action === "evaluate") {
      const v = need(!!args.code, "code is required for action 'evaluate'.");
      if (v) return v;
    }
    if (action === "upload") {
      const v = need(
        Array.isArray(args.files) && args.files.length > 0,
        "files (workspace paths, e.g. ['uploads/report.pdf']) is required for action 'upload'.",
      );
      if (v) return v;
    }
    if (action === "select" && args.value === undefined) {
      return { error: "value is required for action 'select'." };
    }

    // ── sandbox + driver ─────────────────────────────────────────────
    const sbx = await chatSandboxForCtx(ctx);
    if (!sbx) {
      return {
        success: false,
        error: { type: "sandbox_unavailable", message: NO_KEY_ERROR, recoverable: false },
      };
    }

    // Build the wire command (only the fields the driver knows).
    const cmd: Record<string, unknown> = { action };
    for (const k of [
      "operation",
      "url",
      "target",
      "text",
      "submit",
      "clear",
      "key",
      "code",
      "direction",
      "amount",
      "ms",
      "selector",
      "fullPage",
      "filter",
      "limit",
      "value",
      "files",
      "tab",
    ] as const) {
      if (args[k] !== undefined) cmd[k] = args[k];
    }

    const onProgress = (line: string) => {
      ctx.onToolOutput?.("", line, "stdout");
    };

    // OPERATION-AWARE TIMEOUTS (PRD §9): the ceiling belongs to the
    // OPERATION, never to the overall task. Recording assembly (stop)
    // installs the video encoder and encodes — it gets the longest budget;
    // screenshots / snapshots / downloads get the mid budget; everything
    // else rides the session manager's default (90s) or the first-boot
    // budget (6 min).
    const HEAVY_OPS = new Set(["screen_record", "screenshot", "snapshot", "download"]);
    const result: BrowserCommandResult = await sendBrowserCommand(sbx.client, cmd, {
      timeoutMs: HEAVY_OPS.has(action) ? 8 * 60_000 : undefined,
      onProgress,
    });

    // Structured pass-through (PRD §9/§27) — never silently fail.
    return { kind: "browser", action, ...result };
  },
  false,
  // "web" (NOT "exec") — category "exec" is the coding surface hidden
  // from foreground turns by filterToolsForRequest (request-scoping.ts);
  // registering this tool as "exec" made the model never see it, so it
  // truthfully told users "I don't have the use_browser tool".
  "web",
);

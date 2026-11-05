"use client";

// use_browser — THE ONE AI-facing browser tool (CloakBrowser + E2B PRD,
// reimplementation 2026-11-01).
//
// Every browser capability (navigation, interaction, screenshots,
// snapshots, DOM inspection, JS evaluation, forms, tabs, downloads,
// uploads) rides this single action-based tool. The runtime underneath
// (CloakBrowser with humanize=True, standard-Chromium fallback) executes
// INSIDE the E2B sandbox and is an implementation detail the model never
// sees — there are no separate browser_navigate / browser_click / … tools.
//
// REWRITE GUARANTEES (the "infinite execution, no output" incident):
//   • the handler NEVER throws — every failure resolves to a structured
//     result, so the agent always receives an answer and can keep
//     reasoning (PRD §7);
//   • every result carries a non-empty human-readable `output` line plus
//     success/action/url/title/error/durationMs (PRD §5);
//   • every action runs under an explicit per-action deadline (PRD §6) —
//     the client enforces it AND the sandbox-side watchdog enforces it;
//   • ctx.signal (the agent's abort signal) is honoured end-to-end;
//   • progress lines narrate the real lifecycle (sandbox → download →
//     initialization → action → result) through ctx.onToolOutput.
//
// Action surface — the PRD core plus the compat aliases older
// conversations and trained models still emit (read ≙ extract_text,
// inspect ≙ get_elements, back/forward/reload ≙ go_back/go_forward/
// refresh, …). The runtime maps them all; nothing the model sends from
// the old schema breaks.

import { registerTool } from "./registry";
import { chatSandboxForCtx } from "@/lib/e2b/sandbox-rotation";
import { sendBrowserCommand, type BrowserCommandResult } from "@/lib/e2b/browser-session";
import { rememberPageToKB } from "@/lib/kb/remember-page";

const NO_KEY_ERROR =
  "The browser requires an E2B Sandbox API key. Add one in Settings → Config → E2B Sandbox.";

/** PRD §5 core action surface. */
const CORE_ACTIONS = [
  "navigate",
  "screenshot",
  "snapshot",
  "click",
  "type",
  "scroll",
  "extract_text",
  "remember_page",
  "inspect",
  "wait",
  "back",
  "forward",
  "close",
] as const;

/** Compat aliases kept so old conversations / trained behaviors keep
 *  working against the same driver (PRD rule 10: preserve compatibility
 *  with the existing orchestration and tool-calling system). */
const COMPAT_ACTIONS = [
  "read", // ≙ extract_text
  "get_page", // ≙ extract_text
  "get_elements", // ≙ inspect
  "press",
  "evaluate",
  "select",
  "upload",
  "download",
  "new_tab",
  "switch_tab",
  "close_tab",
  "go_back", // ≙ back
  "go_forward", // ≙ forward
  "reload", // ≙ navigate current page
  "refresh", // ≙ reload
  "screen_record",
] as const;

const ACTIONS = [...CORE_ACTIONS, ...COMPAT_ACTIONS] as const;
type BrowserAction = (typeof ACTIONS)[number];

/**
 * Per-action client deadlines (PRD §6 — configurable, in ONE place). Each
 * is the DRIVER-side budget (browser-driver.ts ACTION_BUDGETS) plus a
 * ~15-25s transport margin, so the driver answers first with the precise
 * error (element_not_found, navigation_failed, …) while the client
 * deadline stays the hard backstop that guarantees a result.
 */
const ACTION_TIMEOUT_MS: Record<BrowserAction, number> = {
  // navigate: 45 s goto + up to 30 s Cloudflare-settle cap (driver budget 80 s).
  navigate: 105_000,
  screenshot: 65_000,
  snapshot: 50_000,
  click: 45_000,
  type: 50_000,
  scroll: 40_000,
  // read-path actions: includes the 12 s challenge-settle cap (driver budget 40 s).
  // remember_page: same read path + the client-side OnyxBase KB save.
  extract_text: 60_000,
  remember_page: 75_000,
  inspect: 50_000,
  wait: 55_000,
  back: 45_000,
  forward: 45_000,
  close: 40_000,
  // compat aliases
  read: 60_000,
  get_page: 60_000,
  get_elements: 50_000,
  press: 35_000,
  evaluate: 65_000,
  select: 45_000,
  upload: 85_000,
  download: 115_000,
  new_tab: 65_000,
  switch_tab: 35_000,
  close_tab: 35_000,
  go_back: 45_000,
  go_forward: 45_000,
  reload: 65_000,
  refresh: 65_000,
  screen_record: 320_000, // 'stop' installs the encoder + assembles the video
};

const USE_BROWSER_DESCRIPTION = `Browse and interact with websites in a real browser (CloakBrowser) running INSIDE the sandbox — one persistent session (cookies/localStorage kept), multiple tabs, page inspection, forms, uploads and downloads.

WHEN TO USE: ONLY when the page needs real interaction — clicking, typing, logging in, JS-rendered apps, anti-bot walls, downloads/uploads. For simply READING a page's text (articles, docs, APIs) use web_fetch instead — it is the default for reading and much faster/cheaper.

Pass \`action\` plus only the fields that action needs:

- "navigate" (url) — open a URL (https://… or http://localhost:PORT for sandbox-local servers). Cloudflare "Just a moment..." interstitials are settled automatically: the passive check is waited out (default ≤ 18 s) and an escalated Turnstile checkbox is clicked humanized; the reply reports the challenge status.
- "screenshot" (fullPage?) — capture a PNG of the page.
- "snapshot" () — the page STRUCTURE: title, heading outline, element counts, top interactive elements + a text excerpt.
- "extract_text" () — the visible page text.
- "remember_page" (note?, include_history?) — one-shot “remember this page”: captures the current page (title, URL, up to 40k chars of text) AND saves it to the workspace Knowledge Base as a searchable document. Use whenever the user says "remember this page / save this" while browsing, or a page is clearly worth keeping (a key reference, a decision, research material). "note" (optional) is your curated note — WHY the page matters, what to remember about it — stored alongside the page. "include_history" (default true) also appends this session's navigation log (the browse history) to the saved item. Returns the saved item's id + title.
- "inspect" (filter?, limit?) — the interactive elements (buttons, links, inputs) with refs + selectors; the returned "ref" (e.g. "e12") or selector works in subsequent actions.
- "click" (target) — click a link/button/element.
- "type" (target, text, submit?, clear?) — fill an input; submit:true presses Enter after typing.
- "scroll" (direction?, amount?) — scroll the page (down/up/left/right).
- "wait" (ms? | selector? | text?) — wait for a moment / element / text.
- "back" / "forward" — history navigation.
- "close" () — close the browser session (profile is kept).
- "press" (key) — press a keyboard key (e.g. "Enter", "Control+a").
- "evaluate" (code) — run JavaScript in the page and get the result.
- "select" (target, value) — choose an option in a <select> dropdown.
- "upload" (target, files) — upload WORKSPACE files (paths like "uploads/report.pdf") to a file input.
- "download" (url? | target?) — capture a download into the workspace (~/downloads), returns the file path.
- "new_tab" (url?) / "switch_tab" (tab: index or id) / "close_tab" (tab?) — tab management.

TARGETING (prefer semantic): a target is EITHER a selector string (CSS like "#id", "button.primary", or Playwright forms "text=Sign in", "xpath=//a[3]") — an inspect ref works BARE ("e12") or prefixed ("ref=e12") — OR a semantic object, passed as an object or as its JSON string: {"role":"button","name":"Sign in"}, {"text":"Sign in"}, {"label":"Email"}, {"placeholder":"Search…"}, {"css":"#submit"}, {"xpath":"//button[1]"}, {"ref":"e12"}.

DOCUMENTATION SITES: do NOT reach for the browser to read docs — use web_fetch on /llms.txt and .md pages first (it is the default reader); the browser is only for doc sites that need interaction to render.

The browser session persists across calls — navigate, then click, then type, all on the same session. The browser installs in the background while you chat, so the first call is usually instant; a genuinely cold sandbox may still need a one-time setup (narrated live in the tool output).`;

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
          "Element to act on (click / type / select / upload / download): a selector string, an inspect ref (bare 'e12' or 'ref=e12'), or a semantic object — {role,name} / {text} / {label} / {placeholder} / {css} / {xpath} / {ref} — passed as an object or its JSON string.",
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
      filter: { type: "string", description: "Substring filter for inspect." },
      limit: { type: "number", description: "Max elements for inspect (default 60)." },
      value: { type: "string", description: "Option value to select (select action)." },
      files: {
        type: "array",
        items: { type: "string" },
        description: "Workspace file paths to upload (upload action).",
      },
      note: { type: "string", description: "Curated note stored with the page (remember_page action) — why this page matters / what to remember." },
      include_history: { type: "boolean", description: "Also save this session's navigation log with the page (remember_page action, default true)." },
      tab: { description: "Tab index (number) or tab id like 'tab_2' (switch_tab / close_tab)." },
    },
    required: ["action"],
    additionalProperties: false,
  },
  async (args, ctx) => {
    const startedAt = Date.now();
    const action = String(args.action ?? "") as BrowserAction;
    const progress = (line: string) => {
      ctx.onToolOutput?.("", line, "stdout");
    };

    // ── structured failure helper: NEVER throw out of this tool ──────
    const fail = (type: string, message: string, opts?: { recoverable?: boolean }) => ({
      kind: "browser" as const,
      success: false,
      action,
      url: null,
      title: null,
      screenshot: null,
      error: { type, message, recoverable: opts?.recoverable ?? true },
      output: `${type}: ${message}`,
      durationMs: Date.now() - startedAt,
    });

    // ── action validation (fail fast with actionable messages) ──────
    if (!ACTIONS.includes(action)) {
      return fail(
        "bad_request",
        `Unknown action "${action}". Supported: ${ACTIONS.join(", ")}.`,
        { recoverable: false },
      );
    }
    if (action === "navigate" && !args.url) {
      return fail("bad_request", "url is required for action 'navigate'.", { recoverable: false });
    }
    if (action === "download" && !args.url && !args.target) {
      return fail("bad_request", "url or target is required for action 'download'.", { recoverable: false });
    }
    if (action === "type" && args.text === undefined && !args.target) {
      return fail("bad_request", "target is required for action 'type'.", { recoverable: false });
    }
    if (action === "evaluate" && !args.code) {
      return fail("bad_request", "code is required for action 'evaluate'.", { recoverable: false });
    }
    if (
      action === "upload" &&
      !(Array.isArray(args.files) && args.files.length > 0)
    ) {
      return fail(
        "bad_request",
        "files (workspace paths, e.g. ['uploads/report.pdf']) is required for action 'upload'.",
        { recoverable: false },
      );
    }
    if (action === "select" && args.value === undefined) {
      return fail("bad_request", "value is required for action 'select'.", { recoverable: false });
    }

    // ── sandbox acquisition ──────────────────────────────────────────
    let sbx: Awaited<ReturnType<typeof chatSandboxForCtx>>;
    try {
      sbx = await chatSandboxForCtx(ctx);
    } catch (e) {
      return fail(
        "sandbox_unavailable",
        `Could not reach the E2B sandbox: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    if (!sbx) {
      return fail("sandbox_unavailable", NO_KEY_ERROR, { recoverable: false });
    }

    // ── wire command (only the fields the driver knows) ─────────────
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

    // Narrate the real lifecycle — every line corresponds to an actual
    // backend transition (boot narration comes from sendBrowserCommand).
    progress(`Browser ${action} started.`);

    // ── execute under the per-action deadline (PRD §6) ──────────────
    let result: BrowserCommandResult;
    try {
      result = await sendBrowserCommand(sbx.client, cmd, {
        timeoutMs: ACTION_TIMEOUT_MS[action],
        onProgress: progress,
        signal: ctx.signal,
      });
    } catch (e) {
      // sendBrowserCommand never rejects by contract — this is belt and
      // braces so the agent can NEVER be left without an answer.
      return fail(
        "browser_error",
        `The browser action could not be completed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    const durationMs =
      typeof result.durationMs === "number"
        ? result.durationMs
        : Date.now() - startedAt;

    // ── remember_page: the driver CAPTURED the page — now save it to the
    // Knowledge Base (the sandbox cannot reach OnyxBase; the save is
    // client-side). The capture text rides along either way so the model
    // sees what was captured even when the save fails honestly.
    if (action === "remember_page" && result.success !== false) {
      const saved = await rememberPageToKB(ctx.userId, {
        url: String(result.url ?? ""),
        title: String(result.title ?? ""),
        text: typeof result.text === "string" ? result.text : "",
        note: typeof args.note === "string" ? args.note : null,
        navLog: Array.isArray(result.navLog)
          ? (result.navLog as Array<{ url: string; title?: string | null; ts?: number }>)
          : [],
        includeHistory: args.include_history !== false,
        source: "ai",
      });
      if (!saved.ok) {
        return {
          ...result,
          kind: "browser" as const,
          action,
          success: false,
          url: (result.url as string | undefined) ?? null,
          title: (result.title as string | undefined) ?? null,
          output: `remember_page: ${saved.message}`,
          screenshot: null,
          error: {
            type: saved.code === "NOT_CONFIGURED" ? "kb_not_configured" : "kb_save_failed",
            message: saved.message,
            recoverable: saved.code === "NOT_CONFIGURED",
          },
          durationMs: Date.now() - startedAt,
        };
      }
      return {
        ...result,
        kind: "browser" as const,
        action,
        success: true,
        url: (result.url as string | undefined) ?? null,
        title: (result.title as string | undefined) ?? null,
        saved: true,
        kbId: saved.item.id,
        kbTitle: saved.item.title,
        contentChars: saved.contentChars,
        historyIncluded: saved.historyIncluded,
        output: `Remembered “${saved.item.title}” — saved to the Knowledge Base as a searchable document (id ${saved.item.id}${saved.historyIncluded ? ", browse history included" : ""}).`,
        screenshot: null,
        error: null,
        durationMs: Date.now() - startedAt,
      };
    }

    // ── structured pass-through (PRD §5 contract) ───────────────────
    // success / action / url / title / output / screenshot / error /
    // durationMs are ALWAYS present; output is NEVER empty.
    const output =
      typeof result.output === "string" && result.output.trim()
        ? result.output
        : result.error
          ? `${result.error.type}: ${result.error.message}`
          : `${action} completed.`;

    return {
      ...result,
      // Canonical contract fields, asserted AFTER the spread so the
      // guarantees hold no matter what the transport returned.
      kind: "browser" as const,
      action,
      success: result.success !== false,
      url: (result.url as string | undefined) ?? null,
      title: (result.title as string | undefined) ?? null,
      output,
      screenshot: (result.dataUrl as string | undefined) ?? null,
      error: result.error ?? null,
      durationMs,
    };
  },
  false,
  // "web" — the browsing category it belongs to (kept stable across the
  // reimplementation: hiding or renaming the tool would break existing
  // conversations and the captions/step-UI keyed on its name).
  "web",
);

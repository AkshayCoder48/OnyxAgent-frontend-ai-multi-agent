"use client";

import { useMemo, useState } from "react";
import { Check, ChevronRight, Globe, Loader2, X } from "lucide-react";
import type { ToolCall } from "@/types";
import { cn } from "@/lib/utils";
import { chipClass, CollapsePanel } from "@/components/assistant-ui/elements";
import { ToolDurationBadge, ToolLiveElapsed } from "../tool-duration";

/**
 * use_browser results — BASIC TOOL CALL + OUTPUT (user directive
 * 2026-10-21: "remove the snapshot and keep it basic tool call and output,
 * no special ui"). The browser is presented exactly like every other tool:
 *
 *  - `BrowserUseGroup` — a run of consecutive use_browser calls as ONE
 *    collapsible tool line ("Use Browser") with a plain mono operation list:
 *    `→ navigate example.com ✓ 0.8s`, `→ click #login ✓ 1.2s`, … Expanding a
 *    row shows the raw OUTPUT of that call (the page text it read, the value
 *    it evaluated, the error it hit) — nothing else. No iframe preview, no
 *    screenshots, no element-ref tables. The LIVE browser view lives in the
 *    chat header's Browser tab (BrowserLivePanel), not in the chat flow.
 *  - `BrowserResult` — the per-call fallback for a use_browser call rendered
 *    OUTSIDE a group (lone call, other renderers). Same basic shape.
 */

/** use_browser result payload (see src/lib/e2b/browser-driver.ts). */
export interface BrowserPayload {
  kind: "browser";
  success?: boolean;
  action?: string;
  operation?: string;
  sessionId?: string;
  runtime?: string;
  url?: string;
  title?: string | null;
  tabs?: Array<{ tabId: string; index: number; url: string; title: string; active: boolean }>;
  activeTab?: number;
  tabCount?: number;
  status?: number | null;
  text?: string;
  elements?: Array<{ ref: string; tag: string; role?: string | null; text?: string | null; selector: string }>;
  forms?: Array<Record<string, unknown>>;
  count?: number;
  value?: unknown;
  dataUrl?: string;
  path?: string;
  file?: string;
  name?: string;
  frames?: number;
  durationSec?: number;
  sizeBytes?: number;
  recording?: boolean;
  message?: string;
  error?: { type: string; message: string; recoverable?: boolean };
  viewport?: { width: number; height: number } | null;
  box?: { x: number; y: number; w: number; h: number } | null;
}

export function parseBrowserResult(result: unknown): BrowserPayload | null {
  try {
    const p = typeof result === "string" ? JSON.parse(result) : result;
    if (p && typeof p === "object" && (p as { kind?: string }).kind === "browser") {
      return p as BrowserPayload;
    }
  } catch {
    /* not JSON */
  }
  return null;
}

/* ── Technical labels ────────────────────────────────────────────────────── */

/** Mono operation verb shown at the start of each row — terse and scannable. */
const OP_LABELS: Record<string, string> = {
  navigate: "Navigate",
  click: "Click",
  type: "Type",
  press: "Press",
  scroll: "Scroll",
  wait: "Wait",
  read: "Read",
  get_page: "Read",
  // Legacy (removed 2026-10-21) — old conversations in history still render.
  snapshot: "Snapshot",
  screenshot: "Screenshot",
  screen_record: "Record",
  inspect: "Inspect",
  get_elements: "Inspect",
  evaluate: "Eval",
  select: "Select",
  upload: "Upload",
  download: "Download",
  new_tab: "New Tab",
  switch_tab: "Switch Tab",
  close_tab: "Close Tab",
  back: "Back",
  go_back: "Back",
  forward: "Forward",
  go_forward: "Forward",
  reload: "Reload",
  refresh: "Reload",
};

/** Settled fallback card header labels (BrowserResult). */
const ACTION_LABELS: Record<string, string> = {
  navigate: "Opened",
  click: "Clicked",
  type: "Typed",
  press: "Pressed",
  scroll: "Scrolled",
  wait: "Waited",
  read: "Read page",
  get_page: "Read page",
  // Legacy (removed 2026-10-21) — old conversations in history still render.
  snapshot: "Page snapshot",
  screenshot: "Screenshot",
  screen_record: "Screen record",
  inspect: "Elements",
  get_elements: "Elements",
  evaluate: "Evaluated",
  select: "Selected",
  upload: "Uploaded",
  download: "Downloaded",
  new_tab: "New tab",
  switch_tab: "Switched tab",
  close_tab: "Closed tab",
  back: "Back",
  go_back: "Back",
  forward: "Forward",
  go_forward: "Forward",
  reload: "Reloaded",
  refresh: "Reloaded",
};

/** Trim a label so rows never blow the layout. */
function clip(text: string, max = 36): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Hostname of a URL ("https://a.b.org/x" → "a.b.org"), "" when unreadable. */
function hostnameOf(url: string): string {
  try {
    if (url.startsWith("data:")) return "";
    return new URL(url).hostname.replace(/^www\./, "") || "";
  } catch {
    return "";
  }
}

/** Short label for a targeting arg — the selector string itself, or the
 * semantic object's name/text/label/placeholder/css/xpath/ref value. */
function targetLabelOf(target: unknown): string | null {
  if (typeof target === "string" && target.trim()) return target.trim();
  if (target && typeof target === "object") {
    const o = target as Record<string, unknown>;
    const v =
      o.name ?? o.text ?? o.label ?? o.placeholder ?? o.alt ?? o.css ?? o.xpath ?? o.ref;
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

/** The argument-side label for one operation — what it acted on. */
function opTarget(args: Record<string, unknown>, action: string): string | null {
  const url = typeof args.url === "string" ? args.url.trim() : "";
  const target = targetLabelOf(args.target);
  switch (action) {
    case "navigate":
      return clip(hostnameOf(url) || url || "page");
    case "new_tab":
    case "switch_tab":
    case "close_tab":
    case "back":
    case "go_back":
    case "forward":
    case "go_forward":
    case "reload":
    case "refresh":
      return hostnameOf(url) || null;
    case "click":
    case "select":
    case "upload":
    case "type":
      return target ? clip(target) : null;
    case "press":
      return typeof args.key === "string" && args.key ? clip(args.key) : null;
    case "screenshot":
      return args.fullPage === true ? "full page" : null;
    case "screen_record": {
      const op = typeof args.operation === "string" ? args.operation : "status";
      return op;
    }
    case "wait":
      return clip(
        (typeof args.selector === "string" && args.selector.trim()) ||
          (typeof args.text === "string" && args.text.trim()) ||
          (typeof args.ms === "number" ? `${args.ms}ms` : ""),
      ) || null;
    default:
      return null;
  }
}

/** A call is in-flight (pending or running). */
function isCallActive(call: ToolCall): boolean {
  return call.status === "running" || call.status === "pending";
}

/** The result-side summary for one settled operation — the "42 elements"
 * / "captured" tail of a row. Pure derivation from the payload. */
function opResultSummary(action: string, payload: BrowserPayload | null): string | null {
  if (!payload || payload.success === false) return null;
  const count = typeof payload.count === "number" ? payload.count : payload.elements?.length;
  switch (action) {
    case "navigate":
    case "new_tab":
    case "switch_tab":
    case "close_tab":
    case "back":
    case "go_back":
    case "forward":
    case "go_forward":
    case "reload":
    case "refresh":
      return typeof payload.status === "number" ? `HTTP ${payload.status}` : "loaded";
    case "read":
    case "get_page":
      return typeof payload.text === "string" && payload.text
        ? `${payload.text.length.toLocaleString()} chars`
        : null;
    case "inspect":
    case "get_elements":
    case "snapshot": // legacy — removed 2026-10-21, old history still renders
      return typeof count === "number" ? `${count} elements` : null;
    case "screenshot":
      return "captured";
    case "screen_record": {
      const op = payload.operation ?? "status";
      if (op === "start") return "recording started";
      if (op === "stop")
        return typeof payload.durationSec === "number"
          ? `${payload.name ?? "video"} · ${payload.durationSec}s`
          : (payload.name ?? "saved");
      return payload.recording ? "recording…" : "not recording";
    }
    case "download":
      return payload.file ? clip(payload.file.split("/").pop() ?? payload.file) : null;
    case "evaluate":
      return payload.value !== undefined
        ? clip(typeof payload.value === "string" ? payload.value : JSON.stringify(payload.value) ?? "", 44)
        : null;
    default:
      return payload.message ? clip(payload.message, 44) : null;
  }
}

/** The PLAIN OUTPUT of one call — the raw text the tool returned (read text,
 * evaluate value, error message). This is the "output" half of the basic
 * tool-call presentation: no derived UI, just what came back. */
function opOutput(action: string, payload: BrowserPayload | null, toolCall: ToolCall): string | null {
  if (payload?.error) return `${payload.error.type} — ${payload.error.message}`;
  if (toolCall.status === "error" && !payload) return `Action ${action} failed.`;
  if (!payload) return null;
  if (action === "evaluate" && payload.value !== undefined) {
    return typeof payload.value === "string"
      ? payload.value
      : (JSON.stringify(payload.value) ?? String(payload.value));
  }
  if (typeof payload.text === "string" && payload.text) return payload.text;
  if (typeof payload.message === "string" && payload.message) return payload.message;
  return null;
}

/* ── One operation row ───────────────────────────────────────────────────── */

/**
 * BrowserOpRow — `→ navigate  example.com  ✓ 0.8s`. Compact, mono,
 * event-driven (the row exists because the backend emitted the call).
 * Click toggles the plain output block — the raw result text, nothing more.
 */
function BrowserOpRow({ toolCall }: { toolCall: ToolCall }) {
  const [open, setOpen] = useState(false);
  const args = (toolCall.args ?? {}) as Record<string, unknown>;
  const action = typeof args.action === "string" && args.action ? args.action : "browser";
  const payload = parseBrowserResult(toolCall.result);
  const isRunning = isCallActive(toolCall);
  const isError = toolCall.status === "error" || payload?.success === false;
  const op = OP_LABELS[action] ?? action;
  const target = opTarget(args, action);
  const summary = opResultSummary(action, payload);
  const isWaiting = isRunning && action === "wait";
  const output = opOutput(action, payload, toolCall);

  return (
    <div className="rounded-md text-xs">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex min-h-8 w-full cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-accent/40",
          isError && "bg-destructive/[0.04]",
        )}
      >
        {/* Status glyph — the only stateful ornament on the row. */}
        <span className="flex w-4 shrink-0 justify-center" aria-hidden>
          {isRunning ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
          ) : isError ? (
            <X className="h-3.5 w-3.5 text-destructive" />
          ) : (
            <Check className="h-3.5 w-3.5 text-primary/70" />
          )}
        </span>

        {/* Operation + target + result summary — mono, one line, scannable. */}
        <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
          <span className="font-mono text-[11px] font-semibold text-foreground/85">{op}</span>
          {target ? (
            <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">{target}</span>
          ) : null}
          {isWaiting ? (
            <span className="rounded-full border border-border bg-foreground/[0.04] px-1.5 py-px font-mono text-[10px] text-muted-foreground">
              waiting…
            </span>
          ) : null}
          {summary && !isError ? (
            <span className="min-w-0 truncate font-mono text-[10px] text-muted-foreground/80">{summary}</span>
          ) : null}
          {isError && payload?.error ? (
            <span className="min-w-0 truncate font-mono text-[10px] text-destructive">
              {clip(payload.error.message, 60)}
            </span>
          ) : null}
        </span>

        {/* Duration + disclosure chevron. */}
        {isRunning ? (
          <ToolLiveElapsed startedAt={toolCall.startedAt} />
        ) : (
          <ToolDurationBadge startedAt={toolCall.startedAt} endedAt={toolCall.endedAt} />
        )}
        {output ? (
          <ChevronRight
            className={cn(
              "h-3 w-3 shrink-0 text-muted-foreground transition-transform duration-200",
              open && "rotate-90",
            )}
            aria-hidden
          />
        ) : (
          <span className="w-3 shrink-0" aria-hidden />
        )}
      </button>

      {/* Plain output — the raw text the tool returned. */}
      {output ? (
        <CollapsePanel open={open}>
          <div className="px-6 pb-1.5 pt-0.5">
            {payload?.url && action !== "navigate" ? (
              <p className="truncate font-mono text-[10px] text-muted-foreground">{payload.url}</p>
            ) : null}
            <pre
              className={cn(
                "max-h-48 overflow-y-auto rounded-md border border-border bg-foreground/[0.02] px-2 py-1.5 font-mono text-[10px] leading-relaxed whitespace-pre-wrap scrollbar-thin",
                isError ? "text-destructive" : "text-muted-foreground",
              )}
            >
              {output.slice(0, 2000)}
              {output.length > 2000 ? "\n…" : ""}
            </pre>
          </div>
        </CollapsePanel>
      ) : null}
    </div>
  );
}

/* ── The grouped view: ONE collapsible "Use Browser" tool line ───────────── */

/**
 * BrowserUseGroup — a run of consecutive use_browser calls rendered as ONE
 * compact tool-call line ("Use Browser" + status) with the plain mono
 * operation list behind the disclosure. Auto-expands while the run is
 * active, settles collapsed; every click after that is the user's own.
 * Statuses: Running / Waiting / Completed · Ns / Failed.
 */
export function BrowserUseGroup({ toolCalls }: { toolCalls: ToolCall[] }) {
  const anyActive = toolCalls.some(isCallActive);
  const anyError = toolCalls.some((c) => c.status === "error");

  // Auto expand/collapse on activity transitions (render-time adjustment —
  // no effect, no cascading renders). Mounting mid-run → expanded; loading
  // a settled history → collapsed.
  const [expanded, setExpanded] = useState(anyActive);
  const [prevActive, setPrevActive] = useState(anyActive);
  if (anyActive !== prevActive) {
    setPrevActive(anyActive);
    setExpanded(anyActive);
  }

  // Group timing: earliest start → latest settle (the Completed badge).
  const { startedAt, endedAt } = useMemo(() => {
    let start: number | undefined;
    let end: number | undefined;
    for (const c of toolCalls) {
      if (typeof c.startedAt === "number" && (start === undefined || c.startedAt < start)) start = c.startedAt;
      if (typeof c.endedAt === "number" && (end === undefined || c.endedAt > end)) end = c.endedAt;
    }
    return { startedAt: start, endedAt: end };
  }, [toolCalls]);

  // The run's current page: the newest settled payload URL, else the newest
  // navigate argument (shown as the header chip while running).
  const currentUrl = useMemo(() => {
    for (let i = toolCalls.length - 1; i >= 0; i--) {
      const p = parseBrowserResult(toolCalls[i]!.result);
      if (p?.url && p.url !== "about:blank") return p.url;
    }
    for (let i = toolCalls.length - 1; i >= 0; i--) {
      const args = (toolCalls[i]!.args ?? {}) as Record<string, unknown>;
      if (args.action === "navigate" && typeof args.url === "string" && args.url) return args.url;
    }
    return null;
  }, [toolCalls]);

  const failed = useMemo(
    () =>
      toolCalls.filter((c) => {
        const p = parseBrowserResult(c.result);
        return c.status === "error" || p?.success === false;
      }).length,
    [toolCalls],
  );

  // "Waiting" when the ACTIVE operation is a wait — explicit and stateful,
  // never a frontend timeout.
  const waiting = useMemo(
    () =>
      toolCalls.some((c) => {
        if (!isCallActive(c)) return false;
        const args = (c.args ?? {}) as Record<string, unknown>;
        return args.action === "wait";
      }),
    [toolCalls],
  );

  const statusLabel = anyActive
    ? waiting
      ? "Waiting"
      : "Running"
    : anyError
      ? "Failed"
      : "Completed";

  return (
    <div
      data-slot="browser-use-group"
      className="step-card-in w-full rounded-lg"
      role="group"
      aria-label={`Use Browser — ${statusLabel}`}
    >
      {/* The tool line — same anatomy as every other tool call: chevron ·
          glyph · name · chip · status. */}
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
        className="flex min-h-7 w-full cursor-pointer items-center gap-2 rounded-lg px-1 py-1 text-left transition-colors hover:bg-accent/40"
      >
        <ChevronRight
          className={cn(
            "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-200",
            expanded && "rotate-90",
          )}
          aria-hidden
        />
        <Globe className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 shrink-0 truncate text-sm font-medium text-foreground/90">Use Browser</span>
        {currentUrl ? (
          <span className={cn(chipClass, "hidden shrink truncate sm:inline-flex")}>
            {clip(hostnameOf(currentUrl) || currentUrl, 30)}
          </span>
        ) : null}

        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {anyActive ? (
            <>
              <span className="inline-flex items-center gap-1.5 text-xs font-medium text-foreground/80">
                <Loader2 className="h-3 w-3 animate-spin text-primary" aria-hidden />
                {statusLabel}
              </span>
              <ToolLiveElapsed startedAt={startedAt} />
            </>
          ) : (
            <>
              <ToolDurationBadge startedAt={startedAt} endedAt={endedAt} />
              <span
                className={cn(
                  "inline-flex items-center gap-1 text-xs font-medium",
                  anyError ? "text-destructive" : "text-foreground/70",
                )}
              >
                {anyError ? (
                  <X className="h-3.5 w-3.5" aria-hidden />
                ) : (
                  <Check className="h-3.5 w-3.5 text-primary" aria-hidden />
                )}
                {statusLabel}
              </span>
            </>
          )}
        </span>
      </button>

      {/* Operation list — compact mono rows, scrollable when long. */}
      <CollapsePanel open={expanded}>
        <div className="space-y-0.5 px-1.5 pt-0.5 pb-2 sm:px-2">
          <div className="max-h-96 space-y-0.5 overflow-y-auto pr-0.5 scrollbar-thin">
            {toolCalls.map((call) => (
              <BrowserOpRow key={call.id} toolCall={call} />
            ))}
          </div>

          {/* Run summary — event-driven counts only. */}
          {!anyActive ? (
            <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 px-1.5 pt-1 font-mono text-[10px] text-muted-foreground">
              <span className="tabular-nums">{toolCalls.length} operations</span>
              {failed > 0 ? (
                <span className="tabular-nums text-destructive">· {failed} failed</span>
              ) : null}
            </p>
          ) : null}
        </div>
      </CollapsePanel>
    </div>
  );
}

/* ── Fallback: the per-call card (use_browser outside a group) ───────────── */

export function BrowserResult({ toolCall }: { toolCall: ToolCall }) {
  const payload = parseBrowserResult(toolCall.result);
  if (!payload) return null;

  const ok = payload.success !== false;
  const action = payload.action ?? "";
  const label = ACTION_LABELS[action] ?? "Browser";
  const text = typeof payload.text === "string" ? payload.text : null;
  const value =
    ok && action === "evaluate" && payload.value !== undefined
      ? typeof payload.value === "string"
        ? payload.value
        : (JSON.stringify(payload.value) ?? String(payload.value))
      : null;

  return (
    <div className="space-y-2 px-1.5 py-1 sm:px-2">
      <div className="flex flex-wrap items-center gap-2">
        {/* Browser identity — the globe glyph + "Browser". */}
        <span className="inline-flex h-5 items-center gap-1 rounded-full bg-primary/10 px-2 text-[10px] font-semibold tracking-wide text-primary uppercase">
          <Globe className="h-3 w-3" aria-hidden />
          Browser
        </span>
        <span className="text-sm font-semibold text-foreground">{label}</span>
        {payload.url && (
          <span className="min-w-0 truncate font-mono text-[10px] text-muted-foreground">
            {payload.url}
          </span>
        )}
        {typeof payload.status === "number" && (
          <span className="rounded-full bg-foreground/[0.05] px-2 py-0.5 font-mono text-[10px] text-muted-foreground">
            HTTP {payload.status}
          </span>
        )}
      </div>

      {/* Error — structured, never silent. */}
      {!ok && payload.error ? (
        <p className="text-xs text-destructive">
          <span className="font-mono">{payload.error.type}</span> — {payload.error.message}
        </p>
      ) : null}

      {/* Captured download / recording → the workspace file it landed as. */}
      {ok && action === "download" && payload.file ? (
        <p className="font-mono text-[11px] text-muted-foreground">{payload.file}</p>
      ) : null}
      {ok && action === "screen_record" && payload.file ? (
        <p className="font-mono text-[11px] text-muted-foreground">
          {payload.file}
          {typeof payload.durationSec === "number" ? ` · ${payload.durationSec}s` : ""}
        </p>
      ) : null}
      {ok && action === "screenshot" && payload.path ? (
        <p className="font-mono text-[11px] text-muted-foreground">{payload.path}</p>
      ) : null}

      {/* The plain OUTPUT — page text or evaluate value. */}
      {ok && text ? (
        <pre className="max-h-56 overflow-y-auto rounded-lg border border-border bg-foreground/[0.02] p-2.5 text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground scrollbar-thin">
          {text.slice(0, 1500)}
          {text.length > 1500 ? "\n…" : ""}
        </pre>
      ) : null}
      {ok && value ? (
        <pre className="max-h-40 overflow-y-auto rounded-lg border border-border bg-foreground/[0.02] p-2.5 font-mono text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground scrollbar-thin">
          {value.slice(0, 800)}
        </pre>
      ) : null}

      {ok && payload.message && !text ? (
        <p className="text-xs text-muted-foreground">{payload.message}</p>
      ) : null}
    </div>
  );
}

"use client";

import { useMemo, useState } from "react";
import {
  Camera,
  Check,
  ChevronRight,
  CirclePlay,
  Download,
  Globe,
  Loader2,
  X,
} from "lucide-react";
import type { ToolCall } from "@/types";
import { cn } from "@/lib/utils";
import {
  chipClass,
  CollapsePanel,
  fieldBlockClass,
  monoLabelClass,
} from "@/components/assistant-ui/elements";
import { ToolDurationBadge, ToolLiveElapsed } from "../tool-duration";
import { LivePageFrame } from "./live-page-frame";

/**
 * use_browser results — the browser presented as a TOOL, not a UI.
 * (Browser-Tool Reliability PRD §1/§2/§8: no dedicated browser panel, no
 * live-viewport surface, no computer-use frame. Every browser action lands
 * as one compact, technical row inside the SAME tool-call rendering the
 * other tools use.)
 *
 *  - `BrowserUseGroup` — a run of consecutive use_browser calls as ONE
 *    collapsible tool line ("Use Browser") with a mono operation list:
 *    `→ Navigate example.com ✓ 0.8s`, `→ Snapshot 42 elements ✓ 1.2s`, …
 *    Above the list, the run's CURRENT PAGE renders as a REAL live
 *    preview — a tall sandboxed <iframe> of the page's URL, always
 *    visible without expanding anything (interactivity opt-in).
 *    Event-driven only (PRD §25): a row appears exactly when the backend
 *    emitted the call — never a faked "Browsing…" state.
 *  - `BrowserResult` — the per-call fallback for a use_browser call
 *    rendered OUTSIDE a group (lone call, other renderers).
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

/** Mono operation verb shown at the start of each row — the PRD §8 shape
 * ("Navigate", "Click", "Snapshot"…), terse and scannable. */
const OP_LABELS: Record<string, string> = {
  navigate: "Navigate",
  click: "Click",
  type: "Type",
  press: "Press",
  scroll: "Scroll",
  wait: "Wait",
  read: "Read",
  get_page: "Read",
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
      return target ? clip(target) : null;
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
    case "snapshot":
    case "inspect":
    case "get_elements":
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

/* ── One operation row ───────────────────────────────────────────────────── */

/**
 * BrowserOpRow — `→ Navigate  example.com  ✓ 0.8s`. Compact, mono,
 * event-driven (the row exists because the backend emitted the call).
 * Click toggles the technical detail block (text excerpt / element refs /
 * evaluate value / the full screenshot / the structured error).
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

  const errorText = payload?.error
    ? `${payload.error.type} — ${payload.error.message}`
    : isError &&
        toolCall.result &&
        typeof toolCall.result === "object" &&
        typeof (toolCall.result as { error?: unknown }).error === "string"
      ? (toolCall.result as { error: string }).error
      : null;

  const text = payload && typeof payload.text === "string" ? payload.text : null;
  const elements =
    payload && Array.isArray(payload.elements) && payload.elements.length > 0 ? payload.elements : null;
  const evaluateValue =
    !isError && action === "evaluate" && payload?.value !== undefined
      ? typeof payload.value === "string"
        ? payload.value
        : (JSON.stringify(payload.value) ?? String(payload.value))
      : null;

  const hasDetail = Boolean(errorText || text || elements || evaluateValue || payload?.dataUrl || payload?.forms);

  return (
    <div className="rounded-md text-xs">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex min-h-8 w-full cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-accent/40",
          isError && "bg-destructive/[0.04]",
          hasDetail ? "cursor-pointer" : "cursor-default",
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
          {isError && errorText ? (
            <span className="min-w-0 truncate font-mono text-[10px] text-destructive">{clip(errorText, 60)}</span>
          ) : null}
        </span>

        {/* Screenshot thumbnail — the artifact rides IN the row (PRD §4). */}
        {payload?.dataUrl && action === "screenshot" ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={payload.dataUrl}
            alt={payload.title ? `Screenshot of ${payload.title}` : "Browser screenshot"}
            className="h-9 w-14 shrink-0 rounded-sm border border-border object-cover object-top"
          />
        ) : null}
        {action === "screen_record" && payload?.file && !isRunning ? (
          <CirclePlay className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        ) : null}

        {/* Duration + disclosure chevron. */}
        {isRunning ? (
          <ToolLiveElapsed startedAt={toolCall.startedAt} />
        ) : (
          <ToolDurationBadge startedAt={toolCall.startedAt} endedAt={toolCall.endedAt} />
        )}
        {hasDetail ? (
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

      {/* Technical detail block — expandable, event-driven content only. */}
      {hasDetail ? (
        <CollapsePanel open={open}>
          <div className="space-y-1.5 px-6 pb-1.5 pt-0.5">
            {payload?.url && action !== "navigate" ? (
              <p className="truncate font-mono text-[10px] text-muted-foreground">{payload.url}</p>
            ) : null}
            {errorText ? (
              <p className="font-mono text-[10px] leading-relaxed break-words text-destructive">{errorText}</p>
            ) : null}
            {text ? (
              <p className="line-clamp-4 rounded-md border border-border bg-foreground/[0.02] px-2 py-1.5 text-[10px] leading-relaxed whitespace-pre-wrap text-muted-foreground">
                {text.slice(0, 600)}
                {text.length > 600 ? "…" : ""}
              </p>
            ) : null}
            {elements ? (
              <div className="max-h-40 space-y-0.5 overflow-y-auto rounded-md border border-border bg-foreground/[0.02] px-2 py-1.5 scrollbar-thin">
                {elements.slice(0, 50).map((el) => (
                  <p key={el.ref} className="flex items-baseline gap-2 font-mono text-[10px] leading-relaxed">
                    <span className="shrink-0 text-primary">{el.ref}</span>
                    <span className="shrink-0 text-foreground/70">{el.tag}</span>
                    {el.text ? <span className="min-w-0 truncate text-muted-foreground">{el.text}</span> : null}
                  </p>
                ))}
                {elements.length > 50 ? (
                  <p className="text-[10px] text-muted-foreground">+{elements.length - 50} more…</p>
                ) : null}
              </div>
            ) : null}
            {payload?.forms && payload.forms.length > 0 ? (
              <p className="font-mono text-[10px] text-muted-foreground">
                {payload.forms.length} form field{payload.forms.length === 1 ? "" : "s"} in snapshot
              </p>
            ) : null}
            {evaluateValue ? (
              <pre className="max-h-40 overflow-auto rounded-md border border-border bg-foreground/[0.02] px-2 py-1.5 font-mono text-[10px] leading-relaxed whitespace-pre-wrap text-muted-foreground">
                {evaluateValue.slice(0, 800)}
              </pre>
            ) : null}
            {payload?.dataUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={payload.dataUrl}
                alt={payload.title ? `Screenshot of ${payload.title}` : "Browser screenshot"}
                className="w-full rounded-md border border-border"
              />
            ) : null}
            {action === "screen_record" && payload?.file ? (
              <p className="inline-flex min-w-0 items-center gap-1.5 font-mono text-[10px] text-muted-foreground">
                <CirclePlay className="h-3 w-3 shrink-0" aria-hidden />
                <span className="truncate">{payload.file}</span>
                {typeof payload.durationSec === "number" ? (
                  <span className="shrink-0">· {payload.durationSec}s</span>
                ) : null}
                {typeof payload.sizeBytes === "number" ? (
                  <span className="shrink-0">· {(payload.sizeBytes / 1024 / 1024).toFixed(1)} MB</span>
                ) : null}
              </p>
            ) : null}
            {action === "download" && payload?.file ? (
              <p className="inline-flex min-w-0 items-center gap-1.5 font-mono text-[10px] text-muted-foreground">
                <Download className="h-3 w-3 shrink-0" aria-hidden />
                <span className="truncate">{payload.file}</span>
              </p>
            ) : null}
          </div>
        </CollapsePanel>
      ) : null}
    </div>
  );
}

/* ── The grouped view: ONE collapsible "Use Browser" tool line ───────────── */

/**
 * BrowserUseGroup — a run of consecutive use_browser calls rendered as ONE
 * compact tool-call line ("Use Browser" + status) with the mono operation
 * list behind the disclosure. Auto-expands while the run is active, settles
 * collapsed (PRD §8: "Collapsible after completion"); every click after
 * that is the user's own. Statuses: Running / Waiting / Completed · Ns /
 * Failed (PRD acceptance).
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

  // The current page's title — same newest-settled derivation as the URL.
  const currentTitle = useMemo(() => {
    for (let i = toolCalls.length - 1; i >= 0; i--) {
      const p = parseBrowserResult(toolCalls[i]!.result);
      if (p?.title) return p.title;
    }
    return null;
  }, [toolCalls]);

  // Run stats (PRD §26): operations, screenshots, snapshots, failures.
  const stats = useMemo(() => {
    let screenshots = 0;
    let snapshots = 0;
    let recordings = 0;
    let failed = 0;
    for (const c of toolCalls) {
      const args = (c.args ?? {}) as Record<string, unknown>;
      const action = typeof args.action === "string" ? args.action : "";
      const payload = parseBrowserResult(c.result);
      if (c.status === "error" || payload?.success === false) failed += 1;
      if (action === "screenshot") screenshots += 1;
      if (action === "snapshot") snapshots += 1;
      if (action === "screen_record" && payload?.file) recordings += 1;
    }
    return { operations: toolCalls.length, screenshots, snapshots, recordings, failed };
  }, [toolCalls]);

  // "Waiting" when the ACTIVE operation is a wait (PRD §20) — explicit and
  // stateful, never a frontend timeout.
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

      {/* LIVE PAGE PREVIEW — always visible, NEVER hidden behind the
          disclosure: the run's current page renders itself in a tall
          sandboxed <iframe> (interactivity opt-in, enlarge ⤢, reload ⟳,
          new-tab escape). The op list below stays collapsed until opened —
          but the PAGE the agent is on is the payload the user came for. */}
      {currentUrl && /^https?:\/\//i.test(currentUrl) ? (
        <div className="px-1.5 pb-1 sm:px-2">
          <LivePageFrame
            url={currentUrl}
            title={currentTitle}
            badge="Browser"
            heightClass="h-[22rem] sm:h-[28rem]"
            note={
              anyActive
                ? "run in progress — the preview follows the agent's current page"
                : undefined
            }
          />
        </div>
      ) : null}

      {/* Operation list — compact mono rows, scrollable when long. */}
      <CollapsePanel open={expanded}>
        <div className="space-y-0.5 px-1.5 pt-0.5 pb-2 sm:px-2">
          <div className="max-h-96 space-y-0.5 overflow-y-auto pr-0.5 scrollbar-thin">
            {toolCalls.map((call) => (
              <BrowserOpRow key={call.id} toolCall={call} />
            ))}
          </div>

          {/* Run summary (PRD §26) — event-driven counts only. */}
          {!anyActive ? (
            <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 px-1.5 pt-1 font-mono text-[10px] text-muted-foreground">
              <span className="tabular-nums">{stats.operations} operations</span>
              {stats.screenshots > 0 ? (
                <span className="tabular-nums">· {stats.screenshots} screenshot{stats.screenshots === 1 ? "" : "s"}</span>
              ) : null}
              {stats.snapshots > 0 ? (
                <span className="tabular-nums">· {stats.snapshots} snapshot{stats.snapshots === 1 ? "" : "s"}</span>
              ) : null}
              {stats.recordings > 0 ? (
                <span className="tabular-nums">· {stats.recordings} recording{stats.recordings === 1 ? "" : "s"}</span>
              ) : null}
              {stats.failed > 0 ? (
                <span className="tabular-nums text-destructive">· {stats.failed} failed</span>
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
  const tabs = Array.isArray(payload.tabs) ? payload.tabs : [];
  const text = typeof payload.text === "string" ? payload.text : null;
  const elements = Array.isArray(payload.elements) ? payload.elements : null;
  const frameUrl =
    ok && typeof payload.url === "string" && /^https?:\/\//i.test(payload.url) ? payload.url : null;

  return (
    <div className="space-y-2.5 px-1.5 py-1 sm:px-2">
      <div className="flex flex-wrap items-center gap-2">
        {/* Browser identity — the globe glyph + "Browser", NEVER the
            generic agent icon or a Composio logo. */}
        <span className="inline-flex h-5 items-center gap-1 rounded-full bg-primary/10 px-2 text-[10px] font-semibold tracking-wide text-primary uppercase">
          <Globe className="h-3 w-3" aria-hidden />
          Browser
        </span>
        <span className="text-sm font-semibold text-foreground">{label}</span>
        {payload.url && (
          <a
            href={payload.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-w-0 items-center gap-1 truncate font-mono text-[10px] text-muted-foreground transition-colors hover:text-foreground"
          >
            <span className="truncate">{payload.url}</span>
          </a>
        )}
        {typeof payload.status === "number" && (
          <span className="rounded-full bg-foreground/[0.05] px-2 py-0.5 font-mono text-[10px] text-muted-foreground">
            HTTP {payload.status}
          </span>
        )}
        {tabs.length > 1 && (
          <span className="rounded-full bg-foreground/[0.05] px-2 py-0.5 font-mono text-[10px] text-muted-foreground">
            {tabs.length} tabs
          </span>
        )}
      </div>

      {payload.title ? (
        <p className="truncate text-sm font-medium text-foreground/80">{payload.title}</p>
      ) : null}

      {/* THE LIVE PAGE — the real preview strategy: the page's URL in a
          tall sandboxed <iframe>, not a text excerpt. The extracted text
          and element refs stay available below (and in the op rows) as the
          honest fallback when a site refuses framing. */}
      {frameUrl ? (
        <LivePageFrame
          url={frameUrl}
          title={payload.title ?? null}
          badge="Browser"
          heightClass="h-[22rem] sm:h-[28rem]"
        />
      ) : null}

      {/* Error — structured, never silent (PRD §27). */}
      {!ok && payload.error ? (
        <p className="text-xs text-destructive">
          <span className="font-mono">{payload.error.type}</span> — {payload.error.message}
        </p>
      ) : null}

      {/* Captured download / recording → the workspace file it landed as. */}
      {ok && action === "download" && payload.file ? (
        <p className="inline-flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
          <Download className="h-3.5 w-3.5" aria-hidden />
          {payload.file}
        </p>
      ) : null}
      {ok && action === "screen_record" && payload.file ? (
        <p className="inline-flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
          <CirclePlay className="h-3.5 w-3.5" aria-hidden />
          {payload.file}
          {typeof payload.durationSec === "number" ? ` · ${payload.durationSec}s` : ""}
          {typeof payload.sizeBytes === "number"
            ? ` · ${(payload.sizeBytes / 1024 / 1024).toFixed(1)} MB`
            : ""}
        </p>
      ) : null}

      {/* Read / snapshot — the visible text excerpt. */}
      {ok && text ? (
        <p className="line-clamp-6 rounded-lg border border-border bg-foreground/[0.02] p-2.5 text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground">
          {text.slice(0, 1500)}
          {text.length > 1500 ? "\n…" : ""}
        </p>
      ) : null}

      {/* Snapshot / inspect — a compact element list (refs the AI used). */}
      {ok && elements && elements.length > 0 ? (
        <div className="max-h-56 space-y-1 overflow-y-auto rounded-lg border border-border bg-foreground/[0.02] p-2 scrollbar-thin">
          {elements.slice(0, 40).map((el) => (
            <p key={el.ref} className="flex items-baseline gap-2 font-mono text-[10px] leading-relaxed">
              <span className="shrink-0 text-primary">{el.ref}</span>
              <span className="shrink-0 text-foreground/70">{el.tag}</span>
              {el.text ? <span className="min-w-0 truncate text-muted-foreground">{el.text}</span> : null}
            </p>
          ))}
          {elements.length > 40 ? (
            <p className="text-[10px] text-muted-foreground">+{elements.length - 40} more…</p>
          ) : null}
        </div>
      ) : null}

      {/* Snapshot form-field state. */}
      {ok && Array.isArray(payload.forms) && payload.forms.length > 0 ? (
        <p className={cn(monoLabelClass, "normal-case")}>
          {payload.forms.length} form field{payload.forms.length === 1 ? "" : "s"} captured
        </p>
      ) : null}

      {/* evaluate — the returned value. */}
      {ok && action === "evaluate" && payload.value !== undefined ? (
        <pre className={cn(fieldBlockClass, "max-h-40 overflow-auto")}>
          {typeof payload.value === "string" ? payload.value : JSON.stringify(payload.value, null, 2)}
        </pre>
      ) : null}

      {/* Screenshot — the captured page, inline. */}
      {payload.dataUrl ? (
        <figure className="overflow-hidden rounded-lg border border-border">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={payload.dataUrl}
            alt={payload.title ? `Screenshot of ${payload.title}` : "Browser screenshot"}
            className="w-full"
          />
          <figcaption className="flex items-center gap-1.5 bg-foreground/[0.02] px-2.5 py-1.5 font-mono text-[10px] text-muted-foreground">
            <Camera className="h-3 w-3" aria-hidden />
            {payload.path ?? "screenshot.png"}
          </figcaption>
        </figure>
      ) : null}

      {ok && payload.message && !text && !elements && !payload.dataUrl ? (
        <p className="text-xs text-muted-foreground">{payload.message}</p>
      ) : null}
    </div>
  );
}

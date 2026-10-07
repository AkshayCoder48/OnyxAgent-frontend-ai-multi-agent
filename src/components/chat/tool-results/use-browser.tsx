"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Camera,
  Check,
  Download,
  ExternalLink,
  Globe,
  Loader2,
  Maximize2,
  Minimize2,
  MousePointer2,
} from "lucide-react";
import type { ToolCall } from "@/types";
import { cn } from "@/lib/utils";
import { friendlyStep } from "@/lib/agent-friendly-steps";
import {
  ComputerUse,
  paperCardClass,
  type ComputerStep,
} from "@/components/assistant-ui/elements";
import { ToolDurationBadge, ToolLiveElapsed } from "../tool-duration";
import { useBrowserLive, type BrowserLive } from "@/hooks/use-browser-live";

/**
 * use_browser results — the ONE browser tool's presentation (🌐 Browser
 * identity, never a Composio integration).
 *
 * TWO layers live here:
 *
 *  - `BrowserUseGroup` — the GROUPED view: a run of consecutive use_browser
 *    calls renders as ONE assistant-ui "Computer use" frame (browser chrome,
 *    the newest screenshot as the screen, a cursor trailing through the
 *    steps) plus one compact row per call. This is what the chat flow uses.
 *  - `BrowserResult` — the per-call payload card, kept as the FALLBACK for
 *    any use_browser call rendered OUTSIDE a group context (e.g. a lone call
 *    in a renderer that doesn't group). The narration sentences themselves
 *    ("Opened example.com", "Clicked “Sign in”") come from friendlyStep.
 */

/** use_browser result payload (see src/lib/e2b/browser-driver.ts). */
export interface BrowserPayload {
  kind: "browser";
  success?: boolean;
  action?: string;
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
  count?: number;
  value?: unknown;
  dataUrl?: string;
  path?: string;
  file?: string;
  name?: string;
  message?: string;
  error?: { type: string; message: string; recoverable?: boolean };
  /** Driver viewport in px (fixed 1280×800) — every state payload carries it. */
  viewport?: { width: number; height: number } | null;
  /** Interacted element's box in VIEWPORT pixels — its center becomes the
   *  computer-use cursor position inside the grouped frame. */
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

const ACTION_LABELS: Record<string, string> = {
  navigate: "Opened",
  click: "Clicked",
  type: "Typed",
  press: "Pressed",
  scroll: "Scrolled",
  wait: "Waited",
  screenshot: "Screenshot",
  get_page: "Page",
  get_elements: "Elements",
  evaluate: "Evaluated",
  select: "Selected",
  upload: "Uploaded",
  download: "Downloaded",
  new_tab: "New tab",
  switch_tab: "Switched tab",
  close_tab: "Closed tab",
  go_back: "Back",
  go_forward: "Forward",
  refresh: "Refreshed",
};

/* ── Grouped view: steps → the Computer use frame ───────────────────────── */

/** Trim a label so footer/row text never blows the layout. */
function clip(text: string, max = 32): string {
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

/** Short human label for a targeting arg — the selector string itself, or
 *  the semantic object's name/text/label/placeholder/css/xpath/ref value. */
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

/** The footer label for one action — what the action acted on. */
function browserStepTarget(args: Record<string, unknown>, action: string): string {
  const url = typeof args.url === "string" ? args.url.trim() : "";
  const target = targetLabelOf(args.target);
  switch (action) {
    case "navigate":
      return clip(hostnameOf(url) || url || "page");
    case "click":
    case "select":
    case "upload":
      return clip(target ?? "page element");
    case "type":
      return clip(target ?? "input");
    case "press":
      return clip(typeof args.key === "string" && args.key ? args.key : "key");
    case "screenshot":
      return args.fullPage === true ? "full page" : "viewport";
    case "new_tab":
    case "switch_tab":
    case "close_tab":
    case "go_back":
    case "go_forward":
    case "refresh":
      return clip(hostnameOf(url) || action);
    case "wait":
      return clip(
        (typeof args.selector === "string" && args.selector.trim()) ||
          (typeof args.text === "string" && args.text.trim()) ||
          `${typeof args.ms === "number" ? args.ms : 1000}ms`,
      );
    default:
      return clip(action);
  }
}

/**
 * One ComputerStep per use_browser call — pure and exported for reuse.
 * Positions prefer the driver-reported element box (center as a % of the
 * viewport, clamped to 2…98); actions without a box fall back to archetypes:
 * navigation starts near the address bar (50,10), scrolling sits at the
 * scroll thumb (50,84), everything else keeps the PREVIOUS step's position
 * so the cursor stays where the agent last was.
 */
export function deriveBrowserSteps(toolCalls: readonly ToolCall[]): ComputerStep[] {
  const steps: ComputerStep[] = [];
  let prevX = 50;
  let prevY = 50;
  for (const call of toolCalls) {
    const args = (call.args ?? {}) as Record<string, unknown>;
    const action =
      typeof args.action === "string" && args.action ? args.action : "browser";
    const payload = parseBrowserResult(call.result);

    let x = prevX;
    let y = prevY;
    const box = payload?.box ?? null;
    const viewport = payload?.viewport ?? null;
    if (
      box &&
      viewport &&
      viewport.width > 0 &&
      viewport.height > 0 &&
      [box.x, box.y, box.w, box.h].every((n) => Number.isFinite(n))
    ) {
      x = ((box.x + box.w / 2) / viewport.width) * 100;
      y = ((box.y + box.h / 2) / viewport.height) * 100;
      x = Math.min(98, Math.max(2, x));
      y = Math.min(98, Math.max(2, y));
    } else if (
      action === "navigate" ||
      action === "new_tab" ||
      action === "go_back" ||
      action === "go_forward" ||
      action === "refresh"
    ) {
      x = 50;
      y = 10;
    } else if (action === "scroll") {
      x = 50;
      y = 84;
    }

    steps.push({
      id: call.id,
      action,
      target: browserStepTarget(args, action),
      x: Math.round(x * 10) / 10,
      y: Math.round(y * 10) / 10,
    });
    prevX = x;
    prevY = y;
  }
  return steps;
}

/** Replay cadence for the play-once cursor animation. */
const PLAY_STEP_MS = 700;
/** Steps revealed per replay window (the tail the cursor trails through). */
const PLAY_WINDOW = 4;

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** Where a replay starts: the last PLAY_WINDOW steps (reduced motion rests
 *  straight on the newest step — nothing animates). */
function replayStart(total: number, reducedMotion: boolean): number {
  return Math.max(0, total - (reducedMotion ? 1 : PLAY_WINDOW));
}

/** A call is in-flight (pending or running). */
function isCallActive(call: ToolCall): boolean {
  return call.status === "running" || call.status === "pending";
}

/** Driver actions that read as the page MOVING (loading). */
const LOADING_ACTIONS = new Set([
  "navigate",
  "new_tab",
  "switch_tab",
  "close_tab",
  "go_back",
  "go_forward",
  "refresh",
]);

/** Driver actions that read as hands-on interaction. */
const INTERACTING_ACTIONS = new Set([
  "mouse_move",
  "click",
  "type",
  "scroll",
  "keypress",
  "select",
  "upload",
  "download",
]);

/** Live phase → the one-word status the toolbar chip shows. */
function liveStatusOf(live: BrowserLive): string {
  if (live.phase === "connecting") return "starting";
  if (live.phase === "live") {
    const a = live.state?.action ?? null;
    if (a && LOADING_ACTIONS.has(a)) return "loading";
    if (a && INTERACTING_ACTIONS.has(a)) return "interacting";
    return "waiting";
  }
  if (live.phase === "closed") return "closed";
  return "unavailable";
}

/** The pulsing LIVE dot (green) / status dot. */
function LiveDot({ tone }: { tone: "live" | "connecting" | "closed" | "error" }) {
  return (
    <span
      aria-hidden
      className={cn(
        "relative flex h-2 w-2 shrink-0",
        tone === "live" && "text-emerald-500",
        tone === "connecting" && "text-amber-500",
        tone === "closed" && "text-muted-foreground",
        tone === "error" && "text-destructive",
      )}
    >
      {(tone === "live" || tone === "connecting") && (
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-current opacity-60 motion-reduce:animate-none" />
      )}
      <span className="relative inline-flex h-2 w-2 rounded-full bg-current" />
    </span>
  );
}

/** Toolbar chrome shared by the inline surface and the expanded overlay. */
function LiveToolbar({
  live,
  runningSince,
  minimized,
  onToggleMinimize,
  onExpand,
  onExitExpand,
}: {
  live: BrowserLive;
  runningSince: number | null;
  minimized: boolean;
  onToggleMinimize: () => void;
  onExpand?: () => void;
  onExitExpand?: () => void;
}) {
  const tone =
    live.phase === "live" ? "live" : live.phase === "connecting" ? "connecting" : live.phase === "closed" ? "closed" : "error";
  const url = live.state?.url && live.state.url !== "about:blank" ? live.state.url : "about:blank";
  return (
    <div className="flex items-center gap-2 px-3 py-2">
      <span className="flex shrink-0 items-center gap-1.5" aria-hidden>
        <span className="h-2 w-2 rounded-full bg-red-400/70" />
        <span className="h-2 w-2 rounded-full bg-amber-400/70" />
        <span className="h-2 w-2 rounded-full bg-emerald-400/70" />
      </span>
      <span
        className={cn(
          "ml-1 inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border bg-foreground/[0.04] px-2 py-0.5",
          "font-mono text-[10px] font-semibold tracking-wide uppercase",
        )}
        title={live.phase === "error" ? (live.error ?? undefined) : undefined}
      >
        <LiveDot tone={tone} />
        {liveStatusOf(live)}
      </span>
      <span
        className="w-0 min-w-0 flex-1 truncate rounded-md border border-border bg-background/70 px-2 py-1 font-mono text-[11px] text-muted-foreground"
        title={live.state?.title || url}
      >
        {url}
      </span>
      {runningSince !== null ? <ToolLiveElapsed startedAt={runningSince} /> : null}
      <span className="flex shrink-0 items-center gap-0.5">
        {onExitExpand ? (
          <button
            type="button"
            onClick={onExitExpand}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
            aria-label="Exit expanded view"
          >
            <Minimize2 className="h-3.5 w-3.5" aria-hidden />
          </button>
        ) : null}
        {onExpand ? (
          <button
            type="button"
            onClick={onExpand}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
            aria-label="Expand live browser view"
          >
            <Maximize2 className="h-3.5 w-3.5" aria-hidden />
          </button>
        ) : null}
        <button
          type="button"
          onClick={onToggleMinimize}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
          aria-label={minimized ? "Restore live browser view" : "Minimize live browser view"}
          aria-pressed={minimized}
        >
          <Camera
            className={cn("h-3.5 w-3.5 transition-transform", minimized && "rotate-180")}
            aria-hidden
          />
        </button>
      </span>
    </div>
  );
}

/** The live screen: newest screencast frame + real cursor overlay + click
 * ripple. Honest placeholders while the driver boots or the stream is
 * unavailable — never a fake screenshot. */
function LiveScreen({ live }: { live: BrowserLive }) {
  const state = live.state;
  const vp = state?.viewport ?? { width: 1280, height: 800 };
  const cx = Math.min(100, Math.max(0, ((state?.cursor.x ?? vp.width / 2) / vp.width) * 100));
  const cy = Math.min(100, Math.max(0, ((state?.cursor.y ?? vp.height / 2) / vp.height) * 100));
  const clicking = state?.action === "click";

  return (
    <div className="relative aspect-[16/10] overflow-hidden border-t border-border bg-muted/40">
      {live.frameUrl ? (
        /* eslint-disable-next-line @next/next/no-img-element */
        <img
          src={live.frameUrl}
          alt={state?.title ? `Live view of ${state.title}` : "Live browser view"}
          className="size-full object-cover object-top"
        />
      ) : live.phase === "error" ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-muted/40 px-4 text-center">
          <AlertTriangle className="h-7 w-7 shrink-0 text-muted-foreground/60" aria-hidden />
          <p className="text-xs font-medium text-foreground/80">Live view unavailable</p>
          <p className="max-w-sm text-[10px] leading-relaxed text-muted-foreground">
            {live.error ?? "The live stream could not be opened."} The browser tool itself
            keeps running — results still land below.
          </p>
        </div>
      ) : (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-muted/40 px-4 text-center">
          <Loader2 className="h-6 w-6 shrink-0 animate-spin text-muted-foreground/60" aria-hidden />
          <p className="text-xs font-medium text-foreground/80">Starting the sandbox browser…</p>
          <p className="text-[10px] leading-relaxed text-muted-foreground/80">
            First launch installs the runtime (up to a few minutes); the live view
            connects the moment the browser is up.
          </p>
        </div>
      )}

      {/* Real cursor overlay — position in % of the driver viewport, CSS
          transition smooths between the ~300ms state updates. */}
      {live.phase === "live" && state ? (
        <span className="pointer-events-none absolute inset-0" aria-hidden>
          <MousePointer2
            className="absolute h-4 w-4 -translate-x-1/2 -translate-y-1/2 text-foreground drop-shadow-[0_1px_2px_rgba(0,0,0,0.65)] transition-[left,top] duration-300 ease-out motion-reduce:transition-none"
            style={{ left: `${cx}%`, top: `${cy}%` }}
          />
          {clicking ? (
            <span
              key={state.seq}
              className="absolute h-8 w-8 rounded-full border-2 border-foreground/80 bg-foreground/25 animate-live-click-ripple motion-reduce:hidden"
              style={{ left: `${cx}%`, top: `${cy}%` }}
            />
          ) : null}
        </span>
      ) : null}
    </div>
  );
}

/** LiveBrowserSurface — the REALTIME browser surface shown while the
 * session is active (and through its single close animation). Inline card
 * with optional minimized bar + expanded overlay. */
function LiveBrowserSurface({
  live,
  runningSince,
  closing,
}: {
  live: BrowserLive;
  runningSince: number | null;
  closing: boolean;
}) {
  const [minimized, setMinimized] = useState(false);
  const [expanded, setExpanded] = useState(false);

  // Escape exits the expanded overlay.
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExpanded(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded]);

  return (
    <>
      <div
        data-slot="browser-live-surface"
        role="group"
        aria-label="Live browser session"
        className={cn(
          "w-full select-none overflow-hidden rounded-xl border border-border bg-card",
          closing && "animate-browser-session-close motion-reduce:animate-none",
        )}
      >
        <LiveToolbar
          live={live}
          runningSince={runningSince}
          minimized={minimized}
          onToggleMinimize={() => setMinimized((m) => !m)}
          onExpand={() => setExpanded(true)}
        />
        {!minimized ? <LiveScreen live={live} /> : null}
      </div>

      {expanded ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm sm:p-8"
          role="dialog"
          aria-modal="true"
          aria-label="Expanded live browser view"
          /* Backdrop click dismisses; Escape (handled above) is the keyboard
             path — the dialog itself is not scrollable/interactive content. */
          // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions
          onClick={(e) => {
            if (e.target === e.currentTarget) setExpanded(false);
          }}
        >
          <div className="w-full max-w-5xl">
            <div className="overflow-hidden rounded-xl border border-border bg-card shadow-2xl">
              <LiveToolbar
                live={live}
                runningSince={runningSince}
                minimized={false}
                onToggleMinimize={() => setExpanded(false)}
                onExitExpand={() => setExpanded(false)}
              />
              <LiveScreen live={live} />
            </div>
            <p className="mt-2 text-center text-[10px] text-muted-foreground">
              Live sandbox browser · Esc or the button to exit
            </p>
          </div>
        </div>
      ) : null}
    </>
  );
}

/**
 * BrowserUseGroup — ONE run of consecutive use_browser calls as a single
 * paper card. While the run is ACTIVE this renders the REALTIME live
 * browser surface (real viewport frames + real cursor, PRD §2–§4); when
 * the session ENDS it plays the close animation EXACTLY ONCE (dedup via
 * the active-session ref) and settles into the recorded Computer use
 * frame with one compact row per call beneath it.
 */
export function BrowserUseGroup({ toolCalls }: { toolCalls: ToolCall[] }) {
  const steps = useMemo(() => deriveBrowserSteps(toolCalls), [toolCalls]);

  // ── session lifecycle (PRD §14: ONE close animation per SESSION) ────
  // The stream runs from the FIRST active call until the close animation
  // finishes — it stays ON through the grace period so consecutive
  // use_browser calls (which can momentarily all-settle between actions)
  // never tear down the live view mid-session.
  const anyActive = toolCalls.some(isCallActive);
  const sessionId = toolCalls[0]?.id ?? "browser-session";
  const activeSessionRef = useRef<string | null>(null);
  const [streamOn, setStreamOn] = useState(false);
  const [closing, setClosing] = useState(false);
  const reducedMotion = useMemo(() => prefersReducedMotion(), []);

  // Render-time adjustment (the repo's converging-setState pattern): the
  // stream switches ON the moment any call activates, and a late
  // continuation retracts any in-flight close animation.
  if (anyActive) {
    if (!streamOn) setStreamOn(true);
    if (closing) setClosing(false);
  }

  useEffect(() => {
    if (anyActive) {
      activeSessionRef.current = sessionId;
      return;
    }
    if (activeSessionRef.current === null) return;
    let closeTimer: number | null = null;
    // GRACE: consecutive calls of the SAME run land a beat apart (all
    // settled in between). Only declare the session over — and play the
    // close animation ONCE — after the quiet period passes. Reactivation
    // inside the window cancels it entirely.
    const graceTimer = window.setTimeout(() => {
      activeSessionRef.current = null;
      if (reducedMotion) {
        setStreamOn(false);
        return;
      }
      setClosing(true);
      closeTimer = window.setTimeout(() => {
        setClosing(false);
        setStreamOn(false);
      }, 680);
    }, 1500);
    return () => {
      window.clearTimeout(graceTimer);
      if (closeTimer !== null) window.clearTimeout(closeTimer);
    };
  }, [anyActive, sessionId, reducedMotion]);

  // The live stream stays enabled through the close animation so the last
  // frame stays on screen while it folds away.
  const live = useBrowserLive({ enabled: streamOn });
  const showLive = streamOn;

  // Earliest running call's start → the toolbar's live elapsed badge.
  const runningSince = useMemo(() => {
    let t: number | null = null;
    for (const c of toolCalls) {
      if (isCallActive(c) && typeof c.startedAt === "number") {
        if (t === null || c.startedAt < t) t = c.startedAt;
      }
    }
    return t;
  }, [toolCalls]);

  // PLAY-ONCE ANIMATION (settled view): on mount (and whenever the run
  // grows) the cursor replays the last few steps, ~700ms apart, then rests
  // on the newest one.
  const [playHead, setPlayHead] = useState(() => ({
    total: steps.length,
    index: replayStart(steps.length, reducedMotion),
  }));
  // Render-time reset when the run grows (the "adjust state when a prop
  // changes" pattern — no effect, no cascading renders; same as the
  // ToolCallCard auto-expand).
  if (playHead.total !== steps.length) {
    setPlayHead({
      total: steps.length,
      index: replayStart(steps.length, reducedMotion),
    });
  }
  const playIndex = Math.min(playHead.index, Math.max(0, steps.length - 1));

  // Advance the play head until it rests on the last step. The effect re-runs
  // per advance (cheap), so the interval self-terminates at the end.
  useEffect(() => {
    const last = steps.length - 1;
    if (last <= 0 || reducedMotion || playIndex >= last) return;
    const id = window.setInterval(() => {
      setPlayHead((h) => ({ ...h, index: Math.min(h.index + 1, last) }));
    }, PLAY_STEP_MS);
    return () => window.clearInterval(id);
  }, [playIndex, steps.length, reducedMotion]);

  // The address field: the most recent settled payload's url, else the
  // newest navigate action's url, else the honest blank page. (Memo shapes
  // kept React-Compiler-friendly: only deep reads + an external helper —
  // no method calls on nested values inside the memo.)
  const url = useMemo(() => {
    for (let i = toolCalls.length - 1; i >= 0; i--) {
      const p = parseBrowserResult(toolCalls[i]!.result);
      if (p?.url) return p.url;
    }
    for (let i = toolCalls.length - 1; i >= 0; i--) {
      const args = (toolCalls[i]!.args ?? {}) as Record<string, unknown>;
      if (args.action === "navigate" && typeof args.url === "string" && args.url) {
        return args.url;
      }
    }
    return "about:blank";
  }, [toolCalls]);

  // The screen: the NEWEST screenshot payload among the calls' results.
  const shot = useMemo(() => {
    for (let i = toolCalls.length - 1; i >= 0; i--) {
      const p = parseBrowserResult(toolCalls[i]!.result);
      if (p?.dataUrl) return p;
    }
    return null;
  }, [toolCalls]);
  const shotAlt = shot?.title ? `Screenshot of ${shot.title}` : "Browser screenshot";

  return (
    <div
      data-slot="browser-use-group"
      className={cn(paperCardClass, "w-full space-y-3 p-3 sm:p-4")}
    >
      {showLive ? (
        <LiveBrowserSurface live={live} runningSince={runningSince} closing={closing} />
      ) : (
        <ComputerUse url={url} steps={steps} activeIndex={playIndex}>
          {shot?.dataUrl ? (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img src={shot.dataUrl} alt={shotAlt} className="size-full object-cover object-top" />
          ) : (
            /* Honest placeholder — no screenshot has landed yet, never a fake one. */
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-muted/40 px-4 text-center">
              <Globe className="h-8 w-8 shrink-0 text-muted-foreground/50" aria-hidden />
              <p className="max-w-full truncate font-mono text-[11px] text-muted-foreground">
                {url}
              </p>
              <p className="text-[10px] text-muted-foreground/70">
                Browser session — no screenshot captured
              </p>
            </div>
          )}
        </ComputerUse>
      )}

      {/* Per-call rows — parity with the old per-call cards. */}
      <div className="divide-y divide-border">
        {toolCalls.map((call) => (
          <BrowserCallRow key={call.id} toolCall={call} />
        ))}
      </div>
    </div>
  );
}

/** One compact row: status glyph + friendly narration + duration, then the
 *  payload bits that exist (error / download path / page text / element
 *  refs / evaluate value). Screenshots never repeat here — the frame owns
 *  the newest one. */
function BrowserCallRow({ toolCall }: { toolCall: ToolCall }) {
  const step = friendlyStep(toolCall);
  const isRunning = isCallActive(toolCall);
  const isError = toolCall.status === "error";
  const args = (toolCall.args ?? {}) as Record<string, unknown>;
  const action = typeof args.action === "string" ? args.action : "";
  const payload = parseBrowserResult(toolCall.result);
  const ok = !payload || payload.success !== false;

  // Error text — the structured driver error, or the plain client-side one.
  const errorText = payload?.error
    ? `${payload.error.type} — ${payload.error.message}`
    : isError &&
        toolCall.result &&
        typeof toolCall.result === "object" &&
        typeof (toolCall.result as { error?: unknown }).error === "string"
      ? (toolCall.result as { error: string }).error
      : null;

  const text = payload && typeof payload.text === "string" ? payload.text : null;
  const elements = payload && Array.isArray(payload.elements) ? payload.elements : null;
  const elementCount =
    typeof payload?.count === "number" ? payload.count : elements ? elements.length : 0;
  const evaluateValue =
    ok && action === "evaluate" && payload?.value !== undefined
      ? typeof payload.value === "string"
        ? payload.value
        : (JSON.stringify(payload.value) ?? String(payload.value))
      : null;

  // Navigation-family extras (parity with the old card): page title, HTTP
  // status, tab count — only where they exist, only where they mean something.
  const showsPageMeta =
    ok &&
    (action === "navigate" ||
      action === "new_tab" ||
      action === "switch_tab" ||
      action === "close_tab" ||
      action === "go_back" ||
      action === "go_forward" ||
      action === "refresh");
  const statusChip =
    showsPageMeta && payload && typeof payload.status === "number"
      ? `HTTP ${payload.status}`
      : null;
  const tabsChip =
    showsPageMeta && payload && typeof payload.tabCount === "number" && payload.tabCount > 1
      ? `${payload.tabCount} tabs`
      : null;

  return (
    <div className="flex min-h-11 items-start gap-2 py-1.5 text-xs">
      {/* Status glyph */}
      <span className="mt-0.5 shrink-0" aria-hidden>
        {isRunning ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
        ) : isError ? (
          <AlertTriangle className="h-3.5 w-3.5 text-destructive" />
        ) : (
          <Check className="h-3.5 w-3.5 text-primary/70" />
        )}
      </span>
      <div className="min-w-0 flex-1 space-y-1">
        {/* Narration — past tense when settled, present while running. */}
        <p className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 leading-relaxed">
          <span className="text-foreground/80">
            {isRunning ? step.present : step.past}
            {step.detail ? (
              <span className="text-muted-foreground"> {step.detail}</span>
            ) : null}
          </span>
          {isRunning ? (
            <ToolLiveElapsed startedAt={toolCall.startedAt} />
          ) : (
            <ToolDurationBadge startedAt={toolCall.startedAt} endedAt={toolCall.endedAt} />
          )}
        </p>

        {errorText ? (
          <p className="font-mono text-[10px] leading-relaxed break-words text-destructive">
            {errorText}
          </p>
        ) : null}

        {ok && action === "download" && payload?.file ? (
          <p className="inline-flex min-w-0 items-center gap-1.5 font-mono text-[10px] text-muted-foreground">
            <Download className="h-3 w-3 shrink-0" aria-hidden />
            <span className="truncate">{payload.file}</span>
          </p>
        ) : null}

        {showsPageMeta && payload?.title ? (
          <p className="truncate text-[10px] text-muted-foreground">{payload.title}</p>
        ) : null}

        {statusChip || tabsChip ? (
          <p className="flex flex-wrap gap-1 font-mono text-[10px] text-muted-foreground">
            {statusChip ? (
              <span className="rounded-full border-border bg-foreground/[0.05] px-1.5 py-px">
                {statusChip}
              </span>
            ) : null}
            {tabsChip ? (
              <span className="rounded-full border-border bg-foreground/[0.05] px-1.5 py-px">
                {tabsChip}
              </span>
            ) : null}
          </p>
        ) : null}

        {ok && text ? (
          <p className="line-clamp-3 rounded-md border-border bg-foreground/[0.02] border px-2 py-1.5 text-[10px] leading-relaxed text-muted-foreground whitespace-pre-wrap">
            {text.slice(0, 280)}
            {text.length > 280 ? "…" : ""}
          </p>
        ) : null}

        {ok && elements && elements.length > 0 ? (
          <p className="flex flex-wrap items-center gap-1 font-mono text-[10px] text-muted-foreground">
            <span className="tabular-nums">{elementCount} interactive elements</span>
            {elements.slice(0, 5).map((el) => (
              <span
                key={el.ref}
                className="rounded border-border bg-muted px-1 py-px text-primary"
              >
                {el.ref}
              </span>
            ))}
          </p>
        ) : null}

        {evaluateValue ? (
          <p className="line-clamp-3 rounded-md border-border bg-foreground/[0.02] border px-2 py-1.5 font-mono text-[10px] leading-relaxed text-muted-foreground break-all whitespace-pre-wrap">
            {evaluateValue}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/* ── Fallback: the per-call card (use_browser outside a group) ───────────── */

export function BrowserResult({ toolCall }: { toolCall: ToolCall }) {
  const payload = useMemo(() => parseBrowserResult(toolCall.result), [toolCall]);
  if (!payload) return null;

  const ok = payload.success !== false;
  const action = payload.action ?? "";
  const label = ACTION_LABELS[action] ?? "Browser";
  const tabs = Array.isArray(payload.tabs) ? payload.tabs : [];
  const text = typeof payload.text === "string" ? payload.text : null;
  const elements = Array.isArray(payload.elements) ? payload.elements : null;

  return (
    <div className="space-y-2.5 px-1.5 py-1 sm:px-2">
      <div className="flex flex-wrap items-center gap-2">
        {/* Browser identity — the globe glyph + "Browser", NEVER the
            generic agent icon or a Composio logo. */}
        <span className="bg-primary/10 text-primary inline-flex h-5 items-center gap-1 rounded-full px-2 text-[10px] font-semibold tracking-wide uppercase">
          <Globe className="h-3 w-3" aria-hidden />
          Browser
        </span>
        <span className="text-foreground text-sm font-semibold">{label}</span>
        {payload.url && (
          <a
            href={payload.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-muted-foreground hover:text-foreground inline-flex min-w-0 items-center gap-1 truncate font-mono text-[10px] transition-colors"
          >
            <span className="truncate">{payload.url}</span>
            <ExternalLink className="h-3 w-3 shrink-0" aria-hidden />
          </a>
        )}
        {typeof payload.status === "number" && (
          <span className="bg-foreground/[0.05] text-muted-foreground rounded-full px-2 py-0.5 font-mono text-[10px]">
            HTTP {payload.status}
          </span>
        )}
        {tabs.length > 1 && (
          <span className="bg-foreground/[0.05] text-muted-foreground rounded-full px-2 py-0.5 font-mono text-[10px]">
            {tabs.length} tabs
          </span>
        )}
      </div>

      {payload.title ? (
        <p className="text-foreground/80 truncate text-sm font-medium">{payload.title}</p>
      ) : null}

      {/* Error — structured, never silent (PRD §27). */}
      {!ok && payload.error ? (
        <p className="text-destructive text-xs">
          <span className="font-mono">{payload.error.type}</span> — {payload.error.message}
        </p>
      ) : null}

      {/* Captured download → the workspace file it landed as. */}
      {ok && action === "download" && payload.file ? (
        <p className="text-muted-foreground inline-flex items-center gap-1.5 font-mono text-[11px]">
          <Download className="h-3.5 w-3.5" aria-hidden />
          {payload.file}
        </p>
      ) : null}

      {/* get_page — the visible text excerpt. */}
      {ok && text ? (
        <p className="text-muted-foreground line-clamp-6 rounded-lg border-border bg-foreground/[0.02] border p-2.5 text-xs leading-relaxed whitespace-pre-wrap">
          {text.slice(0, 1500)}
          {text.length > 1500 ? "\n…" : ""}
        </p>
      ) : null}

      {/* get_elements — a compact element list (refs the AI used). */}
      {ok && elements && elements.length > 0 ? (
        <div className="max-h-56 space-y-1 overflow-y-auto rounded-lg border-border bg-foreground/[0.02] border p-2">
          {elements.slice(0, 40).map((el) => (
            <p key={el.ref} className="flex items-baseline gap-2 font-mono text-[10px] leading-relaxed">
              <span className="text-primary shrink-0">{el.ref}</span>
              <span className="text-foreground/70 shrink-0">{el.tag}</span>
              {el.text ? <span className="text-muted-foreground min-w-0 truncate">{el.text}</span> : null}
            </p>
          ))}
          {elements.length > 40 ? (
            <p className="text-muted-foreground text-[10px]">+{elements.length - 40} more…</p>
          ) : null}
        </div>
      ) : null}

      {/* evaluate — the returned value. */}
      {ok && action === "evaluate" && payload.value !== undefined ? (
        <pre className="text-muted-foreground max-h-40 overflow-auto rounded-lg border-border bg-foreground/[0.02] border p-2.5 font-mono text-[11px] whitespace-pre-wrap">
          {typeof payload.value === "string" ? payload.value : JSON.stringify(payload.value, null, 2)}
        </pre>
      ) : null}

      {/* Screenshot — the captured page, inline. */}
      {payload.dataUrl ? (
        <figure className="overflow-hidden rounded-lg border-border border">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={payload.dataUrl}
            alt={payload.title ? `Screenshot of ${payload.title}` : "Browser screenshot"}
            className="w-full"
          />
          <figcaption className="text-muted-foreground flex items-center gap-1.5 bg-foreground/[0.02] px-2.5 py-1.5 font-mono text-[10px]">
            <Camera className="h-3 w-3" aria-hidden />
            {payload.path ?? "screenshot.png"}
          </figcaption>
        </figure>
      ) : null}

      {ok && payload.message && !text && !elements && !payload.dataUrl ? (
        <p className={cn("text-muted-foreground text-xs")}>{payload.message}</p>
      ) : null}
    </div>
  );
}

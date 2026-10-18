"use client";

import * as React from "react";
import type { CSSProperties } from "react";
import { Orb } from "./orb";
import {
  getActivePersonality,
  resolveOrb,
  type OrbPersonality,
  type OrbReactionState,
} from "@/lib/orb/personalities";
import {
  useOrbOverrideState,
  useOrbPersonalityStore,
} from "@/stores/orb-personality-store";
import {
  executionHub,
  useExecutionChatValue,
  useExecutionFor,
  useRunningExecutions,
  useHubStore,
} from "@/lib/agent/execution-hub";
import { useConversationStore } from "@/stores/conversation-store";
import type { ChatMessage } from "@/types";
import styles from "./PersonalityOrb.module.css";

/* ─────────────────────────────────────────────────────────────────────────
 * PersonalityOrb — the personality-aware status orb (PRD §10).
 *
 * Maps the app's REAL activity signals onto the nine reaction states, then
 * resolves the active personality (`resolveOrb`) into concrete `<Orb>` props.
 * Signal sources, in priority order:
 *
 *   1. The transient OVERRIDE state (see the contract block in
 *      `stores/orb-personality-store.ts` — Task 2-d sets "awaiting_approval"
 *      there; nothing else outranks it).
 *   2. The live execution (per-execution chat store via execution-hub — the
 *      same source the chat UI renders): isProcessing + the message phase,
 *      projected from the SAME signals `use-agent-activity.ts` derives
 *      (tool-call status, isStreaming, visible text, newest-message role):
 *        tool call running/pending      → tool_running
 *        assistant streaming w/ text    → thinking (the writing phase)
 *        assistant streaming, no text   → thinking
 *        no assistant message in flight → submitted (just sent)
 *   3. The settle pulse (≈2.4s window after a turn ends — mirrors
 *      useAgentActivity's): execution status "stopped" → cancelled,
 *      "failed" → error, else the generation summary stamped on the newest
 *      assistant message → success / error / cancelled.
 *   4. User typing (document-level input listener, debounced 1.2s — the
 *      composer has no exported typing signal, so this reacts to real
 *      keystrokes in any text field while no run is active).
 *   5. idle.
 *
 * The orb is always a COMPLEMENT, never the only status indicator (PRD
 * §10.4): every surface that renders it keeps its text/labels, and the orb
 * itself is decorative (aria-hidden) so screen readers only read the real
 * status text next to it.
 * ───────────────────────────────────────────────────────────────────────── */

/** ── Signal projection (pure) ──────────────────────────────────────────── */

type LivePhase = "idle" | "submitted" | "thinking" | "writing" | "tool";

/**
 * Project the live message phase — mirrors `deriveActivity` in
 * use-agent-activity.ts (tool status first, then streaming text presence,
 * walking from the NEWEST message) but returns a STABLE STRING so zustand's
 * identity check re-renders the orb only when the phase actually changes,
 * not on every streaming flush.
 */
function projectLivePhase(
  isProcessing: boolean,
  messages: readonly ChatMessage[],
): LivePhase {
  if (!isProcessing) return "idle";
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.role !== "assistant") continue;
    let anyToolActive = false;
    for (const c of m.toolCalls ?? []) {
      if (c.status !== "running" && c.status !== "pending") continue;
      anyToolActive = true;
      if (c.name === "use_browser") return "tool";
    }
    if (anyToolActive) return "tool";
    if (m.isStreaming) {
      const hasText =
        Boolean(m.content) ||
        (m.parts ?? []).some((p) => p.type === "text" && p.content);
      return hasText ? "writing" : "thinking";
    }
    break; // newest assistant message exists but hasn't started streaming
  }
  // No assistant message in flight — the newest message is the user's own:
  // the request was just submitted.
  return "submitted";
}

/** Read-once settle outcome at the moment a turn ends (pure). */
function settleOutcome(
  execStatus: string | null,
  messages: readonly ChatMessage[],
): OrbReactionState | null {
  // The execution record's own status is the authoritative outcome.
  if (execStatus === "stopped") return "cancelled";
  if (execStatus === "failed") return "error";
  if (execStatus === "completed") return "success";
  // Status not settled yet — read the generation summary the event processor
  // stamps on the newest assistant message (mirrors useAgentActivity's
  // lastTurnErrored walk). NEVER inferred from model phrasing (PRD §10.3).
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m) continue;
    if (m.role === "assistant") {
      if (m.generation) {
        if (m.generation.stopped) return "cancelled";
        if (m.generation.failed) return "error";
        if (m.generation.completedAt) return "success";
      }
      for (const c of m.toolCalls ?? []) {
        if (c.status === "error") return "error";
      }
      // A run we observed ending, with no error stamped on it: completed.
      return "success";
    }
    if (m.role === "user") return null;
  }
  return null;
}

/** ── Hooks ─────────────────────────────────────────────────────────────── */

/** Live `prefers-reduced-motion` (kept current across OS setting changes). */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = React.useState(false);
  React.useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  return reduced;
}

/**
 * True for ~1.2s after the last keystroke in a text field (textarea, text
 * input, contenteditable) — the composer exposes no typing signal, so this
 * listens at the document level. Only active when `active` (no run in
 * flight, no override), so typing-to-queue during a run doesn't fight the
 * working states.
 */
function useUserTypingSignal(active: boolean): boolean {
  const [typing, setTyping] = React.useState(false);
  React.useEffect(() => {
    if (!active) {
      setTyping(false);
      return;
    }
    let timer: number | null = null;
    const onInput = (e: Event) => {
      const t = e.target as HTMLElement | null;
      if (!t) return;
      const tag = t.tagName;
      const isTextField =
        tag === "TEXTAREA" ||
        t.isContentEditable ||
        (tag === "INPUT" &&
          !["checkbox", "radio", "button", "submit", "range", "file", "color"].includes(
            (t as HTMLInputElement).type,
          ));
      if (!isTextField) return;
      setTyping(true);
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => setTyping(false), 1200);
    };
    document.addEventListener("input", onInput, true);
    return () => {
      document.removeEventListener("input", onInput, true);
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [active]);
  return typing;
}

/**
 * Derive the CURRENT reaction state from real application signals (see the
 * file header for the priority order). Re-renders only when the derived
 * state actually changes (all subscriptions return stable primitives).
 */
export function useOrbReactionState(): OrbReactionState {
  // The execution the VIEWED conversation is running (or, on a brand-new
  // chat with no conversation id yet, the most recent running execution —
  // the same convExec ?? activeExec fallback use-chat performs).
  const conversationId = useConversationStore((s) => s.currentConversationId);
  const running = useRunningExecutions();
  const convExec = useExecutionFor(conversationId);
  const exec =
    convExec ??
    (conversationId === null && running.length > 0
      ? running.reduce((a, b) => (a.startedAt >= b.startedAt ? a : b))
      : null);
  const execId = exec?.id ?? null;

  // Both execution hooks must run unconditionally (hooks rules) — the
  // "running" gate is applied to the RESULT, not the call.
  const execProcessing = useExecutionChatValue<boolean>(
    execId,
    (s) => s.isProcessing,
    false,
  );
  const isProcessing = exec?.status === "running" && execProcessing;
  const livePhase = useExecutionChatValue<LivePhase>(
    execId,
    (s) => projectLivePhase(s.isProcessing, s.messages),
    "idle",
  );
  const override = useOrbOverrideState();

  // SETTLE PULSE (success / error / cancelled) — the same beat useAgentActivity
  // plays: a short reaction right after the turn ends, then back to ambient.
  const [pulse, setPulse] = React.useState<OrbReactionState | null>(null);
  const sawActiveRef = React.useRef(false);
  const activeExecIdRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (isProcessing) {
      sawActiveRef.current = true;
      activeExecIdRef.current = execId;
      return;
    }
    if (!sawActiveRef.current) return;
    sawActiveRef.current = false;
    // Read ONCE at settle time — the execution that just ended may already
    // have dropped out of the reactive fallbacks, so resolve it by the id
    // captured while it was live.
    const settledId = execId ?? activeExecIdRef.current;
    const settledMessages = settledId
      ? executionHub.getStore(settledId)?.getState().messages
      : null;
    const status = settledId
      ? useHubStore.getState().byExecution[settledId]?.status ?? null
      : null;
    const outcome = settleOutcome(
      status,
      settledMessages ?? [],
    );
    if (!outcome) return;
    // setState lives inside the timers — never synchronously in the effect
    // body (repo lint rule).
    const t1 = window.setTimeout(() => setPulse(outcome), 300);
    const t2 = window.setTimeout(() => setPulse(null), 2700);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
    // Settle reads are one-shot (resolved from the captured execution id, not
    // from reactive state), so re-running the timers per message change would
    // only restart the pulse mid-flight — the same rationale as
    // useAgentActivity's settle beat.
  }, [isProcessing, execId]);

  const typing = useUserTypingSignal(!isProcessing && override === null);

  if (override) return override;
  if (isProcessing) {
    switch (livePhase) {
      case "tool":
        return "tool_running";
      case "submitted":
        return "submitted";
      // "writing" (answer text actively streaming) and "thinking" both mean
      // the MODEL is at work — the 9 reaction states have one bucket for it,
      // and the adjacent status caption ("Writing…") carries the nuance.
      case "thinking":
      case "writing":
      default:
        return "thinking";
    }
  }
  if (pulse) return pulse;
  if (typing) return "user_typing";
  return "idle";
}

/** Whether the personality orb is currently visible in chat surfaces. */
export function useOrbChatVisible(): boolean {
  return useOrbPersonalityStore(
    (s) => getActivePersonality(s.personalityId, s.custom).showInChat,
  );
}

/** ── Component ─────────────────────────────────────────────────────────── */

export interface PersonalityOrbProps {
  /**
   * Explicit reaction state — overrides live signal derivation (used by the
   * settings panel's live preview). Omit to derive from real signals.
   */
  state?: OrbReactionState;
  /** Rendered edge length in px (passed to `<Orb>`). */
  size?: number;
  /**
   * "chat" (default) respects the personality's showInChat flag; "preview"
   * always renders (settings previews must show even a chat-hidden orb).
   */
  surface?: "chat" | "preview";
  className?: string;
  style?: CSSProperties;
}

/** One-shot reaction overlay state (see the celebration/error logic below). */
interface Reaction {
  kind: "success" | "error";
  key: number;
}

/**
 * `<PersonalityOrb />` — the app's status orb, driven by the user's chosen
 * personality. Decorative by design (aria-hidden): the status TEXT beside it
 * is always the accessible source of truth (PRD §10.4 — the orb never is the
 * only indicator).
 */
export function PersonalityOrb({
  state,
  size = 20,
  surface = "chat",
  className,
  style,
}: PersonalityOrbProps) {
  // Mount gate: the personality is persisted (localStorage), so the first
  // client render may differ from the SSR frame — render nothing until
  // mounted to avoid a hydration mismatch (the orb pops in right after).
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);

  const personality: OrbPersonality = useOrbPersonalityStore((s) =>
    getActivePersonality(s.personalityId, s.custom),
  );
  const derived = useOrbReactionState();
  const reactionState = state ?? derived;
  const reducedMotion = usePrefersReducedMotion();

  // ── One-shot reaction overlay (success celebration / restrained error) ──
  // Fires on the TRANSITION into "success"/"error" (never mid-state), plays
  // once (≤900ms, CSS keyframes in PersonalityOrb.module.css), then settles.
  // Fully skipped when: reduced motion; very low intensity; success also
  // needs celebrationEnabled + a moderate intensity. Error reactions stay
  // SUBTLE for every personality (PRD §10.3) — they are never skipped for
  // being "too serious", only by the global gates.
  const [reaction, setReaction] = React.useState<Reaction | null>(null);
  const prevStateRef = React.useRef<OrbReactionState>("idle");
  React.useEffect(() => {
    const prev = prevStateRef.current;
    prevStateRef.current = reactionState;
    if (reactionState === prev) return;
    if (reactionState !== "success" && reactionState !== "error") return;
    if (reducedMotion) return;
    if (personality.reactionIntensity < 0.2) return;
    if (
      reactionState === "success" &&
      (!personality.celebrationEnabled || personality.reactionIntensity < 0.35)
    ) {
      return;
    }
    const key = Date.now();
    setReaction({ kind: reactionState, key });
    // Safety net: if the animationend event never fires (e.g. a hidden
    // tab suspends animations), clear the overlay shortly after its natural
    // end so it can never linger.
    const t = window.setTimeout(() => {
      setReaction((r) => (r && r.key === key ? null : r));
    }, 1200);
    return () => window.clearTimeout(t);
  }, [reactionState, reducedMotion, personality]);

  if (!mounted) return null;
  if (surface === "chat" && !personality.showInChat) return null;

  const resolved = resolveOrb(personality, reactionState, reducedMotion);
  // Under reduced motion the lattice is static — EXCEPT the slow working
  // pulse `resolveOrb` may keep. That exception needs the global
  // .orb-essential hook: Orb.module.css's reduced-motion exception rule is
  // keyed on it (the rule must live in the Orb module, where the cell class
  // and the orbCell keyframes name share their CSS-module hashes).
  const essential = reducedMotion && resolved.animate;

  const orb = (
    <Orb
      variant={resolved.variant}
      size={size}
      animate={resolved.animate}
      durationScale={resolved.durationScale}
      className={essential ? "orb-essential" : undefined}
    />
  );

  return (
    <span
      data-slot="personality-orb"
      aria-hidden="true"
      className={styles.wrap + (className ? " " + className : "")}
      style={style}
    >
      {reaction ? (
        <span
          key={reaction.key}
          className={reaction.kind === "success" ? styles.celebrate : styles.errorShake}
          onAnimationEnd={() =>
            setReaction((r) => (r && r.key === reaction.key ? null : r))
          }
        >
          {orb}
        </span>
      ) : (
        orb
      )}
    </span>
  );
}

/**
 * Onyx Context Manager (Onyx Infinite Context PRD §3–§14) — the single
 * architecture that decides what the model actually sees each turn.
 *
 *   Persistent history (Dexie)        ← NEVER deleted by compaction
 *        ↓
 *   manageContext(...)                ← THIS module, before the request
 *        ↓ budget → thresholds → tiered compaction → tool-pair safety
 *   Active model context              ← only what this turn needs
 *
 * TIERED COMPACTION (cheapest first, PRD §11):
 *   L1 cheap cleanup    — drop empty/whitespace-only history messages.
 *   L2 long-message trim — ancient messages larger than LONG_MESSAGE_CHARS
 *                          become head+tail excerpts with a marker.
 *   L3 sliding window   — drop OLDEST messages beyond the input budget,
 *                          always preserving: the FIRST user message (the
 *                          original task), and the most recent exchanges.
 *   L4 extractive digest — when L3 dropped anything, a tiny deterministic
 *                          summary of the dropped turns (user intents +
 *                          assistant conclusions) rides along as one system
 *                          note. NO extra AI call — deterministic and free
 *                          (critical for rate-limited providers; an AI
 *                          summarizer can be layered in later).
 *   L5 emergency        — when even the recent window can't fit: keep system
 *                          + digest + last user/assistant pair + input.
 *
 * TOOL-PAIR SAFETY (PRD §22): the request builder (buildPriorMessages /
 * buildHistory) already strips tool roles and tool_calls from history —
 * history reaching this manager is user/assistant text only, so compaction
 * can never split a tool_call from its tool_result.
 *
 * VERCEL/STATELESS (PRD §26): no server memory — everything this manager
 * needs arrives as arguments and the result is consumed immediately.
 */

import { estimateTokens, estimateToolTokens } from "./token-counter";
import { resolveModelContext } from "./model-context";

// ---------------------------------------------------------------------------
// Types.
// ---------------------------------------------------------------------------

export interface ContextMessage {
  role: "user" | "assistant" | "system";
  content: string;
  /** Optional passthrough (e.g. DeepSeek-style reasoning replay) — the
   *  manager never reads it, but spreads it through so provider-specific
   *  fields survive compaction. */
  reasoning?: string | null;
}

export type ContextStatus = "healthy" | "monitor" | "prepare" | "compact" | "emergency";

export interface ContextUsage {
  /** Estimated tokens of every section that goes into the request. */
  systemTokens: number;
  toolsTokens: number;
  historyTokens: number;
  inputTokens: number;
  /** contextWindow - reservedOutput - safetyMargin. */
  inputBudget: number;
  contextWindow: number;
  reservedOutput: number;
  /** (system+tools+history+input) / inputBudget, 0..1+. */
  usagePercentage: number;
  status: ContextStatus;
  modelSource: "override" | "known-model" | "safe-fallback";
  modelLabel: string;
}

export interface CompactionMeta {
  applied: boolean;
  level: "none" | "cleanup" | "trim" | "window" | "emergency";
  removedMessages: number;
  trimmedMessages: number;
  /** How many turns the extractive digest covers. */
  digestedMessages: number;
}

export interface ManagedContext {
  /** The messages the provider request should carry (system FIRST). */
  messages: ContextMessage[];
  usage: ContextUsage;
  compaction: CompactionMeta;
}

export interface ManageContextInput {
  systemPrompt: string;
  /** Tool definitions (name/description/parameters). */
  tools: Array<{ name?: string; description?: string; parameters?: unknown }>;
  /** FULL persistent history (user/assistant messages, oldest first). */
  history: ContextMessage[];
  /** The model id — drives the context window resolution. */
  model: string;
  /** The CURRENT turn's user input (already the last history entry — pass
   *  null to count it separately). */
  currentInput?: string | null;
}

// ---------------------------------------------------------------------------
// Tunables.
// ---------------------------------------------------------------------------

/** Fraction of the input budget kept free as a safety margin. */
const SAFETY_MARGIN_RATIO = 0.06;
/** Thresholds (of input budget) — PRD §10. */
const MONITOR_THRESHOLD = 0.7;
const PREPARE_THRESHOLD = 0.8;
const COMPACT_THRESHOLD = 0.9;
const EMERGENCY_THRESHOLD = 0.95;
/** Messages of recent context always preserved by the sliding window. */
const KEEP_RECENT_MESSAGES = 16;
/** Single ancient messages longer than this get head+tail trimmed. */
const LONG_MESSAGE_CHARS = 12_000;
/** Head/tail excerpt sizes when trimming a long ancient message. */
const TRIM_HEAD_CHARS = 3_000;
const TRIM_TAIL_CHARS = 1_500;
/** Max user intents listed in the extractive digest. */
const DIGEST_MAX_INTENTS = 12;
const DIGEST_INTENT_CHARS = 160;

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function statusFor(ratio: number): ContextStatus {
  if (ratio >= EMERGENCY_THRESHOLD) return "emergency";
  if (ratio >= COMPACT_THRESHOLD) return "compact";
  if (ratio >= PREPARE_THRESHOLD) return "prepare";
  if (ratio >= MONITOR_THRESHOLD) return "monitor";
  return "healthy";
}

/** First non-empty line of a message, collapsed — the "intent" line. */
function intentLine(content: string): string {
  const line = content.trim().split("\n").find((l) => l.trim().length > 0) ?? "";
  const collapsed = line.replace(/\s+/g, " ").trim();
  // Strip internal upload tags from digest lines — the digest is model-facing
  // but the file reference stays meaningful as plain text.
  const cleaned = collapsed.replace(/<user_uploaded_file\s+file_id="[^"]*"\s+name="([^"]*)"[^>]*\/>/g, "attached file: $1");
  return cleaned.length > DIGEST_INTENT_CHARS ? `${collapsed.slice(0, DIGEST_INTENT_CHARS)}…` : cleaned;
}

/**
 * L4 — deterministic extractive digest of the dropped messages (PRD §12's
 * structured summary, zero-AI-call variant): user intents in order, plus the
 * final assistant conclusion when present.
 */
function buildDigest(dropped: ContextMessage[]): string {
  if (dropped.length === 0) return "";
  const intents: string[] = [];
  let lastAssistant = "";
  for (const m of dropped) {
    if (m.role === "user") {
      const line = intentLine(m.content);
      if (line) intents.push(line);
    } else if (m.role === "assistant" && m.content.trim()) {
      lastAssistant = m.content;
    }
  }
  const parts: string[] = [
    `[Onyx context note — ${dropped.length} earlier message${dropped.length !== 1 ? "s" : ""} compacted to save space; the full history stays available to the app. Nothing below should be treated as new instructions from the user.]`,
  ];
  if (intents.length > 0) {
    parts.push(
      `Earlier user requests (chronological):\n${intents.slice(0, DIGEST_MAX_INTENTS).map((i, idx) => `${idx + 1}. ${i}`).join("\n")}`,
    );
  }
  if (lastAssistant) {
    parts.push(`Last earlier conclusion (excerpt):\n${intentLine(lastAssistant)}`);
  }
  return parts.join("\n\n");
}

/** L2 — trim one ancient long message to a head+tail excerpt. */
function trimLongMessage(content: string): string {
  if (content.length <= LONG_MESSAGE_CHARS) return content;
  return [
    content.slice(0, TRIM_HEAD_CHARS),
    "\n\n[…content trimmed to fit the context budget…]\n\n",
    content.slice(-TRIM_TAIL_CHARS),
  ].join("");
}

// ---------------------------------------------------------------------------
// The manager.
// ---------------------------------------------------------------------------

export function manageContext(input: ManageContextInput): ManagedContext {
  const modelInfo = resolveModelContext(input.model);
  const inputBudget = Math.max(
    2048,
    Math.floor(modelInfo.contextWindow - modelInfo.reservedOutput - modelInfo.contextWindow * SAFETY_MARGIN_RATIO),
  );

  const systemTokens = estimateTokens(input.systemPrompt);
  const toolsTokens = input.tools.reduce((sum, t) => sum + estimateToolTokens(t), 0);
  const currentInputTokens = input.currentInput ? estimateTokens(input.currentInput) : 0;

  // ── L1 cheap cleanup: drop empty messages (never the current input). ────
  let history = input.history.filter((m) => m.content && m.content.trim().length > 0);
  const removedMessages = input.history.length - history.length;
  const cleanupApplied = removedMessages > 0;

  const historyTokensRaw = history.reduce((sum, m) => sum + estimateTokens(m.content), 0);

  // ── Budget check (before compaction). ───────────────────────────────────
  const fixedTokens = systemTokens + toolsTokens + currentInputTokens;
  const ratioWith = (historyTokens: number) =>
    (fixedTokens + historyTokens) / inputBudget;

  let compaction: CompactionMeta = {
    applied: false,
    level: "none",
    removedMessages,
    trimmedMessages: 0,
    digestedMessages: 0,
  };

  // ── Nothing to do — healthy budget, pass everything through. ────────────
  if (ratioWith(historyTokensRaw) < COMPACT_THRESHOLD) {
    const ratio = ratioWith(historyTokensRaw);
    return {
      messages: [
        ...(input.systemPrompt ? [{ role: "system" as const, content: input.systemPrompt }] : []),
        ...history,
      ],
      usage: {
        systemTokens,
        toolsTokens,
        historyTokens: historyTokensRaw,
        inputTokens: currentInputTokens,
        inputBudget,
        contextWindow: modelInfo.contextWindow,
        reservedOutput: modelInfo.reservedOutput,
        usagePercentage: Math.min(ratio, 1.5),
        status: statusFor(ratio),
        modelSource: modelInfo.source,
        modelLabel: modelInfo.label,
      },
      compaction: cleanupApplied ? { ...compaction, applied: true, level: "cleanup" } : compaction,
    };
  }

  // ── L2 trim ancient long messages, oldest first. ────────────────────────
  let trimmedMessages = 0;
  {
    const tokens = () => history.reduce((sum, m) => sum + estimateTokens(m.content), 0);
    let guard = 0;
    while (ratioWith(tokens()) >= COMPACT_THRESHOLD && guard < history.length && guard < 200) {
      // Find the LARGEST ancient message (outside the KEEP_RECENT tail) that
      // is still over the trim threshold — trimming it frees the most.
      const ancientEnd = Math.max(0, history.length - KEEP_RECENT_MESSAGES);
      let target = -1;
      let targetLen = 0;
      for (let i = 0; i < ancientEnd; i++) {
        if (history[i]!.content.length > LONG_MESSAGE_CHARS && history[i]!.content.length > targetLen) {
          target = i;
          targetLen = history[i]!.content.length;
        }
      }
      if (target === -1) break;
      history = history.map((m, i) => (i === target ? { ...m, content: trimLongMessage(m.content) } : m));
      trimmedMessages++;
      guard++;
    }
  }
  if (trimmedMessages > 0) {
    compaction = { ...compaction, applied: true, level: "trim", trimmedMessages };
  }

  // ── L3 sliding window (with first-user-message + recent preservation). ──
  const dropped: ContextMessage[] = [];
  if (ratioWith(history.reduce((sum, m) => sum + estimateTokens(m.content), 0)) >= COMPACT_THRESHOLD) {
    const historyTokens = () => history.reduce((sum, m) => sum + estimateTokens(m.content), 0);
    // First user message = the original task (PRD §46). Keep it unless the
    // emergency tier says otherwise.
    const firstUserIdx = history.findIndex((m) => m.role === "user");
    const keepIdx = new Set<number>();
    for (let i = Math.max(0, history.length - KEEP_RECENT_MESSAGES); i < history.length; i++) {
      keepIdx.add(i);
    }
    if (firstUserIdx >= 0) keepIdx.add(firstUserIdx);

    // Drop from the OLDEST end (skipping kept indices) until we fit.
    let i = 0;
    let guard = 0;
    while (ratioWith(historyTokens()) >= COMPACT_THRESHOLD && guard < 2000) {
      // Advance past kept indices.
      while (i < history.length && keepIdx.has(i)) i++;
      if (i >= history.length) break;
      dropped.push(history[i]!);
      history = history.filter((_, idx) => idx !== i);
      // keepIdx indices shifted by -1 for everything after i.
      const shifted = new Set<number>();
      for (const k of keepIdx) shifted.add(k > i ? k - 1 : k);
      keepIdx.clear();
      for (const k of shifted) keepIdx.add(k);
      guard++;
    }
    if (dropped.length > 0) {
      compaction = {
        ...compaction,
        applied: true,
        level: compaction.level === "none" ? "window" : compaction.level,
        removedMessages: compaction.removedMessages + dropped.length,
        digestedMessages: dropped.length,
      };
    }
  }

  // ── L5 emergency: still over budget — keep the bare minimum. ────────────
  const tokensNow = history.reduce((sum, m) => sum + estimateTokens(m.content), 0);
  if (ratioWith(tokensNow) >= EMERGENCY_THRESHOLD) {
    const emergency: ContextMessage[] = [];
    // System prompt survives (it is the operating manual).
    const firstUser = history.find((m) => m.role === "user");
    const lastUser = [...history].reverse().find((m) => m.role === "user");
    const lastAssistant = [...history].reverse().find((m) => m.role === "assistant");
    if (input.systemPrompt) {
      emergency.push({ role: "system", content: input.systemPrompt });
    }
    if (firstUser && firstUser !== lastUser) {
      emergency.push({ role: "user", content: `[original request] ${trimLongMessage(firstUser.content)}` });
    }
    if (lastAssistant) {
      emergency.push({ role: "assistant", content: trimLongMessage(lastAssistant.content), reasoning: lastAssistant.reasoning });
    }
    if (lastUser) {
      emergency.push({ role: "user", content: lastUser.content });
    }
    const before = history.length;
    history = emergency;
    compaction = {
      ...compaction,
      applied: true,
      level: "emergency",
      removedMessages: compaction.removedMessages + Math.max(0, before - history.length),
    };
  }

  // ── L4 digest of everything the window dropped. ─────────────────────────
  const digest = buildDigest(dropped);
  const finalHistoryTokens = history.reduce((sum, m) => sum + estimateTokens(m.content), 0)
    + (digest ? estimateTokens(digest) : 0);
  const finalRatio = (fixedTokens + finalHistoryTokens) / inputBudget;

  const messages: ContextMessage[] = [];
  if (input.systemPrompt) messages.push({ role: "system", content: input.systemPrompt });
  if (digest) messages.push({ role: "system", content: digest });
  messages.push(...history);

  return {
    messages,
    usage: {
      systemTokens,
      toolsTokens,
      historyTokens: finalHistoryTokens,
      inputTokens: currentInputTokens,
      inputBudget,
      contextWindow: modelInfo.contextWindow,
      reservedOutput: modelInfo.reservedOutput,
      usagePercentage: Math.min(finalRatio, 1.5),
      status: statusFor(finalRatio),
      modelSource: modelInfo.source,
      modelLabel: modelInfo.label,
    },
    compaction,
  };
}

export { resolveModelContext };

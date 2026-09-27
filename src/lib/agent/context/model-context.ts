/**
 * Model context-window resolver (Onyx Infinite Context PRD §8/§35).
 *
 * Determines the context window + output budget for the selected model:
 *   1. an explicit per-model override (Settings/debug),
 *   2. known-model pattern matching over the model id,
 *   3. a SAFE FALLBACK (32k) for unknown OpenAI-compatible models — never
 *      assume infinite capacity.
 *
 * The resolver is provider-agnostic: the Context Manager prepares context to
 * fit the resolved window regardless of which OpenAI-compatible gateway is
 * on the other side (PRD §34).
 */

export interface ModelContextInfo {
  /** Total context window (input + output tokens). */
  contextWindow: number;
  /** Reserved output budget (max output tokens we plan for). */
  reservedOutput: number;
  /** Where the numbers came from — surfaced in the debug UI. */
  source: "override" | "known-model" | "safe-fallback";
  /** Human-readable label, e.g. "128K". */
  label: string;
}

interface KnownModel {
  patterns: RegExp[];
  contextWindow: number;
  reservedOutput: number;
}

/** Token budget reserved for the model's response. */
const DEFAULT_OUTPUT_RESERVE = 16_384;
const SMALL_OUTPUT_RESERVE = 8_192;

/** Known model families (checked top-down; first match wins). */
const KNOWN_MODELS: KnownModel[] = [
  // ── 1M+ windows ─────────────────────────────────────────────────────────
  {
    patterns: [/gemini[-. ]?(1\.5|2\.[05])[-. ]?pro/i, /gemma[-. ]?3[-. ]?(27b|1b|4b|12b)/i],
    contextWindow: 1_000_000,
    reservedOutput: DEFAULT_OUTPUT_RESERVE,
  },
  // ── 400K ────────────────────────────────────────────────────────────────
  {
    patterns: [/llama[-. ]?4/i, /command[-. ]?a/i],
    contextWindow: 400_000,
    reservedOutput: DEFAULT_OUTPUT_RESERVE,
  },
  // ── 256K ────────────────────────────────────────────────────────────────
  {
    patterns: [/gpt[-. ]?5/i, /gpt[-. ]?4\.1/i, /o[34][-—]/i, /\bo3\b/i, /\bo4\b/i],
    contextWindow: 256_000,
    reservedOutput: DEFAULT_OUTPUT_RESERVE,
  },
  // ── 200K ────────────────────────────────────────────────────────────────
  {
    patterns: [/claude/i, /anthropic/i, /qwen([-. ]?(2\.5|3))?[-. ]?(max|72b|235b)/i, /command[-. ]?r/i, /mistral([-_. ]?large|-medium)/i],
    contextWindow: 200_000,
    reservedOutput: DEFAULT_OUTPUT_RESERVE,
  },
  // ── 128K ────────────────────────────────────────────────────────────────
  {
    patterns: [
      /gpt[-. ]?4o/i, /gpt[-. ]?4[-. ]?turbo/i, /\bgpt[-. ]?4\b/i,
      /deepseek/i, /glm[-. ]?4/i, /grok([-].*)?$/i, /kimi/i, /yinqwen/i,
      /qwen/i, /mistral/i, /mixtral/i, /hermes/i, /llama([-.]?3.*)?$/i,
    ],
    contextWindow: 128_000,
    reservedOutput: DEFAULT_OUTPUT_RESERVE,
  },
  // ── 64K ─────────────────────────────────────────────────────────────────
  {
    patterns: [/gpt[-. ]?3\.5/i, /\bllama[-. ]?2\b/i],
    contextWindow: 64_000,
    reservedOutput: SMALL_OUTPUT_RESERVE,
  },
];

/** Per-model overrides (model id → context window). Survives reloads. */
const OVERRIDE_KEY = "onyx:context-window-overrides";
const OVERRIDES_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 365; // 1y

type OverrideMap = Record<string, { window: number; at: number }>;

function readOverrides(): OverrideMap {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(OVERRIDE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as OverrideMap;
    // Drop stale entries.
    const now = Date.now();
    const out: OverrideMap = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (v && typeof v.window === "number" && now - v.at < OVERRIDES_MAX_AGE_MS) {
        out[k] = v;
      }
    }
    return out;
  } catch {
    return {};
  }
}

/** Set a context-window override for one exact model id (0 removes it). */
export function setModelContextOverride(modelId: string, contextWindow: number): void {
  if (typeof window === "undefined") return;
  const map = readOverrides();
  if (contextWindow > 0) {
    map[modelId] = { window: contextWindow, at: Date.now() };
  } else {
    delete map[modelId];
  }
  try {
    window.localStorage.setItem(OVERRIDE_KEY, JSON.stringify(map));
  } catch {
    /* storage unavailable — overrides are best-effort */
  }
}

/** List the current overrides (debug UI). */
export function getModelContextOverrides(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(readOverrides())) out[k] = v.window;
  return out;
}

function humanLabel(windowTokens: number): string {
  if (windowTokens >= 1_000_000) return `${(windowTokens / 1_000_000).toFixed(windowTokens % 1_000_000 === 0 ? 0 : 1)}M`;
  return `${Math.round(windowTokens / 1000)}K`;
}

/**
 * Resolve the context window for a model id. Unknown models get a SAFE
 * fallback of 32K (never assume unlimited).
 */
export function resolveModelContext(modelId: string | null | undefined): ModelContextInfo {
  const id = (modelId ?? "").trim();
  if (id) {
    const override = readOverrides()[id];
    if (override) {
      return {
        contextWindow: override.window,
        reservedOutput: Math.min(DEFAULT_OUTPUT_RESERVE, Math.floor(override.window * 0.15)),
        source: "override",
        label: humanLabel(override.window),
      };
    }
    for (const known of KNOWN_MODELS) {
      if (known.patterns.some((p) => p.test(id))) {
        return {
          contextWindow: known.contextWindow,
          reservedOutput: known.reservedOutput,
          source: "known-model",
          label: humanLabel(known.contextWindow),
        };
      }
    }
  }
  return {
    contextWindow: 32_000,
    reservedOutput: SMALL_OUTPUT_RESERVE,
    source: "safe-fallback",
    label: "32K",
  };
}

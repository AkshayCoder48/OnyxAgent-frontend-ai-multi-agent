/**
 * OnyxAI — OnyxAgent's optional default local-inference provider.
 *
 * OnyxAI is powered by QVAC (Tether's local-first AI runtime,
 * https://docs.qvac.tether.io). The user runs `qvac serve --openai` on their
 * own device — phone, laptop, desktop, or a beefy server — and OnyxAgent
 * talks to it like any other OpenAI-compatible provider at
 * `http://localhost:11434/v1`.
 *
 * This module holds:
 *   1. The curated model catalog (real QVAC SDK constants from
 *      tetherto/qvac's model registry), grouped by device tier with
 *      tool-calling capability flags — because OnyxAgent is agent-first and
 *      NON-TOOL-CALLING MODELS WON'T WORK WELL as the agent brain.
 *   2. Helpers to generate the user's `qvac.config.json` serve.models block
 *      (including entries that load ANY Hugging Face GGUF via explicit src).
 *   3. `isLocalBaseUrl()` — local providers must be called DIRECTLY from the
 *      browser (the server-side chat proxy cannot reach the user's machine).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type OnyxAiDeviceTier = "mobile" | "laptop" | "desktop" | "server";

/**
 * Tool-calling capability of a catalog model.
 *
 * - "native"   — the model family is trained for function/tool calling
 *                (Qwen3*, GPT-OSS Harmony, Llama-Tool-Calling, DeepSeek V4).
 * - "template" — llama.cpp's jinja tool template exists (`tools: true`) but
 *                the family has no dedicated tool post-training — unreliable.
 * - "none"     — chat-only tune; no tool calling at all.
 */
export type OnyxAiToolCalling = "native" | "template" | "none";

/**
 * How well the model works as the OnyxAgent agent backend (empirical guidance
 * from QVAC's own docs: reliable local tool use generally needs ≥14B params
 * and coder/agent post-training; Q4 4B–8B instruct tunes can chat but won't
 * reliably invoke tools).
 */
export type OnyxAiAgentReadiness =
  | "recommended" // QVAC's documented local-agent default
  | "solid" // large tool-trained models — dependable agent brains
  | "limited" // chats fine; tool invocation unreliable at this size/quant
  | "poor"; // non-tool-calling — NOT suitable as the agent brain

export interface OnyxAiModel {
  /** QVAC SDK model constant — the `model` value in serve.models entries. */
  constant: string;
  /** serve.models alias — the `model` string OnyxAgent sends in requests. */
  alias: string;
  /** Human label shown in the UI. */
  label: string;
  /** Model family (for grouping/badges). */
  family: string;
  /** Parameter count, e.g. "9B", "35B-A3B". */
  params: string;
  /** Quantization, e.g. "Q4_K_M". */
  quant: string;
  /** Approximate download size in GB (from the QVAC registry). */
  sizeGb: number;
  deviceTier: OnyxAiDeviceTier;
  toolCalling: OnyxAiToolCalling;
  agentReadiness: OnyxAiAgentReadiness;
  /** Latest model generation (Qwen3.5 / Qwen3.6 / Qwen3.8 / GPT-OSS / Gemma4 / DeepSeek V4). */
  latest?: boolean;
  /** The QVAC docs' recommended local agent default. */
  recommended?: boolean;
  /** Extra UI note (shown as a hint under the model). */
  note?: string;
}

// ---------------------------------------------------------------------------
// Provider constants
// ---------------------------------------------------------------------------

/** Display name of the built-in provider row. */
export const ONYXAI_PROVIDER_NAME = "OnyxAI";
/** Default QVAC serve endpoint (qvac serve --openai binds 127.0.0.1:11434). */
export const ONYXAI_DEFAULT_BASE_URL = "http://localhost:11434/v1";
/** Default QVAC serve port. */
export const ONYXAI_DEFAULT_PORT = 11434;

/**
 * Models seeded into the OnyxAI provider row by default — all tool-calling,
 * covering every device tier (mobile → server). The user can add/remove any.
 */
export const ONYXAI_DEFAULT_MODELS: string[] = [
  "qwen3.5-9b",
  "qwen3.5-4b",
  "qwen3.5-2b",
  "qwen3.6-27b",
  "qwen3.6-35b-a3b",
  "gpt-oss-20b",
];

// ---------------------------------------------------------------------------
// Curated catalog — real constants from the QVAC SDK model registry
// (github.com/tetherto/qvac → packages/inference/src/models/registry/models.ts)
// ---------------------------------------------------------------------------

const TIER_ORDER: OnyxAiDeviceTier[] = ["mobile", "laptop", "desktop", "server"];

export const ONYXAI_CATALOG: OnyxAiModel[] = [
  // ── 📱 MOBILE — phones & tiny devices (≤ ~4B) ────────────────────────────
  {
    constant: "QWEN3_5_4B_MULTIMODAL_Q4_K_M",
    alias: "qwen3.5-4b",
    label: "Qwen3.5 4B",
    family: "Qwen3.5",
    params: "4B",
    quant: "Q4_K_M",
    sizeGb: 2.74,
    deviceTier: "mobile",
    toolCalling: "native",
    agentReadiness: "limited",
    latest: true,
    note: "QVAC docs: “smaller machines and lighter prompts”. Latest generation with native tool calling — good mobile pick, but 4B quants can miss tool calls.",
  },
  {
    constant: "QWEN3_5_2B_MULTIMODAL_Q4_K_M",
    alias: "qwen3.5-2b",
    label: "Qwen3.5 2B",
    family: "Qwen3.5",
    params: "2B",
    quant: "Q4_K_M",
    sizeGb: 1.28,
    deviceTier: "mobile",
    toolCalling: "native",
    agentReadiness: "limited",
    latest: true,
    note: "Latest generation tool-calling model that fits any modern phone.",
  },
  {
    constant: "QWEN3_4B_INST_Q4_K_M",
    alias: "qwen3-4b",
    label: "Qwen3 4B Instruct",
    family: "Qwen3",
    params: "4B",
    quant: "Q4_K_M",
    sizeGb: 2.5,
    deviceTier: "mobile",
    toolCalling: "native",
    agentReadiness: "limited",
    note: "QVAC docs (empirical): Q4 4B instruct tunes chat well but won't reliably invoke tools — fine for chat, weak as the agent brain.",
  },
  {
    constant: "LLAMA_TOOL_CALLING_1B_INST_Q4_K",
    alias: "llama-tc-1b",
    label: "Llama 3.2 1B Tool Calling",
    family: "Llama 3.2",
    params: "1B",
    quant: "Q4_K",
    sizeGb: 0.81,
    deviceTier: "mobile",
    toolCalling: "native",
    agentReadiness: "limited",
    note: "Purpose-built tool-calling fine-tune of Llama 3.2 1B — tiny, but 1B tool reliability is best-effort.",
  },
  {
    constant: "QWEN3_1_7B_INST_Q4",
    alias: "qwen3-1.7b",
    label: "Qwen3 1.7B",
    family: "Qwen3",
    params: "1.7B",
    quant: "Q4",
    sizeGb: 1.06,
    deviceTier: "mobile",
    toolCalling: "native",
    agentReadiness: "limited",
  },
  {
    constant: "QWEN3_5_0_8B_MULTIMODAL_Q4_K_M",
    alias: "qwen3.5-0.8b",
    label: "Qwen3.5 0.8B",
    family: "Qwen3.5",
    params: "0.8B",
    quant: "Q4_K_M",
    sizeGb: 0.53,
    deviceTier: "mobile",
    toolCalling: "native",
    agentReadiness: "poor",
    latest: true,
    note: "QVAC docs: connectivity checks only — not recommended for agent work.",
  },
  {
    constant: "QWEN3_600M_INST_Q4",
    alias: "qwen3-600m",
    label: "Qwen3 600M",
    family: "Qwen3",
    params: "600M",
    quant: "Q4",
    sizeGb: 0.38,
    deviceTier: "mobile",
    toolCalling: "native",
    agentReadiness: "poor",
    note: "Smoke tests only.",
  },
  {
    constant: "GEMMA4_4B_MULTIMODAL_Q4_K_M",
    alias: "gemma4-4b",
    label: "Gemma4 4B",
    family: "Gemma4",
    params: "4B",
    quant: "Q4_K_M",
    sizeGb: 5.41,
    deviceTier: "mobile",
    toolCalling: "template",
    agentReadiness: "poor",
    latest: true,
    note: "No dedicated tool post-training — chat only. Won't work well as the OnyxAgent brain.",
  },
  {
    constant: "GEMMA4_2B_MULTIMODAL_Q4_K_M",
    alias: "gemma4-2b",
    label: "Gemma4 2B",
    family: "Gemma4",
    params: "2B",
    quant: "Q4_K_M",
    sizeGb: 3.46,
    deviceTier: "mobile",
    toolCalling: "template",
    agentReadiness: "poor",
    latest: true,
    note: "No dedicated tool post-training — chat only. Won't work well as the OnyxAgent brain.",
  },
  {
    constant: "SMOLLM2_360M_INST_Q8",
    alias: "smollm2-360m",
    label: "SmolLM2 360M",
    family: "SmolLM2",
    params: "360M",
    quant: "Q8",
    sizeGb: 0.39,
    deviceTier: "mobile",
    toolCalling: "none",
    agentReadiness: "poor",
    note: "Tiny chat-only model — no tool calling.",
  },

  // ── 💻 LAPTOP (≈ 5–9B dense) ─────────────────────────────────────────────
  {
    constant: "QWEN3_5_9B_MULTIMODAL_Q4_K_M",
    alias: "qwen3.5-9b",
    label: "Qwen3.5 9B",
    family: "Qwen3.5",
    params: "9B",
    quant: "Q4_K_M",
    sizeGb: 5.68,
    deviceTier: "laptop",
    toolCalling: "native",
    agentReadiness: "recommended",
    latest: true,
    recommended: true,
    note: "QVAC's documented recommended local agent default — the best balance for laptop agents.",
  },
  {
    constant: "QWEN3_8B_INST_Q4_K_M",
    alias: "qwen3-8b",
    label: "Qwen3 8B Instruct",
    family: "Qwen3",
    params: "8B",
    quant: "Q4_K_M",
    sizeGb: 5.03,
    deviceTier: "laptop",
    toolCalling: "native",
    agentReadiness: "limited",
    note: "QVAC docs (empirical): Q4 8B instruct tunes chat well but won't reliably invoke tools — use a bigger agent-tuned model for real agent work.",
  },

  // ── 🖥️ DESKTOP (≈ 14–35B) ────────────────────────────────────────────────
  {
    constant: "GPT_OSS_20B_INST_Q4_K_M",
    alias: "gpt-oss-20b",
    label: "GPT-OSS 20B",
    family: "GPT-OSS",
    params: "20B",
    quant: "Q4_K_M",
    sizeGb: 11.62,
    deviceTier: "desktop",
    toolCalling: "native",
    agentReadiness: "recommended",
    latest: true,
    recommended: true,
    note: "Harmony tool-call support — QVAC docs: reliable local tool use generally needs ≥14B + agent post-training; this is the documented example.",
  },
  {
    constant: "QWEN3_6_27B_MULTIMODAL_Q4_K_XL",
    alias: "qwen3.6-27b",
    label: "Qwen3.6 27B",
    family: "Qwen3.6",
    params: "27B",
    quant: "Q4_K_XL",
    sizeGb: 17.61,
    deviceTier: "desktop",
    toolCalling: "native",
    agentReadiness: "solid",
    latest: true,
    note: "Latest-generation larger Qwen — stronger local agent.",
  },
  {
    constant: "QWEN3_6_35B_A3B_MULTIMODAL_Q4_K_M",
    alias: "qwen3.6-35b-a3b",
    label: "Qwen3.6 35B-A3B (MoE)",
    family: "Qwen3.6",
    params: "35B-A3B",
    quant: "Q4_K_M",
    sizeGb: 22.13,
    deviceTier: "desktop",
    toolCalling: "native",
    agentReadiness: "solid",
    latest: true,
    note: "Mixture-of-Experts — 35B quality with ~3B active speed; needs more RAM.",
  },
  {
    constant: "GEMMA4_31B_MULTIMODAL_Q4_K_M",
    alias: "gemma4-31b",
    label: "Gemma4 31B",
    family: "Gemma4",
    params: "31B",
    quant: "Q4_K_M",
    sizeGb: 19.6,
    deviceTier: "desktop",
    toolCalling: "template",
    agentReadiness: "poor",
    latest: true,
    note: "QVAC docs list it for larger machines, but it has no dedicated tool post-training — chat only. Won't work well as the agent brain.",
  },

  // ── 🗄️ SERVER / WORKSTATION (70B+) ──────────────────────────────────────
  {
    constant: "GPT_OSS_120B_INST_Q4_K_M_SHARD",
    alias: "gpt-oss-120b",
    label: "GPT-OSS 120B",
    family: "GPT-OSS",
    params: "120B",
    quant: "Q4_K_M",
    sizeGb: 62.77,
    deviceTier: "server",
    toolCalling: "native",
    agentReadiness: "solid",
    latest: true,
    note: "Sharded download — workstation/server class.",
  },
  {
    constant: "QWEN3_8_FLASH_NEXT_177B_MULTIMODAL_UD_Q2_K_XL_SHARD",
    alias: "qwen3.8-flash-177b",
    label: "Qwen3.8 Flash Next 177B (MoE)",
    family: "Qwen3.8",
    params: "177B",
    quant: "UD-Q2_K_XL",
    sizeGb: 78.87,
    deviceTier: "server",
    toolCalling: "native",
    agentReadiness: "solid",
    latest: true,
    note: "Very latest flash MoE — frontier-class local agent.",
  },
  {
    constant: "DEEPSEEK_V4_304B_INST_UD_IQ2_M_SHARD",
    alias: "deepseek-v4-304b",
    label: "DeepSeek V4 304B (MoE)",
    family: "DeepSeek V4",
    params: "304B",
    quant: "UD-IQ2_M",
    sizeGb: 90.93,
    deviceTier: "server",
    toolCalling: "native",
    agentReadiness: "solid",
    latest: true,
    note: "The biggest tool-calling brain in the catalog — server only.",
  },
];

// ---------------------------------------------------------------------------
// Catalog helpers
// ---------------------------------------------------------------------------

/** Find a catalog model by its serve alias (e.g. "qwen3.5-9b"). */
export function catalogByAlias(alias: string): OnyxAiModel | undefined {
  return ONYXAI_CATALOG.find((m) => m.alias === alias);
}

/** Find a catalog model by its SDK constant name. */
export function catalogByConstant(constant: string): OnyxAiModel | undefined {
  return ONYXAI_CATALOG.find((m) => m.constant === constant);
}

/** Catalog grouped by device tier, tool-calling models first in each tier. */
export function catalogByTier(): { tier: OnyxAiDeviceTier; models: OnyxAiModel[] }[] {
  return TIER_ORDER.map((tier) => {
    const models = ONYXAI_CATALOG.filter((m) => m.deviceTier === tier);
    // Sort: tool-calling first, then latest first, then smaller first.
    const toolRank = (t: OnyxAiToolCalling) => (t === "native" ? 0 : t === "template" ? 1 : 2);
    models.sort((a, b) => {
      const d = toolRank(a.toolCalling) - toolRank(b.toolCalling);
      if (d !== 0) return d;
      if (a.latest !== b.latest) return a.latest ? -1 : 1;
      return a.sizeGb - b.sizeGb;
    });
    return { tier, models };
  });
}

export const ONYXAI_TIER_META: Record<
  OnyxAiDeviceTier,
  { label: string; description: string }
> = {
  mobile: {
    label: "Mobile",
    description: "Phones & tiny devices (≤ ~4B) — runs QVAC on Android/iOS-class hardware",
  },
  laptop: {
    label: "Laptop",
    description: "Laptops & mini-PCs (≈ 5–9B) — the recommended local agent tier",
  },
  desktop: {
    label: "Desktop",
    description: "Desktops with a GPU / 16GB+ RAM (≈ 14–35B)",
  },
  server: {
    label: "Server",
    description: "Workstations & servers (70B+) — frontier-class local agents",
  },
};

// ---------------------------------------------------------------------------
// Local-URL detection — local providers bypass the server-side chat proxy
// ---------------------------------------------------------------------------

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]", "::1"]);

/**
 * True when the URL points at the user's own machine — the request must be
 * sent DIRECTLY from the browser (the chat proxy runs server-side and cannot
 * reach the user's localhost).
 */
export function isLocalBaseUrl(baseUrl: string): boolean {
  try {
    const u = new URL(baseUrl);
    if (LOCAL_HOSTNAMES.has(u.hostname)) return true;
    // qvac serve --host also allows .localhost subdomains.
    if (u.hostname.endsWith(".localhost")) return true;
    return false;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// qvac.config.json generation
// ---------------------------------------------------------------------------

/** ctx_size per model size — agents need ≥16k (QVAC docs), tiny models cap lower. */
function ctxSizeFor(model: OnyxAiModel): number {
  const params = parseFloat(model.params) || 0;
  if (params <= 2) return 8192;
  if (params <= 9) return 16384;
  return 32768;
}

/**
 * Build the `serve.models` block for the given catalog aliases (JSON string,
 * pretty-printed, ready to paste into qvac.config.json).
 *
 * Every entry gets `tools: true` (QVAC's tool-call formatting — required for
 * agent use) and an explicit `ctx_size` (the QVAC default of 1024 tokens is
 * unusable for agents).
 */
export function buildServeModelsBlock(aliases: string[]): string {
  const entries: Record<string, unknown> = {};
  for (const alias of aliases) {
    const model = catalogByAlias(alias);
    if (!model) continue;
    entries[alias] = {
      model: model.constant,
      preload: true,
      config: {
        ctx_size: ctxSizeFor(model),
        tools: true,
      },
    };
  }
  return JSON.stringify({ serve: { models: entries } }, null, 2);
}

/**
 * Build a serve.models entry for a CUSTOM Hugging Face model (any GGUF the
 * QVAC registry doesn't ship). Uses the explicit `{ src, type }` ModelEntry
 * form so the user can load literally any HF model file.
 */
export function buildCustomHfServeEntry(
  alias: string,
  hfSrc: string,
): string {
  return JSON.stringify(
    {
      [alias]: {
        src: hfSrc,
        type: "llm",
        preload: false,
        config: {
          ctx_size: 16384,
          tools: true,
        },
      },
    },
    null,
    2,
  );
}

/** Normalize an HF input into a direct-download GGUF URL if possible. */
export function hfSrcForInput(input: string): string {
  const trimmed = input.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed; // already a URL
  // "org/repo" → resolve-style URL (user can adjust the filename).
  if (/^[\w.-]+\/[\w.-]+$/.test(trimmed)) {
    return `https://huggingface.co/${trimmed}/resolve/main/model.gguf`;
  }
  return trimmed;
}

/**
 * Tool-calling status for an arbitrary model alias — catalog lookup first,
 * then heuristic family detection for custom HF models. Returns null when the
 * family is unknown.
 */
export function toolCallingForAlias(
  alias: string,
): OnyxAiToolCalling | null {
  const hit = catalogByAlias(alias);
  if (hit) return hit.toolCalling;
  const a = alias.toLowerCase();
  if (/qwen|gpt-?oss|glm-4|hermes|functionary|deepseek|command-r|llama-tc|tool/.test(a)) {
    return "native";
  }
  if (/gemma|smollm|medgemma|visionpsy|ocr|translat/.test(a)) return "none";
  return null;
}

/** True when the alias is a non-tool-calling model (the "won't work well" case). */
export function isNonToolCallingAlias(alias: string): boolean {
  return toolCallingForAlias(alias) === "none" || toolCallingForAlias(alias) === "template";
}

/** The `qvac serve` command with the app origin trusted for CORS. */
export function buildServeCommand(origin: string): string {
  return `qvac serve --openai --cors-origin ${origin}`;
}

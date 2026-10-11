"use client";

/**
 * Capability mapping — turns RAW provider metadata from the live catalogue
 * (https://gen.pollinations.ai/models) into the normalized model view the
 * spec requires (`list_models_with_modalities`), with honest "unknown"
 * handling: a capability is only `true` when the provider's own metadata
 * says so; unverifiable fields are never guessed.
 */
import type {
  CostEstimate,
  ModalityKey,
  ModelCapabilityInfo,
  PollinationsModel,
  PollinationsPricing,
} from "./types";

const num = (v: string | number | undefined | null): number | null => {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * A model is FREE only when the provider's rates are all exactly zero — or,
 * as the LIVE catalogue currently represents its free models, when the
 * pricing object exists but carries NO rate fields at all (only `currency`).
 * A rate-less paid_only model (e.g. minimax-h3-max) hides its rates and is
 * never guessed free.
 */
export function isFreeModel(m: PollinationsModel): boolean {
  const p = m.pricing;
  if (!p) return false;
  const values = Object.entries(p)
    .filter(([k]) => k !== "currency")
    .map(([, v]) => num(v as string | undefined));
  if (values.length === 0) return m.paid_only !== true;
  return values.every((v) => v === 0);
}

export function tierOf(m: PollinationsModel): "free" | "quest-or-paid" | "paid-only" {
  if (isFreeModel(m)) return "free";
  return m.paid_only === true ? "paid-only" : "quest-or-paid";
}

function fmtPollen(v: number): string {
  if (v === 0) return "0";
  if (v < 0.001) return v.toPrecision(2).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
  return String(Number(v.toFixed(6)));
}

/** Per-1M-token normalized line (rates are pollen-per-token). */
function perMillion(v: number): string {
  return `${fmtPollen(v * 1_000_000)} pollen / 1M tokens`;
}

/**
 * Human-readable price lines, per-unit, from the LIVE rates only. Empty
 * array = provider sent no rate for this model (render "pricing unknown").
 */
export function priceLinesOf(m: PollinationsModel): string[] {
  const p = m.pricing;
  if (!p) return [];
  // Currency-only pricing (the live catalogue's free representation, or a
  // paid-only model with hidden rates — isFreeModel keeps them apart).
  if (Object.keys(p).every((k) => k === "currency")) {
    return isFreeModel(m) ? ["FREE — 0 pollen (no rates published)"] : [];
  }
  const lines: string[] = [];
  const pt = num(p.promptTextTokens);
  const pi = num(p.promptImageTokens);
  const pv = num(p.promptVideoTokens);
  const pa = num(p.promptAudioTokens);
  const ct = num(p.completionTextTokens);
  const ci = num(p.completionImageTokens);
  const cv = num(p.completionVideoSeconds);
  const ca = num(p.completionAudioTokens);
  if (pt !== null) lines.push(`input text: ${perMillion(pt)}`);
  if (pi !== null) lines.push(`image input: ${pi < 0.0001 ? perMillion(pi) : `${fmtPollen(pi)} pollen / image`}`);
  if (pv !== null) lines.push(`video input: ${fmtPollen(pv)} pollen / sec of input video`);
  if (pa !== null) lines.push(`audio input: ${perMillion(pa)}`);
  if (ct !== null) lines.push(`output text: ${perMillion(ct)}`);
  if (ci !== null) lines.push(`output image: ${fmtPollen(ci)} pollen / image`);
  if (cv !== null) lines.push(`output video: ${fmtPollen(cv)} pollen / generated second`);
  if (ca !== null) lines.push(`output audio: ${perMillion(ca)}`);
  if (lines.length === 0) return [];
  return isFreeModel(m) ? ["FREE — 0 pollen (all rates zero)"] : lines;
}

/** True when the provider's own metadata marks the model as unavailable. */
export function isUnavailable(m: PollinationsModel): boolean {
  const status = m.health?.status?.toLowerCase();
  return status === "down" || status === "unavailable" || status === "offline";
}

// ---------------------------------------------------------------------------
// Normalized capability record.
// ---------------------------------------------------------------------------

export function enrichModel(m: PollinationsModel): ModelCapabilityInfo {
  const inMods = m.input_modalities ?? [];
  const outMods = m.output_modalities ?? [];
  const endpoints = m.supported_endpoints ?? [];
  const caps = m.capabilities ?? [];
  const has = (list: string[], v: string) => list.map((s) => s.toLowerCase()).includes(v);

  const modalities = {
    text_input: has(inMods, "text"),
    image_input: has(inMods, "image"),
    video_input: has(inMods, "video"),
    audio_input: has(inMods, "audio"),
    text_output: has(outMods, "text"),
    image_output: has(outMods, "image"),
    video_output: has(outMods, "video"),
    audio_output: has(outMods, "audio"),
    realtime: endpoints.some((e) => e.includes("/realtime")) || m.category === "realtime",
    embeddings: endpoints.some((e) => e.includes("/v1/embeddings")) || m.category === "embedding",
    transcription: endpoints.some((e) => e.includes("/v1/audio/transcriptions")),
    tool_calling: m.tools === true || has(caps, "tool_calling"),
    reasoning: m.reasoning === true || has(caps, "reasoning"),
  };

  const durations =
    m.min_duration != null || m.max_duration != null || m.default_duration != null || m.allowed_durations?.length
      ? {
          min: m.min_duration,
          max: m.max_duration,
          default: m.default_duration,
          allowed: m.allowed_durations,
        }
      : undefined;

  return {
    id: m.name,
    display_name: m.title ?? m.name,
    publisher: m.publisher ?? "unknown",
    category: m.category ?? null,
    community: m.community === true,
    modalities,
    endpoints,
    limits: {
      context_length: m.context_length,
      max_reference_images: m.max_reference_images,
      per_user_rpm: m.per_user_rpm ?? null,
      durations,
      resolutions: m.resolutions,
      voices: m.voices,
    },
    // All generation endpoints require an API key (official docs).
    authentication: { required: true, paid_only: m.paid_only === true },
    pollen: {
      free: isFreeModel(m),
      flat_rate: m.flat_rate === true,
      rates: m.pricing ?? {},
      priceLines: priceLinesOf(m),
      tier: tierOf(m),
    },
    availability: {
      status: m.health?.status ?? "unknown",
      success_rate: m.health?.success_rate ?? null,
      requests: m.health?.requests ?? null,
    },
    capabilities_verified: true,
  };
}

// ---------------------------------------------------------------------------
// Task compatibility (model selection validation).
// ---------------------------------------------------------------------------

export type TaskType = ModalityKey | "transcription";

/** Does the LIVE metadata say this model can serve this task? Never guessed. */
export function modelSupports(m: PollinationsModel, task: TaskType): { supported: boolean; reason: string } {
  const info = enrichModel(m);
  const mod = info.modalities;
  switch (task) {
    case "text":
      return mod.text_output
        ? { supported: true, reason: "" }
        : { supported: false, reason: "model does not output text" };
    case "image":
      return mod.image_output
        ? { supported: true, reason: "" }
        : { supported: false, reason: "model does not output images" };
    case "video":
      return mod.video_output
        ? { supported: true, reason: "" }
        : { supported: false, reason: "model does not output video" };
    case "audio":
      return mod.audio_output
        ? { supported: true, reason: "" }
        : { supported: false, reason: "model does not output audio" };
    case "3d":
      return (info.category === "3d" || m.output_modalities?.includes("3d"))
        ? { supported: true, reason: "" }
        : { supported: false, reason: "model does not output 3D" };
    case "realtime":
      return mod.realtime
        ? { supported: true, reason: "" }
        : { supported: false, reason: "model has no realtime endpoint" };
    case "embedding":
      return mod.embeddings
        ? { supported: true, reason: "" }
        : { supported: false, reason: "model has no embeddings endpoint" };
    case "transcription":
      return mod.transcription
        ? { supported: true, reason: "" }
        : { supported: false, reason: "model has no transcription endpoint" };
    default:
      return { supported: false, reason: "unknown task type" };
  }
}

/** Resolve a model from the live catalogue by canonical id OR any alias. */
export function findModel(
  models: PollinationsModel[],
  idOrAlias: string,
): PollinationsModel | undefined {
  const needle = idOrAlias.trim().toLowerCase();
  return models.find(
    (m) => m.name.toLowerCase() === needle || (m.aliases ?? []).some((a) => a.toLowerCase() === needle),
  );
}

/** Models that support a task, sorted for pickers: FREE first (highlighted
 *  as recommended), then healthy official models by flat price, then the
 *  rest. Unavailable models sink to the bottom. */
export function compatibleModels(models: PollinationsModel[], task: TaskType): PollinationsModel[] {
  return models
    .filter((m) => modelSupports(m, task).supported)
    .sort((a, b) => {
      const rank = (m: PollinationsModel): number => {
        if (isUnavailable(m)) return 9;
        if (isFreeModel(m)) return 0; // free = recommended, top
        if (m.health?.status?.toLowerCase() === "healthy") return 1;
        return 2;
      };
      const r = rank(a) - rank(b);
      if (r !== 0) return r;
      // Cheapest flat image/audio cost next.
      const flat = (m: PollinationsModel): number => {
        const p = m.pricing ?? {};
        const candidates = [
          num(p.completionImageTokens),
          num(p.completionVideoSeconds),
          num(p.completionTextTokens),
        ].filter((v): v is number => v !== null);
        return candidates.length ? Math.min(...candidates) : Number.MAX_SAFE_INTEGER;
      };
      const f = flat(a) - flat(b);
      if (f !== 0) return f;
      return a.name.localeCompare(b.name);
    });
}

/**
 * Pick a sensible default for a modality from the LIVE catalogue — NO
 * hardcoded model ids (ids rotate). Preference: healthy free official →
 * healthy cheapest official → healthy community → any compatible.
 */
export function pickDefaultModel(models: PollinationsModel[], modality: ModalityKey): PollinationsModel | null {
  const list = compatibleModels(models, modality);
  if (list.length === 0) return null;
  const officialHealthyFree = list.find((m) => !m.community && !isUnavailable(m) && isFreeModel(m));
  if (officialHealthyFree) return officialHealthyFree;
  const officialHealthy = list.find((m) => !m.community && !isUnavailable(m));
  if (officialHealthy) return officialHealthy;
  const anyHealthy = list.find((m) => !isUnavailable(m));
  if (anyHealthy) return anyHealthy;
  return list[0] ?? null;
}

// ---------------------------------------------------------------------------
// Cost estimation — LIVE rates only; token-based costs are honestly unknown.
// ---------------------------------------------------------------------------

export interface EstimateInput {
  /** Reference/input image count (image + video models). */
  inputImages?: number;
  /** Requested video duration in seconds. */
  videoDuration?: number;
  /** Requested number of outputs (multi-item disclosure). */
  outputCount?: number;
  /** Approximate input characters (embeddings / text). */
  inputChars?: number;
}

export function estimateCost(
  m: PollinationsModel,
  kind: "image" | "video" | "audio" | "3d" | "text" | "embeddings" | "realtime" | "transcription",
  input: EstimateInput = {},
): CostEstimate {
  if (isFreeModel(m)) {
    return { kind: "free", pollen: 0, basis: "All provider rates for this model are zero." };
  }
  const p: PollinationsPricing = m.pricing ?? {};
  const n = outputCountMul(input.outputCount ?? 1);
  const images = Math.max(0, input.inputImages ?? 0);

  if (kind === "image" || kind === "3d") {
    const perImage = num(p.completionImageTokens);
    const perInputImage = num(p.promptImageTokens);
    if (perImage === null && perInputImage === null) {
      return { kind: "unknown", basis: "The provider did not publish an image rate for this model.", rateLines: priceLinesOf(m) };
    }
    let pollen = 0;
    const parts: string[] = [];
    if (perImage !== null) {
      pollen += perImage * n;
      parts.push(`${fmtPollen(perImage)} × ${n} image${n > 1 ? "s" : ""}`);
    }
    if (perInputImage !== null && images > 0) {
      pollen += perInputImage * images;
      parts.push(`${fmtPollen(perInputImage)} × ${images} input image${images > 1 ? "s" : ""}`);
    }
    return { kind: "estimate", pollen, basis: parts.join(" + ") || "image rate" };
  }

  if (kind === "video") {
    const perSecond = num(p.completionVideoSeconds);
    const perInputImage = num(p.promptImageTokens);
    const duration = input.videoDuration ?? m.default_duration ?? 4;
    if (perSecond === null) {
      return { kind: "unknown", basis: "The provider did not publish a per-second video rate for this model.", rateLines: priceLinesOf(m) };
    }
    let pollen = perSecond * duration;
    const parts = [`${fmtPollen(perSecond)} × ${duration}s of video`];
    if (perInputImage !== null && images > 0) {
      pollen += perInputImage * images;
      parts.push(`${fmtPollen(perInputImage)} × ${images} input image${images > 1 ? "s" : ""}`);
    }
    return { kind: "estimate", pollen, basis: parts.join(" + ") };
  }

  if (kind === "audio") {
    // Hosted TTS bills completionAudioTokens (per token); output length is
    // unknowable before generation → honestly unknown, but show the rate.
    return {
      kind: "unknown",
      basis: "Audio cost depends on the generated audio length — the exact price can only be known after generation.",
      rateLines: priceLinesOf(m),
    };
  }

  if (kind === "embeddings") {
    const perToken = num(p.promptTextTokens);
    if (perToken === null) {
      return { kind: "unknown", basis: "No published embedding rate.", rateLines: priceLinesOf(m) };
    }
    const approxTokens = Math.ceil((input.inputChars ?? 0) / 4);
    return {
      kind: "estimate",
      pollen: perToken * approxTokens,
      basis: `${fmtPollen(perToken)} × ~${approxTokens} tokens (chars/4 — rough)`,
      rough: true,
    };
  }

  if (kind === "realtime") {
    return {
      kind: "unknown",
      basis: "Realtime sessions bill per audio token while the session is open — final cost depends on the live conversation.",
      rateLines: priceLinesOf(m),
    };
  }

  // text + transcription
  return {
    kind: "unknown",
    basis: "Text cost depends on generated token counts — unknowable before generation.",
    rateLines: priceLinesOf(m),
  };
}

function outputCountMul(n: number): number {
  return Number.isFinite(n) && n > 0 ? Math.min(10, Math.round(n)) : 1;
}

/** Format an estimate for display (accepts the flattened dialog shape). */
export function formatEstimate(e: {
  kind: "free" | "estimate" | "unknown";
  basis?: string;
  rough?: boolean;
  pollen?: number | null;
}): string {
  if (e.kind === "free") return "FREE — 0 pollen";
  if (e.kind === "estimate") {
    const v = typeof e.pollen === "number" ? e.pollen : null;
    if (v == null) return "Cost unknown";
    return `≈ ${fmtPollen(v)} pollen${e.rough ? " (rough)" : ""} — ${e.basis ?? ""}`.trim();
  }
  return `Cost unknown — ${e.basis ?? "the provider did not publish a usable rate."}`;
}

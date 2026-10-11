"use client";

/**
 * Pollinations.ai client types — mirrored from the OFFICIAL live model
 * catalogue (GET https://gen.pollinations.ai/models) and the account API
 * (https://gen.pollinations.ai/docs). Nothing here invents model data; every
 * field is a typed view of what the provider actually returns, and anything
 * the provider doesn't send stays `undefined` → rendered as "unknown".
 */

// ---------------------------------------------------------------------------
// Live catalogue (https://gen.pollinations.ai/models).
// ---------------------------------------------------------------------------

export interface PollinationsPricing {
  currency?: string;
  promptTextTokens?: string;
  promptCachedTokens?: string;
  promptImageTokens?: string;
  promptVideoTokens?: string;
  promptAudioTokens?: string;
  completionTextTokens?: string;
  completionImageTokens?: string;
  completionVideoSeconds?: string;
  completionAudioTokens?: string;
  [key: string]: string | undefined;
}

export interface PricingVariant {
  name: string;
  label?: string;
  description?: string;
  pricing: PollinationsPricing;
}

export interface ModelHealth {
  status?: string;
  success_rate?: number | null;
  requests?: number | null;
}

export type ModelCategory = "text" | "image" | "video" | "audio" | "realtime" | "embedding" | "3d" | (string & {});

export interface PollinationsModel {
  /** Canonical id — `publisher/model` (aliases remain valid in requests). */
  name: string;
  aliases?: string[];
  category?: ModelCategory;
  publisher?: string;
  community?: boolean;
  pricing?: PollinationsPricing;
  pricing_variants?: PricingVariant[];
  pricing_default_label?: string;
  title?: string;
  description?: string;
  input_modalities?: string[];
  output_modalities?: string[];
  supported_endpoints?: string[];
  capabilities?: string[];
  supported_parameters?: string[];
  voices?: string[];
  resolutions?: string[];
  per_user_rpm?: number | null;
  flat_rate?: boolean;
  paid_only?: boolean;
  context_length?: number;
  tools?: boolean;
  reasoning?: boolean;
  max_reference_images?: number;
  max_reference_videos?: number;
  min_duration?: number;
  max_duration?: number;
  default_duration?: number;
  allowed_durations?: number[];
  video_capabilities?: string[];
  health?: ModelHealth;
  brand_url?: string;
  brand_icon_url?: string;
  agent?: boolean;
  base_model?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Normalized capability view (spec: "list_models_with_modalities" shape).
// ---------------------------------------------------------------------------

export interface ModelCapabilityInfo {
  id: string;
  display_name: string;
  publisher: string;
  category: ModelCategory | null;
  community: boolean;
  modalities: {
    text_input: boolean;
    image_input: boolean;
    video_input: boolean;
    audio_input: boolean;
    text_output: boolean;
    image_output: boolean;
    video_output: boolean;
    audio_output: boolean;
    realtime: boolean;
    embeddings: boolean;
    transcription: boolean;
    tool_calling: boolean;
    reasoning: boolean;
  };
  endpoints: string[];
  limits: {
    context_length?: number;
    max_reference_images?: number;
    per_user_rpm?: number | null;
    durations?: { min?: number; max?: number; default?: number; allowed?: number[] };
    resolutions?: string[];
    voices?: string[];
  };
  authentication: { required: boolean; paid_only: boolean };
  pollen: {
    free: boolean;
    flat_rate: boolean;
    /** Raw provider rates, pollen-per-unit (strings preserved verbatim). */
    rates: PollinationsPricing;
    /** Human-readable per-unit price lines. */
    priceLines: string[];
    tier: "free" | "quest-or-paid" | "paid-only";
  };
  availability: {
    status: string;
    success_rate: number | null;
    requests: number | null;
  };
  /** True when every capability above was derived from provider metadata. */
  capabilities_verified: boolean;
}

// ---------------------------------------------------------------------------
// Pricing / cost estimation.
// ---------------------------------------------------------------------------

export type CostEstimate =
  | { kind: "free"; pollen: 0; basis: string }
  | { kind: "estimate"; pollen: number; basis: string; rough?: boolean }
  | { kind: "unknown"; basis: string; rateLines?: string[] };

/** Flattened estimate shape the confirmation dialogs consume (pollen is
 *  `null` when unknowable — the UI must then say “final cost unknown”). */
export interface ConfirmEstimate {
  kind: "free" | "estimate" | "unknown";
  pollen: number | null;
  basis: string;
  rough?: boolean;
  rateLines?: string[];
}

/** Flatten a CostEstimate into the dialog shape (never invents a number). */
export function toConfirmEstimate(e: CostEstimate): ConfirmEstimate {
  if (e.kind === "free") return { kind: "free", pollen: 0, basis: e.basis };
  if (e.kind === "estimate") {
    return { kind: "estimate", pollen: e.pollen, basis: e.basis, ...(e.rough ? { rough: true } : {}) };
  }
  return { kind: "unknown", pollen: null, basis: e.basis, ...(e.rateLines ? { rateLines: e.rateLines } : {}) };
}

export interface PollenBalance {
  /** Pollen visible to this caller (budgeted keys see the key budget). */
  balance: number;
  /** Full account split — present when the key has the usage scope. */
  accountBalance?: { total: number; tier: number; paid: number };
  checkedAt: string;
  source: "provider";
}

// ---------------------------------------------------------------------------
// Usage (GET /account/usage — per-request actual costs).
// ---------------------------------------------------------------------------

export interface UsageRow {
  timestamp?: string;
  cursor_event_id?: string;
  type?: string;
  model?: string | null;
  cost?: number | string | null;
  meter_source?: string | null;
  input_text_tokens?: number;
  output_text_tokens?: number;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Connection (BYOP — the user's own scoped key).
// ---------------------------------------------------------------------------

export interface PollinationsProfile {
  githubUsername?: string;
  name?: string;
  email?: string;
}

export interface PollinationsConnectionMeta {
  method: "oauth" | "manual";
  connectedAt: string;
  expiresAt?: string;
  scope?: string;
  profile?: PollinationsProfile;
}

export type ConnectionStatus = "checking" | "connected" | "expired" | "disconnected";

// ---------------------------------------------------------------------------
// Defaults / prefs.
// ---------------------------------------------------------------------------

export type ModalityKey = "text" | "image" | "video" | "audio" | "realtime" | "embedding" | "3d";

export const MODALITY_KEYS: readonly ModalityKey[] = ["text", "image", "video", "audio", "realtime", "embedding", "3d"];

export interface PollinationsPrefs {
  /** Offer "Enhance prompt" prominently in the confirmation dialog. */
  enhanceByDefault: boolean;
  imageWidth: number;
  imageHeight: number;
  videoDuration: number;
  videoResolution: string;
  audioVoice: string;
  audioFormat: "mp3" | "opus" | "aac" | "flac" | "wav" | "pcm";
  /** Safety filter — official values: privacy,secrets / sexual,violence / shield. */
  safe: string;
}

export const DEFAULT_PREFS: PollinationsPrefs = {
  enhanceByDefault: true,
  imageWidth: 1024,
  imageHeight: 1024,
  videoDuration: 4,
  videoResolution: "720p",
  audioVoice: "alloy",
  audioFormat: "mp3",
  safe: "",
};

// ---------------------------------------------------------------------------
// Generation jobs + activity log.
// ---------------------------------------------------------------------------

export type GenerationJobStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export interface GenerationJob {
  id: string;
  operation: string;
  kind: "image" | "video" | "audio" | "3d" | "text" | "embeddings" | "transcription" | "realtime" | (string & {});
  model: string;
  prompt: string;
  status: GenerationJobStatus;
  createdAt: string;
  endedAt?: string;
  timeMs?: number;
  url?: string | null;
  error?: string;
  /** Estimated Pollen cost shown at confirmation time (null = unknown). */
  estimatedPollen?: number | null;
  /** Actual cost when the provider reports one. */
  actualPollen?: number | null;
  usageHeaders?: Record<string, string> | null;
}

export interface ActivityLogEntry {
  id: string;
  ts: string;
  operation: string;
  model?: string;
  status: "completed" | "failed" | "cancelled";
  estimatedPollen?: number | null;
  actualPollen?: number | null;
  detail?: string;
  prompt?: string;
}

// ---------------------------------------------------------------------------
// The two-step confirmation contract (tool ⇄ UI).
// ---------------------------------------------------------------------------

export type ConfirmStage = "prepare" | "confirm";

export interface ConfirmModelInfo {
  id: string;
  title: string;
  publisher: string;
  community: boolean;
  free: boolean;
  paidOnly: boolean;
  priceLines: string[];
  health?: { status?: string; successRate?: number | null };
  tier: "free" | "quest-or-paid" | "paid-only";
}

export interface ConfirmRequestPayload {
  requestId: string;
  stage: ConfirmStage;
  operation: string;
  kind: string;
  model: ConfirmModelInfo;
  prompt: string;
  /** Original prompt when this is a post-enhancement round. */
  originalPrompt?: string;
  /** Labeled generation settings displayed to the user. */
  params: Array<{ label: string; value: string }>;
  estimate: ConfirmEstimate;
  free: boolean;
  /** Multi-output disclosure (spec §6 rule 10). */
  outputCount?: number;
  warning?: string;
  issuedAt: string;
}

export type ConfirmAction =
  | { requestId: string; action: "use"; prompt?: string }
  | { requestId: string; action: "enhance" }
  | { requestId: string; action: "cancel" }
  | { requestId: string; action: "confirm"; prompt?: string; params?: Record<string, unknown> }
  | { requestId: string; action: "reject" };

export const CONFIRM_RESPONSE_EVENT = "pollinations:confirm-response";

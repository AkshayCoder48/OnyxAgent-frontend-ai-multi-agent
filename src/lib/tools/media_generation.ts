"use client";

/**
 * media_generation — the unified Pollinations.ai agent tool.
 *
 * ONE registered tool, many subtools (spec: "Architecture: Native AI tool
 * with multiple subtools"). Every capability is a REAL call against the
 * official API (https://gen.pollinations.ai) through our server proxy
 * routes — no simulated results, no invented capabilities, no hardcoded
 * model ids (the catalogue is fetched live every time it matters).
 *
 * Subtool groups:
 *   Discovery      list_models · list_models_with_modalities · get_model_details
 *   Selection      select_model · set_default_model · get_default_models
 *   Pollen/usage   check_pollen_balance · get_usage_information · connection_status
 *   Generation     generate_text · generate_image · generate_video · generate_audio
 *                  generate_3d · transcribe_audio · generate_embeddings · run_realtime_session
 *   Jobs           get_generation_status · wait_for_generation · cancel_generation · list_generation_history
 *   Publishing     publish_model · list_my_models · update_my_model · delete_my_model · test_my_model
 *                  publish_agent · list_agents · update_agent · delete_agent · sync_code_agent
 *
 * MANDATORY TWO-STEP CONFIRMATION (enforced HERE, in the execution layer):
 * any operation that may consume Pollen first shows the user the exact
 * prompt + model + settings + estimated cost (`stage: "prepare"` — the user
 * may edit the prompt or request an AI enhancement, which NEVER generates),
 * then a final `stage: "confirm"` dialog. The provider endpoint is invoked
 * ONLY after the explicit confirm action; cancel/reject/abort/timeout never
 * touch it. Free models (all live rates zero) confirm once, clearly labelled
 * FREE — 0 pollen.
 */
import { nanoid } from "nanoid";
import { registerTool, type ToolContext } from "./registry";
import type { WSEvent } from "@/types";
import {
  compatibleModels,
  enrichModel,
  estimateCost,
  findModel,
  formatEstimate,
  isFreeModel,
  modelSupports,
  pickDefaultModel,
  priceLinesOf,
  tierOf,
  type TaskType,
} from "@/lib/pollinations/capabilities";
import {
  accountCall,
  generateEmbeddings,
  generateMedia,
  generateText,
  PollinationsApiError,
  transcribeAudio,
} from "@/lib/pollinations/api";
import { usePollinationsStore } from "@/lib/pollinations/store";
import {
  CONFIRM_RESPONSE_EVENT,
  toConfirmEstimate,
  type ActivityLogEntry,
  type ConfirmEstimate,
  type ConfirmAction,
  type ConfirmRequestPayload,
  type ModalityKey,
  type PollinationsModel,
} from "@/lib/pollinations/types";

// ---------------------------------------------------------------------------
// Arg helpers.
// ---------------------------------------------------------------------------

type Args = Record<string, unknown>;

const str = (a: Args, k: string, max = 32_000): string => {
  const v = a[k];
  if (typeof v !== "string") return "";
  return v.trim().slice(0, max);
};
const num = (a: Args, k: string): number | undefined => {
  const v = a[k];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return undefined;
};
const bool = (a: Args, k: string): boolean | undefined => {
  const v = a[k];
  if (typeof v === "boolean") return v;
  if (v === "true") return true;
  if (v === "false") return false;
  return undefined;
};
const obj = (a: Args, k: string): Record<string, unknown> | null => {
  const v = a[k];
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  return null;
};

// ---------------------------------------------------------------------------
// Error mapping — provider-accurate, never "success" on rejection.
// ---------------------------------------------------------------------------

interface ToolFail {
  ok: false;
  code: number;
  error: string;
  hint?: string;
  retryAfter?: number;
}

function apiFail(err: unknown, context: string): ToolFail {
  if (err instanceof PollinationsApiError) {
    const hints: Record<string, string> = {
      UNAUTHORIZED: "The connected Pollinations key is missing or invalid — reconnect via Settings → Pollinations AI.",
      INSUFFICIENT_BALANCE: "The connected account is out of Pollen. Top up at https://enter.pollinations.ai/pollen, or pick a FREE (0 pollen) model with list_models free_only=true.",
      PAYMENT_REQUIRED: "The connected account is out of Pollen. Top up at https://enter.pollinations.ai/pollen, or pick a FREE (0 pollen) model.",
      KEY_BUDGET_EXHAUSTED: "The authorized key reached its Pollen budget — reconnect from Settings → Pollinations AI (the user can raise the budget).",
      QUEST_POLLEN_ONLY: "This model requires PAID Pollen, but the request would have spent Quest Pollen. Use a non paid-only model or add paid Pollen.",
      FORBIDDEN: "The connected key lacks the required permission for this operation (e.g. the `keys` scope for publishing, or the `usage` scope for balance).",
      RATE_LIMITED: "Rate limited by Pollinations — wait and retry.",
      PROVIDER_UNREACHABLE: "Pollinations is unreachable right now — retry shortly.",
    };
    return {
      ok: false,
      code: err.status,
      error: `${context}: ${err.message}`,
      ...(hints[err.code] ? { hint: hints[err.code] } : {}),
      ...(err.retryAfter !== undefined ? { retryAfter: err.retryAfter } : {}),
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { ok: false, code: 500, error: `${context}: ${message}` };
}

// ---------------------------------------------------------------------------
// Connection resolution.
// ---------------------------------------------------------------------------

async function ensureStore(ctx: ToolContext): Promise<typeof usePollinationsStore> {
  const store = usePollinationsStore;
  if (ctx.userId) await store.getState().init(ctx.userId);
  return store;
}

async function requireToken(ctx: ToolContext): Promise<{ token: string } | ToolFail> {
  const store = await ensureStore(ctx);
  const state = store.getState();
  if (!state.token) {
    return {
      ok: false,
      code: 401,
      error: "No Pollinations account connected. Generation requires the user's own key (BYOP).",
      hint: "Ask the user to open Settings → Pollinations AI → Connect account (official OAuth) or paste their API key from https://enter.pollinations.ai/keys.",
    };
  }
  const meta = state.connectionMeta;
  if (meta?.expiresAt && new Date(meta.expiresAt).getTime() <= Date.now()) {
    return {
      ok: false,
      code: 401,
      error: "The connected Pollinations key has expired.",
      hint: "Ask the user to reconnect via Settings → Pollinations AI (authorized keys are time-boxed; the provider issues no refresh tokens).",
    };
  }
  return { token: state.token };
}

// ---------------------------------------------------------------------------
// Live catalogue helpers (ALWAYS fresh — a stale list is a correctness bug).
// ---------------------------------------------------------------------------

async function liveModels(ctx: ToolContext): Promise<PollinationsModel[] | ToolFail> {
  const store = await ensureStore(ctx);
  const models = await store.getState().refreshModels();
  if (models.length === 0) {
    return {
      ok: false,
      code: 503,
      error: store.getState().modelsError ?? "The live Pollinations model catalogue is unavailable.",
      hint: "Model discovery needs https://gen.pollinations.ai to be reachable. Retry shortly; never guess model ids.",
    };
  }
  return models;
}

/** Resolve + validate a model for a task from the LIVE catalogue. */
async function resolveModelForTask(
  ctx: ToolContext,
  task: TaskType,
  requestedId: string,
): Promise<{ model: PollinationsModel } | ToolFail> {
  const modelsOr = await liveModels(ctx);
  if ("ok" in modelsOr && modelsOr.ok === false) return modelsOr;
  const models = modelsOr as PollinationsModel[];
  const store = usePollinationsStore.getState();
  const want = requestedId || store.defaults[task as ModalityKey] || "";
  let model: PollinationsModel | undefined = want ? findModel(models, want) : undefined;
  if (!model) {
    model = pickDefaultModel(models, task as ModalityKey) ?? undefined;
    if (!model) {
      return {
        ok: false,
        code: 404,
        error: `No ${task} model is currently available in the live Pollinations catalogue.`,
        hint: "Show the user an unavailable state for this modality — do not fabricate results.",
      };
    }
  }
  const support = modelSupports(model, task);
  if (!support.supported) {
    const alternatives = compatibleModels(models, task)
      .slice(0, 5)
      .map((m) => m.name);
    return {
      ok: false,
      code: 400,
      error: `Model ${model.name} cannot serve ${task} tasks (${support.reason}).`,
      hint:
        alternatives.length > 0
          ? `Compatible models include: ${alternatives.join(", ")}.`
          : "No compatible model was found in the live catalogue.",
    };
  }
  if (model.paid_only === true) {
    // Allowed, but disclose the tier honestly.
  }
  return { model };
}

// ---------------------------------------------------------------------------
// The two-step confirmation primitive (execution-layer enforced).
// ---------------------------------------------------------------------------

const CONFIRM_TIMEOUT_MS = 15 * 60 * 1000; // dialog auto-cancel after 15 min

function confirmModelInfo(m: PollinationsModel): ConfirmRequestPayload["model"] {
  return {
    id: m.name,
    title: m.title ?? m.name,
    publisher: m.publisher ?? "unknown",
    community: m.community === true,
    free: isFreeModel(m),
    paidOnly: m.paid_only === true,
    priceLines: priceLinesOf(m).length ? priceLinesOf(m) : ["Pricing not published by the provider"],
    health: {
      status: m.health?.status,
      successRate: m.health?.success_rate ?? null,
    },
    tier: tierOf(m),
  };
}

/** Emit the confirmation event and wait for the user's decision. */
function waitForConfirmation(
  payload: ConfirmRequestPayload,
  ctx: ToolContext,
): Promise<ConfirmAction> {
  return new Promise((resolve) => {
    let settled = false;
    const cleanup = () => {
      window.removeEventListener(CONFIRM_RESPONSE_EVENT, onEvent);
      ctx.signal?.removeEventListener("abort", onAbort);
      window.clearTimeout(timer);
      usePollinationsStore.getState().setPendingConfirmation(null);
    };
    const onEvent = (event: Event) => {
      const detail = (event as CustomEvent<ConfirmAction>).detail;
      if (!detail || detail.requestId !== payload.requestId) return;
      settled = true;
      cleanup();
      resolve(detail);
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ requestId: payload.requestId, action: "cancel" });
    };
    const timer = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ requestId: payload.requestId, action: "cancel" });
    }, CONFIRM_TIMEOUT_MS);

    window.addEventListener(CONFIRM_RESPONSE_EVENT, onEvent);
    ctx.signal?.addEventListener("abort", onAbort);
    usePollinationsStore.getState().setPendingConfirmation(payload);
    ctx.emit({
      type: "media_generation_confirm",
      data: payload,
      timestamp: new Date().toISOString(),
    } satisfies WSEvent);
  });
}

interface ConfirmedPlan {
  prompt: string;
  model: PollinationsModel;
  estimate: ConfirmEstimate;
  outputCount: number;
}

/**
 * The mandatory confirmation flow. Returns the confirmed plan or an honest
 * cancellation. NEVER calls the provider unless the user confirmed.
 */
async function runConfirmationFlow(opts: {
  operation: string;
  kind: "image" | "video" | "audio" | "3d" | "text" | "embeddings" | "transcription" | "realtime";
  task: TaskType;
  model: PollinationsModel;
  prompt: string;
  params: Array<{ label: string; value: string }>;
  estimate: ConfirmEstimate;
  outputCount?: number;
  warning?: string;
  ctx: ToolContext;
}): Promise<{ confirmed: true; plan: ConfirmedPlan } | { cancelled: true; reason: string } | ToolFail> {
  const { operation, kind, model, ctx } = opts;
  const free = isFreeModel(model);
  let prompt = opts.prompt;
  let originalPrompt: string | undefined;

  // ── STEP 1 — prompt preparation ("What would you like to generate?") ──
  // The user may edit the prompt, request an AI enhancement (never generates
  // media), or cancel. FREE models confirm right here.
  let prep: ConfirmAction = await waitForConfirmation(
    {
      requestId: `pln_${nanoid(12)}`,
      stage: "prepare",
      operation,
      kind,
      model: confirmModelInfo(model),
      prompt,
      ...(originalPrompt ? { originalPrompt } : {}),
      params: opts.params,
      estimate: opts.estimate,
      free,
      ...(opts.outputCount && opts.outputCount > 1 ? { outputCount: opts.outputCount } : {}),
      ...(opts.warning ? { warning: opts.warning } : {}),
      issuedAt: new Date().toISOString(),
    },
    ctx,
  );

  let enhancedOnce = false;
  while (prep.action === "enhance") {
    if (enhancedOnce && originalPrompt) {
      // Second enhance request on an already-enhanced prompt — re-enhance the
      // CURRENT text, keeping the true original for reference.
    }
    const enhanced = await enhancePrompt(prompt, kind, ctx);
    if ("ok" in enhanced && enhanced.ok === false) return enhanced;
    originalPrompt = originalPrompt ?? prompt;
    prompt = (enhanced as { prompt: string }).prompt;
    enhancedOnce = true;
    prep = await waitForConfirmation(
      {
        requestId: `pln_${nanoid(12)}`,
        stage: "prepare",
        operation,
        kind,
        model: confirmModelInfo(model),
        prompt,
        originalPrompt,
        params: opts.params,
        estimate: opts.estimate,
        free,
        ...(opts.outputCount && opts.outputCount > 1 ? { outputCount: opts.outputCount } : {}),
        warning: opts.warning ? `${opts.warning} Prompt was AI-enhanced — review it before generating.` : "Prompt was AI-enhanced by a free text model — review and edit freely before generating.",
        issuedAt: new Date().toISOString(),
      },
      ctx,
    );
  }

  if (prep.action === "cancel" || prep.action === "reject") {
    return { cancelled: true, reason: "The user cancelled at the prompt-preparation step — nothing was generated and no Pollen was spent." };
  }
  // "use" — adopt the (possibly edited) prompt.
  if (prep.action === "use" && typeof prep.prompt === "string" && prep.prompt.trim()) {
    prompt = prep.prompt.trim();
  }

  // ── STEP 2 — final confirmation (chargeable models only) ────────────────
  // FREE models skip this step: the "use" click above was the explicit
  // confirmation, clearly labelled FREE — 0 pollen.
  if (!free) {
    const final: ConfirmAction = await waitForConfirmation(
      {
        requestId: `pln_${nanoid(12)}`,
        stage: "confirm",
        operation,
        kind,
        model: confirmModelInfo(model),
        prompt,
        ...(originalPrompt ? { originalPrompt } : {}),
        params: opts.params,
        estimate: opts.estimate,
        free,
        ...(opts.outputCount && opts.outputCount > 1 ? { outputCount: opts.outputCount } : {}),
        issuedAt: new Date().toISOString(),
      },
      ctx,
    );
    if (final.action !== "confirm") {
      return { cancelled: true, reason: "The user declined the final confirmation — nothing was generated and no Pollen was spent." };
    }
    if (typeof final.prompt === "string" && final.prompt.trim()) {
      prompt = final.prompt.trim();
    }
  }

  return {
    confirmed: true,
    plan: {
      prompt,
      model,
      estimate: opts.estimate,
      outputCount: opts.outputCount ?? 1,
    },
  };
}

// ---------------------------------------------------------------------------
// Prompt enhancement (free text model only — never generates media).
// ---------------------------------------------------------------------------

const ENHANCER_SYSTEMS: Record<string, string> = {
  image:
    "You improve prompts for AI image generation. Rewrite the user's prompt into one vivid, concrete prompt (max 80 words): keep their EXACT subject and intent, then enrich composition, style, lighting, camera angle, mood and quality terms. Output ONLY the improved prompt — no preamble, no quotes, no explanations.",
  video:
    "You improve prompts for AI video generation. Rewrite the user's prompt into one cinematic prompt (max 80 words): keep their EXACT subject and intent, then enrich motion, camera movement, scene progression, lighting and mood. Output ONLY the improved prompt — no preamble, no quotes.",
  audio:
    "You improve text that will be spoken or sung by an AI voice. Keep the user's EXACT wording intent; make it flow naturally when spoken aloud (pacing, punctuation, emphasis cues). Output ONLY the improved text — no preamble, no quotes.",
  "3d":
    "You improve prompts for AI 3D asset generation. Keep the user's EXACT subject; describe geometry, materials and level of detail concisely. Output ONLY the improved prompt.",
  text: "You improve prompts for language models. Keep the user's EXACT intent; add clarity, structure and necessary context. Output ONLY the improved prompt.",
  embeddings: "You improve text that will be embedded for semantic search. Keep the meaning intact. Output ONLY the improved text.",
  transcription: "You clean up text for context. Keep the meaning. Output ONLY the improved text.",
  realtime: "You improve opening messages for a realtime voice assistant conversation. Keep the user's EXACT intent. Output ONLY the improved message.",
};

async function enhancePrompt(
  prompt: string,
  kind: string,
  ctx: ToolContext,
): Promise<{ prompt: string } | ToolFail> {
  const tokenOr = await requireToken(ctx);
  if ("ok" in tokenOr && tokenOr.ok === false) return tokenOr;
  const token = (tokenOr as { token: string }).token;

  const modelsOr = await liveModels(ctx);
  if ("ok" in modelsOr && modelsOr.ok === false) return modelsOr;
  const models = modelsOr as PollinationsModel[];
  // Prefer the configured default IF it is free; otherwise a free text model;
  // otherwise enhancement is honestly unavailable (never silently charge).
  const store = usePollinationsStore.getState();
  const configured = store.defaults.text ? findModel(models, store.defaults.text) : undefined;
  const freeDefault = configured && isFreeModel(configured) ? configured : undefined;
  const freePick = freeDefault ?? compatibleModels(models, "text").find((m) => isFreeModel(m) && !m.community);
  const enhancer = freePick ?? compatibleModels(models, "text").find((m) => isFreeModel(m));
  if (!enhancer) {
    return {
      ok: false,
      code: 503,
      error: "No FREE text model is currently available for prompt enhancement.",
      hint: "Prompt enhancement must never consume Pollen — tell the user they can edit the prompt manually instead.",
    };
  }
  try {
    const res = await generateText(token, {
      model: enhancer.name,
      prompt,
      system: ENHANCER_SYSTEMS[kind] ?? ENHANCER_SYSTEMS.text,
      temperature: 0.7,
      max_tokens: 300,
    });
    const improved = (res.result?.choices?.[0]?.message?.content ?? "").trim();
    if (!improved) {
      return { ok: false, code: 502, error: `The prompt enhancer (${enhancer.name}) returned an empty result.` };
    }
    return { prompt: improved.slice(0, 4000) };
  } catch (err) {
    return apiFail(err, "Prompt enhancement failed");
  }
}

// ---------------------------------------------------------------------------
// Job bookkeeping.
// ---------------------------------------------------------------------------

const jobAbortControllers = new Map<string, AbortController>();

function startJob(opts: { operation: string; kind: string; model: string; prompt: string; estimatedPollen?: number | null }): {
  jobId: string;
  controller: AbortController;
} {
  const store = usePollinationsStore.getState();
  const controller = new AbortController();
  const jobId = store.createJob({
    operation: opts.operation,
    kind: opts.kind,
    model: opts.model,
    prompt: opts.prompt,
    status: "running",
    estimatedPollen: opts.estimatedPollen ?? null,
  });
  jobAbortControllers.set(jobId, controller);
  return { jobId, controller };
}

function finishJob(jobId: string, patch: { status: "completed" | "failed" | "cancelled"; url?: string | null; error?: string; timeMs?: number; actualPollen?: number | null; usageHeaders?: Record<string, string> | null }) {
  const store = usePollinationsStore.getState();
  store.updateJob(jobId, { ...patch, endedAt: new Date().toISOString() });
  jobAbortControllers.delete(jobId);
  const job = store.getJob(jobId);
  if (job) {
    void store.logActivity({
      operation: job.operation,
      model: job.model,
      status: patch.status,
      estimatedPollen: job.estimatedPollen ?? null,
      actualPollen: patch.actualPollen ?? null,
      detail: patch.error ?? (patch.url ? "generated" : undefined),
      prompt: job.prompt.slice(0, 300),
    } satisfies Omit<ActivityLogEntry, "id" | "ts">);
  }
}

// ---------------------------------------------------------------------------
// The confirmed media generation executor.
// ---------------------------------------------------------------------------

interface MediaGenParams {
  model?: string;
  width?: number;
  height?: number;
  seed?: number;
  quality?: string;
  resolution?: string;
  aspect_ratio?: string;
  image?: string;
  transparent?: boolean;
  duration?: number;
  audio?: boolean;
  voice?: string;
  response_format?: string;
  instructions?: string;
  safe?: string;
  n?: number;
}

async function executeConfirmedMediaGeneration(opts: {
  operation: string;
  kind: "image" | "video" | "audio" | "3d";
  task: TaskType;
  args: Args;
  ctx: ToolContext;
}): Promise<Record<string, unknown> | ToolFail> {
  const { operation, kind, task, args, ctx } = opts;
  const tokenOr = await requireToken(ctx);
  if ("ok" in tokenOr && tokenOr.ok === false) return tokenOr;
  const token = (tokenOr as { token: string }).token;

  // Resolve + validate the model against the LIVE catalogue.
  const modelOr = await resolveModelForTask(ctx, task, str(args, "model", 200) || str(args, "model_id", 200));
  if ("ok" in modelOr && modelOr.ok === false) return modelOr;
  const model = (modelOr as { model: PollinationsModel }).model;

  const params = (args as unknown as MediaGenParams) ?? {};
  const store = usePollinationsStore.getState();
  const prefs = store.prefs;

  // Normalize params with prefs defaults + per-model clamp hints.
  const n = Math.min(4, Math.max(1, Math.round(num(args, "n") ?? num(args, "count") ?? 1)));
  const inputImages = params.image ? 1 : 0;
  const videoDuration =
    kind === "video"
      ? Math.min(model.max_duration ?? 120, Math.max(model.min_duration ?? 1, num(args, "duration") ?? model.default_duration ?? prefs.videoDuration))
      : undefined;

  const estimate = estimateCost(model, kind, {
    inputImages,
    videoDuration,
    outputCount: n,
  });

  // Labeled settings for the dialogs (cost-affecting ones locked after confirm).
  const paramLines: Array<{ label: string; value: string }> = [];
  if (kind === "image") {
    paramLines.push({ label: "Size", value: `${num(args, "width") ?? prefs.imageWidth} × ${num(args, "height") ?? prefs.imageHeight}` });
    if (params.resolution) paramLines.push({ label: "Resolution", value: String(params.resolution) });
    if (params.transparent) paramLines.push({ label: "Transparent", value: "yes" });
  }
  if (kind === "video" && videoDuration) paramLines.push({ label: "Duration", value: `${videoDuration}s` });
  if (kind === "video" && params.resolution) paramLines.push({ label: "Resolution", value: String(params.resolution) });
  if (kind === "audio") {
    paramLines.push({ label: "Voice", value: str(args, "voice", 40) || prefs.audioVoice });
    paramLines.push({ label: "Format", value: str(args, "response_format", 10) || prefs.audioFormat });
  }
  if (kind === "3d" && params.resolution) paramLines.push({ label: "Detail", value: String(params.resolution) });
  if (params.image) paramLines.push({ label: "Reference image", value: "yes (image-to-X)" });
  if (typeof params.seed === "number") paramLines.push({ label: "Seed", value: String(params.seed) });
  if (n > 1) paramLines.push({ label: "Outputs", value: String(n) });

  const warnings: string[] = [];
  if (model.paid_only === true) warnings.push("This model requires PAID Pollen (it cannot spend Quest Pollen).");
  if (model.community === true) warnings.push("Community model — published by a third party.");
  const health = model.health?.status?.toLowerCase();
  if (health && health !== "healthy") warnings.push(`Model health: ${model.health?.status ?? "unknown"}.`);

  const prompt = str(args, "prompt", 32_000);
  if (!prompt && kind !== "3d") {
    return { ok: false, code: 400, error: "Missing required parameter: prompt" };
  }
  if (kind === "3d" && !prompt && !params.image) {
    return { ok: false, code: 400, error: "3D generation needs an `image` (image-to-3D) and/or a `prompt`." };
  }

  // ── The mandatory two-step confirmation ─────────────────────────────────
  const confirmedOr = await runConfirmationFlow({
    operation,
    kind,
    task,
    model,
    prompt: prompt || "(image-driven 3D generation)",
    params: paramLines,
    estimate: toConfirmEstimate(estimate),
    outputCount: n,
    ...(warnings.length ? { warning: warnings.join(" ") } : {}),
    ctx,
  });
  if ("cancelled" in confirmedOr) {
    const jobId = usePollinationsStore.getState().createJob({
      operation, kind, model: model.name, prompt: prompt || "(image-driven 3D)", status: "cancelled",
      estimatedPollen: estimate.kind === "estimate" ? estimate.pollen : null,
    });
    void usePollinationsStore.getState().logActivity({
      operation, model: model.name, status: "cancelled",
      estimatedPollen: estimate.kind === "estimate" ? estimate.pollen : null,
      detail: "cancelled before generation", prompt: (prompt || "").slice(0, 300),
    });
    return { ok: false, code: 499, cancelled: true, error: confirmedOr.reason, job_id: jobId, model: model.name };
  }
  if ("ok" in confirmedOr && confirmedOr.ok === false) return confirmedOr;
  const plan = (confirmedOr as { plan: ConfirmedPlan }).plan;

  // ── Execution — ONLY after confirmation ─────────────────────────────────
  const { jobId, controller } = startJob({
    operation,
    kind,
    model: model.name,
    prompt: plan.prompt,
    estimatedPollen: estimate.kind === "estimate" ? estimate.pollen : null,
  });
  const mergedSignal = mergeSignals(ctx.signal, controller.signal);
  const startedAt = Date.now();

  const requestParams: Record<string, unknown> = {
    model: model.name,
    ...(kind === "image"
      ? {
          width: num(args, "width") ?? prefs.imageWidth,
          height: num(args, "height") ?? prefs.imageHeight,
        }
      : {}),
    ...(params.seed !== undefined ? { seed: params.seed } : {}),
    ...(params.quality ? { quality: params.quality } : {}),
    ...(params.resolution ? { resolution: params.resolution } : {}),
    ...(params.aspect_ratio ? { aspect_ratio: params.aspect_ratio } : {}),
    ...(params.image ? { image: params.image } : {}),
    ...(params.transparent === true ? { transparent: true } : {}),
    ...(kind === "video" && videoDuration ? { duration: videoDuration } : {}),
    ...(kind === "video" && params.audio !== undefined ? { audio: params.audio } : {}),
    ...(kind === "audio"
      ? {
          voice: str(args, "voice", 40) || prefs.audioVoice,
          response_format: str(args, "response_format", 10) || prefs.audioFormat,
          ...(str(args, "instructions", 2000) ? { instructions: str(args, "instructions", 2000) } : {}),
        }
      : {}),
    ...(prefs.safe && !params.safe ? { safe: prefs.safe } : params.safe ? { safe: params.safe } : {}),
  };

  try {
    const urls: string[] = [];
    let last: Awaited<ReturnType<typeof generateMedia>> | null = null;
    for (let i = 0; i < n; i++) {
      last = await generateMedia(token, kind, { ...requestParams, prompt: plan.prompt }, mergedSignal);
      if (last.url) urls.push(last.url);
      else if (last.b64) urls.push(last.b64);
    }
    const timeMs = Date.now() - startedAt;
    finishJob(jobId, { status: "completed", url: urls[0] ?? null, timeMs, usageHeaders: last?.usage ?? null });
    // Sync the model the user just confirmed as the modality default
    // (everything except text, per the settings-sync requirement).
    if (task !== "text") {
      void usePollinationsStore.getState().setDefaultModel(task as ModalityKey, model.name);
    }
    return {
      ok: true,
      operation,
      kind,
      model: model.name,
      model_title: model.title ?? model.name,
      url: urls[0] ?? null,
      ...(n > 1 ? { urls } : {}),
      count: urls.length,
      prompt: plan.prompt,
      time_ms: timeMs,
      stored: last?.stored,
      cost: {
        free: isFreeModel(model),
        estimated_pollen: estimate.kind === "estimate" ? estimate.pollen : estimate.kind === "free" ? 0 : null,
        estimate_basis: formatEstimate(estimate),
        actual_pollen: null,
        note:
          last?.usage && Object.keys(last.usage).length > 0
            ? "Provider usage headers were recorded — see usage information."
            : "Actual cost is reported by the provider in the account usage history (get_usage_information).",
      },
      job_id: jobId,
    };
  } catch (err) {
    if (mergedSignal.aborted || (err instanceof DOMException && err.name === "AbortError")) {
      finishJob(jobId, { status: "cancelled", error: "cancelled during generation" });
      return { ok: false, code: 499, cancelled: true, error: "Generation cancelled — no further requests were sent.", job_id: jobId, model: model.name };
    }
    const fail = apiFail(err, `${kind} generation failed`);
    finishJob(jobId, { status: "failed", error: fail.error });
    return { ...fail, job_id: jobId, model: model.name };
  }
}

function mergeSignals(a: AbortSignal | undefined, b: AbortSignal): AbortSignal {
  if (!a) return b;
  if (a.aborted) return a;
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  a.addEventListener("abort", onAbort, { once: true });
  b.addEventListener("abort", onAbort, { once: true });
  return controller.signal;
}

// ---------------------------------------------------------------------------
// Realtime session (official WS protocol — text-mode interaction).
// ---------------------------------------------------------------------------

async function runRealtime(args: Args, ctx: ToolContext): Promise<Record<string, unknown> | ToolFail> {
  const tokenOr = await requireToken(ctx);
  if ("ok" in tokenOr && tokenOr.ok === false) return tokenOr;
  const token = (tokenOr as { token: string }).token;

  const modelsOr = await liveModels(ctx);
  if ("ok" in modelsOr && modelsOr.ok === false) return modelsOr;
  const modelOr = await resolveModelForTask(ctx, "realtime", str(args, "model", 200));
  if ("ok" in modelOr && modelOr.ok === false) return modelOr;
  const model = (modelOr as { model: PollinationsModel }).model;

  const inputText = str(args, "input_text", 8000) || str(args, "prompt", 8000);
  if (!inputText) return { ok: false, code: 400, error: "Missing required parameter: input_text (the message to send in the realtime session)" };

  const estimate = estimateCost(model, "realtime", {});
  const confirmedOr = await runConfirmationFlow({
    operation: "run_realtime_session",
    kind: "realtime",
    task: "realtime",
    model,
    prompt: inputText,
    params: [{ label: "Session", value: "one text exchange over the official realtime WebSocket" }],
    estimate: { ...toConfirmEstimate(estimate), pollen: null },
    warning: "Realtime sessions bill per audio token while the session is open — the final cost is only known after it closes.",
    ctx,
  });
  if ("cancelled" in confirmedOr) return { ok: false, code: 499, cancelled: true, error: confirmedOr.reason, model: model.name };
  if ("ok" in confirmedOr && confirmedOr.ok === false) return confirmedOr;
  const plan = (confirmedOr as { plan: ConfirmedPlan }).plan;

  const { jobId, controller } = startJob({
    operation: "run_realtime_session",
    kind: "realtime",
    model: model.name,
    prompt: plan.prompt,
    estimatedPollen: null,
  });
  const mergedSignal = mergeSignals(ctx.signal, controller.signal);
  const startedAt = Date.now();

  try {
    const transcript = await realtimeExchange(model.name, token, plan.prompt, str(args, "instructions", 2000), mergedSignal);
    const timeMs = Date.now() - startedAt;
    finishJob(jobId, { status: "completed", timeMs });
    return {
      ok: true,
      operation: "run_realtime_session",
      model: model.name,
      model_title: model.title ?? model.name,
      transcript,
      time_ms: timeMs,
      cost: { free: isFreeModel(model), estimated_pollen: null, estimate_basis: formatEstimate(estimate), actual_pollen: null, note: "Realtime cost is settled when the session closes — see the account usage history." },
      job_id: jobId,
    };
  } catch (err) {
    if (mergedSignal.aborted) {
      finishJob(jobId, { status: "cancelled", error: "cancelled" });
      return { ok: false, code: 499, cancelled: true, error: "Realtime session cancelled.", job_id: jobId };
    }
    const fail = apiFail(err, "Realtime session failed");
    finishJob(jobId, { status: "failed", error: fail.error });
    return { ...fail, job_id: jobId };
  }
}

/** One text exchange over the official realtime WebSocket (OpenAI Realtime
 *  protocol; browsers authenticate with `?key=` — the officially documented
 *  browser mechanism). */
function realtimeExchange(
  modelName: string,
  key: string,
  inputText: string,
  instructions: string,
  signal: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let ws: WebSocket | null = null;
    const parts: string[] = [];
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error(`The realtime session did not complete within ${REALTIME_TIMEOUT_MS / 1000}s (model: ${modelName})`));
    }, REALTIME_TIMEOUT_MS);

    function cleanup() {
      window.clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      try { ws?.close(); } catch { /* already closed */ }
    }
    function onAbort() {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(parts.join(""));
    }

    signal.addEventListener("abort", onAbort);
    try {
      const url = `wss://gen.pollinations.ai/realtime?model=${encodeURIComponent(modelName)}&key=${encodeURIComponent(key)}`;
      ws = new WebSocket(url);
    } catch (err) {
      window.clearTimeout(timeout);
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    const sock = ws;

    sock.addEventListener("open", () => {
      sock.send(JSON.stringify({
        type: "session.update",
        session: { type: "realtime", ...(instructions ? { instructions } : {}) },
      }));
      sock.send(JSON.stringify({
        type: "conversation.item.create",
        item: { type: "message", role: "user", content: [{ type: "input_text", text: inputText }] },
      }));
      sock.send(JSON.stringify({ type: "response.create" }));
    });

    sock.addEventListener("message", (event) => {
      try {
        const data = JSON.parse(String(event.data)) as { type?: string; delta?: string; error?: { message?: string } | string };
        if (data.type === "response.text.delta" && typeof data.delta === "string") {
          parts.push(data.delta);
        } else if (data.type === "response.done" || data.type === "response.completed") {
          settled = true;
          cleanup();
          resolve(parts.join(""));
        } else if (data.type === "error") {
          settled = true;
          cleanup();
          const msg = typeof data.error === "string" ? data.error : data.error?.message ?? "unknown realtime error";
          reject(new Error(`Realtime error: ${msg}`));
        } else if (data.type === "session.closed" || data.type === "session.close") {
          settled = true;
          cleanup();
          resolve(parts.join(""));
        }
      } catch {
        /* ignore malformed frames */
      }
    });

    sock.addEventListener("error", () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error("The realtime WebSocket connection failed (the model or network may be unavailable)."));
    });
    sock.addEventListener("close", () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(parts.join(""));
    });
  });
}

const REALTIME_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------
// Model summary builders (compact, context-safe).
// ---------------------------------------------------------------------------

function modelSummary(m: PollinationsModel): Record<string, unknown> {
  const info = enrichModel(m);
  return {
    id: m.name,
    title: m.title ?? m.name,
    publisher: m.publisher ?? "unknown",
    category: m.category ?? "unknown",
    community: m.community === true,
    free: info.pollen.free,
    recommended: info.pollen.free && info.availability.status === "healthy" && !info.community,
    price: info.pollen.free ? "0 pollen — unlimited use" : info.pollen.priceLines[0] ?? "pricing unknown",
    all_pollen_rates: info.pollen.priceLines,
    tier: info.pollen.tier,
    health: info.availability.status,
    success_rate: info.availability.success_rate,
    input: m.input_modalities ?? [],
    output: m.output_modalities ?? [],
    ...(m.voices?.length ? { voices: m.voices.length } : {}),
    ...(m.resolutions?.length ? { resolutions: m.resolutions } : {}),
    ...(info.limits.durations ? { durations: info.limits.durations } : {}),
    endpoints: info.endpoints.length,
  };
}

// ---------------------------------------------------------------------------
// Tool registration.
// ---------------------------------------------------------------------------

const OPERATIONS = [
  "list_models", "list_models_with_modalities", "get_model_details",
  "select_model", "set_default_model", "get_default_models",
  "check_pollen_balance", "get_usage_information", "connection_status",
  "generate_text", "generate_image", "generate_video", "generate_audio", "generate_3d",
  "transcribe_audio", "generate_embeddings", "run_realtime_session",
  "get_generation_status", "wait_for_generation", "cancel_generation", "list_generation_history",
  "publish_model", "list_my_models", "update_my_model", "delete_my_model", "test_my_model",
  "publish_agent", "list_agents", "update_agent", "delete_agent", "sync_code_agent",
] as const;

const TOOL_DESCRIPTION = `Unified Pollinations AI interface (official https://gen.pollinations.ai API) for discovering models, inspecting capabilities, selecting models, managing defaults, checking Pollen balance/usage, and generating text, images, video, audio, 3D, embeddings — plus realtime sessions and publishing your own models/agents. Requires the user's connected Pollinations account (BYOP) and EXPLICIT two-step user confirmation before any operation that may consume Pollen — the tool itself shows the user a confirmation dialog and waits; never claim a generation happened unless the tool returned ok:true.

Operations (pass as \`operation\`):
• list_models {category?, search?, free_only?, limit?} — LIVE catalogue (fetched fresh from the provider; never assumes a hardcoded list). FREE 0-pollen models are listed first, marked recommended.
• list_models_with_modalities {category?, search?, limit?} — full capability records: input/output modalities, tool calling, realtime, embeddings, transcription, authentication, Pollen pricing per unit, availability.
• get_model_details {model_id} — one model's complete verified capability record.
• select_model {model_id, task_type} — validate a model for a task against the live catalogue; selections for every modality EXCEPT text are synced to the user's saved defaults.
• set_default_model {modality (text|image|video|audio|realtime|embedding|3d), model_id} — persist a default.
• get_default_models {} — current defaults + live validity check.
• check_pollen_balance {} — the connected account's real balance (Quest tier vs paid Pollen). Never fabricated.
• get_usage_information {days?, limit?} — actual per-request usage history from the provider + the local generation log.
• connection_status {} — connection, scope, expiry, profile.
• generate_text {prompt|messages, model?, system?, temperature?, max_tokens?} — chat completion via Pollinations.
• generate_image {prompt, model?, width?, height?, seed?, resolution?, quality?, image? (URL for image-to-image), transparent?, n? (1-4)} — renders inline.
• generate_video {prompt, model?, duration?, resolution?, image? (start frame), audio?} — MP4, renders inline.
• generate_audio {prompt (text to speak/sing), model?, voice?, response_format?, instructions?} — speech/music, plays inline.
• generate_3d {model?, image? (image-to-3D), resolution?, prompt?} — GLB model file.
• transcribe_audio {url (public audio URL), model?, language?, response_format?} — speech to text.
• generate_embeddings {input (string or string[]), model?, dimensions?} — vectors.
• run_realtime_session {input_text, model?, instructions?} — one text exchange over the official realtime WebSocket.
• get_generation_status {job_id} / wait_for_generation {job_id, timeout_seconds?} / cancel_generation {job_id} / list_generation_history {limit?} — honest job tracking (no invented progress percentages).
• publish_model {config} / list_my_models / update_my_model {id, config} / delete_my_model {id} / test_my_model {config} — publish your own model to Pollinations (needs the keys scope).
• publish_agent {config} / list_agents / update_agent {id, config} / delete_agent {id} / sync_code_agent {id} — managed prompt/code agents (community/owner/name listings).

Pollen rules: every chargeable operation shows the user the exact prompt, model, settings and estimated cost BEFORE anything runs (editable prompt + optional free AI enhancement); a second explicit confirmation follows for paid models. Free models (all rates zero) are labelled FREE — 0 pollen. If the user cancels at ANY point, nothing is sent to the provider. On 402 (insufficient pollen) suggest free models (free_only=true) or topping up. On unsupported model/modality, the tool lists real alternatives from the live catalogue.`;

const PARAMETERS_SCHEMA = {
  type: "object",
  properties: {
    operation: {
      type: "string",
      enum: [...OPERATIONS],
      description: "The subtool to execute.",
    },
    // Discovery / selection
    category: { type: "string", description: "list_models/list_models_with_modalities: filter by category (text|image|video|audio|realtime|embedding|3d)." },
    search: { type: "string", description: "list_models: case-insensitive search over id/title/publisher/description." },
    free_only: { type: "boolean", description: "list_models: only models whose Pollen rates are all zero (FREE, unlimited use)." },
    limit: { type: "integer", description: "list_models/usage/history: cap the number of returned rows (default 30, max 50)." },
    model_id: { type: "string", description: "select_model/get_model_details: canonical id (publisher/model) or alias." },
    model: { type: "string", description: "Generation ops: model override (defaults come from the user's saved settings, validated against the live catalogue)." },
    task_type: { type: "string", enum: ["text", "image", "video", "audio", "realtime", "embedding", "3d", "transcription"], description: "select_model: the task to validate the model against." },
    modality: { type: "string", enum: ["text", "image", "video", "audio", "realtime", "embedding", "3d"], description: "set_default_model: which default to persist." },
    // Generation
    prompt: { type: "string", description: "generate_text/image/video/audio/3d: the prompt (for audio: the text to speak/sing)." },
    system: { type: "string", description: "generate_text: system prompt." },
    messages: { type: "array", items: { type: "object" }, description: "generate_text: chat messages [{role, content}] (alternative to prompt)." },
    temperature: { type: "number", description: "generate_text: sampling temperature (0-2)." },
    max_tokens: { type: "integer", description: "generate_text: response cap." },
    width: { type: "integer", description: "generate_image: width (64-4096)." },
    height: { type: "integer", description: "generate_image: height (64-4096)." },
    seed: { type: "integer", description: "generate_image/video/audio: reproducibility seed." },
    resolution: { type: "string", description: "image/video: e.g. 1k|2k|720p|1080p (model-dependent); 3d: low|medium|high." },
    quality: { type: "string", enum: ["low", "medium", "high", "hd"], description: "generate_image: quality tier." },
    aspect_ratio: { type: "string", description: "generate_image/video: e.g. 16:9, 9:16, 1:1." },
    image: { type: "string", description: "generate_image (reference/edit), generate_video (start frame), generate_3d (image-to-3D): public image URL." },
    transparent: { type: "boolean", description: "generate_image: transparent background where supported." },
    duration: { type: "number", description: "generate_video: seconds (clamped to the model's live min/max/default)." },
    audio: { type: "boolean", description: "generate_video: include audio where supported." },
    voice: { type: "string", description: "generate_audio: voice id (e.g. alloy, nova — see model details)." },
    response_format: { type: "string", description: "generate_audio: mp3|opus|aac|flac|wav|pcm; transcribe_audio: json|text|srt|vtt|verbose_json." },
    instructions: { type: "string", description: "generate_audio / run_realtime_session: delivery or behavior instructions." },
    n: { type: "integer", description: "generate_image: number of outputs (1-4; total cost is disclosed before confirming)." },
    safe: { type: "string", description: "Official safety filters: privacy,secrets / sexual,violence / shield." },
    // Transcription / embeddings
    url: { type: "string", description: "transcribe_audio: public audio URL (mp3/mp4/mpeg/mpga/m4a/wav/webm)." },
    language: { type: "string", description: "transcribe_audio: ISO-639-1 language hint." },
    input: { type: "string", description: "generate_embeddings: text (or JSON-encoded string array, max 32 items)." },
    dimensions: { type: "integer", description: "generate_embeddings: output dimensions where the model supports them." },
    input_text: { type: "string", description: "run_realtime_session: the message to send." },
    // Jobs
    job_id: { type: "string", description: "get_generation_status/wait_for_generation/cancel_generation: job id from a generation result." },
    timeout_seconds: { type: "number", description: "wait_for_generation: how long to wait (default 180)." },
    days: { type: "integer", description: "get_usage_information: history window in days (1-90, default 30)." },
    // Publishing (official /account/my-models + /account/agents shapes)
    id: { type: "string", description: "update/delete/sync ops: the entity id." },
    config: { type: "object", description: "publish/update ops: the official request body (e.g. publish_model: {name, api, url, baseUrl, pricing…}; publish_agent: {name, type: prompt|code, model, instructions, mcpServers / repoUrl})." },
  },
  required: ["operation"],
  additionalProperties: false,
} as const;

registerTool(
  "media_generation",
  TOOL_DESCRIPTION,
  PARAMETERS_SCHEMA as Record<string, unknown>,
  async (args: Args, ctx: ToolContext) => {
    const operation = str(args, "operation", 60);
    try {
      switch (operation) {
        // ── Discovery ────────────────────────────────────────────────────
        case "list_models":
          return await opListModels(args, ctx, false);
        case "list_models_with_modalities":
          return await opListModels(args, ctx, true);
        case "get_model_details":
          return await opModelDetails(args, ctx);

        // ── Selection ────────────────────────────────────────────────────
        case "select_model":
          return await opSelectModel(args, ctx);
        case "set_default_model":
          return await opSetDefaultModel(args, ctx);
        case "get_default_models":
          return await opGetDefaultModels(ctx);

        // ── Pollen / usage / connection ─────────────────────────────────
        case "check_pollen_balance":
          return await opCheckBalance(ctx);
        case "get_usage_information":
          return await opGetUsage(args, ctx);
        case "connection_status":
          return await opConnectionStatus(ctx);

        // ── Generation ───────────────────────────────────────────────────
        case "generate_text":
          return await opGenerateText(args, ctx);
        case "generate_image":
          return await executeConfirmedMediaGeneration({ operation, kind: "image", task: "image", args, ctx });
        case "generate_video":
          return await executeConfirmedMediaGeneration({ operation, kind: "video", task: "video", args, ctx });
        case "generate_audio":
          return await executeConfirmedMediaGeneration({ operation, kind: "audio", task: "audio", args, ctx });
        case "generate_3d":
          return await executeConfirmedMediaGeneration({ operation, kind: "3d", task: "3d", args, ctx });
        case "transcribe_audio":
          return await opTranscribe(args, ctx);
        case "generate_embeddings":
          return await opEmbeddings(args, ctx);
        case "run_realtime_session":
          return await runRealtime(args, ctx);

        // ── Jobs ─────────────────────────────────────────────────────────
        case "get_generation_status":
          return opJobStatus(str(args, "job_id", 60));
        case "wait_for_generation":
          return await opWaitForGeneration(str(args, "job_id", 60), num(args, "timeout_seconds") ?? 180, ctx);
        case "cancel_generation":
          return opCancelGeneration(str(args, "job_id", 60));
        case "list_generation_history":
          return opJobHistory(num(args, "limit") ?? 20);

        // ── Publishing (models + agents) ─────────────────────────────────
        case "publish_model":
          return await opPublish(args, ctx, "/account/my-models", "POST", "publish_model");
        case "list_my_models":
          return await opPublish({ operation: "list" }, ctx, "/account/my-models", "GET", "list_my_models");
        case "update_my_model":
          return await opPublish(args, ctx, `/account/my-models/${encodeURIComponent(str(args, "id", 200))}/update`, "POST", "update_my_model");
        case "delete_my_model":
          return await opPublish(args, ctx, `/account/my-models/${encodeURIComponent(str(args, "id", 200))}`, "DELETE", "delete_my_model");
        case "test_my_model":
          return await opPublish(args, ctx, "/account/my-models/test", "POST", "test_my_model");
        case "publish_agent":
          return await opPublish(args, ctx, "/account/agents", "POST", "publish_agent");
        case "list_agents":
          return await opPublish({ operation: "list" }, ctx, "/account/agents", "GET", "list_agents");
        case "update_agent":
          return await opPublish(args, ctx, `/account/agents/${encodeURIComponent(str(args, "id", 200))}`, "PATCH", "update_agent");
        case "delete_agent":
          return await opPublish(args, ctx, `/account/agents/${encodeURIComponent(str(args, "id", 200))}`, "DELETE", "delete_agent");
        case "sync_code_agent":
          return await opPublish(args, ctx, `/account/agents/${encodeURIComponent(str(args, "id", 200))}/sync`, "POST", "sync_code_agent");

        default:
          return {
            ok: false,
            code: 400,
            error: `Unknown operation "${operation}". Valid operations: ${OPERATIONS.join(", ")}.`,
          };
      }
    } catch (err) {
      return apiFail(err, `media_generation ${operation || "(no operation)"} failed`);
    }
  },
  false,
  "media",
);

// ---------------------------------------------------------------------------
// Operation implementations.
// ---------------------------------------------------------------------------

async function opListModels(args: Args, ctx: ToolContext, withModalities: boolean): Promise<Record<string, unknown> | ToolFail> {
  const modelsOr = await liveModels(ctx);
  if ("ok" in modelsOr && modelsOr.ok === false) return modelsOr;
  let models = modelsOr as PollinationsModel[];

  const category = str(args, "category", 20).toLowerCase();
  const search = str(args, "search", 200).toLowerCase();
  const freeOnly = bool(args, "free_only") === true;
  const limit = Math.min(50, Math.max(1, num(args, "limit") ?? (withModalities ? 15 : 30)));

  const totalBefore = models.length;
  if (category) models = models.filter((m) => String(m.category ?? "").toLowerCase() === category);
  if (freeOnly) models = models.filter((m) => isFreeModel(m));
  if (search) {
    models = models.filter((m) =>
      [m.name, m.title ?? "", m.publisher ?? "", m.description ?? "", (m.aliases ?? []).join(" ")]
        .join(" ")
        .toLowerCase()
        .includes(search),
    );
  }

  // FREE (0 pollen) models float to the top, marked recommended — then
  // healthy official, then the rest (never by hardcoded ids).
  const ranked = [...models].sort((a, b) => {
    const rank = (m: PollinationsModel): number => {
      const healthy = m.health?.status?.toLowerCase() === "healthy";
      if (isFreeModel(m) && healthy && !m.community) return 0;
      if (isFreeModel(m)) return 1;
      if (healthy && !m.community) return 2;
      if (healthy) return 3;
      return 4;
    };
    return rank(a) - rank(b) || a.name.localeCompare(b.name);
  });

  const showing = ranked.slice(0, limit);
  return {
    ok: true,
    operation: withModalities ? "list_models_with_modalities" : "list_models",
    fetched_live: true,
    total_in_catalogue: totalBefore,
    matched: ranked.length,
    showing: showing.length,
    note: ranked.length > showing.length ? `Showing the top ${showing.length} of ${ranked.length} matches — refine with category/search/free_only or raise limit (max 50).` : undefined,
    models: withModalities ? showing.map(enrichModel) : showing.map(modelSummary),
    pricing_note: "Prices are Pollen per unit, quoted from the provider's LIVE rates. free=true means every rate is zero (unlimited use at 0 pollen).",
  };
}

async function opModelDetails(args: Args, ctx: ToolContext): Promise<Record<string, unknown> | ToolFail> {
  const id = str(args, "model_id", 200) || str(args, "model", 200);
  if (!id) return { ok: false, code: 400, error: "Missing required parameter: model_id" };
  const modelsOr = await liveModels(ctx);
  if ("ok" in modelsOr && modelsOr.ok === false) return modelsOr;
  const model = findModel(modelsOr as PollinationsModel[], id);
  if (!model) {
    return { ok: false, code: 404, error: `Model "${id}" is not in the live Pollinations catalogue.`, hint: "Use list_models to see current ids — never guess model ids." };
  }
  return { ok: true, operation: "get_model_details", model: enrichModel(model) };
}

async function opSelectModel(args: Args, ctx: ToolContext): Promise<Record<string, unknown> | ToolFail> {
  const modelId = str(args, "model_id", 200) || str(args, "model", 200);
  const taskType = (str(args, "task_type", 20) || "") as TaskType;
  if (!modelId || !taskType) {
    return { ok: false, code: 400, error: "select_model requires model_id and task_type." };
  }
  const modelsOr = await liveModels(ctx);
  if ("ok" in modelsOr && modelsOr.ok === false) return modelsOr;
  const models = modelsOr as PollinationsModel[];
  const model = findModel(models, modelId);
  if (!model) {
    return { ok: false, code: 404, error: `Model "${modelId}" is not in the live catalogue.`, hint: "Use list_models for current ids." };
  }
  const support = modelSupports(model, taskType);
  if (!support.supported) {
    const alternatives = compatibleModels(models, taskType).slice(0, 5).map((m) => m.name);
    return {
      ok: false,
      code: 400,
      error: `${model.name} cannot serve ${taskType} (${support.reason}).`,
      hint: alternatives.length ? `Compatible: ${alternatives.join(", ")}.` : "No compatible model in the live catalogue.",
    };
  }
  // Sync the selection to the user's saved defaults for every modality
  // EXCEPT text (text stays on the main provider router).
  let synced = false;
  if (taskType !== "text" && (["image", "video", "audio", "realtime", "embedding", "3d"] as const).includes(taskType as "image")) {
    await usePollinationsStore.getState().setDefaultModel(taskType as ModalityKey, model.name);
    synced = true;
  }
  return {
    ok: true,
    operation: "select_model",
    model: model.name,
    task_type: taskType,
    valid: true,
    synced_to_settings: synced,
    model_info: modelSummary(model),
  };
}

async function opSetDefaultModel(args: Args, ctx: ToolContext): Promise<Record<string, unknown> | ToolFail> {
  const modality = str(args, "modality", 20).toLowerCase() as ModalityKey;
  const modelId = str(args, "model_id", 200) || str(args, "model", 200);
  if (!modality || !modelId) return { ok: false, code: 400, error: "set_default_model requires modality and model_id." };
  const validModalities = ["text", "image", "video", "audio", "realtime", "embedding", "3d"] as const;
  if (!validModalities.includes(modality as (typeof validModalities)[number])) {
    return { ok: false, code: 400, error: `modality must be one of ${validModalities.join(", ")}.` };
  }
  const modelsOr = await liveModels(ctx);
  if ("ok" in modelsOr && modelsOr.ok === false) return modelsOr;
  const model = findModel(modelsOr as PollinationsModel[], modelId);
  if (!model) {
    return { ok: false, code: 404, error: `Model "${modelId}" is not in the live catalogue.`, hint: "Use list_models for current ids." };
  }
  const support = modelSupports(model, modality);
  if (!support.supported) {
    return { ok: false, code: 400, error: `${model.name} cannot serve ${modality} (${support.reason}) — refusing to save an incompatible default.` };
  }
  await ensureStore(ctx);
  await usePollinationsStore.getState().setDefaultModel(modality, model.name);
  return { ok: true, operation: "set_default_model", modality, model: model.name, persisted: true };
}

async function opGetDefaultModels(ctx: ToolContext): Promise<Record<string, unknown>> {
  const store = await ensureStore(ctx);
  const state = store.getState();
  const modelsOr = await liveModels(ctx);
  const live = "ok" in modelsOr && modelsOr.ok === false ? [] : (modelsOr as PollinationsModel[]);
  const defaults = state.defaults;
  const report: Record<string, unknown> = {};
  for (const [modality, id] of Object.entries(defaults)) {
    if (!id) continue;
    const model = live.length ? findModel(live, id) : undefined;
    const stillValid = !!model;
    const supports = model ? modelSupports(model, modality as TaskType) : { supported: false, reason: "catalogue unavailable" };
    report[modality] = {
      model: id,
      valid: stillValid && supports.supported,
      ...(stillValid && !supports.supported ? { warning: supports.reason } : {}),
      ...(!stillValid ? { warning: "not in the live catalogue anymore", fallback_hint: "pick a replacement with select_model — never silently switch to a different-cost model." } : {}),
      ...(model ? { free: isFreeModel(model), price: priceLinesOf(model)[0] ?? "pricing unknown" } : {}),
    };
  }
  return {
    ok: true,
    operation: "get_default_models",
    defaults: report,
    note: Object.keys(report).length === 0 ? "No defaults saved yet — they are set automatically the first time a generation is confirmed, or via set_default_model." : undefined,
  };
}

async function opCheckBalance(ctx: ToolContext): Promise<Record<string, unknown> | ToolFail> {
  const tokenOr = await requireToken(ctx);
  if ("ok" in tokenOr && tokenOr.ok === false) return tokenOr;
  const token = (tokenOr as { token: string }).token;
  const store = await ensureStore(ctx);
  try {
    const balance = await accountCall<{ balance: number; accountBalance?: { total: number; tier: number; paid: number } }>(
      token,
      "/account/balance",
    );
    await store.getState().refreshBalance();
    return {
      ok: true,
      operation: "check_pollen_balance",
      balance: balance.balance,
      ...(balance.accountBalance
        ? {
            account_balance: balance.accountBalance,
            pollen_tiers: {
              total: balance.accountBalance.total,
              quest_pollen: balance.accountBalance.tier,
              paid_pollen: balance.accountBalance.paid,
              note: "Quest Pollen (tier) is earned from free daily credits/quests; Paid Pollen is topped up. paid_only models can ONLY spend Paid Pollen.",
            },
          }
        : {
            note: "The account-level Quest/Paid split was not returned (the connected key may lack the usage scope) — showing the caller-visible balance only. This is the REAL provider value, never an estimate.",
          }),
      checked_at: new Date().toISOString(),
    };
  } catch (err) {
    return apiFail(err, "Balance check failed");
  }
}

async function opGetUsage(args: Args, ctx: ToolContext): Promise<Record<string, unknown> | ToolFail> {
  const tokenOr = await requireToken(ctx);
  if ("ok" in tokenOr && tokenOr.ok === false) return tokenOr;
  const token = (tokenOr as { token: string }).token;
  const days = Math.min(90, Math.max(1, num(args, "days") ?? 30));
  const limit = Math.min(100, Math.max(1, num(args, "limit") ?? 25));
  try {
    const usage = await accountCall<{ usage?: Array<Record<string, unknown>> }>(
      token,
      "/account/usage",
      { query: { limit, days } },
    );
    const rows = Array.isArray(usage?.usage) ? usage.usage : [];
    const store = usePollinationsStore.getState();
    const localLog = store.activityLog.slice(0, limit);
    const totalCost = rows.reduce((sum, r) => sum + (Number(r.cost) || 0), 0);
    return {
      ok: true,
      operation: "get_usage_information",
      window_days: days,
      provider_usage: rows.map((r) => ({
        timestamp: r.timestamp,
        type: r.type,
        model: r.model,
        cost_pollen: r.cost,
        meter_source: r.meter_source === "tier" ? "Quest Pollen" : r.meter_source === "pack" ? "Paid Pollen" : r.meter_source,
        tokens: { in: r.input_text_tokens, out: r.output_text_tokens },
      })),
      provider_total_cost_pollen: Number(totalCost.toFixed(6)),
      cost_note: "Provider rows are ACTUAL reported costs (post-generation). Local log entries below carry the ESTIMATED cost shown at confirmation time — estimates and actuals are labelled distinctly and never mixed.",
      local_activity_log: localLog,
    };
  } catch (err) {
    return apiFail(err, "Usage information failed");
  }
}

async function opConnectionStatus(ctx: ToolContext): Promise<Record<string, unknown>> {
  const store = await ensureStore(ctx);
  const s = store.getState();
  const meta = s.connectionMeta;
  return {
    ok: true,
    operation: "connection_status",
    connected: s.connectionStatus === "connected",
    status: s.connectionStatus,
    method: meta?.method ?? null,
    connected_at: meta?.connectedAt ?? null,
    expires_at: meta?.expiresAt ?? null,
    expired: !!meta?.expiresAt && new Date(meta.expiresAt).getTime() <= Date.now(),
    scope: meta?.scope ?? null,
    profile: meta?.profile ?? null,
    balance: s.balance,
    balance_error: s.balanceError,
    defaults_saved: s.defaults,
    hint:
      s.connectionStatus === "disconnected"
        ? "Connect via Settings → Pollinations AI (official OAuth or paste an API key from https://enter.pollinations.ai/keys)."
        : s.connectionStatus === "expired"
          ? "The authorized key expired (no refresh tokens exist) — reconnect from Settings → Pollinations AI."
          : undefined,
  };
}

async function opGenerateText(args: Args, ctx: ToolContext): Promise<Record<string, unknown> | ToolFail> {
  const tokenOr = await requireToken(ctx);
  if ("ok" in tokenOr && tokenOr.ok === false) return tokenOr;
  const token = (tokenOr as { token: string }).token;

  const modelsOr = await liveModels(ctx);
  if ("ok" in modelsOr && modelsOr.ok === false) return modelsOr;
  const models = modelsOr as PollinationsModel[];
  const requested = str(args, "model", 200);
  const store = usePollinationsStore.getState();
  const want = requested || store.defaults.text || "";
  const model = (want ? findModel(models, want) : undefined) ?? pickDefaultModel(models, "text") ?? undefined;
  if (!model) return { ok: false, code: 404, error: "No text model available in the live catalogue." };
  const support = modelSupports(model, "text");
  if (!support.supported) {
    return { ok: false, code: 400, error: `${model.name} does not generate text (${support.reason}).`, hint: `Try: ${compatibleModels(models, "text").slice(0, 5).map((m) => m.name).join(", ")}.` };
  }

  const prompt = str(args, "prompt", 32_000);
  const messages = Array.isArray(args.messages) ? (args.messages as Array<{ role: string; content: string }>) : null;
  if (!prompt && !messages) return { ok: false, code: 400, error: "generate_text requires prompt or messages." };

  const estimate = estimateCost(model, "text", { inputChars: prompt.length });
  const free = isFreeModel(model);
  const confirmedOr = await runConfirmationFlow({
    operation: "generate_text",
    kind: "text",
    task: "text",
    model,
    prompt: prompt || (messages ?? []).map((m) => `${m.role}: ${m.content}`).join("\n").slice(0, 2000),
    params: [
      { label: "Messages", value: messages ? `${messages.length} message${messages.length > 1 ? "s" : ""}` : "1 prompt" },
      ...(str(args, "system", 8000) ? [{ label: "System", value: "set" }] : []),
    ],
    estimate: { ...toConfirmEstimate(estimate), pollen: null },
    ctx,
  });
  if ("cancelled" in confirmedOr) return { ok: false, code: 499, cancelled: true, error: confirmedOr.reason, model: model.name };
  if ("ok" in confirmedOr && confirmedOr.ok === false) return confirmedOr;
  const plan = (confirmedOr as { plan: ConfirmedPlan }).plan;

  const { jobId, controller } = startJob({ operation: "generate_text", kind: "text", model: model.name, prompt: plan.prompt.slice(0, 2000), estimatedPollen: null });
  const signal = mergeSignals(ctx.signal, controller.signal);
  const startedAt = Date.now();
  try {
    const res = await generateText(
      token,
      {
        model: model.name,
        ...(messages ? { messages } : { prompt: plan.prompt }),
        ...(str(args, "system", 8000) ? { system: str(args, "system", 8000) } : {}),
        ...(num(args, "temperature") !== undefined ? { temperature: num(args, "temperature") } : {}),
        ...(num(args, "max_tokens") !== undefined ? { max_tokens: num(args, "max_tokens") } : {}),
      },
      signal,
    );
    const text = res.result?.choices?.[0]?.message?.content ?? "";
    const timeMs = Date.now() - startedAt;
    finishJob(jobId, { status: "completed", timeMs, url: null });
    return {
      ok: true,
      operation: "generate_text",
      model: model.name,
      model_title: model.title ?? model.name,
      text,
      usage: res.result?.usage ?? null,
      time_ms: timeMs,
      cost: { free, estimated_pollen: null, estimate_basis: formatEstimate(estimate), actual_pollen: null },
      job_id: jobId,
    };
  } catch (err) {
    if (signal.aborted) {
      finishJob(jobId, { status: "cancelled", error: "cancelled" });
      return { ok: false, code: 499, cancelled: true, error: "Text generation cancelled.", job_id: jobId };
    }
    const fail = apiFail(err, "Text generation failed");
    finishJob(jobId, { status: "failed", error: fail.error });
    return { ...fail, job_id: jobId };
  }
}

async function opTranscribe(args: Args, ctx: ToolContext): Promise<Record<string, unknown> | ToolFail> {
  const tokenOr = await requireToken(ctx);
  if ("ok" in tokenOr && tokenOr.ok === false) return tokenOr;
  const token = (tokenOr as { token: string }).token;

  const url = str(args, "url", 8192) || str(args, "audio_url", 8192);
  if (!url) return { ok: false, code: 400, error: "transcribe_audio requires url (a public audio URL: mp3/mp4/mpeg/mpga/m4a/wav/webm)." };

  const modelsOr = await liveModels(ctx);
  if ("ok" in modelsOr && modelsOr.ok === false) return modelsOr;
  const modelOr = await resolveModelForTask(ctx, "transcription", str(args, "model", 200));
  if ("ok" in modelOr && modelOr.ok === false) return modelOr;
  const model = (modelOr as { model: PollinationsModel }).model;

  const estimate = estimateCost(model, "transcription", {});
  const confirmedOr = await runConfirmationFlow({
    operation: "transcribe_audio",
    kind: "transcription",
    task: "transcription",
    model,
    prompt: `Transcribe ${url}`,
    params: [
      { label: "Audio", value: url.slice(0, 120) },
      ...(str(args, "language", 8) ? [{ label: "Language", value: str(args, "language", 8) }] : []),
      { label: "Output", value: str(args, "response_format", 20) || "json" },
    ],
    estimate: { ...toConfirmEstimate(estimate), pollen: null },
    ctx,
  });
  if ("cancelled" in confirmedOr) return { ok: false, code: 499, cancelled: true, error: confirmedOr.reason, model: model.name };
  if ("ok" in confirmedOr && confirmedOr.ok === false) return confirmedOr;

  const { jobId, controller } = startJob({ operation: "transcribe_audio", kind: "transcription", model: model.name, prompt: url.slice(0, 300), estimatedPollen: null });
  const signal = mergeSignals(ctx.signal, controller.signal);
  const startedAt = Date.now();
  try {
    const res = await transcribeAudio(
      token,
      {
        url,
        model: model.name,
        ...(str(args, "language", 8) ? { language: str(args, "language", 8) } : {}),
        ...(str(args, "response_format", 20) ? { response_format: str(args, "response_format", 20) } : {}),
      },
      signal,
    );
    const timeMs = Date.now() - startedAt;
    finishJob(jobId, { status: "completed", timeMs });
    return {
      ok: true,
      operation: "transcribe_audio",
      model: model.name,
      transcript: res.result && typeof res.result === "object" && "text" in (res.result as Record<string, unknown>)
        ? (res.result as { text?: string }).text
        : res.transcript ?? null,
      full_result: res.result ?? null,
      time_ms: timeMs,
      cost: { free: isFreeModel(model), estimated_pollen: null, estimate_basis: formatEstimate(estimate), actual_pollen: null },
      job_id: jobId,
    };
  } catch (err) {
    if (signal.aborted) {
      finishJob(jobId, { status: "cancelled", error: "cancelled" });
      return { ok: false, code: 499, cancelled: true, error: "Transcription cancelled.", job_id: jobId };
    }
    const fail = apiFail(err, "Transcription failed");
    finishJob(jobId, { status: "failed", error: fail.error });
    return { ...fail, job_id: jobId };
  }
}

async function opEmbeddings(args: Args, ctx: ToolContext): Promise<Record<string, unknown> | ToolFail> {
  const tokenOr = await requireToken(ctx);
  if ("ok" in tokenOr && tokenOr.ok === false) return tokenOr;
  const token = (tokenOr as { token: string }).token;

  const rawInput = args.input;
  let input: string | string[];
  if (typeof rawInput === "string") {
    input = rawInput;
  } else if (Array.isArray(rawInput)) {
    input = rawInput.map((v) => String(v ?? "")).slice(0, 32);
  } else {
    return { ok: false, code: 400, error: "generate_embeddings requires input (string or array of strings)." };
  }
  const totalChars = (Array.isArray(input) ? input.join("") : input).length;

  const modelsOr = await liveModels(ctx);
  if ("ok" in modelsOr && modelsOr.ok === false) return modelsOr;
  const modelOr = await resolveModelForTask(ctx, "embedding", str(args, "model", 200));
  if ("ok" in modelOr && modelOr.ok === false) return modelOr;
  const model = (modelOr as { model: PollinationsModel }).model;

  const estimate = estimateCost(model, "embeddings", { inputChars: totalChars });
  const preview = (Array.isArray(input) ? input.join(" ") : input).slice(0, 200);
  const confirmedOr = await runConfirmationFlow({
    operation: "generate_embeddings",
    kind: "embeddings",
    task: "embedding",
    model,
    prompt: preview,
    params: [
      { label: "Items", value: String(Array.isArray(input) ? input.length : 1) },
      { label: "Characters", value: String(totalChars) },
      ...(num(args, "dimensions") !== undefined ? [{ label: "Dimensions", value: String(num(args, "dimensions")) }] : []),
    ],
    estimate: { ...estimate, pollen: estimate.kind === "estimate" ? estimate.pollen : null },
    ctx,
  });
  if ("cancelled" in confirmedOr) return { ok: false, code: 499, cancelled: true, error: confirmedOr.reason, model: model.name };
  if ("ok" in confirmedOr && confirmedOr.ok === false) return confirmedOr;

  const { jobId, controller } = startJob({ operation: "generate_embeddings", kind: "embeddings", model: model.name, prompt: preview, estimatedPollen: estimate.kind === "estimate" ? estimate.pollen : null });
  const signal = mergeSignals(ctx.signal, controller.signal);
  try {
    const res = await generateEmbeddings(token, { model: model.name, input, ...(num(args, "dimensions") !== undefined ? { dimensions: num(args, "dimensions") } : {}) }, signal);
    finishJob(jobId, { status: "completed", url: null });
    const data = res.result?.data ?? [];
    return {
      ok: true,
      operation: "generate_embeddings",
      model: model.name,
      count: data.length,
      dimensions: data[0]?.embedding?.length ?? null,
      // Vectors stay summarized — never dump thousands of floats into chat.
      preview: data[0]?.embedding?.slice(0, 8) ?? [],
      usage: res.result?.usage ?? null,
      cost: { free: isFreeModel(model), estimated_pollen: estimate.kind === "estimate" ? estimate.pollen : null, estimate_basis: formatEstimate(estimate), actual_pollen: null },
      job_id: jobId,
    };
  } catch (err) {
    if (signal.aborted) {
      finishJob(jobId, { status: "cancelled", error: "cancelled" });
      return { ok: false, code: 499, cancelled: true, error: "Embeddings cancelled.", job_id: jobId };
    }
    const fail = apiFail(err, "Embeddings failed");
    finishJob(jobId, { status: "failed", error: fail.error });
    return { ...fail, job_id: jobId };
  }
}

// ── Jobs ──────────────────────────────────────────────────────────────────

function opJobStatus(jobId: string): Record<string, unknown> | ToolFail {
  if (!jobId) return { ok: false, code: 400, error: "Missing required parameter: job_id" };
  const job = usePollinationsStore.getState().getJob(jobId);
  if (!job) return { ok: false, code: 404, error: `Unknown job_id "${jobId}".`, hint: "Use list_generation_history to see recent jobs." };
  return {
    ok: true,
    operation: "get_generation_status",
    job,
    progress_note:
      job.status === "running"
        ? "The provider exposes no progress percentages — this is the truthful live state (running, with elapsed time), never an invented progress bar."
        : undefined,
  };
}

async function opWaitForGeneration(jobId: string, timeoutSec: number, ctx: ToolContext): Promise<Record<string, unknown> | ToolFail> {
  if (!jobId) return { ok: false, code: 400, error: "Missing required parameter: job_id" };
  const deadline = Date.now() + Math.min(600, Math.max(5, timeoutSec)) * 1000;
  while (Date.now() < deadline) {
    if (ctx.signal?.aborted) break;
    const job = usePollinationsStore.getState().getJob(jobId);
    if (!job) return { ok: false, code: 404, error: `Unknown job_id "${jobId}".` };
    if (job.status !== "running" && job.status !== "pending") {
      return { ok: true, operation: "wait_for_generation", job };
    }
    await new Promise((r) => window.setTimeout(r, 1000));
  }
  const job = usePollinationsStore.getState().getJob(jobId);
  return {
    ok: true,
    operation: "wait_for_generation",
    timed_out: true,
    job,
    note: "Still running after the wait window — the provider does not expose progress; call again or check the job later.",
  };
}

function opCancelGeneration(jobId: string): Record<string, unknown> | ToolFail {
  if (!jobId) return { ok: false, code: 400, error: "Missing required parameter: job_id" };
  const store = usePollinationsStore.getState();
  const job = store.getJob(jobId);
  if (!job) return { ok: false, code: 404, error: `Unknown job_id "${jobId}".` };
  if (job.status === "completed") {
    return { ok: true, operation: "cancel_generation", cancelled: false, job, note: "The job already completed — it cannot be cancelled (and no duplicate charge is created by this call)." };
  }
  if (job.status === "cancelled" || job.status === "failed") {
    return { ok: true, operation: "cancel_generation", cancelled: true, already: true, job };
  }
  const controller = jobAbortControllers.get(jobId);
  controller?.abort();
  store.updateJob(jobId, { status: "cancelled", endedAt: new Date().toISOString() });
  jobAbortControllers.delete(jobId);
  return {
    ok: true,
    operation: "cancel_generation",
    cancelled: true,
    job: store.getJob(jobId),
    note: "The in-flight request was aborted. The provider may still bill an already-started generation once — check get_usage_information for the actual outcome.",
  };
}

function opJobHistory(limit: number): Record<string, unknown> {
  const store = usePollinationsStore.getState();
  const n = Math.min(50, Math.max(1, limit));
  return {
    ok: true,
    operation: "list_generation_history",
    jobs: store.jobs.slice(0, n),
    activity_log: store.activityLog.slice(0, n),
    note: "Jobs live in this browser session; the activity log is persisted per user.",
  };
}

// ── Publishing (models + agents) ─────────────────────────────────────────

async function opPublish(
  args: Args,
  ctx: ToolContext,
  path: string,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  operation: string,
): Promise<Record<string, unknown> | ToolFail> {
  const tokenOr = await requireToken(ctx);
  if ("ok" in tokenOr && tokenOr.ok === false) return tokenOr;
  const token = (tokenOr as { token: string }).token;

  const config = obj(args, "config");
  if ((method === "POST" || method === "PATCH") && !config) {
    return {
      ok: false,
      code: 400,
      error: `${operation} requires a \`config\` object (the official request body).`,
      hint:
        operation === "publish_model"
          ? 'e.g. {name, api: "chat_completions", url, pricing: {…}} — see https://gen.pollinations.ai/docs → Publish a Model.'
          : operation === "publish_agent"
            ? 'e.g. {name, type: "prompt", model, instructions} or {name, type: "code", repoUrl} — see Publish an Agent.'
            : "Pass the update patch as config.",
    };
  }
  try {
    const result = await accountCall<unknown>(token, path, { method, body: config ?? undefined });
    await usePollinationsStore.getState().logActivity({
      operation,
      status: "completed",
      detail: `${method} ${path}`,
    });
    return { ok: true, operation, result };
  } catch (err) {
    const fail = apiFail(err, `${operation} failed`);
    await usePollinationsStore.getState().logActivity({ operation, status: "failed", detail: fail.error });
    if (fail.code === 403) {
      return {
        ...fail,
        hint: "Publishing requires a key with the `keys` scope — reconnect from Settings → Pollinations AI granting key management, or publish via the dashboard at https://enter.pollinations.ai.",
      };
    }
    return fail;
  }
}

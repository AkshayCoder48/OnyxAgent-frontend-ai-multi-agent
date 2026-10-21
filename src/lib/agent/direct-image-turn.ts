"use client";

/**
 * DIRECT IMAGE TURN — `/image <prompt>` (user request 2026-10-21: "add /image
 * that directly triggers image gen, not call text api to make image gen call").
 *
 * Generates an image WITHOUT a single text-model round-trip: no agent
 * runtime, no tool-calling loop, no LLM request at all. The prompt goes
 * through the exact same guarded path the media_generation tool uses —
 *   1. the mandatory TWO-STEP CONFIRMATION dialog (pollinations-confirm —
 *      prompt editable, cost estimate shown, AI enhancement available), and
 *   2. the /api/pollinations/generate server choke-point with the user's own
 *      BYOP key,
 * then the result lands in the chat as a persisted markdown image message.
 *
 * The turn runs through the execution hub like any other turn — streaming
 * placeholder, Stop button support, Dexie persistence, sidebar refresh — so
 * `/image` behaves like a first-class chat action, not a bolt-on.
 */

import { nanoid } from "nanoid";
import { executionHub } from "@/lib/agent/execution-hub";
import { conversationService } from "@/lib/services";
import { generateMedia, generateText } from "@/lib/pollinations/api";
import {
  compatibleModels,
  estimateCost,
  findModel,
  isFreeModel,
  pickDefaultModel,
  priceLinesOf,
  tierOf,
} from "@/lib/pollinations/capabilities";
import { usePollinationsStore } from "@/lib/pollinations/store";
import {
  CONFIRM_RESPONSE_EVENT,
  toConfirmEstimate,
  type ConfirmAction,
  type ConfirmModelInfo,
  type ConfirmRequestPayload,
  type PollinationsModel,
} from "@/lib/pollinations/types";
import type { WSEvent } from "@/types";

const CONFIRM_TIMEOUT_MS = 15 * 60 * 1000; // dialog auto-cancel (tool parity)

/** Mirror of the tool's confirmModelInfo — the dialog renders this shape. */
function confirmModelInfo(m: PollinationsModel): ConfirmModelInfo {
  return {
    id: m.name,
    title: (m.title as string | undefined) ?? m.name,
    publisher: (m.publisher as string | undefined) ?? "unknown",
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

/** Standalone re-implementation of the tool's waitForConfirmation — the
 *  direct turn has no ToolContext, so the emit goes straight to the
 *  processor sink and the abort comes from the execution's controller. */
function waitForConfirmation(
  payload: ConfirmRequestPayload,
  emit: (e: WSEvent) => void,
  signal?: AbortSignal,
): Promise<ConfirmAction> {
  return new Promise((resolve) => {
    let settled = false;
    const cleanup = () => {
      window.removeEventListener(CONFIRM_RESPONSE_EVENT, onEvent);
      signal?.removeEventListener("abort", onAbort);
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
    signal?.addEventListener("abort", onAbort);
    usePollinationsStore.getState().setPendingConfirmation(payload);
    emit({
      type: "media_generation_confirm",
      data: payload,
      timestamp: new Date().toISOString(),
    });
  });
}

/** Free-text-model prompt enhancement (tool parity — enhancement NEVER
 *  consumes Pollen; with no free text model available it honestly declines). */
async function enhanceImagePrompt(
  token: string,
  models: PollinationsModel[],
  prompt: string,
): Promise<string | null> {
  const store = usePollinationsStore.getState();
  const configured = store.defaults.text ? findModel(models, store.defaults.text) : undefined;
  const freeDefault = configured && isFreeModel(configured) ? configured : undefined;
  const enhancer =
    freeDefault ??
    compatibleModels(models, "text").find((m) => isFreeModel(m) && !m.community) ??
    compatibleModels(models, "text").find((m) => isFreeModel(m));
  if (!enhancer) return null;
  try {
    const res = await generateText(token, {
      model: enhancer.name,
      prompt,
      system:
        "You improve prompts for AI image generation. Rewrite the user's prompt into one vivid, concrete prompt (max 80 words): keep their EXACT subject and intent, then enrich composition, style, lighting, camera angle, mood and quality terms. Output ONLY the improved prompt — no preamble, no quotes, no explanations.",
      temperature: 0.7,
      max_tokens: 300,
    });
    const improved = (res.result?.choices?.[0]?.message?.content ?? "").trim();
    return improved || null;
  } catch {
    return null;
  }
}

export interface DirectImageTurnInput {
  userId: string;
  prompt: string;
  conversationId: string | null;
  onConversationCreated?: (conversationId: string) => void;
}

/**
 * Run the whole direct-generation turn. Never throws — every failure path
 * settles the execution honestly (visible chat error or a saved cancel
 * note), mirroring the runtime's guarantees.
 */
export async function runDirectImageTurn(input: DirectImageTurnInput): Promise<void> {
  const { userId, prompt } = input;
  let conversationId = input.conversationId;

  // ── EXECUTION (hub-owned: placeholder, Stop support, persistence) ──────
  const execution = executionHub.createExecution({
    conversationId,
    mode: "foreground",
    onConversationCreated: input.onConversationCreated,
  });
  const emitRaw = execution.processor.handle as (e: WSEvent) => void;
  const signal = execution.abortController?.signal;
  const generationId = nanoid();
  const assistantMessageId = nanoid();
  const turnStartedAt = Date.now();
  // GENERATION-ID WRAPPER (runtime parity — wrapEmitWithGenerationId): every
  // event carries data.generation_id, and data-less events get data injected.
  // The processor's honest-durations tracker reads data?.ts unguarded by the
  // WSEvent type — a bare data-less `complete` crashed it ("reading 'ts'").
  const emit = (event: WSEvent): void => {
    if (event.data && typeof event.data === "object") {
      emitRaw({
        ...event,
        data: { ...(event.data as Record<string, unknown>), generation_id: generationId },
      });
    } else if (event.data === undefined) {
      emitRaw({ ...event, data: { generation_id: generationId } });
    } else {
      emitRaw(event);
    }
  };

  const finishWith = async (content: string, opts?: { failed?: boolean; errorMessage?: string }) => {
    const durationMs = Math.max(0, Date.now() - turnStartedAt);
    if (opts?.failed) {
      // ERROR-PATH ORDER (runtime parity): the error event appends the
      // visible ❌ text to the STORE message and settles the execution
      // (onTurnEnd → finishExecution); the Dexie checkpoint below then
      // persists the same honest note under the stable id so a reload
      // shows it too.
      emit({
        type: "error",
        data: {
          message:
            opts.errorMessage ??
            "Image generation failed — nothing was generated and no Pollen was spent.",
        },
        timestamp: new Date().toISOString(),
      });
      try {
        await conversationService.saveAgentCheckpoint(
          conversationId!,
          userId,
          assistantMessageId,
          {
            role: "assistant",
            content,
            modelName: "Pollinations image",
            isStreaming: false,
            generation: {
              startedAt: turnStartedAt,
              completedAt: Date.now(),
              durationMs,
              failed: true as const,
            },
          },
        );
      } catch (err) {
        console.warn("[direct-image] failed to persist assistant message:", err);
      }
      return;
    }
    try {
      await conversationService.saveAgentCheckpoint(
        conversationId!,
        userId,
        assistantMessageId,
        {
          role: "assistant",
          content,
          modelName: "Pollinations image",
          isStreaming: false,
          generation: {
            startedAt: turnStartedAt,
            completedAt: Date.now(),
            durationMs,
          },
        },
      );
    } catch (err) {
      console.warn("[direct-image] failed to persist assistant message:", err);
    }
    emit({
      type: "message_saved",
      data: { message_id: assistantMessageId, generation_id: generationId },
      timestamp: new Date().toISOString(),
    });
    emit({
      type: "final_result",
      data: { output: content, tool_events: [] },
      timestamp: new Date().toISOString(),
    });
    emit({ type: "complete", timestamp: new Date().toISOString() });
  };

  // Live status text accumulator — declared at turn scope so the catch
  // path can persist whatever already streamed.
  let streamed = "";
  const stream = (text: string) => {
    streamed += text;
    emit({
      type: "text_delta",
      data: { index: 0, content: text, generation_id: generationId },
      timestamp: new Date().toISOString(),
    });
  };

  try {
    // ── 1. USER MESSAGE (store-optimistic, Dexie-persisted) ──────────────
    const userMessageId = nanoid();
    execution.processor.setUserMessageId(userMessageId);
    execution.store.getState().addMessage({
      id: userMessageId,
      role: "user",
      content: `/image ${prompt}`,
      timestamp: new Date(),
      conversationId: conversationId ?? undefined,
    });
    if (!conversationId) {
      const collapsed = prompt.replace(/\s+/g, " ").trim();
      const title = `/image ${collapsed.length > 53 ? collapsed.slice(0, 53) + "…" : collapsed}`;
      const conv = await conversationService.create(userId, title);
      conversationId = conv.id;
      emit({
        type: "conversation_created",
        data: { conversation_id: conv.id },
        timestamp: new Date().toISOString(),
      });
    }
    const userRow = await conversationService.addMessage(conversationId, userId, {
      role: "user",
      content: `/image ${prompt}`,
    });
    emit({
      type: "user_prompt",
      data: { message: `/image ${prompt}`, message_id: userRow.id },
      timestamp: new Date().toISOString(),
    });

    // ── 2. ASSISTANT PLACEHOLDER + LIVE STATUS TEXT ─────────────────────
    emit({
      type: "model_request_start",
      data: { round: 1, generation_id: generationId, model: "Pollinations image" },
      timestamp: new Date().toISOString(),
    });
    stream(
      `🎨 **Direct image generation** — *no text model involved, this prompt goes straight to the image endpoint.*\n\n`,
    );

    // ── 3. CONNECTION + MODEL RESOLUTION ────────────────────────────────
    const store = usePollinationsStore.getState();
    await store.init(userId);
    const token = usePollinationsStore.getState().getToken();
    if (!token) {
      stream(
        "Image generation uses your own Pollinations key (BYOP) — none is connected yet.\n\n" +
          "**Connect your Pollinations account to use /image:** open **Settings → Pollinations AI → Connect** (official OAuth), " +
          "or paste a key from https://enter.pollinations.ai/keys. Then run /image again.",
      );
      await finishWith(streamed);
      return;
    }

    let models = usePollinationsStore.getState().models;
    if (models.length === 0) {
      stream("*Fetching the live image model catalogue…*\n\n");
      models = await usePollinationsStore.getState().refreshModels();
    }
    const defaults = usePollinationsStore.getState().defaults;
    const model =
      (defaults.image ? findModel(models, defaults.image) : undefined) ??
      pickDefaultModel(models, "image");
    if (!model) {
      stream(
        "*No image model is currently available in the catalogue.*\n\n" +
          "The live Pollinations catalogue returned no image models — the provider may be having a moment. Try again shortly.",
      );
      await finishWith(streamed, {
        failed: true,
        errorMessage: "No image model is currently available in the live Pollinations catalogue — try again shortly.",
      });
      return;
    }

    // ── 4. MANDATORY TWO-STEP CONFIRMATION (tool parity) ────────────────
    const prefs = usePollinationsStore.getState().prefs;
    const estimate = toConfirmEstimate(estimateCost(model, "image", {}));
    const params: Array<{ label: string; value: string }> = [
      { label: "Width", value: String(prefs.imageWidth) },
      { label: "Height", value: String(prefs.imageHeight) },
      { label: "Endpoint", value: "GET /image/{prompt}" },
    ];
    const free = isFreeModel(model);
    let finalPrompt = prompt;
    let originalPrompt: string | undefined;

    let prep: ConfirmAction = await waitForConfirmation(
      {
        requestId: `pln_${nanoid(12)}`,
        stage: "prepare",
        operation: "generate_image",
        kind: "image",
        model: confirmModelInfo(model),
        prompt: finalPrompt,
        params,
        estimate,
        free,
        issuedAt: new Date().toISOString(),
      },
      emit,
      signal,
    );
    // AI PROMPT ENHANCEMENT (free text model only — never generates media).
    while (prep.action === "enhance") {
      const enhanced = await enhanceImagePrompt(token, models, finalPrompt);
      if (enhanced) {
        originalPrompt = originalPrompt ?? finalPrompt;
        finalPrompt = enhanced;
      }
      prep = await waitForConfirmation(
        {
          requestId: `pln_${nanoid(12)}`,
          stage: "prepare",
          operation: "generate_image",
          kind: "image",
          model: confirmModelInfo(model),
          prompt: finalPrompt,
          ...(originalPrompt ? { originalPrompt } : {}),
          params,
          estimate,
          free,
          warning: enhanced
            ? "Prompt was AI-enhanced by a free text model — review and edit freely before generating."
            : "No FREE text model is available for enhancement right now — edit the prompt manually instead.",
          issuedAt: new Date().toISOString(),
        },
        emit,
        signal,
      );
    }
    if (prep.action === "cancel" || prep.action === "reject") {
      stream("Image generation cancelled — nothing was generated and no Pollen was spent.");
      await finishWith(streamed);
      return;
    }
    if (prep.action === "use" && typeof prep.prompt === "string" && prep.prompt.trim()) {
      finalPrompt = prep.prompt.trim();
    }
    if (!free) {
      const final: ConfirmAction = await waitForConfirmation(
        {
          requestId: `pln_${nanoid(12)}`,
          stage: "confirm",
          operation: "generate_image",
          kind: "image",
          model: confirmModelInfo(model),
          prompt: finalPrompt,
          ...(originalPrompt ? { originalPrompt } : {}),
          params,
          estimate,
          free,
          issuedAt: new Date().toISOString(),
        },
        emit,
        signal,
      );
      if (final.action !== "confirm") {
        stream("Image generation cancelled — nothing was generated and no Pollen was spent.");
        await finishWith(streamed);
        return;
      }
      if (typeof final.prompt === "string" && final.prompt.trim()) {
        finalPrompt = final.prompt.trim();
      }
    }
    if (signal?.aborted) return; // user pressed Stop during the dialog

    // ── 5. GENERATE (the single provider call — no text LLM anywhere) ───
    stream(`Generating with **${model.title ?? model.name}**…\n\n`);
    const result = await generateMedia(
      token,
      "image",
      {
        prompt: finalPrompt,
        model: model.name,
        width: prefs.imageWidth,
        height: prefs.imageHeight,
        ...(prefs.safe ? { safe: prefs.safe } : {}),
      },
      signal,
    );
    const url = result.url ?? result.b64 ?? null;
    if (!url) {
      stream("The provider returned no image. Nothing was charged.");
      await finishWith(streamed, {
        failed: true,
        errorMessage: "The provider returned no image (empty result) — nothing was charged. Try again or pick a different image model.",
      });
      return;
    }
    const seconds = (result.timeMs / 1000).toFixed(1);
    stream(
      `![${finalPrompt.replace(/[\[\]]/g, "")}](${url})\n\n` +
        `*Model:* \`${model.name}\` · *Size:* ${prefs.imageWidth}×${prefs.imageHeight} · *Took:* ${seconds}s\n\n` +
        `---\nGenerated directly with \`/image\` — no text model was involved. Run \`/image <prompt>\` again for another.`,
    );
    await finishWith(streamed);
  } catch (err) {
    // ABORT ≠ ERROR: the Stop button aborts the fetch / confirm wait — the
    // hub already finalized the execution (markStoppedByUser).
    if (signal?.aborted) return;
    const message = err instanceof Error ? err.message : String(err);
    console.error("[direct-image] generation failed:", err);
    await finishWith(`${streamed}\n\n❌ Image generation failed: ${message}`, {
      failed: true,
      errorMessage: `Image generation failed: ${message}`,
    });
  }
}

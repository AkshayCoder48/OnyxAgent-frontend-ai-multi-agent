"use client";

import { nanoid } from "nanoid";
import { useSubagentStore, type SubagentConfig, type SubagentMessage } from "@/stores/subagent-store";
import { useAuthStore } from "@/stores";
import { aiProviderService, settingsService } from "@/lib/services";
import { listTools } from "@/lib/tools/registry";
import { ensureToolDigest, promptKb } from "@/lib/agent/tool-digest";
import {
  applyParamPolicy,
  learnParamBan,
  parseUnsupportedParam,
} from "@/lib/agent/param-policy";
import {
  buildWireMessages,
  getWireCompat,
  nextStrictGatewayStep,
  wireAllowsTools,
} from "@/lib/agent/wire-compat";
import { stripFunctionCallTags } from "@/lib/text-sanitizer";
import { logError, logWarn } from "@/lib/client-logger";
import { extractStreamError } from "@/lib/agent/stream-guards";
import {
  malformedToolResult,
  parseToolCallArguments,
  wireSafeArguments,
} from "@/lib/agent/tool-args";

/**
 * Subagent runtime — executes subagent tasks by calling the LLM API with
 * REAL STREAMING (SSE). Streams text back token-by-token to the subagent
 * chat sidebar.
 *
 * Uses sessions (persisted to localStorage) so chats survive page refresh.
 * Each session is a separate conversation with a subagent.
 *
 * Fixes applied:
 * - Passes reasoning_content back to the API (required by DeepSeek/moonshot)
 * - Adds Accept: text/event-stream + cache: no-store (curl -N equivalent)
 * - Streams tool call args live (shows tool card immediately, not after stream ends)
 * - No 60ms throttle (flush immediately like main chat)
 * - Tool calls execute in parallel
 * - PRD §34/§35: Shares the SAME E2B sandbox as the main agent — subagents
 *   receive the real `e2bApiKey` + `sandboxApiKey` + `envVars` so file
 *   operations performed by a subagent hit the same workspace the main
 *   agent sees. Previously `e2bApiKey: undefined` silently stripped sandbox
 *   access from every subagent tool call.
 */

interface ChatCompletionMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  name?: string;
  reasoning_content?: string;
}

async function resolveApiConfig(subagent: SubagentConfig) {
  const userId = useAuthStore.getState().user?.id;
  if (!userId) throw new Error("No authenticated user");

  const providers = await aiProviderService.list(userId);
  if (providers.length === 0) throw new Error("No AI providers configured. Add one in Settings → Config.");

  const { selectedProviderId, selectedModel } = await import("@/stores/chat-store").then(m => {
    const store = m.useChatStore.getState();
    return { selectedProviderId: store.selectedProviderId, selectedModel: store.selectedModel };
  });

  let provider = subagent.providerId
    ? providers.find((p) => p.id === subagent.providerId)
    : selectedProviderId
      ? providers.find((p) => p.id === selectedProviderId)
      : providers.find((p) => p.is_active) || providers[0];
  if (!provider) provider = providers[0];
  if (!provider) throw new Error("No provider available");

  let apiKey = subagent.apiKey;
  if (!apiKey) {
    apiKey = await aiProviderService.getDecryptedApiKey(provider.id);
  }
  if (!apiKey) throw new Error(`No API key for provider "${provider.name}"`);

  const model = subagent.model || selectedModel || provider.models[0] || "gpt-4o-mini";
  const baseUrl = subagent.baseUrl || provider.base_url;
  const noPrefix = (provider as { no_prefix?: boolean }).no_prefix ?? false;

  return {
    provider,
    apiKey,
    model,
    baseUrl,
    noPrefix,
    toolsEnabled: provider.tools_enabled,
    thinkingEnabled: (provider as { thinking_enabled?: boolean }).thinking_enabled ?? false,
    disabledParams: (provider as { disabled_params?: string[] }).disabled_params ?? [],
  };
}

/** Delivery receipt returned the moment a subagent message is accepted —
 * the generation itself keeps running independently (fire-and-forget,
 * async subagent messaging spec: "delivery is not generation completion").
 * Consumed by query_subagent (tools/subagents.ts); the session state is
 * readable live by read_chat (tools/chat_inspect.ts). */
export interface SubagentTurnDelivery {
  /** The subagent chat session the message landed in (read_chat chatId). */
  sessionId: string;
  /** The persisted user message id. */
  userMessageId: string;
  /** The streaming assistant placeholder that will carry the reply. */
  assistantMessageId: string;
  /** Settles with the final response text when the detached turn ends
   * (never rejects — generation errors resolve as the error text, exactly
   * like the old awaited behavior). */
  completion: Promise<string>;
}

/**
 * startSubagentTurn — DELIVERY-CONFIRMED subagent messaging. Synchronously
 * validates the target, persists the user message into the subagent's chat
 * session and mounts the streaming assistant placeholder, then kicks off
 * the LLM generation DETACHED. The returned receipt exists the instant
 * delivery is confirmed — the caller never waits for the target AI's
 * response, thinking, tools or completion.
 *
 * Delivery fails fast (throws) only when the message CANNOT be accepted:
 * unknown subagent or unusable session. Everything after that (provider
 * errors, tool failures, timeouts) belongs to the TARGET run and surfaces
 * through `completion` and the session's message state — a failed
 * generation never retroactively fails a confirmed delivery.
 */
export function startSubagentTurn(
  subagentId: string,
  userMessage: string,
  _fileIds?: string[],
  sessionId?: string,
): SubagentTurnDelivery {
  const store = useSubagentStore.getState();
  const subagent = store.getSubagent(subagentId);
  if (!subagent) throw new Error(`Subagent ${subagentId} not found`);

  // Get or create a session.
  let session = sessionId ? store.sessions.find((s) => s.id === sessionId) : store.getActiveSession();
  if (!session || session.subagentId !== subagentId) {
    session = store.createSession(subagent.id, userMessage.slice(0, 40));
  }
  const sid = session.id;

  // DELIVERY CONFIRMATION POINT: persisting the user message into the
  // target session. After this write the message belongs to the target
  // chat; the runtime below owns its own execution lifecycle.
  const userMsg: SubagentMessage = {
    id: nanoid(),
    role: "user",
    content: userMessage,
    timestamp: new Date().toISOString(),
  };
  store.addMessage(sid, userMsg);

  // Streaming placeholder the generation streams into — read_chat sees it
  // immediately with status "streaming" and partial content as it grows.
  const assistantMsgId = nanoid();
  store.addMessage(sid, {
    id: assistantMsgId,
    role: "assistant",
    content: "",
    timestamp: new Date().toISOString(),
    isStreaming: true,
  });

  // DETACHED GENERATION — never awaited by the caller. The loop writes
  // everything (deltas, tool cards, errors, completion) into the session
  // store; this catch is the last-resort net so an unexpected rejection
  // can never surface as an unhandled promise in the caller's context.
  const completion = runSubagentLoop(subagent, sid, assistantMsgId).catch(
    (err: unknown) => (err instanceof Error ? err.message : String(err)),
  );

  return { sessionId: sid, userMessageId: userMsg.id, assistantMessageId: assistantMsgId, completion };
}

/**
 * The generation loop of one subagent turn — streamed LLM rounds + tool
 * calls, all written into the subagent session store. Runs INDEPENDENTLY
 * of the caller (started detached by startSubagentTurn); resolves with the
 * final response text (or the error text — it never rejects past the
 * delivery boundary).
 */
async function runSubagentLoop(
  subagent: SubagentConfig,
  sid: string,
  assistantMsgId: string,
): Promise<string> {
  const subagentId = subagent.id;
  let accumulatedReasoning = "";

  // PRD §34/§35: Load the user's decrypted E2B sandbox key + env vars so
  // subagent tool calls hit the SAME workspace as the main agent. Previously
  // these were hardcoded to `undefined`, silently breaking every file tool
  // a subagent tried to call.
  let subagentSandboxKey: string | undefined;
  let subagentEnvVars: Record<string, string> = {};
  try {
    const userId = useAuthStore.getState().user?.id;
    if (userId) {
      const decryptedKey = await settingsService.getDecryptedSandboxKey(userId);
      subagentSandboxKey = decryptedKey ?? undefined;
      const decryptedEnv = await settingsService.getDecryptedEnvVars(userId);
      subagentEnvVars = decryptedEnv ?? {};
    }
  } catch (err) {
    console.warn("[subagent] failed to load sandbox key / env vars:", err);
  }

  try {
    const config = await resolveApiConfig(subagent);
    const allTools = listTools();
    const toolsSchema = allTools.map((t) => ({
      type: "function" as const,
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));

    // Build message history from the session.
    const updatedSession = useSubagentStore.getState().sessions.find((s) => s.id === sid);
    const sessionMessages = (updatedSession?.messages ?? [])
      .filter((m) => m.role !== "system" && !m.isStreaming);
    const trimmedSessionMessages = sessionMessages.length > 20
      ? sessionMessages.slice(-20)
      : sessionMessages;
    // PRD §13/§14/§38 — subagents get the FULL registry toolset (toolsSchema
    // above) but their system prompt used to be just a name+description,
    // so subagents denied tools they actually had. Inject the tool digest
    // (every tool + availability rules) + the LIVE tool names for this
    // session, so subagent tool knowledge matches the main agent's.
    const subagentBasePrompt =
      subagent.systemPrompt || `You are ${subagent.name}, a subagent. ${subagent.description}`;
    const subagentSystemPrompt = ensureToolDigest(
      `${subagentBasePrompt}\n\n## Active tools this turn (${allTools.length})\n${allTools.map((t) => t.name).join(", ")}\nAll of them are real and callable via function-calling — never claim you lack a tool that is in your definitions; never call one that is not.`,
    );
    console.log(`[subagent] system prompt: ${promptKb(subagentSystemPrompt)}KB (tools=${allTools.length})`);
    const apiMessages: ChatCompletionMessage[] = [
      {
        role: "system",
        content: subagentSystemPrompt,
      },
      ...trimmedSessionMessages.map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
        // Pass reasoning_content back — required by DeepSeek/moonshot/g4f
        reasoning_content: (m as { reasoning?: string }).reasoning || undefined,
      })),
    ];

    // Build the target URL — same logic as the main runtime.
    const base = config.baseUrl.replace(/\/$/, "");
    const targetUrl = config.noPrefix ? base : `${base}/chat/completions`;
    let fullResponse = "";
    let maxIterations = 10;
    // TRANSIENT GATEWAY RETRY (HTTP 502 fix, mirrors the main runtime):
    // bounded per subagent run so a dead provider can't loop forever.
    let gatewayRetries = 0;

    while (maxIterations-- > 0) {
      // STRICT-GATEWAY WIRE COMPAT (LLM HTTP 400 fix): the wire copy of
      // apiMessages is rebuilt each iteration through buildWireMessages, so
      // session-learned downgrades (tool-text mode, compact/dropped system,
      // no-tools) apply from the next round on. The subagent's own
      // apiMessages array keeps its NATIVE shape for persistence.
      const wireMode = getWireCompat(config.baseUrl, config.model);
      const body: Record<string, unknown> = {
        model: config.model,
        messages: buildWireMessages(apiMessages, wireMode),
        temperature: 0.7,
        stream: true, // ALWAYS stream
        stream_options: { include_usage: true },
      };
      if (
        config.toolsEnabled &&
        toolsSchema.length > 0 &&
        wireAllowsTools(config.baseUrl, config.model)
      ) {
        body.tools = toolsSchema;
        body.tool_choice = "auto";
      }
      if (config.thinkingEnabled) {
        body.chat_template_kwargs = { enable_thinking: true };
      }
      // PARAMETER POLICY: strip params the user disabled for this provider
      // and params auto-learned from unsupported-parameter 400s.
      applyParamPolicy(body, {
        baseUrl: config.baseUrl,
        model: config.model,
        disabledParams: config.disabledParams,
      });

      // Use ?url= query param + Accept: text/event-stream + cache: no-store
      // (curl -N equivalent — no buffering anywhere in the pipeline).
      // RATE-LIMIT POLICY (user-requested change): NO auto-retry on
      // 429/529 — fail fast with a clear message (mirrors the main
      // runtime). Only the 400 self-healing ladder still retries (it
      // FIXES the request, not just re-sends it).
      const requestUrl = `/api/chat-proxy?url=${encodeURIComponent(targetUrl)}`;
      let res: Response;
      for (;;) {
        res = await fetch(requestUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-target-url": targetUrl,
            Authorization: `Bearer ${config.apiKey}`,
            Accept: "text/event-stream",
          },
          body: JSON.stringify(body),
          cache: "no-store",
        });

        // No rate-limit auto-retry (removed per user request) — fall
        // through to the !res.ok handler with a clear error message.
        break;
      }

      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        // TRANSIENT GATEWAY RETRY (HTTP 502 fix): 502/503/504 come from the
        // provider's load balancer ("502 Bad Gateway … alb" HTML page) when
        // its upstream briefly hiccups — the request was never processed,
        // so an immediate retry costs no quota. NOT rate-limit retrying
        // (429/529 stay fail-fast). Max 2 quick retries per subagent run.
        if (
          (res.status === 502 || res.status === 503 || res.status === 504) &&
          gatewayRetries < 2
        ) {
          gatewayRetries += 1;
          const delayMs = gatewayRetries === 1 ? 700 : 1600;
          console.warn(`[subagent] provider gateway hiccup (HTTP ${res.status}) — retrying in ${delayMs}ms (${gatewayRetries}/2)`);
          logWarn("subagent", `Subagent LLM: provider gateway hiccup (HTTP ${res.status}) — retrying in ${delayMs}ms (${gatewayRetries}/2)`, {
            context: { model: config.model, status: res.status, retry_in_ms: delayMs },
          });
          await new Promise((r) => setTimeout(r, delayMs));
          continue;
        }
        // PARAMETER SELF-HEALING: a 400 unsupported_parameter names the
        // offending field — learn the ban, strip it, retry once.
        const badParam = parseUnsupportedParam(errText);
        if (badParam && body[badParam] !== undefined) {
          learnParamBan(config.baseUrl, config.model, badParam);
          delete body[badParam];
          if (badParam === "reasoning_effort") delete body.thinking;
          if (badParam === "thinking") delete body.reasoning_effort;
          console.warn(`[subagent] provider rejected '${badParam}' — stripped and retrying`);
          logWarn("subagent", `Subagent LLM: provider rejected parameter '${badParam}' — stripped and retrying`, {
            detail: errText,
            context: { model: config.model, status: res.status },
          });
          continue;
        }
        // STRICT-GATEWAY LADDER (LLM HTTP 400 fix): mirrors the main
        // runtime's streamRound ladder — tool-text mode, compact system,
        // dropped system, no-tools — each learned per provider+model for
        // the session and applied on the next iteration's body rebuild.
        const healReason = nextStrictGatewayStep({
          baseUrl: config.baseUrl,
          model: config.model,
          messages: apiMessages,
          hasToolsParam: body.tools !== undefined,
          errorText: errText,
        });
        if (healReason) {
          console.warn(`[subagent] 400 self-healing: ${healReason} — retrying`);
          logWarn("subagent", `Subagent LLM: HTTP 400 self-healing (${healReason}) — retrying`, {
            detail: errText,
            context: { model: config.model, status: 400 },
          });
          continue;
        }
        logError("subagent", `Subagent LLM request failed (HTTP ${res.status})`, {
          detail: errText,
          context: {
            model: config.model,
            endpoint: targetUrl,
            status: res.status,
          },
        });
        if (res.status === 429 || res.status === 529) {
          throw new Error(
            `Rate limit reached (HTTP ${res.status}) — the provider is throttling requests. Wait a moment and try again. ${errText.slice(0, 200)}`,
          );
        }
        // HONEST GATEWAY-DOWN ERROR (HTTP 502 fix): a 502/503/504 that
        // survived both quick retries — provider's server is unreachable
        // (their load balancer's HTML error page); replace the wall of HTML
        // with what happened + the next step. Raw body stays in the log
        // detail above.
        if (res.status === 502 || res.status === 503 || res.status === 504) {
          throw new Error(
            `Provider gateway is down (HTTP ${res.status}) — the provider's server is temporarily unreachable ` +
            `(their load balancer returned an error page; the request was never processed, so no quota was used). ` +
            `This is transient on the provider's side — wait a moment and try again, or switch model/provider.`,
          );
        }
        throw new Error(`API ${res.status}: ${errText.slice(0, 500)}`);
      }

      // Check if the response is actually SSE (stream:true).
      const contentType = res.headers.get("content-type") || "";
      if (!contentType.includes("text/event-stream") && !contentType.includes("application/x-ndjson")) {
        // Non-streaming response (some providers don't support stream:true).
        const data = await res.json();
        const choice = data.choices?.[0];
        if (!choice) {
          const se = extractStreamError(data as Record<string, unknown>);
          logError("subagent", `Subagent LLM: no response — ${se ?? "response had no choices"}`, {
            detail: JSON.stringify(data).slice(0, 1500),
            context: { model: config.model, status: res.status },
          });
          throw new Error(se ?? "No response from API");
        }
        const msg = choice.message;

        // Handle tool calls.
        if (msg.tool_calls && msg.tool_calls.length > 0 && config.toolsEnabled) {
          // Pass reasoning_content back
          if (msg.reasoning_content) accumulatedReasoning += msg.reasoning_content;
          apiMessages.push({
            role: "assistant",
            content: msg.content || "",
            reasoning_content: accumulatedReasoning || undefined,
            tool_calls: msg.tool_calls.map((tc: { id: string; function: { name: string; arguments: string } }) => ({
              id: tc.id,
              type: "function" as const,
              function: tc.function,
            })),
          });

          // Execute tool calls in parallel
          await executeToolCallsParallel(
            msg.tool_calls, allTools, subagentId, sid, assistantMsgId, apiMessages,
            msg.content || "",
            subagentSandboxKey,
            subagentEnvVars,
          );
          fullResponse = stripFunctionCallTags(msg.content || "");
          continue;
        }

        fullResponse = stripFunctionCallTags(msg.content || "");
        useSubagentStore.getState().updateMessage(sid, assistantMsgId, {
          content: fullResponse,
          isStreaming: false,
        });
        break;
      }

      // Parse SSE stream — NO THROTTLE, flush immediately (like main chat)
      const reader = res.body?.getReader();
      if (!reader) throw new Error("No response body");
      const decoder = new TextDecoder();
      let buffer = "";
      let accumulatedText = "";
      accumulatedReasoning = "";
      const toolCallsBuffer: Array<{ id: string; function: { name: string; arguments: string } }> = [];

      // SILENT-STOP DIAGNOSTICS (auto-stop fix, mirrors the main runtime):
      // error payloads inside a 200 stream used to be dropped silently
      // (`if (!delta) continue`) → empty answer → looked like the subagent
      // just stopped. Capture them so every stop has a reason in the logs.
      let subStreamError: string | null = null;
      const subRawTail: string[] = [];
      // PREMATURE-EOF DETECTION (mirrors the main runtime): a stream that
      // ends without [DONE] / finish_reason / usage was cut off mid-
      // generation, not completed.
      let sawDoneMarker = false;
      let sawFinishReason = false;
      let sawUsage = false;

      // Track which tool calls we've already shown as "running" to avoid duplicates
      const shownToolCalls = new Set<string>();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // Process complete SSE lines (split on \n\n for full events)
        let eventIdx: number;
        while ((eventIdx = buffer.indexOf("\n\n")) !== -1) {
          const rawEvent = buffer.slice(0, eventIdx);
          buffer = buffer.slice(eventIdx + 2);

          for (const line of rawEvent.split("\n")) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith("data:")) continue;
            const dataStr = trimmed.slice(5).trim();
            if (!dataStr || dataStr === "[DONE]") {
              if (dataStr === "[DONE]") sawDoneMarker = true;
              continue;
            }

            try {
              const chunk = JSON.parse(dataStr);
              if (chunk.usage) sawUsage = true;
              const fr = chunk.choices?.[0]?.finish_reason ?? chunk.choices?.[0]?.stop_reason;
              if (fr) sawFinishReason = true;
              const delta = chunk.choices?.[0]?.delta;
              if (!delta) {
                // SILENT-STOP FIX: no delta ≠ harmless — it may be the
                // provider's error payload (the real failure after a 200).
                const se = extractStreamError(chunk as Record<string, unknown>);
                if (se && !subStreamError) {
                  subStreamError = se;
                  subRawTail.push(dataStr.slice(0, 400));
                }
                continue;
              }

              // Text delta — flush immediately (no throttle)
              if (delta.content) {
                accumulatedText += delta.content;
                // Immediate update — no 60ms throttle
                useSubagentStore.getState().updateMessage(sid, assistantMsgId, {
                  content: stripFunctionCallTags(accumulatedText),
                  isStreaming: true,
                });
              }

              // Reasoning delta — accumulate for passing back to API
              if (delta.reasoning_content || delta.reasoning) {
                accumulatedReasoning += (delta.reasoning_content || delta.reasoning || "");
              }

              // Tool call delta — buffer + show immediately
              if (delta.tool_calls) {
                for (const tc of delta.tool_calls) {
                  const idx = tc.index ?? 0;
                  if (!toolCallsBuffer[idx]) {
                    toolCallsBuffer[idx] = {
                      id: tc.id || nanoid(),
                      function: { name: tc.function?.name || "", arguments: tc.function?.arguments || "" },
                    };
                  } else {
                    if (tc.function?.name) toolCallsBuffer[idx]!.function.name += tc.function.name;
                    if (tc.function?.arguments) toolCallsBuffer[idx]!.function.arguments += tc.function.arguments;
                    if (tc.id) toolCallsBuffer[idx]!.id = tc.id;
                  }

                  // Show tool call card IMMEDIATELY when name is known (streaming)
                  const tcBuf = toolCallsBuffer[idx]!;
                  if (tcBuf.function.name && !shownToolCalls.has(tcBuf.id)) {
                    shownToolCalls.add(tcBuf.id);
                    const currentMsg = useSubagentStore.getState().sessions.find((x) => x.id === sid)?.messages.find((m) => m.id === assistantMsgId);
                    useSubagentStore.getState().updateMessage(sid, assistantMsgId, {
                      content: stripFunctionCallTags(accumulatedText),
                      toolCalls: [
                        ...(currentMsg?.toolCalls ?? []),
                        {
                          id: tcBuf.id,
                          name: tcBuf.function.name,
                          args: { _streaming: tcBuf.function.arguments } as Record<string, unknown>,
                          status: "pending" as const,
                        },
                      ],
                    });
                  } else if (tcBuf.function.arguments && shownToolCalls.has(tcBuf.id)) {
                    // Update streaming args on existing card
                    const msg = useSubagentStore.getState().sessions.find((x) => x.id === sid)?.messages.find((m) => m.id === assistantMsgId);
                    if (msg?.toolCalls) {
                      useSubagentStore.getState().updateMessage(sid, assistantMsgId, {
                        toolCalls: msg.toolCalls.map((tc2) =>
                          tc2.id === tcBuf.id
                            ? { ...tc2, args: { _streaming: tcBuf.function.arguments } as Record<string, unknown> }
                            : tc2,
                        ),
                      });
                    }
                  }
                }
              }
            } catch {
              // partial JSON — skip
            }
          }
        }
      }

      // SILENT-STOP GUARDS (auto-stop fix, mirrors the main runtime): a
      // finished stream with no text, no reasoning, and no tool calls must
      // surface WHY instead of ending as a normal empty answer.
      if (toolCallsBuffer.length === 0) {
        if (subStreamError && !accumulatedText.trim()) {
          logError("subagent", `Subagent LLM stream error (HTTP 200): ${subStreamError}`, {
            detail: subRawTail.join("\n"),
            context: { model: config.model, status: 200 },
          });
          throw new Error(`Provider stream error: ${subStreamError}`);
        }
        if (!accumulatedText.trim() && !accumulatedReasoning.trim()) {
          logWarn("subagent", "Subagent LLM returned an empty response — the model produced no content", {
            detail: subRawTail.length > 0 ? subRawTail.join("\n") : "(stream produced no usable chunks)",
            context: { model: config.model, status: 200 },
          });
          throw new Error("Provider returned an empty response — the model produced no content");
        }
      }

      // PREMATURE STREAM CUT (auto-stop fix, mirrors the main runtime):
      // output arrived but the stream ended with no finish_reason, no
      // [DONE] marker and no usage chunk — the connection was severed
      // mid-generation. Surface it instead of silently treating the
      // partial text as a complete subagent answer.
      if (
        !sawFinishReason &&
        !sawDoneMarker &&
        !sawUsage &&
        (accumulatedText.trim() || accumulatedReasoning.trim() || toolCallsBuffer.length > 0)
      ) {
        // Drop tool calls whose args JSON was cut mid-string.
        const completeCalls = toolCallsBuffer.filter(
          (tc) => {
            if (!tc.function.arguments) return true;
            try {
              JSON.parse(tc.function.arguments);
              return true;
            } catch {
              return false;
            }
          },
        );
        const droppedCalls = toolCallsBuffer.length - completeCalls.length;
        toolCallsBuffer.length = 0;
        toolCallsBuffer.push(...completeCalls);

        logWarn(
          "subagent",
          `Subagent response stream was cut off mid-generation (no finish signal) — ${accumulatedText.length} chars received, possibly incomplete`,
          {
            detail: subRawTail.length > 0 ? subRawTail.join("\n") : "(no chunks retained)",
            context: {
              model: config.model,
              status: 200,
              finish_reason: "none",
              done_marker: false,
              usage: "none",
              tool_calls_dropped: droppedCalls,
            },
          },
        );
        const cutNotice =
          "\n\n---\n⚠️ **The provider ended this response without a completion signal** — it was likely cut off mid-generation" +
          (droppedCalls > 0 ? ` (and ${droppedCalls} tool call${droppedCalls === 1 ? " was" : "s were"} dropped as incomplete)` : "") +
          ". The text above may be incomplete.";
        accumulatedText += cutNotice;
        useSubagentStore.getState().updateMessage(sid, assistantMsgId, {
          content: stripFunctionCallTags(accumulatedText),
          isStreaming: true,
        });
      }

      // Process any buffered tool calls.
      if (toolCallsBuffer.length > 0 && config.toolsEnabled) {
        // Parse args and update tool call cards to "running". Malformed /
        // truncated argument JSON is REPAIRED when possible and otherwise
        // short-circuits to a structured MALFORMED_TOOL_ARGUMENTS tool
        // result — never executed, never replayed raw (tool-args.ts).
        const parsedToolCalls: Array<{ id: string; name: string; args: Record<string, unknown>; malformed: boolean; raw?: string }> = [];
        for (const tc of toolCallsBuffer) {
          const parsed = parseToolCallArguments(tc.function.arguments);
          const toolArgs = parsed.args;
          const malformed = parsed.malformed && !parsed.repaired;
          parsedToolCalls.push({ id: tc.id, name: tc.function.name, args: toolArgs, malformed, raw: parsed.raw });

          // Update card to "running" with parsed args
          const msg = useSubagentStore.getState().sessions.find((x) => x.id === sid)?.messages.find((m) => m.id === assistantMsgId);
          if (msg?.toolCalls) {
            useSubagentStore.getState().updateMessage(sid, assistantMsgId, {
              toolCalls: msg.toolCalls.map((tc2) =>
                tc2.id === tc.id ? { ...tc2, args: toolArgs, status: "running" as const } : tc2,
              ),
            });
          }
        }

        // Add assistant message with tool calls + reasoning_content to API
        // history. The replayed argument string is ALWAYS valid JSON
        // (repaired copy / {}) — never the raw truncated text.
        apiMessages.push({
          role: "assistant",
          content: accumulatedText || "",
          reasoning_content: accumulatedReasoning || undefined,
          tool_calls: toolCallsBuffer.map((tc) => ({
            id: tc.id,
            type: "function" as const,
            function: {
              name: tc.function.name,
              arguments: wireSafeArguments(tc.function.arguments),
            },
          })),
        });

        // Execute all tool calls in PARALLEL (same as main runtime)
        await Promise.all(parsedToolCalls.map(async (ptc) => {
          const tool = allTools.find((t) => t.name === ptc.name);
          let toolResult: unknown;
          let toolStatus: "completed" | "error" = "completed";
          if (ptc.malformed) {
            // Structured tool error — the model re-issues a valid call on
            // the next round; NEVER executed, NEVER a provider error.
            toolResult = malformedToolResult(ptc.raw ?? "");
            toolStatus = "error";
          } else {
          try {
            if (tool) {
              const ctx = {
                userId: useAuthStore.getState().user?.id ?? "",
                conversationId: subagentId,
                emit: () => {},
                signal: undefined,
                // PRD §34/§35: subagents share the main agent's E2B sandbox.
                e2bApiKey: subagentSandboxKey,
                sandboxApiKey: subagentSandboxKey,
                sandboxMode: "shared" as const,
                envVars: subagentEnvVars,
                onToolOutput: () => {},
              };
              toolResult = await tool.handler(ptc.args, ctx);
            } else {
              toolResult = { error: `Unknown tool: ${ptc.name}` };
              toolStatus = "error";
            }
          } catch (e) {
            toolResult = { error: e instanceof Error ? e.message : String(e) };
            toolStatus = "error";
          }
          }

          // Update tool call card with result
          const updatedMsg = useSubagentStore.getState().sessions.find((x) => x.id === sid)?.messages.find((m) => m.id === assistantMsgId);
          if (updatedMsg?.toolCalls) {
            useSubagentStore.getState().updateMessage(sid, assistantMsgId, {
              toolCalls: updatedMsg.toolCalls.map((tc2) =>
                tc2.id === ptc.id ? { ...tc2, result: toolResult, status: toolStatus } : tc2,
              ),
            });
          }

          apiMessages.push({
            role: "tool" as const,
            content: JSON.stringify(toolResult),
            tool_call_id: ptc.id,
          });
        }));

        fullResponse = stripFunctionCallTags(accumulatedText);
        continue;
      }

      // No tool calls — this is the final response.
      fullResponse = stripFunctionCallTags(accumulatedText);
      useSubagentStore.getState().updateMessage(sid, assistantMsgId, {
        content: fullResponse,
        isStreaming: false,
      });
      break;
    }

    return fullResponse;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    useSubagentStore.getState().updateMessage(sid, assistantMsgId, {
      content: `Error: ${errMsg}`,
      isStreaming: false,
    });
    return errMsg;
  }
}

/**
 * Back-compat awaited wrapper — delivers the message, then waits for the
 * detached generation to settle and resolves with its final text. Used by
 * the subagent SIDEBAR UI (a human watching one chat). The agent-side
 * query_subagent tool uses startSubagentTurn directly so it returns on
 * delivery, never on completion.
 */
export async function executeSubagentTurn(
  subagentId: string,
  userMessage: string,
  _fileIds?: string[],
  sessionId?: string,
): Promise<string> {
  return startSubagentTurn(subagentId, userMessage, _fileIds, sessionId).completion;
}

/** Execute tool calls in parallel for non-streaming mode. */
async function executeToolCallsParallel(
  toolCalls: Array<{ id: string; function: { name: string; arguments: string } }>,
  allTools: ReturnType<typeof listTools>,
  _subagentId: string,
  sid: string,
  assistantMsgId: string,
  apiMessages: ChatCompletionMessage[],
  _accumulatedText: string,
  sandboxKey: string | undefined,
  envVars: Record<string, string>,
) {
  await Promise.all(toolCalls.map(async (tc) => {
    const parsed = parseToolCallArguments(tc.function.arguments);
    const toolArgs = parsed.args;
    // Malformed + unrepairable → structured tool error, never executed.
    const malformed = parsed.malformed && !parsed.repaired;

    const tool = allTools.find((t) => t.name === tc.function.name);

    // Add running tool call card
    const currentMsg = useSubagentStore.getState().sessions.find((x) => x.id === sid)?.messages.find((m) => m.id === assistantMsgId);
    useSubagentStore.getState().updateMessage(sid, assistantMsgId, {
      toolCalls: [
        ...(currentMsg?.toolCalls ?? []),
        { id: tc.id, name: tc.function.name, args: toolArgs, status: "running" as const },
      ],
    });

    let toolResult: unknown;
    let toolStatus: "completed" | "error" = "completed";
    if (malformed) {
      // Structured tool error — never executed, never a provider error.
      toolResult = malformedToolResult(parsed.raw);
      toolStatus = "error";
    } else {
    try {
      if (tool) {
        const ctx = {
          userId: useAuthStore.getState().user?.id ?? "",
          conversationId: _subagentId,
          emit: () => {},
          signal: undefined,
          // PRD §34/§35: subagents share the main agent's E2B sandbox.
          e2bApiKey: sandboxKey,
          sandboxApiKey: sandboxKey,
          sandboxMode: "shared" as const,
          envVars,
          onToolOutput: () => {},
        };
        toolResult = await tool.handler(toolArgs, ctx);
      } else {
        toolResult = { error: `Unknown tool: ${tc.function.name}` };
        toolStatus = "error";
      }
    } catch (e) {
      toolResult = { error: e instanceof Error ? e.message : String(e) };
      toolStatus = "error";
    }
    }

    // Update tool call card with result
    const updatedMsg = useSubagentStore.getState().sessions.find((x) => x.id === sid)?.messages.find((m) => m.id === assistantMsgId);
    if (updatedMsg?.toolCalls) {
      useSubagentStore.getState().updateMessage(sid, assistantMsgId, {
        toolCalls: updatedMsg.toolCalls.map((tc2) =>
          tc2.id === tc.id ? { ...tc2, result: toolResult, status: toolStatus } : tc2,
        ),
      });
    }

    apiMessages.push({
      role: "tool" as const,
      content: JSON.stringify(toolResult),
      tool_call_id: tc.id,
    });
  }));
}

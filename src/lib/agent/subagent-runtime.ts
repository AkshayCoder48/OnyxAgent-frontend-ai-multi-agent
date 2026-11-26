"use client";

import { nanoid } from "nanoid";
import { useSubagentStore, type SubagentConfig, type SubagentMessage } from "@/stores/subagent-store";
import { useAuthStore } from "@/stores";
import { aiProviderService, settingsService } from "@/lib/services";
import { listTools, getTool } from "@/lib/tools/registry";
import { filterToolsForRequest } from "@/lib/tools/request-scoping";
import { resolveModelContext } from "@/lib/agent/context/model-context";
import { ensureToolDigest, promptKb } from "@/lib/agent/tool-digest";
import {
  applyParamPolicy,
  learnParamBan,
  parseUnsupportedParam,
} from "@/lib/agent/param-policy";
import {
  buildWireMessages,
  beginTurnWireCompat,
  getWireCompat,
  nextStrictGatewayStep,
  wireAllowsTools,
} from "@/lib/agent/wire-compat";
import { stripFunctionCallTags } from "@/lib/text-sanitizer";
import { normalizeToolCall, unknownToolResult } from "@/lib/agent/tool-call-normalize";
import { maybeGateToolCall, recordApprovalOutcome } from "@/lib/agent/approval-gate";
import { waitForAskUser, SUBAGENT_ASK_USER_TIMEOUT_MS } from "@/lib/agent/ask-user-wait";
import type { WSEvent } from "@/types";
import { listUsableProviders, resolveProviderForModel, chatCompletionsUrl } from "@/lib/agent/provider-resolution";
import { logError, logWarn } from "@/lib/client-logger";
import { extractStreamError } from "@/lib/agent/stream-guards";
import {
  malformedToolResult,
  parseToolCallArguments,
  wireSafeArguments,
} from "@/lib/agent/tool-args";
// Streamed tool-call accumulator keying (tool-reliability PRD §7.2) — shared
// with the main runtime so index-less providers behave identically here.
import {
  resolveToolCallAccumulatorKey,
  type AccumulatedToolCallEntry,
} from "@/lib/agent/runtime";

/**
 * Subagent runtime — executes subagent tasks by calling the LLM API with
 * REAL STREAMING (SSE). Streams text token-by-token into the subagent's
 * chat SESSION (the data layer the AI reads back via read_chat; there is
 * no sub-agent chat UI — subagents are API-only).
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

/** One choice of a NON-STREAMING chat completion (providers that answer
 *  stream:true with a plain JSON body). */
interface NonStreamingChoice {
  message?: {
    content?: string | null;
    reasoning_content?: string;
    tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
  };
}

/** STREAM IDLE TIMEOUT (subagent-stall fix): a gateway that accepts the
 *  subagent request then goes silent used to hang `reader.read()` FOREVER —
 *  the detached loop never settled, the message stayed `isStreaming: true`
 *  and poll_subagent reported a stall (the "subagent stalls after 2-3 tool
 *  calls" bug: it survives the first rounds, then one silent stream wedges
 *  the whole turn with no way to stop it). Mirrors the main runtime's
 *  STREAM_IDLE_TIMEOUT_MS: no chunk for this long → cancel the body and
 *  transient-retry the round; a dead gateway can never wedge a subagent. */
const SUBAGENT_STREAM_IDLE_TIMEOUT_MS = 120_000;
/** Headers-phase watchdog: bounded wait for response HEADERS (a provider
 *  that accepts the request and never answers). Generous — some providers
 *  hold headers until the first token, and non-streaming responders hold
 *  them until the FULL completion is done — but never infinite. */
const SUBAGENT_HEADERS_TIMEOUT_MS = 300_000;

/**
 * resolveApiConfig — SAME resolution contract as the main chat
 * (use-chat buildTurnOptions),
 * via the shared layer (lib/agent/provider-resolution):
 *
 *   LEGACY-CLASSIC GUARD — stale text.pollinations.ai rows self-heal and are
 *   never callable; the retired Classic endpoint cannot serve gen-catalog
 *   models (it answers the "isn't on the Classic API" 404).
 *
 *   PROVIDER CHAIN (first match wins):
 *     1. subagent.providerId — an intentional per-subagent override
 *        (configured in the subagent editor), respected verbatim
 *     2. MODEL-FIRST — the chat store's selectedModel resolved to the
 *        provider that OFFERS it (active providers preferred). The selected
 *        model always travels with a gateway that actually serves it.
 *     3. the chat store's selectedProviderId
 *     4. first active provider
 *
 *   MODEL CHAIN: subagent.model (intentional override) → the chat store's
 *   selectedModel when the resolved provider offers it → provider.models[0].
 *   NO hardcoded fallback model — a provider without models is an honest
 *   error, never a silent switch to an unrelated model (endpoint-migration
 *   PRD §4: "Never silently default to a hardcoded model").
 */
async function resolveApiConfig(subagent: SubagentConfig) {
  const userId = useAuthStore.getState().user?.id;
  if (!userId) throw new Error("No authenticated user");

  const providers = await listUsableProviders(userId);
  if (providers.length === 0) throw new Error("No AI providers configured. Add one in Settings → Config.");

  const { selectedProviderId, selectedModel } = await import("@/stores/chat-store").then(m => {
    const store = m.useChatStore.getState();
    return { selectedProviderId: store.selectedProviderId, selectedModel: store.selectedModel };
  });

  let provider = subagent.providerId
    ? providers.find((p) => p.id === subagent.providerId)
    : undefined;
  // MODEL-FIRST: the selected model with the provider that OWNS it (also the
  // stale-selection recovery — a selectedProviderId pointing at a deleted or
  // legacy row while the model lives on another provider still lands on the
  // right gateway).
  if (!provider) provider = resolveProviderForModel(providers, selectedModel);
  if (!provider && selectedProviderId) {
    provider = providers.find((p) => p.id === selectedProviderId);
  }
  if (!provider) provider = providers.find((p) => p.is_active) ?? providers[0];
  if (!provider) throw new Error("No provider available");

  let apiKey = subagent.apiKey;
  if (!apiKey) {
    apiKey = await aiProviderService.getDecryptedApiKey(provider.id);
  }
  if (!apiKey) throw new Error(`No API key for provider "${provider.name}"`);

  let model = subagent.model;
  // Adopt the chat-store model ONLY when the resolved provider offers it —
  // an orphaned selection id falls through to the provider's first model
  // instead of a guaranteed-404 model.
  if (!model && selectedModel && (provider.models ?? []).includes(selectedModel)) {
    model = selectedModel;
  }
  if (!model) model = provider.models?.[0];
  if (!model) {
    throw new Error(
      `The provider "${provider.name}" has no models configured — add at least one model in Settings → Config, or pick a model for this subagent.`,
    );
  }
  const baseUrl = subagent.baseUrl || provider.base_url;
  const noPrefix = (provider as { no_prefix?: boolean }).no_prefix ?? false;

  return {
    provider,
    apiKey,
    model,
    baseUrl,
    noPrefix,
    // TOOL-CALLING PARITY (tool-reliability PRD §4.3): `undefined` means the
    // provider row predates the tools_enabled column (no Dexie backfill) —
    // the MAIN runtime treats undefined as ON (`toolsEnabled !== false`,
    // runtime.ts). The subagent path previously used raw truthiness, so
    // legacy providers silently ran subagents TOOLLESS (the model could
    // never call tools even though they were advertised). Normalize here so
    // all four gates below (request tools, non-streamed + streamed tool-call
    // execution) behave identically to the main runtime.
    toolsEnabled: provider.tools_enabled !== false,
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
 * MAIN-AGENT PARITY EVENT BRIDGE: a subagent tool's WSEvents route into the
 * ORIGINATING main-chat conversation's live execution store, so interactive
 * surfaces (ask_user's question panel) render in the very conversation that
 * delegated the work — exactly where the main agent's own ask_user renders.
 * No live execution (background subagent turn, page refreshed, unknown
 * origin) → safe no-op: waitForAskUser's window CustomEvent listener still
 * receives answers typed anywhere, and approval cards already route through
 * the global usePendingApprovals store.
 */
function makeSubagentEmit(originConversationId: string | null): (e: WSEvent) => void {
  if (!originConversationId || typeof window === "undefined") return () => {};
  return (e: WSEvent) => {
    try {
      // Dynamic import avoids a module cycle (execution-hub → runtime → …).
      void import("@/lib/agent/execution-hub").then((m) => {
        const summary = m.executionHub.getFor(originConversationId);
        if (!summary) return;
        const store = m.executionHub.getStore(summary.id);
        if (!store) return;
        const state = store.getState();
        // ask_user: surface the questions in the conversation's live panel.
        if (e.type === "ask_user") {
          const { questions } = (e as { data?: { questions?: Array<{ question: string; options?: string[]; allow_custom?: boolean }> } }).data ?? {};
          state.setPendingQuestions(
            (questions ?? []).map((q) => ({
              question: q.question,
              options: q.options ?? [],
              allowCustom: q.allow_custom ?? true,
            })),
          );
        }
      });
    } catch {
      // The emit bridge is best-effort UI routing — never fail a tool for it.
    }
  };
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
  /** The MAIN-CHAT conversation the delivering turn belongs to — the
   *  permission gate resolves PROJECT rules through it (main-agent
   *  parity: a tool granted at project level is granted to that
   *  project's subagents too). Falls back to the session's previously
   *  stamped origin. */
  originConversationId?: string | null,
): SubagentTurnDelivery {
  const store = useSubagentStore.getState();
  const subagent = store.getSubagent(subagentId);
  if (!subagent) throw new Error(`Subagent ${subagentId} not found`);

  // Defensive delivery input (query_subagent crash 2026-11-25): a call that
  // reached delivery without a message used to die on `undefined.slice`
  // below BEFORE persisting — masking the real cause as DELIVERY_FAILED.
  // An empty message is a delivery-time failure by definition; fail fast
  // with an honest error instead of corrupting the session state.
  const message = typeof userMessage === "string" ? userMessage.trim() : "";
  if (!message) {
    throw new Error(
      "No message provided — delivery needs message text. To check a task's status instead, return the task status (query_subagent with task_id only) rather than delivering an empty message.",
    );
  }

  // Get or create a session.
  let session = sessionId ? store.sessions.find((s) => s.id === sessionId) : store.getActiveSession();
  if (!session || session.subagentId !== subagentId) {
    session = store.createSession(subagent.id, message.slice(0, 40));
  }
  const sid = session.id;

  // PROJECT-RULE PARITY: stamp the originating main-chat conversation onto
  // the session (later deliveries win). The loop's permission gates resolve
  // project rules through it — same grants the main agent has.
  const effectiveOrigin =
    originConversationId ?? session.origin_conversation_id ?? null;
  if (originConversationId && originConversationId !== session.origin_conversation_id) {
    store.setSessionOriginConversation(sid, originConversationId);
  }

  // DELIVERY CONFIRMATION POINT: persisting the user message into the
  // target session. After this write the message belongs to the target
  // chat; the runtime below owns its own execution lifecycle.
  const userMsg: SubagentMessage = {
    id: nanoid(),
    role: "user",
    content: message,
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
  const completion = runSubagentLoop(subagent, sid, assistantMsgId, effectiveOrigin).catch(
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
  /** The originating main-chat conversation — permission gates resolve
   *  PROJECT rules through it (main-agent parity). Null = global policy
   *  only (legacy sessions / unknown origin). */
  originConversationId: string | null = null,
): Promise<string> {
  const subagentId = subagent.id;
  // TURN-LEVEL ACCUMULATORS (Sub-Agent Chat PRD §1/§3/§4): they live for
  // the WHOLE turn across every streaming round. `fullTurnText` is what
  // the chat message shows — text deltas APPEND to it and every store
  // write carries the full value, so content from earlier rounds can
  // never be replaced or disappear when a later round streams.
  let fullTurnText = "";
  // Reasoning accumulated across rounds: streamed into the message for the
  // ThinkingReasoning UI AND replayed to the API (DeepSeek/moonshot/g4f
  // require reasoning_content on assistant tool-call messages).
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

  // MAIN-AGENT PARITY EVENT BRIDGE: tool events (ask_user questions, …)
  // route into the originating conversation's live execution store.
  const subagentEmit = makeSubagentEmit(originConversationId);

  // ABORT LIFECYCLE (subagent-stall fix): every fetch of this subagent
  // run rides ONE controller (declared OUTSIDE the try so the finally
  // below can always remove the pagehide hook). An AbortController with
  // zero listeners would make every stream un-cancellable — now a
  // stalled/dead stream is cancelled at the body (idle timeout above)
  // and a page reload tears the whole run down via the pagehide hook.
  const runAbort = new AbortController();
  const onRunAbort = () => runAbort.abort();
  if (typeof window !== "undefined") {
    window.addEventListener("pagehide", onRunAbort);
  }

  try {
    const config = await resolveApiConfig(subagent);
    // Build message history from the session.
    const updatedSession = useSubagentStore.getState().sessions.find((s) => s.id === sid);
    const sessionMessages = (updatedSession?.messages ?? [])
      .filter((m) => m.role !== "system" && !m.isStreaming);
    const trimmedSessionMessages = sessionMessages.length > 20
      ? sessionMessages.slice(-20)
      : sessionMessages;
    // PRD §13/§14/§38 — subagents' system prompt used to be just a
    // name+description, so subagents denied tools they actually had. Inject
    // the tool digest (every tool + availability rules) + the LIVE tool
    // names for this session, so subagent tool knowledge matches the main
    // agent's.
    const subagentBasePrompt =
      subagent.systemPrompt || `You are ${subagent.name}, a subagent. ${subagent.description}`;
    // FULL-PARITY TOOL SURFACE (user directive 2026-11-25: subagents "can
    // use everything granted anything just like the main agent"): the
    // subagent's tool surface is built with the EXACT same scoping inputs as
    // the main runtime —
    //   1. the SAME context-window awareness (small models → ESSENTIAL +
    //      intent, else the full CORE surface), resolved from the subagent's
    //      own model
    //   2. the SAME used-tools LATCH: tools this subagent already used in
    //      earlier rounds/messages of this session can never be scoped out
    //      mid-turn
    //   3. the SAME intent matching over its brief + first task
    // The brief-only CORE-less subset (the old behavior) left subagents
    // missing CORE extras (schedule / workflow / chats / custom_tools /
    // subagents) whenever their brief didn't keyword-match them — subagents
    // are focused workers, but they are NOT second-class agents.
    const firstTask = sessionMessages.find((m) => m.role === "user")?.content ?? "";
    const subagentBrief = `${subagent.name} ${subagent.description} ${subagentBasePrompt} ${firstTask}`;
    // Session-history latch (main runtime: usedToolNamesFromHistory).
    const subagentUsedToolNames = new Set<string>();
    for (const m of sessionMessages) {
      for (const tc of m.toolCalls ?? []) {
        if (tc?.name) subagentUsedToolNames.add(tc.name);
      }
    }
    // Round-latch accumulator — tools used by earlier rounds of THIS turn
    // ride along from the next round on (rebuilt per round, main-runtime
    // parity).
    const turnUsedToolNames = new Set<string>();
    const buildSubagentTools = () => {
      const used = new Set([...subagentUsedToolNames, ...turnUsedToolNames]);
      const scoped = filterToolsForRequest(listTools(), {
        lastUserText: subagentBrief,
        usedToolNames: used,
        modelContextWindow: resolveModelContext(config.model).contextWindow,
      });
      return scoped;
    };
    const allTools = buildSubagentTools();
    const buildToolsSchema = (tools: typeof allTools) =>
      tools.map((t) => ({
        type: "function" as const,
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
    let toolsSchema = buildToolsSchema(allTools);
    const subagentSystemPrompt = ensureToolDigest(
      `${subagentBasePrompt}\n\n## Active tools this turn (${allTools.length})\n${allTools.map((t) => t.name).join(", ")}\nAll of them are real and callable via function-calling — never claim you lack a tool that is in your definitions; never call one that is not.\nYou have the SAME tool access as the main agent — everything granted to it is granted to you, including integrations, skills, schedules, workflows and spawning your own subagents.`,
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

    // Build the target URL — the ONE shared construction (provider-resolution).
    const targetUrl = chatCompletionsUrl(config.baseUrl, config.noPrefix);
    let fullResponse = "";
    // ITERATION CAP (Persistent Execution PRD §3): a SAFETY bound, not a
    // silent truncation — raised 10 → 25, and an exhausted cap returns an
    // honest marker instead of an empty string (the orchestrator used to
    // treat an empty subagent reply as its completed answer).
    let maxIterations = 25;
    // MISSION BUDGET vs RETRY BUDGET (subagent-stall fix): `maxIterations`
    // counts ONLY productive tool rounds. Self-healing retries (gateway 502
    // blips, context compaction, param strips, strict-gateway ladder) used
    // to decrement the SAME budget — a flapping gateway could burn 6+ of
    // the 25 iterations before any real work, ending long tasks with
    // "stopped after its round budget" while the model was making steady
    // progress. Each retry path now refunds the iteration it consumed
    // (the `maxIterations += 1` before each healing `continue`), keeping
    // the productive-round semantics intact. Every retry class stays
    // separately bounded: gatewayRetries < 2, the ctxKeepLadder, the
    // param-strip loop (a stripped param can never repeat), and the
    // finite strict-gateway ladder.
    // TRANSIENT STREAM RETRIES (subagent-stall fix): an idle-timeout /
    // network failure while READING a stream rewinds and re-streams the
    // SAME round (mirrors the main runtime's transient ladder). Bounded
    // per subagent run so a dead provider can't loop forever.
    let transientStreamRetries = 0;
    const TRANSIENT_STREAM_MAX = 4;
    // TRANSIENT GATEWAY RETRY (HTTP 502 fix, mirrors the main runtime):
    // bounded per subagent run so a dead provider can't loop forever.
    let gatewayRetries = 0;
    // TRANSIENT TRANSPORT RETRY (Sub-Agent background network-error fix —
    // mirrors the main runtime's classifier): fetch()-level failures
    // ("TypeError: network error", "Failed to fetch", ECONNRESET, socket
    // hang up, stream cut) used to kill the whole background turn on the
    // FIRST blip. Background runs live in throttled tabs where transient
    // failures are common — retry with capped backoff instead of dying.
    let transientRetries = 0;
    const TRANSIENT_RETRY_MAX = 5;
    const isTransientTransportError = (msg: string) =>
      /network error|failed to fetch|fetch failed|load failed|econnreset|socket hang up|connection reset|terminated|bodystreambuffer|stream aborted|idle timeout|abnormal|networkerror/i.test(
        msg,
      );
    // CONTEXT-OVERFLOW SELF-HEALING (LLM HTTP 400 fix, mirrors the sandbox
    // runner): a 400 "maximum context length" is a SIZE problem — compact
    // the subagent history (keep system + most recent messages) and retry
    // the SAME iteration. Ladder: keep 16 → 8 → 4 trailing messages.
    let ctxCompactLevel = 0;
    const ctxOverflowRe =
      /maximum context length|context_length_exceeded|context length exceeded|too many tokens|context window|reduce the length|shorter context/i;
    const ctxKeepLadder = [16, 8, 4];
    // BEGIN-OF-RUN RESET ("browser tool isn't available in this mode" fix):
    // a noTools downgrade learned on an earlier turn/session must not strip
    // THIS subagent's tool surface — subagents live and die by their tools.
    beginTurnWireCompat(config.baseUrl, config.model);

    while (maxIterations-- > 0) {
      // ROUND-SCOPED TOOL REBUILD (main-runtime parity): tools used by
      // earlier rounds of THIS turn are latched in from the next round on,
      // so a turn that legitimately wanders across capabilities (research →
      // write file → schedule) never loses one it already used. The wire
      // schema + the "everything granted" set stay in sync per round.
      if (turnUsedToolNames.size > 0) {
        const rebuilt = buildSubagentTools();
        if (rebuilt.length !== allTools.length) {
          toolsSchema = buildToolsSchema(rebuilt);
          allTools.length = 0;
          allTools.push(...rebuilt);
        }
      }
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
      try {
        for (;;) {
          // HEADERS-PHASE WATCHDOG (subagent-stall fix): a provider that
          // accepts the connection then never answers headers used to hang
          // this fetch forever (no signal, no timeout — the stall's second
          // face). Race the fetch against a bounded watchdog; the loser
          // aborts the fetch. 300s covers non-streaming providers that hold
          // headers until the full completion is ready. The thrown message
          // deliberately contains "idle timeout" so the catch below routes
          // it into the bounded transient retry, not a hard death.
          const fetchAbort = new AbortController();
          const onRunAbortForFetch = () => fetchAbort.abort();
          runAbort.signal.addEventListener("abort", onRunAbortForFetch, { once: true });
          let headersTimer: ReturnType<typeof setTimeout> | undefined;
          // CLEARTEXT-UPSTREAM KEY GUARD (same as the main runtime): never
          // attach the Bearer key to an http:// target, never send an empty
          // Bearer (strict gateways 401 on `Bearer ` with no token).
          const isCleartextUpstream = targetUrl.startsWith("http://");
          const fetchHeaders: Record<string, string> = {
            "Content-Type": "application/json",
            "x-target-url": targetUrl,
            Accept: "text/event-stream",
          };
          if (config.apiKey && !isCleartextUpstream) {
            fetchHeaders.Authorization = `Bearer ${config.apiKey}`;
          }
          try {
            res = await Promise.race([
              fetch(requestUrl, {
                method: "POST",
                headers: fetchHeaders,
                body: JSON.stringify(body),
                cache: "no-store",
                signal: fetchAbort.signal,
              }),
              new Promise<never>((_, reject) => {
                headersTimer = setTimeout(() => {
                  fetchAbort.abort();
                  reject(
                    new Error(
                      `idle timeout waiting for response headers — the provider never answered within ${Math.round(SUBAGENT_HEADERS_TIMEOUT_MS / 1000)}s (subagent headers watchdog)`,
                    ),
                  );
                }, SUBAGENT_HEADERS_TIMEOUT_MS);
              }),
            ]);
          } finally {
            if (headersTimer !== undefined) clearTimeout(headersTimer);
            runAbort.signal.removeEventListener("abort", onRunAbortForFetch);
          }

          // No rate-limit auto-retry (removed per user request) — fall
          // through to the !res.ok handler with a clear error message.
          break;
        }
      } catch (fetchErr) {
        // TRANSIENT TRANSPORT RETRY (background network-error fix): a
        // fetch()-level throw (TypeError: network error / Failed to fetch /
        // socket-level reset) is a TRANSPORT blip, not a provider verdict —
        // background subagent runs used to die here on the first hiccup.
        // Bounded backoff (1s → 16s, 5 attempts), then the honest error.
        const msg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
        if (isTransientTransportError(msg) && transientRetries < TRANSIENT_RETRY_MAX) {
          transientRetries += 1;
          const delayMs = Math.round(Math.min(1000 * 2 ** (transientRetries - 1), 16_000) * (0.75 + Math.random() * 0.5));
          console.warn(
            `[subagent] transient network error — retrying in ${delayMs}ms (${transientRetries}/${TRANSIENT_RETRY_MAX}): ${msg.slice(0, 120)}`,
          );
          logWarn("subagent", `Subagent LLM: transient network error — retrying in ${Math.round(delayMs / 1000)}s (${transientRetries}/${TRANSIENT_RETRY_MAX})`, {
            detail: msg.slice(0, 300),
            context: { model: config.model, retry_in_ms: delayMs },
          });
          // Don't burn a generation round on a transport retry.
          maxIterations += 1;
          await new Promise((r) => setTimeout(r, delayMs));
          continue;
        }
        throw fetchErr;
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
          maxIterations += 1; // retry, not a productive round — refund the budget
          continue;
        }
        // CONTEXT-OVERFLOW SELF-HEALING — checked BEFORE param stripping and
        // the wire-compat ladder: a size problem must not burn shape-fix
        // steps (none of them shrink anything). Compact + retry same round.
        if (res.status === 400 && ctxOverflowRe.test(errText)) {
          const keep = ctxKeepLadder[Math.min(ctxCompactLevel, ctxKeepLadder.length - 1)];
          if (ctxCompactLevel < ctxKeepLadder.length && apiMessages.length > keep + 1) {
            ctxCompactLevel += 1;
            const dropped = apiMessages.length - keep - 1;
            apiMessages.splice(
              1,
              dropped,
              {
                role: "system",
                content:
                  "CONTEXT NOTE: earlier messages were compacted to fit the model's context window. The system prompt and the most recent work are preserved. Continue from the latest messages — do NOT redo completed work.",
              } as ChatCompletionMessage,
            );
            body.messages = buildWireMessages(apiMessages, wireMode);
            console.warn(
              `[subagent] context overflow (HTTP 400) — compacted ${dropped} messages (kept system + last ${keep}), retrying`,
            );
            logWarn(
              "subagent",
              `Subagent LLM: context overflow (HTTP 400) — compacted ${dropped} messages (kept system + last ${keep}), retrying the same round`,
              { detail: errText.slice(0, 200), context: { model: config.model, status: 400 } },
            );
            maxIterations += 1; // compaction retry — refund the mission budget
            continue;
          }
          throw new Error(
            `Context overflow (HTTP 400) — the subagent conversation exceeds this endpoint's maximum context length even after emergency compaction. ${errText.slice(0, 300)}`,
          );
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
          maxIterations += 1; // param-strip retry — refund the mission budget
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
          maxIterations += 1; // strict-ladder retry — refund the mission budget
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
        // GUARDED PARSE: a 200 with an HTML error page / empty body /
        // truncated JSON used to throw a raw SyntaxError ("Unexpected token
        // '<'") that read as the subagent's answer. Parse defensively and
        // surface an honest provider error instead.
        let data: { choices?: NonStreamingChoice[] } & Record<string, unknown>;
        const rawBody = await res.text().catch(() => "");
        try {
          data = JSON.parse(rawBody) as { choices?: NonStreamingChoice[] } & Record<string, unknown>;
        } catch {
          logError("subagent", "Subagent LLM: non-streaming response was not JSON", {
            detail: rawBody.slice(0, 400),
            context: { model: config.model, status: res.status },
          });
          throw new Error(
            `Provider returned a non-JSON response (HTTP ${res.status}, content-type ${contentType || "unknown"}) — likely an HTML error page. First 200 chars: ${rawBody.slice(0, 200)}`,
          );
        }
        const choice = data.choices?.[0];
        if (!choice) {
          const se = extractStreamError(data as Record<string, unknown>);
          logError("subagent", `Subagent LLM: no response — ${se ?? "response had no choices"}`, {
            detail: JSON.stringify(data).slice(0, 1500),
            context: { model: config.model, status: res.status },
          });
          throw new Error(se ?? "No response from API");
        }
        const msg = choice.message ?? {};

        // Handle tool calls.
        if (msg.tool_calls && msg.tool_calls.length > 0 && config.toolsEnabled) {
          // Pass reasoning_content back; surface reasoning in the UI too.
          if (msg.reasoning_content) {
            accumulatedReasoning += msg.reasoning_content;
            useSubagentStore.getState().updateMessage(sid, assistantMsgId, {
              reasoning: accumulatedReasoning,
              isReasoningStreaming: true,
            });
          }
          apiMessages.push({
            role: "assistant",
            content: msg.content || "",
            reasoning_content: accumulatedReasoning || undefined,
            // WIRE-SAFE REPLAY (mirrors the streaming path): the replayed
            // argument string is ALWAYS valid JSON (repaired copy / {}) —
            // never the provider's raw truncated text, which poisoned the
            // next request with a 400 "invalid arguments".
            tool_calls: msg.tool_calls.map((tc: { id: string; function: { name: string; arguments: string } }) => ({
              id: tc.id,
              type: "function" as const,
              function: {
                name: tc.function.name,
                arguments: wireSafeArguments(tc.function.arguments),
              },
            })),
          });

          // Execute tool calls in parallel
          await executeToolCallsParallel(
            msg.tool_calls, allTools, subagentId, sid, assistantMsgId, apiMessages,
            msg.content || "",
            subagentSandboxKey,
            subagentEnvVars,
            turnUsedToolNames,
            originConversationId,
            subagentEmit,
          );
          // CROSS-ROUND APPEND (PRD §1): non-streamed rounds also add to
          // the turn's text — never replace it.
          fullTurnText += stripFunctionCallTags(msg.content || "");
          fullResponse = fullTurnText;
          continue;
        }

        fullTurnText += stripFunctionCallTags(msg.content || "");
        fullResponse = fullTurnText;
        useSubagentStore.getState().updateMessage(sid, assistantMsgId, {
          content: fullResponse,
          isStreaming: false,
        });
        break;
      }

      // Parse SSE stream — NO THROTTLE, flush immediately (like main chat).
      // TRANSIENT-RETRY ENVELOPE (subagent-stall fix): a dead or silent
      // stream (idle timeout, cut socket, network failure) rewinds and
      // re-streams THIS round — bounded by transientStreamRetries — instead
      // of ending the subagent run on one transport hiccup (mirrors the
      // main runtime's transient ladder; the old code had NO timeout and
      // NO retry, so one silent stream stalled the subagent forever).
      // CROSS-ROUND ACCUMULATION (Sub-Agent Chat PRD §1/§4 — the
      // disappearing-text fix): these accumulators LIVE ACROSS ROUNDS now.
      // The old code reset them to "" at the top of every round, so after a
      // tool round the pre-tool text vanished from the message (each round
      // REPLACED content with only its own delta tail). `roundText` /
      // `roundReasoning` capture THIS round's stream; the persisted message
      // carries the full turn — text appended, never replaced.
      let roundText = "";
      let roundReasoning = "";
      let toolCallsBuffer: Array<{ id: string; function: { name: string; arguments: string } }> = [];
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
      try {
      const reader = res.body?.getReader();
      if (!reader) throw new Error("No response body");
      const decoder = new TextDecoder();
      let buffer = "";
      // STREAMED TOOL-CALL ACCUMULATOR (tool-reliability PRD §7.2 — parity
      // with the main runtime): keyed via resolveToolCallAccumulatorKey.
      // The old `tc.index ?? 0` keying merged every parallel call from
      // index-less providers into ONE entry (names/args concatenated into
      // invalid JSON → MALFORMED_TOOL_ARGUMENTS round-trips).
      const toolCallAcc = new Map<number, { id: string; name: string; args: string }>();
      // Stable card id per accumulator slot — minted once when the card is
      // pre-emitted, so streaming-arg card updates keep matching even while
      // the real provider id has not arrived yet.
      const cardIds = new Map<number, string>();

      // Track which tool calls we've already shown as "running" to avoid duplicates
      const shownToolCards = new Set<number>();

      // STREAM IDLE TIMEOUT (subagent-stall fix — mirrors the main runtime's
      // parseSSEStream): no chunk for SUBAGENT_STREAM_IDLE_TIMEOUT_MS →
      // cancel the body and throw a transient transport error, which the
      // catch below routes into a bounded rewind-and-retry. A gateway that
      // accepts the request then goes silent can never wedge
      // reader.read() forever — the #1 cause of "subagent stalls after
      // 2-3 tool calls" (the message stuck at isStreaming: true with no
      // way to stop it).
      const readWithIdleTimeout = async (): Promise<ReadableStreamReadResult<Uint8Array>> => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  new Error(
                    `idle timeout — the provider stream sent nothing for ${Math.round(SUBAGENT_STREAM_IDLE_TIMEOUT_MS / 1000)}s`,
                  ),
                ),
              SUBAGENT_STREAM_IDLE_TIMEOUT_MS,
            );
          });
          return await Promise.race([reader.read(), timeout]);
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
      };

      try {
      while (true) {
        let readResult: ReadableStreamReadResult<Uint8Array>;
        try {
          readResult = await readWithIdleTimeout();
        } catch (idleErr) {
          // Abandon the dead body (cancels the download; releaseLock alone
          // cannot run with a read pending) — the error then flows into
          // the transient-retry catch below.
          try {
            await reader.cancel();
          } catch {
            // already errored/closed — nothing to cancel
          }
          throw idleErr;
        }
        const { done, value } = readResult;
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

              // Text delta — flush immediately (no throttle). PRD §1:
              // APPEND to the turn's accumulated text; the store write
              // carries the FULL turn (prior rounds + this delta), so a
              // later round never replaces earlier generated text.
              if (delta.content) {
                roundText += delta.content;
                fullTurnText += delta.content;
                // Immediate update — no 60ms throttle
                useSubagentStore.getState().updateMessage(sid, assistantMsgId, {
                  content: stripFunctionCallTags(fullTurnText),
                  isStreaming: true,
                });
              }

              // Reasoning delta — PRD §3: persist into the message so the
              // shared ThinkingReasoning element renders it live; also
              // accumulated for passing back to the API.
              if (delta.reasoning_content || delta.reasoning) {
                const rDelta = (delta.reasoning_content || delta.reasoning || "");
                roundReasoning += rDelta;
                accumulatedReasoning += rDelta;
                useSubagentStore.getState().updateMessage(sid, assistantMsgId, {
                  reasoning: accumulatedReasoning,
                  isReasoningStreaming: true,
                });
              }

              // Tool call delta — buffer + show immediately
              if (delta.tool_calls) {
                for (const tc of delta.tool_calls) {
                  // INDEX-LESS DELTA FIX (tool-reliability PRD §7.2): resolve
                  // the accumulator slot via resolveToolCallAccumulatorKey —
                  // providers that omit `index` previously merged every
                  // parallel call into ONE malformed entry (all deltas landed
                  // on slot 0: names/args concatenated into invalid JSON).
                  const snapshot: AccumulatedToolCallEntry[] = Array.from(
                    toolCallAcc.entries(),
                  ).map(([key, v]) => ({ key, id: v.id, name: v.name, args: v.args }));
                  const slot = resolveToolCallAccumulatorKey(
                    {
                      index: tc.index,
                      id: tc.id,
                      name: tc.function?.name,
                      arguments: tc.function?.arguments,
                    },
                    snapshot,
                  );
                  const existing = toolCallAcc.get(slot) ?? {
                    id: "",
                    name: "",
                    args: "",
                  };
                  if (tc.id) existing.id = tc.id;
                  if (tc.function?.name) existing.name += tc.function.name;
                  if (tc.function?.arguments) existing.args += tc.function.arguments;
                  toolCallAcc.set(slot, existing);

                  // Stable card id for this slot — minted once at pre-emit
                  // (prefers the provider's real id when it arrived in this
                  // same delta), then never re-keyed: streaming-arg updates
                  // and the settle keep matching the same card even when a
                  // real provider id lands later. The same id rides the
                  // assistant replay + tool result (tool_call_id), so the
                  // wire stays self-consistent.
                  if (!cardIds.has(slot)) {
                    cardIds.set(slot, tc.id || existing.id || nanoid());
                  }
                  const cardId = cardIds.get(slot)!;

                  // Show tool call card IMMEDIATELY when name is known (streaming)
                  if (existing.name && !shownToolCards.has(slot)) {
                    shownToolCards.add(slot);
                    const currentMsg = useSubagentStore.getState().sessions.find((x) => x.id === sid)?.messages.find((m) => m.id === assistantMsgId);
                    useSubagentStore.getState().updateMessage(sid, assistantMsgId, {
                      content: stripFunctionCallTags(fullTurnText),
                      toolCalls: [
                        ...(currentMsg?.toolCalls ?? []),
                        {
                          id: cardId,
                          name: existing.name,
                          args: { _streaming: existing.args } as Record<string, unknown>,
                          status: "pending" as const,
                        },
                      ],
                    });
                  } else if (existing.args && shownToolCards.has(slot)) {
                    // Update streaming args on existing card
                    const msg = useSubagentStore.getState().sessions.find((x) => x.id === sid)?.messages.find((m) => m.id === assistantMsgId);
                    if (msg?.toolCalls) {
                      useSubagentStore.getState().updateMessage(sid, assistantMsgId, {
                        toolCalls: msg.toolCalls.map((tc2) =>
                          tc2.id === cardId
                            ? { ...tc2, args: { _streaming: existing.args } as Record<string, unknown> }
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
      } finally {
        // READER HYGIENE (subagent-stall fix — mirrors the main runtime):
        // release the lock on EVERY exit path (normal end, thrown idle
        // timeout, thrown stream error). A leaked lock keeps the body
        // pinned and the connection half-open forever.
        try {
          reader.releaseLock();
        } catch {
          // already released/closed — nothing to do
        }
      }

      // Materialize the accumulator into the ordered wire buffer (slot
      // order), with each call carrying its stable card id. From here on,
      // `toolCallsBuffer` is the canonical list for the guards + replay +
      // execution below.
      toolCallsBuffer = Array.from(toolCallAcc.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([slot, tc]) => ({
          id: cardIds.get(slot) || tc.id || nanoid(),
          function: { name: tc.name, arguments: tc.args },
        }));
      } catch (streamErr) {
        // TRANSIENT TRANSPORT FAILURE — idle timeout, cut socket, network
        // error mid-stream. Rewind + re-stream THIS round when the budget
        // allows (bounded, backoff), otherwise surface an honest error.
        // ABORTED runs (pagehide) are terminal — never retried.
        const msg = streamErr instanceof Error ? streamErr.message : String(streamErr);
        const aborted = runAbort.signal.aborted;
        const isTransient = /idle timeout|network|fetch failed|stream read failed|failed to fetch|aborted/i.test(msg);
        if (!aborted && isTransient && transientStreamRetries < TRANSIENT_STREAM_MAX) {
          transientStreamRetries += 1;
          const backoffMs = Math.min(1500 * 2 ** (transientStreamRetries - 1), 15_000);
          // Rewind ONLY this round's partial text (cross-round accumulation
          // keeps earlier rounds): the retry re-streams the round from its
          // start, so the failed attempt's deltas must not duplicate — both
          // in the UI message AND in the in-memory accumulators the retry
          // appends into.
          fullTurnText = fullTurnText.slice(0, Math.max(0, fullTurnText.length - roundText.length));
          roundText = "";
          roundReasoning = "";
          useSubagentStore.getState().updateMessage(sid, assistantMsgId, {
            content: stripFunctionCallTags(fullTurnText),
            isStreaming: true,
          });
          logWarn(
            "subagent",
            `Subagent stream failed mid-round (${msg.slice(0, 120)}) — retrying the same round in ${Math.round(backoffMs / 1000)}s (${transientStreamRetries}/${TRANSIENT_STREAM_MAX})`,
            { context: { model: config.model, status: 200, retry_in_ms: backoffMs } },
          );
          await new Promise((r) => setTimeout(r, backoffMs));
          maxIterations += 1; // transport retry — refund the mission budget
          continue;
        }
        if (aborted) {
          throw new Error("Subagent run was aborted (page unload) — stopping without retry.");
        }
        logError("subagent", `Subagent stream failed after ${transientStreamRetries} transport retries: ${msg}`, {
          context: { model: config.model, status: 200 },
        });
        throw streamErr;
      }

      // SILENT-STOP GUARDS (auto-stop fix, mirrors the main runtime): a
      // finished stream with no text, no reasoning, and no tool calls must
      // surface WHY instead of ending as a normal empty answer. NOTE: with
      // cross-round accumulation a PRIOR round's text/reasoning means this
      // round legitimately added nothing (e.g. tool-only round) — only an
      // empty TURN is an error.
      if (toolCallsBuffer.length === 0) {
        if (subStreamError && !fullTurnText.trim() && !roundText.trim()) {
          logError("subagent", `Subagent LLM stream error (HTTP 200): ${subStreamError}`, {
            detail: subRawTail.join("\n"),
            context: { model: config.model, status: 200 },
          });
          throw new Error(`Provider stream error: ${subStreamError}`);
        }
        if (
          !fullTurnText.trim() &&
          !accumulatedReasoning.trim() &&
          !roundText.trim() &&
          !roundReasoning.trim()
        ) {
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
        (roundText.trim() || roundReasoning.trim() || toolCallsBuffer.length > 0)
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
          `Subagent response stream was cut off mid-generation (no finish signal) — ${roundText.length} chars this round, possibly incomplete`,
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
        roundText += cutNotice;
        fullTurnText += cutNotice;
        useSubagentStore.getState().updateMessage(sid, assistantMsgId, {
          content: stripFunctionCallTags(fullTurnText),
          isStreaming: true,
        });
      }

      // Process any buffered tool calls.
      if (toolCallsBuffer.length > 0 && config.toolsEnabled) {
        // PRD §3: settle the reasoning stream while tools run — the
        // thinking block folds to its "Thought for Ns" summary and STAYS
        // visible (it never disappears when tools execute).
        if (accumulatedReasoning) {
          useSubagentStore.getState().updateMessage(sid, assistantMsgId, {
            isReasoningStreaming: false,
          });
        }
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

          // Update card to "running" with parsed args + a start timestamp
          // (drives the shared ToolCallCard's live elapsed badge).
          const msg = useSubagentStore.getState().sessions.find((x) => x.id === sid)?.messages.find((m) => m.id === assistantMsgId);
          if (msg?.toolCalls) {
            useSubagentStore.getState().updateMessage(sid, assistantMsgId, {
              toolCalls: msg.toolCalls.map((tc2) =>
                tc2.id === tc.id
                  ? { ...tc2, args: toolArgs, status: "running" as const, startedAt: Date.now(), endedAt: undefined }
                  : tc2,
              ),
            });
          }
        }

        // Add assistant message with tool calls + reasoning_content to API
        // history. The replayed argument string is ALWAYS valid JSON
        // (repaired copy / {}) — never the raw truncated text.
        apiMessages.push({
          role: "assistant",
          content: roundText || "",
          reasoning_content: roundReasoning || undefined,
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
          // ANTI-HALLUCINATION: rewrite dotted/namespace/invented names to
          // the real tool (+ action/operation argument) before lookup —
          // resolve against the FULL registry, not just this turn's
          // request-scoped subset (scope is a prompt budget, not a
          // permission; the digest documents every registered tool).
          const nc = normalizeToolCall(
            ptc.name,
            ptc.args,
            (n) => allTools.find((t) => t.name === n) ?? getTool(n) ?? undefined,
          );
          const tool = allTools.find((t) => t.name === nc.name) ?? (getTool(nc.name) ?? undefined);
          // ROUND-LATCH (main-runtime parity): record the resolved tool for
          // the next round's scope rebuild — it can never be scoped out
          // mid-turn.
          if (tool) turnUsedToolNames.add(nc.name);
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
                // MAIN-AGENT PARITY: real event routing (ask_user panels in
                // the originating conversation) + the same interactive
                // ask-user waiter the main runtime uses — a subagent can ask
                // the user a question and gets the same answered-wait.
                emit: subagentEmit,
                waitForAskUser: (questions: Parameters<typeof waitForAskUser>[0]) =>
                  // BOUNDED WAIT (subagent-stall fix): the question may land
                  // in a conversation with no live execution — nobody
                  // answers, so resolve as skipped instead of hanging the
                  // subagent forever.
                  waitForAskUser(questions, subagentEmit, undefined, SUBAGENT_ASK_USER_TIMEOUT_MS),
                signal: undefined,
                // PRD §34/§35: subagents share the main agent's E2B sandbox.
                e2bApiKey: subagentSandboxKey,
                sandboxApiKey: subagentSandboxKey,
                sandboxMode: "shared" as const,
                envVars: subagentEnvVars,
                onToolOutput: () => {},
              };
              // HITL APPROVAL GATE (Task 2-d / PRD §13) — SAME GATE, SAME
              // GRANTS as the foreground runtime: the gate resolves the
              // ORIGINATING main-chat conversation's PROJECT rules through
              // originConversationId (a project-granted tool is granted to
              // that project's subagents too — main-agent parity); the
              // interactive approval surfaces through the pending-approvals
              // store (Settings → Tools queue + chat cards).
              const gate = await maybeGateToolCall({
                toolName: nc.name,
                args: nc.args,
                conversationId: originConversationId ?? subagentId,
                emit: () => {},
                source: "subagent",
              });
              if (gate.verdict === "denied") {
                toolResult = gate.reason;
                toolStatus = "error";
              } else if (gate.verdict === "executed") {
                toolResult = gate.result;
                toolStatus = gate.status;
              } else {
                toolResult = await tool.handler(nc.args, ctx);
                if (gate.approvalId) {
                  void recordApprovalOutcome(gate.approvalId, toolResult);
                }
              }
            } else {
              // Corrective payload: suggestions + how-to-call + the
              // never-invent rule — the model self-corrects in one round
              // instead of retrying invented names.
              toolResult = unknownToolResult(ptc.name, listTools());
              toolStatus = "error";
            }
          } catch (e) {
            toolResult = { error: e instanceof Error ? e.message : String(e) };
            toolStatus = "error";
          }
          }

          // Update tool call card with result (corrected name when a
          // hallucinated name was rewritten) + the settle timestamp for
          // the shared card's duration badge.
          const updatedMsg = useSubagentStore.getState().sessions.find((x) => x.id === sid)?.messages.find((m) => m.id === assistantMsgId);
          if (updatedMsg?.toolCalls) {
            useSubagentStore.getState().updateMessage(sid, assistantMsgId, {
              toolCalls: updatedMsg.toolCalls.map((tc2) =>
                tc2.id === ptc.id
                  ? { ...tc2, name: nc.name, args: nc.args, result: toolResult, status: toolStatus, endedAt: Date.now() }
                  : tc2,
              ),
            });
          }

          apiMessages.push({
            role: "tool" as const,
            content: JSON.stringify(toolResult),
            tool_call_id: ptc.id,
          });
        }));

        fullResponse = stripFunctionCallTags(fullTurnText);
        continue;
      }

      // No tool calls — this is the final response. Settle BOTH the text
      // and the reasoning stream (PRD §3: the thinking block folds into
      // its "Thought for Ns" summary, still fully visible).
      fullResponse = stripFunctionCallTags(fullTurnText);
      useSubagentStore.getState().updateMessage(sid, assistantMsgId, {
        content: fullResponse,
        ...(accumulatedReasoning ? { isReasoningStreaming: false } : {}),
        isStreaming: false,
      });
      break;
    }

    // Cap exhausted mid-task (tool calls were still flowing) — mark it
    // honestly so the orchestrator never mistakes this for a real answer.
    if (maxIterations <= 0 && !fullResponse.trim()) {
      fullResponse = "(subagent stopped after its round budget — no final answer was produced)";
    }

    return fullResponse;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    // Preserve any text/reasoning the turn already produced (PRD §1/§4):
    // the error replaces nothing — it APPENDS below what was generated.
    const existing = useSubagentStore.getState().sessions
      .find((x) => x.id === sid)?.messages.find((m) => m.id === assistantMsgId);
    const prefix = existing?.content?.trim() ? `${existing.content.trim()}\n\n---\n` : "";
    useSubagentStore.getState().updateMessage(sid, assistantMsgId, {
      content: `${prefix}Error: ${errMsg}`,
      ...(existing?.reasoning ? { isReasoningStreaming: false } : {}),
      isStreaming: false,
    });
    return errMsg;
  } finally {
    // ABORT LIFECYCLE cleanup — the pagehide hook must never outlive the
    // run (a leaked listener would abort nothing but pin the closure).
    if (typeof window !== "undefined") {
      window.removeEventListener("pagehide", onRunAbort);
    }
  }
}

/**
 * Back-compat awaited wrapper — delivers the message, then waits for the
 * detached generation to settle and resolves with its final text. Kept for
 * tests + tool callers that want the settled text. The agent-side
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
  /** Round-latch accumulator (main-runtime parity) — optional for
   *  back-compat call sites; resolved tools are latched for the next
   *  round's scope rebuild. */
  turnUsedToolNames?: Set<string>,
  /** The originating main-chat conversation — the permission gate resolves
   *  PROJECT rules through it (main-agent parity). Optional for back-compat
   *  call sites; null → global policy only. */
  originConversationId: string | null = null,
  /** Event bridge into the originating conversation's live execution store
   *  (ask_user panels, …). Optional; absent → no-op emit, no ask-user. */
  subagentEmit?: (e: WSEvent) => void,
) {
  await Promise.all(toolCalls.map(async (tc) => {
    const parsed = parseToolCallArguments(tc.function.arguments);
    const toolArgs = parsed.args;
    // Malformed + unrepairable → structured tool error, never executed.
    const malformed = parsed.malformed && !parsed.repaired;

    // ANTI-HALLUCINATION: rewrite dotted/namespace/invented names to the
    // real tool (+ action/operation argument); resolve against the FULL
    // registry (request scope is a prompt budget, not a permission).
    const nc = normalizeToolCall(
      tc.function.name,
      toolArgs,
      (n) => allTools.find((t) => t.name === n) ?? getTool(n) ?? undefined,
    );
    const tool = allTools.find((t) => t.name === nc.name) ?? (getTool(nc.name) ?? undefined);
    // ROUND-LATCH (main-runtime parity, streaming site latches too): the
    // resolved tool rides along from the next round's scope rebuild.
    if (tool) turnUsedToolNames?.add(nc.name);

    // Add running tool call card (shows the CORRECTED name when a
    // hallucinated name was rewritten, so the card reflects what ran).
    const currentMsg = useSubagentStore.getState().sessions.find((x) => x.id === sid)?.messages.find((m) => m.id === assistantMsgId);
    useSubagentStore.getState().updateMessage(sid, assistantMsgId, {
      toolCalls: [
        ...(currentMsg?.toolCalls ?? []),
        { id: tc.id, name: nc.name, args: nc.args, status: "running" as const, startedAt: Date.now() },
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
        // MAIN-AGENT PARITY: real event routing + interactive ask-user (the
        // emit bridge is threaded in by the caller — see the streaming site).
        const ctx = {
          userId: useAuthStore.getState().user?.id ?? "",
          conversationId: _subagentId,
          emit: subagentEmit ?? (() => {}),
          waitForAskUser: subagentEmit
            ? (questions: Parameters<typeof waitForAskUser>[0]) =>
                // BOUNDED WAIT (subagent-stall fix): see the streaming site.
                waitForAskUser(questions, subagentEmit, undefined, SUBAGENT_ASK_USER_TIMEOUT_MS)
            : undefined,
          signal: undefined,
          // PRD §34/§35: subagents share the main agent's E2B sandbox.
          e2bApiKey: sandboxKey,
          sandboxApiKey: sandboxKey,
          sandboxMode: "shared" as const,
          envVars,
          onToolOutput: () => {},
        };
        // HITL APPROVAL GATE (Task 2-d / PRD §13) — same gate as the other
        // dispatch sites (see the note in the streaming site above): the
        // ORIGINATING main-chat conversation resolves PROJECT rules
        // (main-agent parity); falls back to the subagent id (global
        // policy) when the origin is unknown.
        const gate = await maybeGateToolCall({
          toolName: nc.name,
          args: nc.args,
          conversationId: originConversationId ?? _subagentId,
          emit: subagentEmit ?? (() => {}),
          source: "subagent",
        });
        if (gate.verdict === "denied") {
          toolResult = gate.reason;
          toolStatus = "error";
        } else if (gate.verdict === "executed") {
          toolResult = gate.result;
          toolStatus = gate.status;
        } else {
          toolResult = await tool.handler(nc.args, ctx);
          if (gate.approvalId) {
            void recordApprovalOutcome(gate.approvalId, toolResult);
          }
        }
      } else {
        // Corrective payload: suggestions + how-to-call + the never-invent
        // rule — the model self-corrects in one round.
        toolResult = unknownToolResult(tc.function.name, listTools());
        toolStatus = "error";
      }
    } catch (e) {
      toolResult = { error: e instanceof Error ? e.message : String(e) };
      toolStatus = "error";
    }
    }

    // Update tool call card with result (+ settle timestamp)
    const updatedMsg = useSubagentStore.getState().sessions.find((x) => x.id === sid)?.messages.find((m) => m.id === assistantMsgId);
    if (updatedMsg?.toolCalls) {
      useSubagentStore.getState().updateMessage(sid, assistantMsgId, {
        toolCalls: updatedMsg.toolCalls.map((tc2) =>
          tc2.id === tc.id ? { ...tc2, result: toolResult, status: toolStatus, endedAt: Date.now() } : tc2,
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

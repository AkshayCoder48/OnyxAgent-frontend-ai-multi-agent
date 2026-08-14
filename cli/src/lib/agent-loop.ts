/**
 * Agent loop — CLI agent runtime that connects the provider, tool registry,
 * and executor into a multi-round agentic loop.
 *
 * Flow:
 *   1. Build system prompt + messages
 *   2. Stream AI response (text, reasoning, tool_call deltas)
 *   3. After stream ends, collect all tool_calls
 *   4. Execute tools (parallel for independent calls)
 *   5. Append tool results to messages
 *   6. If tool calls were made, loop back to step 2
 *   7. If no tool calls, return final response
 */

import {
  streamChatCompletion,
  type ProviderConfig,
  type ChatMessage,
} from "./provider.js";
import {
  getTool,
  getToolSchemas,
  type ToolContext,
  type ToolResult,
} from "./tools.js";
import type { Executor } from "./executor.js";

export interface AgentLoopOptions {
  provider: ProviderConfig;
  executor: Executor;
  systemPrompt: string;
  userMessage: string;
  maxRounds?: number;
  singleRound?: boolean;
  showReasoning?: boolean;
  signal?: AbortSignal;
  onTextDelta?: (delta: string) => void;
  onReasoningDelta?: (delta: string) => void;
  onToolCall?: (name: string, args: Record<string, unknown>, toolCallId: string) => void;
  onToolResult?: (toolCallId: string, result: ToolResult) => void;
  onRoundStart?: (round: number) => void;
  onRoundEnd?: (round: number, hasToolCalls: boolean) => void;
}

export interface AgentLoopResult {
  finalContent: string;
  reasoning?: string;
  toolCalls: Array<{ id: string; name: string; args: Record<string, unknown>; result?: ToolResult }>;
  rounds: number;
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
}

export async function runAgentLoop(opts: AgentLoopOptions): Promise<AgentLoopResult> {
  const maxRounds = opts.singleRound ? 2 : (opts.maxRounds ?? 50);
  const tools = getToolSchemas();

  const messages: ChatMessage[] = [
    { role: "system", content: opts.systemPrompt },
    { role: "user", content: opts.userMessage },
  ];

  let allToolCalls: AgentLoopResult["toolCalls"] = [];
  let lastContent = "";
  let lastReasoning = "";
  let lastUsage: AgentLoopResult["usage"];
  let roundsCompleted = 0;

  const toolCtx: ToolContext = {
    executor: opts.executor,
    onToolOutput: (_id, output) => {
      if (opts.onTextDelta) opts.onTextDelta(output);
    },
  };

  for (let round = 1; round <= maxRounds; round++) {
    opts.onRoundStart?.(round);
    roundsCompleted = round;

    // Stream AI response
    const toolCallAccumulator = new Map<number, { id: string; name: string; args: string }>();
    let roundContent = "";
    let roundReasoning = "";

    try {
      for await (const chunk of streamChatCompletion(
        opts.provider,
        messages,
        tools.length > 0 ? tools : undefined,
        opts.signal,
      )) {
        if (chunk.textDelta) {
          roundContent += chunk.textDelta;
          opts.onTextDelta?.(chunk.textDelta);
        }
        if (chunk.reasoningDelta) {
          roundReasoning += chunk.reasoningDelta;
          opts.onReasoningDelta?.(chunk.reasoningDelta);
        }
        if (chunk.toolCallDelta) {
          const existing = toolCallAccumulator.get(chunk.toolCallDelta.index) ?? {
            id: chunk.toolCallDelta.id ?? "",
            name: chunk.toolCallDelta.name ?? "",
            args: "",
          };
          if (chunk.toolCallDelta.id) existing.id = chunk.toolCallDelta.id;
          if (chunk.toolCallDelta.name) existing.name = chunk.toolCallDelta.name;
          if (chunk.toolCallDelta.arguments) existing.args += chunk.toolCallDelta.arguments;
          toolCallAccumulator.set(chunk.toolCallDelta.index, existing);
        }
        if (chunk.usage) {
          lastUsage = chunk.usage;
        }
        if (chunk.done) break;
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        break;
      }
      throw err;
    }

    lastContent = roundContent || lastContent;
    lastReasoning = roundReasoning || lastReasoning;

    // Collect tool calls
    const toolCalls = Array.from(toolCallAccumulator.values());

    opts.onRoundEnd?.(round, toolCalls.length > 0);

    // In single-round mode, don't execute tools in round 2
    if (opts.singleRound && round >= 2) {
      break;
    }

    // No tool calls → done
    if (toolCalls.length === 0) {
      break;
    }

    // Append assistant message with tool calls
    messages.push({
      role: "assistant",
      content: roundContent || "",
      ...(roundReasoning ? { reasoning_content: roundReasoning } : {}),
      tool_calls: toolCalls.map((tc) => ({
        id: tc.id,
        type: "function" as const,
        function: { name: tc.name, arguments: tc.args },
      })),
    });

    // Execute all tool calls in parallel
    const toolResults = await Promise.all(
      toolCalls.map(async (tc): Promise<{ id: string; name: string; args: Record<string, unknown>; result: ToolResult }> => {
        let parsedArgs: Record<string, unknown> = {};
        try {
          parsedArgs = JSON.parse(tc.args || "{}");
        } catch {}

        opts.onToolCall?.(tc.name, parsedArgs, tc.id);

        const toolDef = getTool(tc.name);
        if (!toolDef) {
          const result: ToolResult = { success: false, output: null, error: `Tool '${tc.name}' not registered` };
          opts.onToolResult?.(tc.id, result);
          return { id: tc.id, name: tc.name, args: parsedArgs, result };
        }

        try {
          const result = await toolDef.execute(parsedArgs, toolCtx);
          opts.onToolResult?.(tc.id, result);
          return { id: tc.id, name: tc.name, args: parsedArgs, result };
        } catch (e) {
          const result: ToolResult = { success: false, output: null, error: e instanceof Error ? e.message : String(e) };
          opts.onToolResult?.(tc.id, result);
          return { id: tc.id, name: tc.name, args: parsedArgs, result };
        }
      }),
    );

    // Append tool results to messages
    for (const tr of toolResults) {
      messages.push({
        role: "tool",
        tool_call_id: tr.id,
        content: JSON.stringify(tr.result.output ?? { error: tr.result.error }),
      });
      allToolCalls.push({ id: tr.id, name: tr.name, args: tr.args, result: tr.result });
    }
  }

  return {
    finalContent: lastContent,
    reasoning: lastReasoning || undefined,
    toolCalls: allToolCalls,
    rounds: roundsCompleted,
    usage: lastUsage,
  };
}

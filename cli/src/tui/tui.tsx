/**
 * TUI — Real Terminal UI using Ink (React for CLI).
 *
 * Features:
 * - Streaming chat with live "Thinking..." indicator before first token
 * - Collapsible reasoning panel (toggle with /reasoning or R key)
 * - Tool call activity feed
 * - Status bar (provider, model, executor, rounds)
 * - Exit with /exit or Ctrl-C
 */

import React, { useState, useEffect, useCallback } from "react";
import { render, Box, Text, useInput, useApp, useStdin } from "ink";
import { loadConfig, saveConfig } from "../lib/config.js";
import { getSecret } from "../lib/vault.js";
import type { ProviderConfig, ChatMessage } from "../lib/provider.js";
import { runAgentLoop } from "../lib/agent-loop.js";
import { LocalExecutor } from "../lib/local-executor.js";
import { E2BExecutor } from "../lib/e2b-executor.js";
import type { Executor } from "../lib/executor.js";

interface ChatEntry {
  role: "user" | "assistant" | "system";
  content: string;
  reasoning?: string;
  toolCalls?: Array<{ name: string; args: Record<string, unknown>; success: boolean; summary: string }>;
  rounds?: number;
}

interface TuiProps {
  providerConfig: ProviderConfig;
  executor: Executor;
  systemPrompt: string;
  showReasoning: boolean;
  singleRound: boolean;
  config: ReturnType<typeof loadConfig>;
}

function TuiApp({ providerConfig, executor, systemPrompt, showReasoning: initialShowReasoning, singleRound, config }: TuiProps) {
  const { exit } = useApp();
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [input, setInput] = useState("");
  const [isGenerating, setGenerating] = useState(false);
  const [thinking, setThinking] = useState(false); // true until first token arrives
  const [streamingText, setStreamingText] = useState("");
  const [streamingReasoning, setStreamingReasoning] = useState("");
  const [toolFeed, setToolFeed] = useState<Array<{ name: string; args: string; status: string; result: string }>>([]);
  const [showReasoning, setShowReasoning] = useState(initialShowReasoning);
  const [reasoningExpanded, setReasoningExpanded] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusLine, setStatusLine] = useState("");
  const messagesRef = React.useRef<ChatMessage[]>([{ role: "system", content: systemPrompt }]);
  const abortRef = React.useRef<AbortController | null>(null);

  useInput((inputChar, key) => {
    if (key.ctrl && inputChar === "c") {
      if (isGenerating && abortRef.current) {
        abortRef.current.abort();
      } else {
        exit();
      }
      return;
    }
    if (key.return) {
      handleSubmit();
      return;
    }
    if (key.backspace || key.delete) {
      setInput((prev) => prev.slice(0, -1));
      return;
    }
    if (inputChar && !key.ctrl && !key.meta) {
      setInput((prev) => prev + inputChar);
    }
  });

  const handleSubmit = useCallback(async () => {
    const text = input.trim();
    if (!text || isGenerating) return;

    setInput("");
    setError(null);

    // Slash commands
    if (text.startsWith("/")) {
      const [cmd, ...args] = text.slice(1).split(" ");
      const arg = args.join(" ");
      switch (cmd) {
        case "exit":
        case "quit":
          exit();
          return;
        case "clear":
          messagesRef.current = [{ role: "system", content: systemPrompt }];
          setEntries([]);
          setToolFeed([]);
          return;
        case "reasoning":
          setShowReasoning((v) => !v);
          return;
        case "expand":
          setReasoningExpanded((v) => !v);
          return;
        case "help":
          setEntries((prev) => [...prev, {
            role: "system",
            content: "Commands: /exit /clear /reasoning /expand /help | Ctrl-C to stop/exit",
          }]);
          return;
        default:
          setEntries((prev) => [...prev, { role: "system", content: `Unknown: /${cmd}. Type /help.` }]);
          return;
      }
    }

    // Shell command
    if (text.startsWith("!")) {
      try {
        const { execSync } = await import("child_process");
        const output = execSync(text.slice(1), { encoding: "utf-8", timeout: 10000 });
        setEntries((prev) => [...prev, { role: "system", content: output.trim() }]);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
      return;
    }

    // Chat
    messagesRef.current.push({ role: "user", content: text });
    setEntries((prev) => [...prev, { role: "user", content: text }]);
    setGenerating(true);
    setThinking(true);
    setStreamingText("");
    setStreamingReasoning("");
    setToolFeed([]);
    setStatusLine("Thinking...");

    const controller = new AbortController();
    abortRef.current = controller;

    let roundCount = 0;
    let toolCount = 0;

    try {
      const result = await runAgentLoop({
        provider: providerConfig,
        executor,
        systemPrompt,
        userMessage: text,
        maxRounds: 50,
        singleRound,
        showReasoning,
        signal: controller.signal,
        onTextDelta: (delta) => {
          if (thinking) {
            setThinking(false);
            setStatusLine("Generating...");
          }
          setStreamingText((prev) => prev + delta);
        },
        onReasoningDelta: (delta) => {
          setStreamingReasoning((prev) => prev + delta);
        },
        onToolCall: (name, args) => {
          toolCount++;
          setToolFeed((prev) => [...prev, {
            name,
            args: JSON.stringify(args).slice(0, 80),
            status: "running...",
            result: "",
          }]);
        },
        onToolResult: (_id, result) => {
          const status = result.success ? "✓" : "✗";
          const summary = result.success
            ? JSON.stringify(result.output).slice(0, 100)
            : result.error ?? "failed";
          setToolFeed((prev) => {
            const updated = [...prev];
            const lastIdx = updated.length - 1;
            if (lastIdx >= 0) {
              updated[lastIdx] = { ...updated[lastIdx]!, status, result: summary };
            }
            return updated;
          });
        },
        onRoundStart: (round) => {
          roundCount = round;
          setStatusLine(`Round ${round}...`);
        },
      });

      const finalEntry: ChatEntry = {
        role: "assistant",
        content: result.finalContent || streamingText || "(empty response)",
        reasoning: streamingReasoning || result.reasoning,
        toolCalls: result.toolCalls.map((tc) => ({
          name: tc.name,
          args: tc.args,
          success: tc.result?.success ?? false,
          summary: JSON.stringify(tc.result?.output ?? { error: tc.result?.error }).slice(0, 80),
        })),
        rounds: result.rounds,
      };
      setEntries((prev) => [...prev, finalEntry]);
      setStreamingText("");
      setStreamingReasoning("");
      messagesRef.current.push({
        role: "assistant",
        content: result.finalContent,
        ...(result.reasoning ? { reasoning_content: result.reasoning } : {}),
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        if (streamingText) {
          setEntries((prev) => [...prev, {
            role: "assistant",
            content: streamingText + " [interrupted]",
            reasoning: streamingReasoning || undefined,
          }]);
        } else {
          setEntries((prev) => [...prev, { role: "system", content: "[Stopped]" }]);
        }
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setGenerating(false);
      setThinking(false);
      setStreamingText("");
      setStreamingReasoning("");
      setStatusLine("");
      abortRef.current = null;
    }
  }, [input, isGenerating, exit, executor, providerConfig, systemPrompt, singleRound, showReasoning, streamingText, streamingReasoning, thinking]);

  return (
    <Box flexDirection="column" height="100%">
      {/* Header */}
      <Box borderStyle="round" borderColor="cyan" paddingX={1}>
        <Text bold color="cyan">🤖 OnyxAgent TUI</Text>
        <Text color="gray"> | </Text>
        <Text color="white">{providerConfig.model}</Text>
        <Text color="gray"> | </Text>
        <Text color={providerConfig.apiKey ? "green" : "yellow"}>
          {providerConfig.apiKey ? "🔑 authed" : "🌐 free"}
        </Text>
        <Text color="gray"> | </Text>
        <Text color="blue">{executor.type === "e2b" ? "☁️ e2b" : "📁 local"}</Text>
        {showReasoning && <Text color="magenta"> | 🧠 reasoning</Text>}
        <Text color="gray"> | /help</Text>
      </Box>

      {/* Chat area */}
      <Box flexDirection="column" flexGrow={1} overflowY="visible" paddingX={1}>
        {entries.map((entry, i) => (
          <EntryRenderer key={i} entry={entry} showReasoning={showReasoning} reasoningExpanded={reasoningExpanded} />
        ))}

        {/* Streaming output */}
        {isGenerating && (
          <Box flexDirection="column">
            {/* Thinking indicator */}
            {thinking && (
              <Box marginTop={1}>
                <Text color="yellow">
                  <Text bold>🧠 Thinking</Text>
                  <Text dimColor>
                    {" ·".repeat(Math.floor(Date.now() / 500) % 4)}
                  </Text>
                </Text>
              </Box>
            )}

            {/* Streaming reasoning (collapsible) */}
            {showReasoning && streamingReasoning && (
              <Box flexDirection="column" marginTop={1} borderStyle="single" borderColor="magenta" paddingX={1}>
                <Text color="magenta" bold>
                  {reasoningExpanded ? "▼" : "▶"} Reasoning
                </Text>
                {reasoningExpanded && (
                  <Text color="gray" dimColor>
                    {streamingReasoning.slice(-500)}
                  </Text>
                )}
              </Box>
            )}

            {/* Streaming text */}
            {streamingText && (
              <Box marginTop={1}>
                <Text color="green">{streamingText}</Text>
              </Box>
            )}

            {/* Tool feed */}
            {toolFeed.length > 0 && (
              <Box flexDirection="column" marginTop={1}>
                {toolFeed.map((tool, i) => (
                  <Box key={i}>
                    <Text color="yellow">🔧 </Text>
                    <Text color="white" bold>{tool.name}</Text>
                    <Text color="gray"> {tool.args}</Text>
                    <Text color={tool.status === "✓" ? "green" : tool.status === "✗" ? "red" : "yellow"}>
                      {" "}{tool.status}
                    </Text>
                    {tool.result && (
                      <Text color="gray" dimColor> {tool.result.slice(0, 60)}</Text>
                    )}
                  </Box>
                ))}
              </Box>
            )}
          </Box>
        )}

        {/* Error */}
        {error && (
          <Box marginTop={1}>
            <Text color="red" bold>❌ {error}</Text>
          </Box>
        )}
      </Box>

      {/* Status bar */}
      <Box borderStyle="single" borderColor="gray" paddingX={1}>
        <Text color="gray" dimColor>
          {isGenerating
            ? statusLine || "Working..."
            : "Ready — type a message and press Enter"}
        </Text>
      </Box>

      {/* Input */}
      <Box paddingX={1}>
        <Text color="cyan" bold>{"onyx> "}</Text>
        <Text color="white">{input}</Text>
        <Text color="cyan">█</Text>
      </Box>

      {/* Footer */}
      <Box paddingX={1}>
        <Text color="gray" dimColor>
          Enter: send · Ctrl-C: {isGenerating ? "stop" : "exit"} · /help · /reasoning · /exit
        </Text>
      </Box>
    </Box>
  );
}

function EntryRenderer({ entry, showReasoning, reasoningExpanded }: {
  entry: ChatEntry;
  showReasoning: boolean;
  reasoningExpanded: boolean;
}) {
  if (entry.role === "user") {
    return (
      <Box marginTop={1} flexDirection="column">
        <Text color="cyan" bold>┌─ You ──────────────────────</Text>
        <Text color="cyan">│ </Text>
        <Text color="white">{entry.content}</Text>
        <Text color="cyan">└─────────────────────────────</Text>
      </Box>
    );
  }

  if (entry.role === "system") {
    return (
      <Box marginTop={1}>
        <Text color="gray" dimColor>  {entry.content}</Text>
      </Box>
    );
  }

  // Assistant
  return (
    <Box marginTop={1} flexDirection="column">
      <Text color="green" bold>┌─ AI ───────────────────────</Text>

      {/* Reasoning panel (collapsible) */}
      {showReasoning && entry.reasoning && (
        <Box flexDirection="column" borderStyle="single" borderColor="magenta" paddingX={1} marginY={0}>
          <Text color="magenta" bold>
            {reasoningExpanded ? "▼" : "▶"} Reasoning
          </Text>
          {reasoningExpanded && (
            <Text color="gray" dimColor>
              {entry.reasoning.slice(0, 1000)}
              {entry.reasoning.length > 1000 ? "..." : ""}
            </Text>
          )}
        </Box>
      )}

      {/* Tool calls */}
      {entry.toolCalls && entry.toolCalls.length > 0 && (
        <Box flexDirection="column" marginY={0}>
          {entry.toolCalls.map((tc, i) => (
            <Box key={i}>
              <Text color="yellow">🔧 </Text>
              <Text color="white" bold>{tc.name}</Text>
              <Text color={tc.success ? "green" : "red"}> {tc.success ? "✓" : "✗"}</Text>
              <Text color="gray" dimColor> {tc.summary.slice(0, 60)}</Text>
            </Box>
          ))}
        </Box>
      )}

      {/* Content */}
      <Text color="white">{entry.content}</Text>

      <Text color="green">└─────────────────────────────</Text>
      {entry.rounds && entry.rounds > 0 && (
        <Text color="gray" dimColor>
          {"  ["}{entry.rounds} round(s)
          {entry.toolCalls && entry.toolCalls.length > 0 ? `, ${entry.toolCalls.length} tool(s)` : ""}
          {"]"}
        </Text>
      )}
    </Box>
  );
}

export async function startTui(opts: { showReasoning?: boolean; singleRound?: boolean } = {}): Promise<void> {
  const config = loadConfig();
  const provider = config.providers.find((p) => p.id === config.activeProviderId);

  if (!provider) {
    console.log("No provider configured. Run 'onyx setup' first.");
    process.exit(1);
  }

  const apiKey = provider.hasApiKey ? getSecret(`provider_${provider.id}`) : null;
  const model = config.defaultModel ?? provider.models[0] ?? "gpt-4o";

  let systemPrompt = "You are OnyxAgent, a helpful AI assistant. Use tools when needed. Be concise.";
  if (config.systemPromptEnabled && config.customSystemPrompt) {
    systemPrompt = config.customSystemPrompt;
  }

  const ws = config.workspaces.find((w) => w.root === config.activeWorkspaceRoot);
  let executor: Executor;
  if (ws?.executor === "e2b") {
    const e2bKey = getSecret("e2b");
    if (e2bKey) {
      executor = new E2BExecutor(e2bKey, ws.sandboxId);
    } else {
      executor = new LocalExecutor(ws?.root ?? process.cwd());
    }
  } else {
    executor = new LocalExecutor(ws?.root ?? process.cwd());
  }

  const providerConfig: ProviderConfig = {
    baseUrl: provider.baseUrl,
    apiKey,
    model,
    modelType: provider.modelType,
    toolsEnabled: provider.toolsEnabled,
    noPrefix: provider.noPrefix,
    thinkingEnabled: provider.thinkingEnabled,
    temperature: config.temperature,
  };

  const showReasoning = opts.showReasoning ?? config.appearance.showReasoning;

  render(
    <TuiApp
      providerConfig={providerConfig}
      executor={executor}
      systemPrompt={systemPrompt}
      showReasoning={showReasoning}
      singleRound={opts.singleRound ?? config.singleRoundMode}
      config={config}
    />
  );
}

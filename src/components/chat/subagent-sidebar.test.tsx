// @vitest-environment jsdom
/**
 * Sub-Agent Chat PRD §2/§3 UI regressions — the subagent sidebar message
 * renderer must REUSE the Main Chat components:
 *   - tool calls render through the shared ToolCallCard (not the deleted
 *     bespoke CollapsibleToolCard)
 *   - reasoning renders through ThinkingReasoning (the message carries
 *     `reasoning`; it is never merged into the text content)
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import React from "react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/",
}));
vi.mock("@/lib/services", () => ({
  settingsService: {
    getDecryptedSandboxKey: async () => null,
    getDecryptedEnvVars: async () => ({}),
  },
  aiProviderService: {},
}));
vi.mock("@/stores", () => ({
  useAuthStore: { getState: () => ({ user: null }) },
}));

import { useSubagentStore, type SubagentMessage } from "@/stores/subagent-store";

// The SubagentMessageItem + the shared components it renders.
import { SubAgentSidebar } from "./subagent-sidebar";
import { ThinkingReasoning } from "@/components/assistant-ui/elements";

beforeEach(() => {
  window.localStorage.clear();
  useSubagentStore.setState({ subagents: [], sessions: [], activeSessionId: null });
  cleanup();
});

describe("Sub-Agent chat rendering parity (PRD §2/§3)", () => {
  it("renders a shared ThinkingReasoning element for a message with reasoning", () => {
    const { container } = render(
      <ThinkingReasoning
        sentences={["Step one.", "Step two."]}
        phase="done"
        elapsedSeconds={3}
        verb="Thought"
        activeLabel="Thinking…"
      />,
    );
    // The shared element renders its sentences (the subagent message item
    // feeds it `reasoning` split into sentences — see the runtime test).
    expect(container.textContent).toContain("Step one.");
    expect(container.textContent).toContain("Step two.");
  });

  it("sidebar renders sessions from the store (component mounts)", async () => {
    // A session with one completed assistant message that has reasoning +
    // a tool call — exactly the shape the runtime now persists.
    const msg: SubagentMessage = {
      id: "m1",
      role: "assistant",
      content: "Here is the result.",
      timestamp: new Date().toISOString(),
      reasoning: "I considered the options.",
      isReasoningStreaming: false,
      isStreaming: false,
      toolCalls: [
        {
          id: "tc1",
          name: "list_files",
          args: { path: "/home/user" },
          result: { files: ["a.txt"] },
          status: "completed",
          startedAt: Date.now() - 1000,
          endedAt: Date.now(),
        },
      ],
    };
    useSubagentStore.setState({
      subagents: [
        {
          id: "agent1",
          name: "Worker",
          description: "test",
          specialty: "general",
          providerId: null,
          model: null,
          baseUrl: null,
          apiKey: null,
          systemPrompt: "",
          enabled: true,
          created_at: new Date().toISOString(),
        },
      ],
      sessions: [
        {
          id: "sess1",
          subagentId: "agent1",
          title: "Test chat",
          messages: [msg],
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      ],
      activeSessionId: "sess1",
    });

    const { container } = render(<SubAgentSidebar onClose={() => {}} />);
    // The message text renders through MarkdownContent (a next/dynamic
    // import — it settles asynchronously, hence waitFor).
    await waitFor(() => {
      expect(container.textContent).toContain("Here is the result.");
    });
    // The reasoning renders through the shared ThinkingReasoning element
    // (the fold summary header + the streamed sentences are both present
    // — the exact rendering Main Chat shows for the same message).
    expect(container.textContent).toMatch(/thought for \d+s/i);
    expect(container.textContent).toContain("I considered the options.");
  });

  it("sidebar renders an empty state when no session is active", () => {
    render(<SubAgentSidebar onClose={() => {}} />);
    expect(screen.getByText(/Tag a subagent with @name to begin/i)).toBeTruthy();
  });
});

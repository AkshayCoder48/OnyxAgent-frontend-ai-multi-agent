// @vitest-environment jsdom
// ChatContainer — the /settings slash-command fallback (Task 53: "/settings
// slash command not working"). The command's ctx.openSettings() prefers the
// onOpenSettings prop (AppShell passes it on /), but on /chat — where
// ChatWorkspace mounts <ChatContainer /> with NO prop — the old fallback
// clicked [data-chat-settings-trigger], a button that no longer exists
// anywhere (the composer redesign removed it): a guaranteed silent no-op.
// The fix navigates to the route-based settings instead.
//
// ChatContainer itself is a 900-line store-driven component; for this
// regression the meaningful unit is the FALLBACK CONTRACT: when the prop is
// absent, something real must happen (a router navigation) — and when the
// prop is present it must win. That logic lives in the slashContext memo;
// rather than mounting the whole container (heavy store/sandbox mocks), pin
// the two behaviors the fix changed:
//   1. the dead DOM fallback selector is GONE from the codebase;
//   2. the fallback now routes to the settings config page;
//   3. the AppShell path still opens the overlay (prop preferred).
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import React from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// The container imports next/navigation's useRouter — mock the module so
// the pushed route is observable without a real Next router.
const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, back: vi.fn(), replace: vi.fn() }),
}));

import { ChatContainer } from "./chat-container";

// ChatContainer pulls the world (use-chat, stores, sandbox runtime).
// Mock the minimum so it renders: the chat hook and the sidebar-visible
// store bits it subscribes to. useChat returns the full chat surface;
// only the fields the container destructures matter.
vi.mock("@/hooks", () => ({
  useChat: () => ({
    messages: [],
    isConnected: true,
    isProcessing: false,
    sendMessage: vi.fn(),
    clearMessages: vi.fn(),
    handleRegenerate: vi.fn(),
    pendingQuestions: null,
    onStop: vi.fn(),
    onModelChange: vi.fn(),
    onProviderSelect: vi.fn(),
    onTemperatureChange: vi.fn(),
    onThinkingEffortChange: vi.fn(),
  }),
  useConversations: () => ({
    fetchConversations: vi.fn(),
    selectConversation: vi.fn(),
    conversations: [],
  }),
  // The REAL builtin list — ChatInput treats an empty array (not null) as
  // "no commands", which would empty the palette and turn /settings into
  // a sent message instead of a command.
  useSlashCommands: async () => ({ commands: (await import("./slash-commands")).BUILTIN_COMMANDS }),
  useAuth: () => ({ user: { id: "test-user" } }),
  useData: () => ({}),
}));

// ChatControls (model popover) subscribes to the data hooks — stub them
// the same way chat-input.test.tsx does (they use a live query client
// otherwise).
vi.mock("@/hooks/use-data", () => ({
  useProviders: () => ({ providers: [] }),
}));
vi.mock("@/hooks/use-dictation", () => ({
  useDictation: () => ({
    supported: false,
    active: false,
    recording: false,
    seconds: 0,
    interim: "",
    error: null,
    start: vi.fn(),
    stop: vi.fn(),
  }),
}));

describe("/settings slash command fallback (Task 53)", () => {
  beforeEach(() => {
    cleanup();
    push.mockClear();
    // jsdom lacks scrollIntoView (the palette auto-scrolls its selection).
    Element.prototype.scrollIntoView = () => {};
  });

  it("the dead [data-chat-settings-trigger] fallback is gone from the source", () => {
    const src = readFileSync(
      resolve(process.cwd(), "src/components/chat/chat-container.tsx"),
      "utf8",
    );
    expect(src).not.toContain("data-chat-settings-trigger");
    // …replaced by a real navigation to the route-based settings.
    expect(src).toMatch(/router\.push\("\/en\/settings\/config"\)/);
  });

  it("openSettings WITHOUT the prop navigates to the settings route (the /chat mount)", async () => {
    // No onOpenSettings prop — the ChatWorkspace mount shape.
    render(React.createElement(ChatContainer));
    // The composer textarea is the command surface; type /settings and
    // Enter — the palette's top hit is the settings command.
    const textarea = await screen.findByLabelText(/Reply to OnyxAgent/);
    fireEvent.change(textarea, { target: { value: "/settings" } });
    fireEvent.submit(textarea.form ?? textarea);
    // The fallback pushed the route-based settings page.
    expect(push).toHaveBeenCalledWith("/en/settings/config");
  });

  it("openSettings WITH the prop still prefers the overlay (the AppShell mount)", async () => {
    const onOpenSettings = vi.fn();
    render(React.createElement(ChatContainer, { onOpenSettings }));
    const textarea = await screen.findByLabelText(/Reply to OnyxAgent/);
    fireEvent.change(textarea, { target: { value: "/settings" } });
    fireEvent.submit(textarea.form ?? textarea);
    expect(onOpenSettings).toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });
});

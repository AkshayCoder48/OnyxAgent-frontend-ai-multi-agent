// BrowserLivePanel — the runtime badge (the "browser shows Chromium"
// fix, 2026-11-24): the sandbox driver's engine ladder reports one of
// cloakbrowser / patchright / chromium in live.json's `runtime`, and the
// panel maps it to a short badge with an honest tooltip. This suite pins
// that mapping (rendered through the real panel component with the live
// hook stubbed).
// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import React from "react";
import { BrowserLivePanel } from "@/components/chat/browser-live-panel";

vi.mock("@/hooks/use-browser-live", () => ({
  useBrowserLive: () => ({
    phase: "live",
    frameUrl: null,
    // per-test override via the mock's module state
    ...(globalThis.__liveState ?? {}),
  }),
}));
vi.mock("@/hooks/use-data", () => ({
  useSettings: () => ({ settings: null }),
  useProviders: () => ({ providers: [] }),
}));
vi.mock("@/stores/conversation-store", () => ({
  useConversationStore: (sel: (s: { currentConversationId: string | null }) => unknown) =>
    sel({ currentConversationId: null }),
}));

const setState = (runtime: string | null) => {
  (globalThis as { __liveState?: unknown }).__liveState = {
    state: { runtime, tabCount: 2, action: "navigate" },
  };
};

const badge = (container: HTMLElement): string | null =>
  container.querySelector("span[title]")?.textContent?.trim() ?? null;

const tooltip = (container: HTMLElement): string | null =>
  container.querySelector("span[title]")?.getAttribute("title") ?? null;

afterEach(() => {
  cleanup();
  (globalThis as { __liveState?: unknown }).__liveState = undefined;
});

describe("BrowserLivePanel runtime badge (engine naming)", () => {
  it("maps cloakbrowser → 'cloak'", () => {
    setState("cloakbrowser");
    const { container } = render(React.createElement(BrowserLivePanel));
    expect(badge(container)).toBe("cloak");
    expect(tooltip(container)).toContain("CloakBrowser stealth Chromium");
  });

  it("maps patchright → 'chrome' (presents as real Chrome)", () => {
    setState("patchright");
    const { container } = render(React.createElement(BrowserLivePanel));
    expect(badge(container)).toBe("chrome");
    expect(tooltip(container)).toContain("presents as real Chrome");
  });

  it("maps chromium → 'chromium' (honest fallback label)", () => {
    setState("chromium");
    const { container } = render(React.createElement(BrowserLivePanel));
    expect(badge(container)).toBe("chromium");
    expect(tooltip(container)).toContain("stealth engine unavailable");
  });

  it("renders no badge when the runtime is unknown", () => {
    setState(null);
    const { container } = render(React.createElement(BrowserLivePanel));
    expect(badge(container)).toBeNull();
  });
});

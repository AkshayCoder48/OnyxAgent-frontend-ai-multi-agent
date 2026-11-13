// @vitest-environment jsdom
/**
 * CitationsFooter — the SOURCES ORGANIZER (Task 24, 2026-11-13):
 * the fixed 360px sources sidebar is GONE. In its place the footer under
 * each answer is a modern inline organizer:
 *
 *   1. REST — one compact pill: "Searched N sources" + the web/KB split.
 *   2. OPEN — the pill expands INLINE into the full organized list
 *      (Web / Knowledge base groups, every source, links on web rows).
 *   3. The sources-panel store still drives it: `open(sources, index)`
 *      (citation chips in the answer text) expands the footer whose
 *      sources array matches BY IDENTITY and highlights the cited row.
 *   4. Escape (or the pill) collapses it again.
 *
 * Plus a source pin (the repo idiom): the sidebar component must never
 * come back — sources-panel.tsx is deleted for good.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, beforeEach, vi } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react";
import { render } from "@testing-library/react";

import { CitationsFooter } from "./citations";
import { useSourcesPanelStore } from "@/stores/sources-panel-store";
import type { SourceItem } from "@/lib/chat-sources";

// jsdom has no scrollIntoView — the highlighted-row scroll needs a stub.
Element.prototype.scrollIntoView = vi.fn();

const webA: SourceItem = {
  index: 1,
  type: "web",
  title: "Next.js Docs",
  subtitle: "nextjs.org",
  url: "https://nextjs.org/docs",
};
const webB: SourceItem = {
  index: 2,
  type: "web",
  title: "React Docs",
  subtitle: "react.dev",
  url: "https://react.dev",
};
const ragA: SourceItem = {
  index: 3,
  type: "rag",
  title: "Workspace notes",
  subtitle: "knowledge base",
  content: "Some chunk",
  score: 0.8,
};

beforeEach(() => {
  useSourcesPanelStore.getState().close();
  useSourcesPanelStore.setState({ sources: [] });
});

describe("CitationsFooter — the sources organizer (Task 24)", () => {
  it("the sources sidebar component is gone for good (source pin)", () => {
    expect(existsSync(join(__dirname, "sources-panel.tsx"))).toBe(false);
  });

  it("rests as the compact total-searched pill with the web/KB split", () => {
    render(<CitationsFooter sources={[webA, webB, ragA]} />);
    expect(screen.getByText("Searched 3 sources")).toBeTruthy();
    expect(screen.getByText("2 web · 1 knowledge base")).toBeTruthy();
    // Collapsed rest state: no group headings, no rows.
    expect(screen.queryByText("Web", { selector: "h3" })).toBeNull();
  });

  it("the pill expands INLINE into the organized groups (no sidebar)", () => {
    render(<CitationsFooter sources={[webA, webB, ragA]} />);
    fireEvent.click(screen.getByRole("button", { name: /searched 3 sources/i }));
    expect(screen.getByText("Hide sources")).toBeTruthy();
    expect(screen.getByText("Next.js Docs")).toBeTruthy();
    expect(screen.getByText("Workspace notes")).toBeTruthy();
    // Grouped sections carry their counts.
    expect(screen.getByText("Web", { selector: "h3" })).toBeTruthy();
    expect(screen.getByText("Knowledge base", { selector: "h3" })).toBeTruthy();
    // Web rows are real links to the source.
    expect(
      screen.getByRole("link", { name: /next\.js docs/i }).getAttribute("href"),
    ).toBe("https://nextjs.org/docs");
  });

  it("citation chips (the store) expand + highlight the cited row", () => {
    const sources = [webA, webB, ragA];
    render(<CitationsFooter sources={sources} />);
    // The inline citation chip flow: open(sources, 1) — highlight webB.
    act(() => {
      useSourcesPanelStore.getState().open(sources, 2);
    });
    // The organizer expanded itself.
    expect(screen.getByText("React Docs")).toBeTruthy();
    // The cited row carries the highlight ring.
    const highlighted = screen.getByText("React Docs").closest("div");
    expect(highlighted?.className).toContain("ring");
  });

  it("a different message's footer does NOT expand (identity match)", () => {
    const mine = [webA];
    const other = [webB, ragA];
    const { unmount } = render(<CitationsFooter sources={other} />);
    render(<CitationsFooter sources={mine} />);
    act(() => {
      useSourcesPanelStore.getState().open(mine, 1);
    });
    // `mine` expanded, `other` (still mounted) did not.
    expect(screen.getByText("Hide sources")).toBeTruthy();
    expect(screen.queryByText("React Docs")).toBeNull();
    unmount();
  });

  it("Escape collapses the organizer and clears the store", () => {
    const sources = [webA, webB];
    render(<CitationsFooter sources={sources} />);
    fireEvent.click(screen.getByRole("button", { name: /searched 2 sources/i }));
    expect(screen.getByText("Hide sources")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByText("Searched 2 sources")).toBeTruthy();
    expect(useSourcesPanelStore.getState().isOpen).toBe(false);
  });
});

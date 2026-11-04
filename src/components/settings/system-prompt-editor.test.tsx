// @vitest-environment jsdom
/**
 * SystemPromptEditor — no length cap + optional .md/.txt import
 * (user directive 2026-11-04).
 *
 * Pins:
 *  - the textarea carries NO maxlength attribute and the counter reads
 *    "no cap" — a >8,000-char prompt (the old ceiling) renders fine;
 *  - "Import .md / .txt" opens a hidden file input accepting only
 *    .md/.markdown/.txt, disabled together with the editor;
 *  - a .md import FILLS the empty field (CRLF normalized), APPENDS below
 *    existing content, and REJECTS anything that is not md/txt.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// The editor's only external deps are the default-prompt constant and the
// settings hook (used by the SELF-CONTAINED lane, not the editor itself).
// Mock both so the test does not pull the whole chat/assistant-ui graph.
vi.mock("@/hooks/use-chat", () => ({ ONYX_AI_SYSTEM_PROMPT: "DEFAULT ONYX PROMPT" }));
vi.mock("@/hooks/use-data", () => ({
  useSettings: () => ({ settings: null, loading: false, update: vi.fn() }),
}));

import { SystemPromptEditor } from "./system-prompt-editor";

function setup(value = "", enabled = true) {
  const onValueChange = vi.fn();
  const onEnabledChange = vi.fn();
  render(
    <SystemPromptEditor
      value={value}
      enabled={enabled}
      onValueChange={onValueChange}
      onEnabledChange={onEnabledChange}
    />,
  );
  return { onValueChange, onEnabledChange };
}

function fileInput() {
  // The only hidden file input in the editor.
  return document.querySelector<HTMLInputElement>('input[type="file"][accept*=".md"]')!;
}

describe("SystemPromptEditor — no length cap", () => {
  it("the textarea has NO maxlength attribute and the counter says no cap", () => {
    setup("hello");
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(textarea).not.toHaveAttribute("maxlength");
    expect(screen.getByText(/no cap/i)).toBeInTheDocument();
  });

  it("a >8,000-char prompt (the old ceiling) renders with the full count", () => {
    const long = "x".repeat(10_000);
    setup(long);
    expect(screen.getByText(/10,000 chars · no cap/i)).toBeInTheDocument();
  });
});

describe("SystemPromptEditor — .md / .txt import", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("the hidden file input accepts only .md/.markdown/.txt", () => {
    setup("");
    const input = fileInput();
    expect(input.accept).toContain(".md");
    expect(input.accept).toContain(".txt");
  });

  it("the import button is disabled when the editor is disabled", () => {
    setup("", false);
    expect(screen.getByRole("button", { name: /import \.md \/ \.txt/i })).toBeDisabled();
  });

  it("a .md import FILLS the empty field (CRLF normalized)", async () => {
    const { onValueChange } = setup("");
    const file = new File(["# Rules\r\nBe terse."], "rules.md", { type: "text/markdown" });
    fireEvent.change(fileInput(), { target: { files: [file] } });
    await waitFor(() => expect(onValueChange).toHaveBeenCalledTimes(1));
    expect(onValueChange).toHaveBeenCalledWith("# Rules\nBe terse.");
  });

  it("a .txt import APPENDS below existing content, never replaces it", async () => {
    const { onValueChange } = setup("existing prompt\n");
    const file = new File(["imported section"], "notes.txt", { type: "text/plain" });
    fireEvent.change(fileInput(), { target: { files: [file] } });
    await waitFor(() => expect(onValueChange).toHaveBeenCalledTimes(1));
    const next = onValueChange.mock.calls[0]![0] as string;
    expect(next).toContain("existing prompt");
    expect(next).toContain("imported section");
    expect(next.indexOf("existing prompt")).toBeLessThan(next.indexOf("imported section"));
  });

  it("rejects files that are not .md/.txt without touching the value", async () => {
    const { onValueChange } = setup("existing");
    const file = new File(["binary-ish"], "rules.pdf", { type: "application/pdf" });
    fireEvent.change(fileInput(), { target: { files: [file] } });
    // The rejection path is synchronous (no read, no state change) — give
    // the async read a beat to prove it never fires, then assert.
    await new Promise((r) => setTimeout(r, 50));
    expect(onValueChange).not.toHaveBeenCalled();
  });
});

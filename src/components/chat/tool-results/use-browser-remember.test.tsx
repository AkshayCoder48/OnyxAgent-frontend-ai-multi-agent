// @vitest-environment jsdom
/**
 * use-browser results — the manual "Remember this page" affordance on read
 * rows (KB deepening, 2026-11-05). The user saves the page the agent just
 * read through the SAME remember-page pipeline the remember_page action
 * uses (source "user" instead of "ai").
 *
 * Heavy neighbors are mocked (the assistant-ui elements barrel, tool
 * duration badges, sonner, the auth store) so the test renders only the
 * use-browser surface.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import type { ToolCall } from "@/types";

const rememberMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/kb/remember-page", () => ({
  rememberPageToKB: rememberMock,
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock("@/stores", () => ({
  useAuthStore: (sel: (s: { user: { id: string } | null }) => unknown) =>
    sel({ user: { id: "user-1" } }),
}));
vi.mock("@/components/assistant-ui/elements", () => ({
  chipClass: "chip",
  CollapsePanel: ({ open, children }: { open: boolean; children: React.ReactNode }) => (
    <div data-open={open} aria-hidden={!open}>
      {children}
    </div>
  ),
}));
vi.mock("../tool-duration", () => ({
  ToolDurationBadge: () => <span>0.1s</span>,
  ToolLiveElapsed: () => <span>0.1s</span>,
}));

import { toast } from "sonner";
import { BrowserUseGroup } from "./use-browser";
import { rememberPageToKB } from "@/lib/kb/remember-page";

function readCall(over: Partial<ToolCall> = {}): ToolCall {
  return {
    id: "tc1",
    name: "use_browser",
    args: { action: "read" },
    result: JSON.stringify({
      kind: "browser",
      success: true,
      action: "read",
      url: "https://a.example.com/guide",
      title: "The Guide",
      text: "Page body text.",
      output: "Extracted 15 characters of visible text.",
    }),
    status: "completed",
    startedAt: Date.now() - 100,
    endedAt: Date.now(),
    ...over,
  } as ToolCall;
}

/** Expand the group, then expand the read row's output panel. */
async function expandReadRow() {
  fireEvent.click(screen.getByRole("button", { name: /use browser/i }));
  // The read row carries no target label (opTarget defaults to null for
  // read) — its accessible name starts with the op verb "Read".
  const rows = screen.getAllByRole("button", { name: /^read/i });
  fireEvent.click(rows[0]!);
}

beforeEach(() => {
  rememberMock.mockReset();
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.error).mockClear();
});

describe("BrowserOpRow — the manual Remember this page affordance", () => {
  it("appears on settled read rows with page text + url, saves with source user", async () => {
    rememberMock.mockResolvedValueOnce({
      ok: true,
      item: { id: "kb_1", title: "The Guide" },
      contentChars: 30,
      historyIncluded: false,
    });
    const { unmount } = renderGroup([readCall()]);
    await expandReadRow();

    const btn = await screen.findByRole("button", { name: /remember this page/i });
    fireEvent.click(btn);

    await waitFor(() =>
      expect(rememberMock).toHaveBeenCalledWith("user-1", {
        url: "https://a.example.com/guide",
        title: "The Guide",
        text: "Page body text.",
        source: "user",
      }),
    );
    // saved → the button flips to the saved state and disables
    await waitFor(() => expect(screen.getByText("Saved to KB")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /saved to kb/i })).toBeDisabled();
    expect(toast.success).toHaveBeenCalled();
    unmount();
  });

  it("an honest failure keeps the row retryable + surfaces the message", async () => {
    rememberMock.mockResolvedValueOnce({
      ok: false,
      code: "NOT_CONFIGURED",
      message: "Remembering pages needs an OnyxBase key.",
    });
    const { unmount } = renderGroup([readCall()]);
    await expandReadRow();

    fireEvent.click(await screen.findByRole("button", { name: /remember this page/i }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    // NOT flipped to saved — the user can retry after configuring
    expect(screen.getByRole("button", { name: /remember this page/i })).toBeEnabled();
    unmount();
  });

  it("never appears on navigate rows or while running", () => {
    const { unmount } = renderGroup([
      readCall({ id: "tc-nav", args: { action: "navigate", url: "https://a.example.com" } }),
      readCall({ id: "tc-live", status: "running", endedAt: undefined }),
    ]);
    fireEvent.click(screen.getByRole("button", { name: /use browser/i }));
    expect(screen.queryByRole("button", { name: /remember this page/i })).toBeNull();
    unmount();
  });
});

function renderGroup(calls: ToolCall[]) {
  const { render } = require("@testing-library/react") as typeof import("@testing-library/react");
  return render(<BrowserUseGroup toolCalls={calls} />);
}

describe("remember_page rows render the KB save outcome", () => {
  it("a saved remember_page row shows the KB id in its summary", () => {
    const { unmount } = renderGroup([
      readCall({
        id: "tc-remember",
        args: { action: "remember_page" },
        result: JSON.stringify({
          kind: "browser",
          success: true,
          action: "remember_page",
          url: "https://a.example.com/guide",
          title: "The Guide",
          text: "Page body text.",
          saved: true,
          kbId: "kb_xyz789",
          output: 'Remembered "The Guide" — saved to the Knowledge Base.',
        }),
      }),
    ]);
    expect(screen.getByText(/saved to KB · kb_xyz789/i)).toBeInTheDocument();
    // already saved by the agent — no manual duplicate button on this row
    expect(screen.queryByRole("button", { name: /remember this page/i })).toBeNull();
    unmount();
  });
});

// Silence the unused import lint — rememberPageToKB is the mocked pipeline.
void rememberPageToKB;

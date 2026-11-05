// @vitest-environment jsdom
/**
 * FilePreviewPanel — the workspace-source variant (Workspace File Manager,
 * 2026-11-05). A SandboxPreviewFile carries its own blob URL: the panel must
 * use it DIRECTLY (no OPFS lookup — those files have no chat_files registry
 * entry) and revoke it when the preview closes or is replaced.
 *
 * The preview card is stubbed (its markdown/highlight pipeline is not under
 * test here — the URL routing is).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";

vi.mock("./file-preview-card", () => ({
  extOf: (name: string) => {
    const i = name.lastIndexOf(".");
    return i > 0 ? name.slice(i + 1).toLowerCase() : null;
  },
  previewKind: (mime?: string, ext?: string | null) => {
    if (mime?.startsWith("image/") || ["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext ?? "")) {
      return "image";
    }
    return "text";
  },
  FilePreviewCard: ({ url, filename }: { url: string; filename: string }) => (
    <div data-testid="preview-card" data-url={url}>
      {filename}
    </div>
  ),
}));
vi.mock("@/lib/file-api", () => ({
  getFileUrl: vi.fn(() => ""),
  loadFileUrl: vi.fn(async () => ""),
}));

import { FilePreviewPanel } from "./file-preview-panel";
import { useFilePreviewStore } from "@/stores/file-preview-store";

const revoke = vi.fn();

beforeAll(() => {
  vi.stubGlobal("URL", {
    ...URL,
    createObjectURL: () => "blob:mock-url",
    revokeObjectURL: revoke,
  });
});

afterEach(() => {
  useFilePreviewStore.getState().close();
  revoke.mockClear();
  document.body.innerHTML = "";
});

function renderPanel() {
  const { render } = require("@testing-library/react") as typeof import("@testing-library/react");
  return render(<FilePreviewPanel />);
}

describe("FilePreviewPanel — sandbox (workspace) sources", () => {
  it("renders the direct blob URL without any OPFS lookup", () => {
    useFilePreviewStore.getState().openSandbox({
      kind: "sandbox",
      id: "sbx:notes.md:1",
      filename: "notes.md",
      path: "notes.md",
      url: "blob:mock-url",
      size: 120,
      mime_type: null,
    });
    renderPanel();
    const card = screen.getByTestId("preview-card");
    expect(card).toHaveAttribute("data-url", "blob:mock-url");
    // the filename shows in the header AND the stubbed viewer — both present
    expect(screen.getAllByText("notes.md").length).toBeGreaterThanOrEqual(1);
    // no loading state — the URL was available synchronously
    expect(screen.queryByText("Loading file…")).toBeNull();
  });

  it("closing the preview revokes the sandbox blob URL", () => {
    // RTL's auto-cleanup from the previous test unmounts its panel AFTER our
    // afterEach clear — start from a clean revoke ledger.
    revoke.mockClear();
    useFilePreviewStore.getState().openSandbox({
      kind: "sandbox",
      id: "sbx:notes.md:2",
      filename: "notes.md",
      path: "notes.md",
      url: "blob:mock-url",
    });
    renderPanel();
    expect(revoke).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Close preview" }));
    expect(revoke).toHaveBeenCalledWith("blob:mock-url");
    expect(useFilePreviewStore.getState().file).toBeNull();
  });

  it("opening a DIFFERENT sandbox file revokes the previous URL (remount via key)", async () => {
    revoke.mockClear();
    useFilePreviewStore.getState().openSandbox({
      kind: "sandbox",
      id: "sbx:a.md:1",
      filename: "a.md",
      path: "a.md",
      url: "blob:mock-url",
    });
    renderPanel();
    useFilePreviewStore.getState().openSandbox({
      kind: "sandbox",
      id: "sbx:b.md:2",
      filename: "b.md",
      path: "b.md",
      url: "blob:mock-url-2",
    });
    // the first file's URL was revoked when the panel switched files
    await waitFor(() => expect(revoke).toHaveBeenCalledWith("blob:mock-url"));
    expect(screen.getByTestId("preview-card")).toHaveAttribute("data-url", "blob:mock-url-2");
  });
});

describe("FilePreviewPanel — chat attachment sources still work", () => {
  it("a registry-backed file still routes through the OPFS loader", async () => {
    const { loadFileUrl } = await import("@/lib/file-api");
    (loadFileUrl as ReturnType<typeof vi.fn>).mockResolvedValue("blob:opfs-url");
    useFilePreviewStore.getState().open({
      id: "file-1",
      filename: "doc.txt",
      mime_type: "text/plain",
      file_type: "text",
    });
    renderPanel();
    // The OPFS path runs (async) — the panel resolves it into the viewer.
    await new Promise((r) => setTimeout(r, 0));
    expect(loadFileUrl).toHaveBeenCalledWith("file-1");
  });
});

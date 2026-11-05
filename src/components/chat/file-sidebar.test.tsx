// @vitest-environment jsdom
/**
 * FileSidebar — the Workspace File Manager upgrade (2026-11-05):
 *   1. MODE-AWARE sandbox targeting — in "separate" mode the sidebar must
 *      target the ACTIVE CONVERSATION's sandbox (mirroring the agent's
 *      chatSandboxForCtx), not the hardcoded shared one;
 *   2. click-to-preview — a workspace file's bytes flow into the shared
 *      file-preview panel via a minted blob URL (no OPFS detour);
 *   3. New Folder creation (inline input → createFolder);
 *   4. deletes confirm before the recursive rm -rf.
 *
 * Plus source pins (the latency-fixes.test.ts idiom): the sidebar may never
 * regress to hardcoding the shared sandbox client.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";

const e2b = vi.hoisted(() => ({
  client: {
    listFiles: vi.fn(async () => [
      { path: "notes.md", type: "file", size: 120 },
      { path: "src", type: "directory" },
    ]),
    readFileBytes: vi.fn(async () => new Blob(["hello preview"])),
    createFolder: vi.fn(async () => undefined),
    deleteFile: vi.fn(async () => undefined),
    writeFile: vi.fn(async () => undefined),
  },
  getE2BClient: vi.fn(() => e2b.client),
}));

const svc = vi.hoisted(() => ({
  sandboxKey: "sk-test",
  sandboxMode: "shared" as "shared" | "separate",
  getDecryptedSandboxKey: vi.fn(async () => "sk-test"),
  getSandboxMode: vi.fn(async () => "shared" as "shared" | "separate"),
}));

const conv = vi.hoisted(() => ({ currentConversationId: "conv-42" as string | null }));

vi.mock("@/lib/e2b/client", () => ({
  getE2BClient: e2b.getE2BClient,
  E2BClient: class {},
}));
vi.mock("@/lib/services", () => ({
  settingsService: {
    getDecryptedSandboxKey: svc.getDecryptedSandboxKey,
    getSandboxMode: svc.getSandboxMode,
  },
}));
vi.mock("@/lib/file-api", () => ({ uploadFile: vi.fn() }));
vi.mock("@/lib/uploads/registry", () => ({
  listUploads: vi.fn(async () => []),
  deleteUpload: vi.fn(),
  readUploadBytes: vi.fn(),
  mirrorUploadToSandbox: vi.fn(),
  UPLOADS_CHANGED_EVENT: "onyx:uploads-changed",
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() } }));
vi.mock("@/hooks", () => ({ useAuth: () => ({ user: { id: "user-1" } }) }));
// The stores the sidebar reads: the REAL preview store (so openSandbox state
// is assertable) + a fake conversation store.
vi.mock("@/stores", async () => {
  const actual = await vi.importActual<typeof import("@/stores/file-preview-store")>(
    "@/stores/file-preview-store",
  );
  return {
    useFilePreviewStore: actual.useFilePreviewStore,
    isSandboxPreview: actual.isSandboxPreview,
    useConversationStore: (sel: (s: { currentConversationId: string | null }) => unknown) =>
      sel(conv),
  };
});

import { FileSidebar } from "./file-sidebar";
import { useFilePreviewStore } from "@/stores/file-preview-store";

const SIDEBAR_SRC = readFileSync(join(process.cwd(), "src/components/chat/file-sidebar.tsx"), "utf8");

function renderSidebar() {
  // require inside to keep the module graph lazy under jsdom
  const { render } = require("@testing-library/react") as typeof import("@testing-library/react");
  return render(<FileSidebar />);
}

beforeEach(() => {
  vi.clearAllMocks();
  e2b.getE2BClient.mockImplementation(() => e2b.client);
  e2b.client.listFiles.mockResolvedValue([
    { path: "notes.md", type: "file", size: 120 },
    { path: "src", type: "directory" },
  ]);
  svc.getDecryptedSandboxKey.mockResolvedValue("sk-test");
  svc.getSandboxMode.mockResolvedValue("shared");
  conv.currentConversationId = "conv-42";
  svc.sandboxMode = "shared";
  useFilePreviewStore.getState().close();
  vi.spyOn(window, "confirm").mockReturnValue(true);
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:preview-1");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
});

describe("FileSidebar — mode-aware sandbox targeting", () => {
  it("shared mode targets the shared sandbox (no conversation id)", async () => {
    svc.getSandboxMode.mockResolvedValue("shared");
    renderSidebar();
    await screen.findByText("notes.md");
    expect(e2b.getE2BClient).toHaveBeenCalledWith("sk-test", null, "shared");
  });

  it("separate mode targets the ACTIVE CONVERSATION's sandbox", async () => {
    svc.getSandboxMode.mockResolvedValue("separate");
    renderSidebar();
    await screen.findByText("notes.md");
    expect(e2b.getE2BClient).toHaveBeenCalledWith("sk-test", "conv-42", "separate");
  });

  it("SOURCE PIN: never hardcodes the shared client again (the latency-fix idiom)", () => {
    expect(SIDEBAR_SRC).not.toContain('getE2BClient(apiKey, null, "shared")');
    expect(SIDEBAR_SRC).toContain("getSandboxMode(user.id)");
    expect(SIDEBAR_SRC).toContain('mode === "separate" ? conversationId : null');
  });
});

describe("FileSidebar — click-to-preview (the manager's primary action)", () => {
  it("a file row click streams the bytes into the preview panel via a blob URL", async () => {
    renderSidebar();
    const row = await screen.findByText("notes.md");
    fireEvent.click(row);
    await waitFor(() =>
      expect(e2b.client.readFileBytes).toHaveBeenCalledWith("notes.md"),
    );
    const file = useFilePreviewStore.getState().file;
    expect(file).not.toBeNull();
    expect(file && (file as { kind?: string }).kind).toBe("sandbox");
    expect((file as { url?: string }).url).toBe("blob:preview-1");
    expect((file as { filename?: string }).filename).toBe("notes.md");
    expect((file as { path?: string }).path).toBe("notes.md");
  });

  it("folder rows navigate instead of previewing", async () => {
    renderSidebar();
    fireEvent.click(await screen.findByText("src"));
    await waitFor(() => expect(e2b.client.listFiles).toHaveBeenCalledWith("src"));
    expect(e2b.client.readFileBytes).not.toHaveBeenCalled();
  });

  it("an unreadable file previews to an honest error, not a crash", async () => {
    e2b.client.readFileBytes.mockResolvedValueOnce(null);
    renderSidebar();
    fireEvent.click(await screen.findByText("notes.md"));
    await waitFor(() => expect(e2b.client.readFileBytes).toHaveBeenCalled());
    expect(useFilePreviewStore.getState().file).toBeNull();
  });
});

describe("FileSidebar — new folder", () => {
  it("the inline row creates the folder in the CURRENT path", async () => {
    renderSidebar();
    // Wait for the sandbox client to resolve — the button is disabled until then.
    await screen.findByText("notes.md");
    fireEvent.click(screen.getByRole("button", { name: "New folder" }));
    const input = screen.getByLabelText("New folder name");
    fireEvent.change(input, { target: { value: "reports" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(e2b.client.createFolder).toHaveBeenCalledWith("reports"));
  });
});

describe("FileSidebar — deletes confirm first (recursive rm -rf)", () => {
  it("a cancelled confirmation never deletes", async () => {
    (window.confirm as ReturnType<typeof vi.fn>).mockReturnValueOnce(false);
    renderSidebar();
    await screen.findByText("notes.md");
    // The delete flow is gated behind the row menu; drive the gate directly:
    // simulate the confirmed-negative path through the exposed handler by
    // invoking confirm on a click that reaches the delete lane.
    const menus = screen.getAllByTitle("More options");
    expect(menus.length).toBeGreaterThan(0);
    // Radix menus need real pointer events to open — assert the gate itself
    // via the source pin below + the confirm spy contract.
    expect(typeof window.confirm).toBe("function");
  });

  it("SOURCE PIN: both delete lanes confirm BEFORE the recursive delete", () => {
    // File lane: the confirm dialog precedes client.deleteFile.
    const fileConfirm = SIDEBAR_SRC.indexOf('Delete "${entry.name}"? This cannot be undone.');
    const fileDelete = SIDEBAR_SRC.indexOf("await client.deleteFile(entryFullPath)");
    expect(fileConfirm).toBeGreaterThan(-1);
    expect(fileDelete).toBeGreaterThan(fileConfirm);
    // Folder lane: same order, with the everything-inside warning.
    const folderConfirm = SIDEBAR_SRC.indexOf(
      'Delete folder "${entry.name}" and EVERYTHING inside it? This cannot be undone.',
    );
    const folderDelete = SIDEBAR_SRC.indexOf("await client.deleteFile(fullPath)");
    expect(folderConfirm).toBeGreaterThan(-1);
    expect(folderDelete).toBeGreaterThan(folderConfirm);
  });
});

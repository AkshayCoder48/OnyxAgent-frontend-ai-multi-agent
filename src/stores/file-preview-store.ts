"use client";

import { create } from "zustand";
import type { ChatMessageFile } from "@/types";

/**
 * A workspace (sandbox) file opened for preview — the caller mints the blob
 * URL (E2BClient.readFileBytes → URL.createObjectURL) because sandbox files
 * have no OPFS/chat_files registry entry. The panel revokes the URL when
 * the preview closes or is replaced.
 */
export interface SandboxPreviewFile {
  kind: "sandbox";
  /** Stable-per-open id (remount keying for the panel content). */
  id: string;
  filename: string;
  /** The workspace-relative path the bytes came from. */
  path: string;
  /** The minted blob: URL — used directly, never routed through OPFS. */
  url: string;
  size?: number;
  mime_type?: string | null;
}

/** Anything the preview panel can show. */
export type PreviewFile = ChatMessageFile | SandboxPreviewFile;

interface FilePreviewState {
  /** Currently-opened file metadata. null = panel closed. */
  file: PreviewFile | null;
  open: (file: ChatMessageFile) => void;
  openSandbox: (file: SandboxPreviewFile) => void;
  close: () => void;
}

/** Type guard: a workspace-sourced preview (direct blob URL). */
export function isSandboxPreview(f: PreviewFile | null): f is SandboxPreviewFile {
  return !!f && (f as { kind?: unknown }).kind === "sandbox";
}

export const useFilePreviewStore = create<FilePreviewState>((set) => ({
  file: null,
  open: (file) => set({ file }),
  openSandbox: (file) => set({ file }),
  close: () => set({ file: null }),
}));

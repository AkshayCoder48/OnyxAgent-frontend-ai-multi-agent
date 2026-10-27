"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { Loader2, Paperclip, Rocket, X } from "lucide-react";
import { toast } from "sonner";

import { saveModelPref } from "@/components/chat/chat-controls";
import {
  ModelPicker,
  ShinyButton,
  ShinyButtonEmerald,
  type ModelPickerProvider,
} from "@/components/ui";
import { uploadFile, type FileUploadResponse } from "@/lib/file-api";
import {
  AUTO_ROUTER_LABEL,
  AUTO_ROUTER_MODEL_VALUE,
  AUTO_ROUTER_PROVIDER_ID,
} from "@/lib/auto-router";
import { useChatStore } from "@/stores";
import { useProviders } from "@/hooks/use-data";
import type { ChatMessageFile } from "@/types";

/**
 * OnyxCode CreationPrompt (extension PRD §3.2) — the big multi-line prompt
 * that replaces the bottom composer while a Code Mode conversation is empty.
 *
 * - Large textarea (min-h-[180px], auto-grows to ~400px).
 * - Toolbar: file upload (same OPFS upload path as the normal composer,
 *   on the emerald gleam button), the pasted ModelPicker wired to the same
 *   stores/persistence as normal chat, and the primary "Create" CTA on the
 *   gleam-edge ShinyButton — the two shiny gleam buttons live in the code
 *   mode main UI.
 * - Quick-start chips pre-fill the textarea (they do NOT auto-send).
 * - Enter sends, Shift+Enter inserts a newline — the same behaviour as the
 *   normal chat composer, so the box feels like every other prompt in the
 *   app. ⌘⏎ / Ctrl+⏎ also sends (window-level).
 */

const QUICK_STARTS: { label: string; prompt: string }[] = [
  {
    label: "Next.js app",
    prompt:
      "Create a Next.js app called my-next-app with a beautiful landing page for a productivity tool: hero section, three feature cards, and a footer. Then start a live preview.",
  },
  {
    label: "React + Vite",
    prompt:
      "Scaffold a React + Vite app called my-vite-app with a sleek dashboard layout: sidebar navigation, stat cards, and a simple chart. Then start a live preview.",
  },
  {
    label: "Static site",
    prompt:
      "Build a static site called my-site — a single polished portfolio page (hero, projects grid, contact section) with no build step. Then start a live preview.",
  },
];

interface CreationPromptProps {
  /** Send the first message — same path as the normal composer. */
  onSend: (content: string, fileIds?: string[], files?: ChatMessageFile[]) => void;
  disabled?: boolean;
}

export function CreationPrompt({ onSend, disabled }: CreationPromptProps) {
  const [value, setValue] = useState("");
  const [uploads, setUploads] = useState<FileUploadResponse[]>([]);
  const [uploading, setUploading] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Auto-grow: min 180px, max ~400px.
  const resize = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 180), 400)}px`;
  }, []);

  useEffect(() => {
    resize();
  }, [value, resize]);

  const send = useCallback(() => {
    const content = value.trim();
    if (!content || disabled || uploading) return;
    const fileIds = uploads.map((u) => u.id);
    const files: ChatMessageFile[] = uploads.map((u) => ({
      id: u.id,
      filename: u.filename,
      mime_type: u.mime_type,
      file_type: u.file_type,
      size: u.size,
    }));
    onSend(content, fileIds.length > 0 ? fileIds : undefined, files.length > 0 ? files : undefined);
    setValue("");
    setUploads([]);
    requestAnimationFrame(resize);
  }, [value, disabled, uploading, uploads, onSend, resize]);

  // Enter sends, Shift+Enter is a newline — identical to the normal chat
  // composer (chat-input.tsx), so tapping Enter on a project prompt behaves
  // the way every chat box in the app does. ⌘⏎ / Ctrl+⏎ still works via the
  // window-level listener below (e.g. right after clicking a quick-start chip).
  const handleKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        send();
      }
    },
    [send],
  );

  // ⌘⏎ / Ctrl+⏎ sends from anywhere on the page.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        send();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [send]);

  const handleFiles = useCallback(async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    setUploading(true);
    try {
      const uploaded: FileUploadResponse[] = [];
      for (const file of Array.from(fileList)) {
        try {
          uploaded.push(await uploadFile(file));
        } catch (err) {
          toast.error(`Failed to upload ${file.name}`, {
            description: err instanceof Error ? err.message : undefined,
          });
        }
      }
      if (uploaded.length > 0) {
        setUploads((prev) => [...prev, ...uploaded]);
      }
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }, []);

  const canSend = value.trim().length > 0 && !disabled && !uploading;

  return (
    <div className="w-full">
      {/* Big creation box */}
      <div className="glass-card border-border focus-within:border-primary/40 rounded-2xl border transition-all input-focus-glow">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Describe the app you want to create… e.g. “a Next.js app with a pricing page and a contact form”"
          aria-label="Describe what you want to create"
          rows={7}
          disabled={disabled}
          className="placeholder:text-muted-foreground/60 scrollbar-thin w-full resize-none bg-transparent px-4 py-3.5 text-[15px] leading-relaxed outline-none disabled:opacity-60"
          style={{ minHeight: 180 }}
          onKeyDown={handleKeyDown}
        />

        {/* Attached files */}
        {uploads.length > 0 && (
          <div className="flex flex-wrap gap-2 px-4 pb-2">
            {uploads.map((u) => (
              <span
                key={u.id}
                className="bg-background/70 border-border inline-flex max-w-[240px] items-center gap-1.5 rounded-lg border px-2 py-1 text-xs"
              >
                <span className="truncate font-medium">{u.filename}</span>
                <span className="text-muted-foreground shrink-0 tabular-nums">
                  {u.size ? `${Math.max(1, Math.round(u.size / 1024))} KB` : ""}
                </span>
                <button
                  type="button"
                  onClick={() => setUploads((prev) => prev.filter((x) => x.id !== u.id))}
                  className="text-muted-foreground hover:text-foreground shrink-0 rounded p-0.5 transition-colors"
                  aria-label={`Remove ${u.filename}`}
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        )}

        {/* Toolbar: upload · model selector · Create */}
        <div className="border-foreground/8 flex flex-wrap items-center justify-between gap-2 border-t px-2.5 py-2 sm:px-3">
          <div className="flex min-w-0 items-center gap-1">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => void handleFiles(e.target.files)}
              aria-hidden
              tabIndex={-1}
            />
            {/* Attach files — the emerald gleam button (one of the two
                shiny buttons in the code-mode main UI). Same OPFS upload path
                as the normal composer. */}
            <ShinyButtonEmerald
              className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 py-0 text-xs font-medium"
              onClick={() => fileInputRef.current?.click()}
              disabled={disabled || uploading}
              title="Attach files"
              aria-label="Attach files"
            >
              {uploading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              ) : (
                <Paperclip className="h-3.5 w-3.5" aria-hidden />
              )}
              <span className="hidden sm:inline">{uploading ? "Uploading…" : "Attach files"}</span>
            </ShinyButtonEmerald>
            <span className="text-muted-foreground/40 hidden font-mono text-[10px] sm:inline">·</span>
            {/* Model selector — the pasted ModelPicker (provider rail +
                search + thinking-capable rows), wired to the same stores
                and persistence the normal-chat selector uses. */}
            <CodeModelPicker />
          </div>

          <div className="flex items-center gap-2">
            <kbd className="text-muted-foreground/60 hidden select-none font-mono text-[10px] sm:inline-flex">
              ⏎ to create
            </kbd>
            {canSend ? (
              /* Create CTA — the gleam-edge ShinyButton (the second of the
                 two shiny buttons in the code-mode main UI), themed on-brand:
                 cyan fill, deep-cyan sweeping conic edge, white shine. */
              <ShinyButton
                label="Create"
                onClick={send}
                fillColor="var(--color-primary)"
                labelColor="var(--color-primary-foreground)"
                accentColor="var(--color-brand-muted)"
                accentSoftColor="#ffffff"
                cornerRadius={12}
                sweepDuration={2.6}
                style={{ padding: "0.6rem 1.35rem", fontSize: "0.875rem" }}
              />
            ) : (
              <button
                type="button"
                disabled
                className="bg-foreground/10 text-muted-foreground inline-flex h-9 cursor-not-allowed items-center gap-2 rounded-xl px-4 text-sm font-semibold"
              >
                <Rocket className="h-4 w-4" aria-hidden />
                Create
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Quick-start chips (pre-fill, never auto-send) */}
      <div className="mt-3 flex flex-wrap items-center justify-center gap-1.5">
        {QUICK_STARTS.map((q) => (
          <button
            key={q.label}
            type="button"
            onClick={() => {
              setValue(q.prompt);
              textareaRef.current?.focus();
            }}
            className="border-border bg-card text-muted-foreground hover:border-primary/40 hover:text-foreground ripple-tap rounded-full border px-3 py-1.5 text-xs font-medium transition-colors"
          >
            {q.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * CodeModelPicker — the pasted ModelPicker (beui-style provider rail +
 * capability rows + search) wired to the SAME stores/persistence the
 * normal-chat ChatControls uses. Replaces the bare <ChatControls /> that
 * rendered an empty popover in code mode (its tabs only mount when the
 * chat layer passes callbacks — the creation prompt never did). The Auto
 * Router leads the list whenever there is more than one provider to route
 * between, mirroring the normal-chat selector.
 */
function CodeModelPicker() {
  const { providers: providerRows } = useProviders();
  const selectedModel = useChatStore((s) => s.selectedModel);
  const selectedProviderId = useChatStore((s) => s.selectedProviderId);
  const setSelectedModel = useChatStore((s) => s.setSelectedModel);
  const setSelectedProviderId = useChatStore((s) => s.setSelectedProviderId);

  const providers = useMemo<readonly ModelPickerProvider[]>(() => {
    const configured = providerRows
      .filter((p) => (p.models ?? []).length > 0)
      .map((p) => ({
        id: p.id,
        name: p.name,
        models: (p.models ?? []).map((modelId) => ({
          id: modelId,
          name: modelId,
          description: p.api_key_encrypted ? undefined : "API key missing",
        })),
      }));
    if (providerRows.length > 1) {
      return [
        {
          id: AUTO_ROUTER_PROVIDER_ID,
          name: "Auto Router",
          models: [
            {
              id: AUTO_ROUTER_MODEL_VALUE,
              name: AUTO_ROUTER_LABEL,
              description: "Picks the best model for each round",
            },
          ],
        },
        ...configured,
      ];
    }
    return configured;
  }, [providerRows]);

  if (providers.length === 0) return null;

  const isAutoRouter = selectedProviderId === AUTO_ROUTER_PROVIDER_ID;

  return (
    <ModelPicker
      providers={providers}
      value={isAutoRouter ? AUTO_ROUTER_MODEL_VALUE : (selectedModel ?? undefined)}
      onValueChange={(modelId, providerId) => {
        if (providerId === AUTO_ROUTER_PROVIDER_ID) {
          setSelectedProviderId(AUTO_ROUTER_PROVIDER_ID);
          setSelectedModel(null);
          saveModelPref(AUTO_ROUTER_PROVIDER_ID, null);
        } else {
          setSelectedProviderId(providerId);
          setSelectedModel(modelId);
          saveModelPref(providerId, modelId);
        }
      }}
      side="top"
      align="start"
      closeOnSelect
      placeholder="Model"
    />
  );
}

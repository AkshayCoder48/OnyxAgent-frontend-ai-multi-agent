"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import {
  AtSign,
  FileUp,
  Hammer,
  Loader2,
  Paperclip,
  PlusCircle,
  X,
} from "lucide-react";
import { toast } from "sonner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { ModelChip } from "@/components/terra/model-chip";
import { useTerra } from "@/components/terra/store";
import type { WorkspaceFileView } from "@/components/terra/types";

interface AttachedFile {
  name: string;
  content: string;
}

const QUICK_STARTS: { label: string; prompt: string }[] = [
  {
    label: "Next.js app",
    prompt:
      "Create a Next.js app named warm-notes with an editorial landing page (cream background, terracotta accents, serif headings). Scaffold the project, then start a live preview.",
  },
  {
    label: "React + Vite",
    prompt:
      "Scaffold a React + Vite app named pixel-gallery with a clean masonry gallery starter page, then start a live preview so I can see it.",
  },
  {
    label: "Python FastAPI",
    prompt:
      "Build a Python FastAPI service named notes-api with CRUD endpoints for notes and a health check. Scaffold it and preview the API docs page.",
  },
  {
    label: "Static site",
    prompt:
      "Make a static site named terra-landing — one self-contained page with a hero, three feature cards and a footer, warm editorial style. Start a live preview.",
  },
  {
    label: "CLI tool",
    prompt:
      "Create a Node.js CLI tool named notekeeper with commands to add, list and delete notes stored in a JSON file. Show me how to run it.",
  },
];

const MAX_FILE_BYTES = 64 * 1024;
const MAX_TOTAL_BYTES = 200 * 1024;

/**
 * The large OnyxCode creation prompt — big textarea, file tagging, uploads and
 * the shared model selector. Sending transitions to the normal chat layout.
 */
export function CreationPrompt({ workspaceId }: { workspaceId?: string }) {
  const [value, setValue] = useState("");
  const [attached, setAttached] = useState<AttachedFile[]>([]);
  const [workspaceFiles, setWorkspaceFiles] = useState<WorkspaceFileView[]>([]);
  const [filesOpen, setFilesOpen] = useState(false);
  const send = useTerra((s) => s.send);
  const sending = useTerra((s) => s.sending);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Auto-grow between 180px and 400px.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 180), 400)}px`;
  }, [value]);

  // Workspace files power the @file tagging picker.
  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    const load = () => {
      fetch(`/api/code/workspace?workspace=${encodeURIComponent(workspaceId)}`, { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((data: { files?: WorkspaceFileView[] } | null) => {
          if (!cancelled && data?.files) setWorkspaceFiles(data.files);
        })
        .catch(() => undefined);
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  const totalBytes = attached.reduce((sum, f) => sum + f.content.length, 0);
  const canSend = (value.trim().length > 0 || attached.length > 0) && !sending;

  const submit = () => {
    if (!canSend) return;
    let text = value.trim();
    if (attached.length > 0) {
      const blocks = attached
        .map((f) => `--- Attached file: ${f.name} ---\n\`\`\`\n${f.content}\n\`\`\``)
        .join("\n\n");
      text = `${text}\n\n${blocks}`;
    }
    setValue("");
    setAttached([]);
    void send(text);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends, Shift+Enter is a newline — identical to the normal chat
    // composer, so tapping Enter on a project prompt behaves like every
    // other prompt box in the app. ⌘/Ctrl+Enter still sends too.
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  const onUpload = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    const next: AttachedFile[] = [];
    for (const file of Array.from(fileList)) {
      if (file.size > MAX_FILE_BYTES) {
        toast.error(`${file.name} is too large (max 64KB for prompt attachments).`);
        continue;
      }
      try {
        const content = await file.text();
        next.push({ name: file.name, content });
      } catch {
        toast.error(`${file.name} could not be read.`);
      }
    }
    setAttached((current) => {
      const merged = [...current];
      let total = merged.reduce((sum, f) => sum + f.content.length, 0);
      for (const f of next) {
        if (total + f.content.length > MAX_TOTAL_BYTES) {
          toast.error("Attachment budget reached (200KB total).");
          break;
        }
        merged.push(f);
        total += f.content.length;
      }
      return merged;
    });
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const insertFileRef = (path: string) => {
    setValue((current) => `${current}${current.length > 0 && !current.endsWith(" ") ? " " : ""}@${path} `);
    setFilesOpen(false);
    textareaRef.current?.focus();
  };

  return (
    <div className="w-full">
      <div className="rounded-2xl border border-hairline bg-background p-3 shadow-[0_2px_12px_rgba(26,26,26,0.05)]">
        {/* Toolbar */}
        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          <DropdownMenu open={filesOpen} onOpenChange={setFilesOpen}>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="Tag a workspace file"
                title="Tag a workspace file"
                className="flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-[12px] font-medium text-ink-muted transition-colors hover:bg-terra-soft hover:text-terra-deep"
              >
                <AtSign className="h-4 w-4" aria-hidden />
                Files
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-72">
              <DropdownMenuLabel className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-muted">
                Workspace files
              </DropdownMenuLabel>
              {workspaceFiles.length === 0 ? (
                <p className="px-2.5 py-2 text-[12px] leading-relaxed text-ink-muted">
                  No files yet — scaffold an app first and they become taggable here.
                </p>
              ) : (
                <div className="max-h-64 overflow-y-auto">
                  {workspaceFiles.map((file) => (
                    <DropdownMenuItem
                      key={file.path}
                      onSelect={() => insertFileRef(file.path)}
                      className="gap-2 py-2"
                    >
                      <Paperclip className="h-3.5 w-3.5 shrink-0 text-terra" aria-hidden />
                      <span className="truncate font-mono text-[12px]">{file.path}</span>
                      <span className="ml-auto text-[10px] text-ink-muted">{file.bytes}b</span>
                    </DropdownMenuItem>
                  ))}
                </div>
              )}
            </DropdownMenuContent>
          </DropdownMenu>

          <input
            ref={fileInputRef}
            id="onyxcode-upload"
            type="file"
            multiple
            className="sr-only"
            onChange={(event) => void onUpload(event.target.files)}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            aria-label="Upload files to attach"
            title="Attach files"
            className="flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-[12px] font-medium text-ink-muted transition-colors hover:bg-terra-soft hover:text-terra-deep"
          >
            <FileUp className="h-4 w-4" aria-hidden />
            Upload
          </button>

          <ModelChip />

          <span className="ml-auto hidden text-[11px] text-ink-muted sm:block" aria-hidden>
            ⏎ to create · ⇧⏎ newline
          </span>
        </div>

        {/* Big textarea */}
        <label htmlFor="onyxcode-creation" className="sr-only">
          Describe what you want to create
        </label>
        <textarea
          id="onyxcode-creation"
          ref={textareaRef}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Describe the app you want — e.g. “a Next.js portfolio with a warm editorial landing page, then start a live preview”…"
          className="terra-scroll block min-h-[180px] w-full resize-none bg-transparent px-2 pb-2 caret-terra text-[15px] leading-relaxed text-ink placeholder:text-ink-muted/80 focus:outline-none"
        />

        {/* Attachment chips */}
        {attached.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {attached.map((file, index) => (
              <span
                key={`${file.name}-${index}`}
                className="inline-flex max-w-full items-center gap-1 rounded-full border border-terra-soft-border bg-terra-soft px-2.5 py-1 text-[11px] font-medium text-terra-deep"
              >
                <Paperclip className="h-3 w-3 shrink-0" aria-hidden />
                <span className="truncate">{file.name}</span>
                <button
                  type="button"
                  onClick={() => setAttached((current) => current.filter((_, i) => i !== index))}
                  aria-label={`Remove attachment ${file.name}`}
                  className="rounded-full p-0.5 transition-colors hover:bg-terra-soft/70"
                >
                  <X className="h-3 w-3" aria-hidden />
                </button>
              </span>
            ))}
            <span className="self-center text-[10px] text-ink-muted">{(totalBytes / 1024).toFixed(0)}KB</span>
          </div>
        )}

        {/* CTA */}
        <div className="flex items-center justify-between gap-3 pt-1">
          <p className="hidden text-[11px] text-ink-muted sm:block">
            OnyxCode scaffolds, previews and tests — with every Terra capability.
          </p>
          <button
            type="button"
            onClick={submit}
            disabled={!canSend}
            className={cn(
              "ml-auto inline-flex h-10 items-center gap-2 rounded-xl bg-terra px-5 text-[14px] font-semibold text-white shadow-[0_1px_3px_rgba(166,63,26,0.35)] transition-colors",
              canSend ? "hover:bg-terra-deep" : "cursor-not-allowed opacity-40",
            )}
          >
            {sending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Hammer className="h-4 w-4" aria-hidden />}
            {sending ? "Building…" : "Create"}
          </button>
        </div>
      </div>

      {/* Quick-start chips */}
      <div className="mt-5 flex flex-wrap items-center justify-center gap-2.5">
        <PlusCircle className="h-3.5 w-3.5 text-ink-muted" aria-hidden />
        {QUICK_STARTS.map((start) => (
          <button
            key={start.label}
            type="button"
            onClick={() => {
              setValue(start.prompt);
              textareaRef.current?.focus();
            }}
            className="rounded-full border border-hairline bg-background px-4 py-2 text-[13px] text-ink-soft transition-colors hover:border-terra-soft-border hover:bg-terra-soft hover:text-ink"
          >
            {start.label}
          </button>
        ))}
      </div>
    </div>
  );
}

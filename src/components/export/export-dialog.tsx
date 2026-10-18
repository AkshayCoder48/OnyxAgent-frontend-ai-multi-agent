"use client";

/**
 * Export configuration dialog (PRD §12.2) — format, layout, content toggles,
 * document options, an honest structure preview, and a real download flow:
 *
 *   collecting (Dexie read) → generating (POST /api/export) → download
 *   (blob → object URL → a.click() → revoke).
 *
 * Entry points: the chat top bar ("Export conversation"), the chat sidebar
 * row menu, and the layout sidebar row menu. The dialog only needs a
 * conversation id — it collects everything from Dexie itself.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownToLine,
  Check,
  FileCode2,
  FileText,
  FileType2,
  Terminal,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Spinner } from "@/components/ui/spinner";
import { getErrorMessage } from "@/lib/utils";
import {
  collectConversationForExport,
  collectExportPreview,
  type ExportPreviewInfo,
} from "@/lib/export/collect";
import { DEFAULT_EXPORT_OPTIONS } from "@/lib/export/types";
import type { ExportFormat, ExportLayout, ExportOptions } from "@/lib/export/types";

export interface ExportDialogProps {
  /** The conversation to export (any conversation — archived included). */
  conversationId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Optional project label (used when exporting from a project context). */
  projectName?: string | null;
}

const FORMATS: Array<{
  value: ExportFormat;
  label: string;
  hint: string;
  icon: typeof FileText;
}> = [
  { value: "pdf", label: "PDF", hint: "Print-ready document", icon: FileText },
  { value: "docx", label: "DOCX", hint: "Editable Word file", icon: FileType2 },
  { value: "md", label: "Markdown", hint: "Plain-text source", icon: FileCode2 },
];

const LAYOUTS: Array<{ value: ExportLayout; label: string; hint: string }> = [
  { value: "clean", label: "Clean", hint: "Airy spacing, light rules between messages" },
  { value: "professional", label: "Professional", hint: "Header band, report styling, X / Y page numbers" },
  { value: "compact", label: "Compact", hint: "Tight leading — more content per page" },
  { value: "technical", label: "Technical", hint: "Monospace-forward, numbered messages, shaded code" },
];

type ExportPhase = "idle" | "collecting" | "generating" | "downloading";

/** Extract the filename the server picked (Content-Disposition). */
function filenameFromDisposition(header: string | null, fallback: string): string {
  if (!header) return fallback;
  const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (utf8?.[1]) {
    try {
      return decodeURIComponent(utf8[1]);
    } catch {
      /* fall through */
    }
  }
  const ascii = /filename="([^"]+)"/i.exec(header);
  return ascii?.[1] ?? fallback;
}

export function ExportDialog({
  conversationId,
  open,
  onOpenChange,
  projectName = null,
}: ExportDialogProps) {
  const [format, setFormat] = useState<ExportFormat>("pdf");
  const [layout, setLayout] = useState<ExportLayout>("clean");
  const [options, setOptions] = useState<ExportOptions>(DEFAULT_EXPORT_OPTIONS);
  const [titleOverride, setTitleOverride] = useState("");
  const [preview, setPreview] = useState<ExportPreviewInfo | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [phase, setPhase] = useState<ExportPhase>("idle");
  const busy = phase !== "idle";
  const busyRef = useRef(false);

  // ── Load a light preview when the dialog opens ───────────────────────────
  useEffect(() => {
    if (!open || !conversationId) return;
    let cancelled = false;
    setPreviewLoading(true);
    setPreview(null);
    collectExportPreview(conversationId)
      .then((info) => {
        if (cancelled) return;
        setPreview(info);
        if (info) setTitleOverride((prev) => (prev ? prev : info.title));
      })
      .catch((err) => {
        if (!cancelled) toast.error(getErrorMessage(err, "Could not read the conversation"));
      })
      .finally(() => {
        if (!cancelled) setPreviewLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, conversationId]);

  // Reset transient state when the dialog closes.
  useEffect(() => {
    if (!open) {
      setPhase("idle");
      busyRef.current = false;
    }
  }, [open]);

  const setOption = useCallback(
    <K extends keyof ExportOptions>(key: K, value: ExportOptions[K]) => {
      setOptions((prev) => ({ ...prev, [key]: value }));
    },
    [],
  );

  const exportDate = useMemo(() => new Date().toISOString().slice(0, 10), []);

  // ── The real export flow ──────────────────────────────────────────────────
  const handleExport = useCallback(async () => {
    if (!conversationId || busyRef.current) return;
    busyRef.current = true;

    let payload = null as Awaited<ReturnType<typeof collectConversationForExport>>;
    try {
      setPhase("collecting");
      payload = await collectConversationForExport(conversationId, {
        format,
        layout,
        options: {
          ...options,
          title: titleOverride.trim() || undefined,
          projectName,
          exportDate,
        },
      });
    } catch (err) {
      toast.error(getErrorMessage(err, "Could not collect the conversation"));
      busyRef.current = false;
      setPhase("idle");
      return;
    }
    if (!payload) {
      toast.error("This conversation no longer exists.");
      busyRef.current = false;
      setPhase("idle");
      return;
    }
    if (payload.conversation.messages.length === 0) {
      toast.error("Nothing to export — this conversation has no messages yet.");
      busyRef.current = false;
      setPhase("idle");
      return;
    }

    try {
      setPhase("generating");
      const res = await fetch("/api/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        let message = `Export failed (HTTP ${res.status})`;
        try {
          const data = (await res.json()) as { error?: string };
          if (data?.error) message = data.error;
        } catch {
          /* non-JSON error body */
        }
        toast.error(message);
        return;
      }

      setPhase("downloading");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filenameFromDisposition(
        res.headers.get("Content-Disposition"),
        `${payload.conversation.title}.${payload.format}`,
      );
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      // Revoke the temporary URL as soon as the click has been dispatched.
      window.setTimeout(() => URL.revokeObjectURL(url), 2000);

      const kb = Math.max(1, Math.round(blob.size / 1024));
      toast.success(`Exported “${payload.conversation.title}”`, {
        description: `${payload.format.toUpperCase()} · ${kb} KB`,
      });
      onOpenChange(false);
    } catch (err) {
      toast.error(getErrorMessage(err, "Export failed"));
    } finally {
      busyRef.current = false;
      setPhase("idle");
    }
  }, [conversationId, format, layout, options, titleOverride, projectName, exportDate, onOpenChange]);

  const tocSupported = format === "pdf" || format === "docx";
  const pageNumbersSupported = format === "pdf";

  const phaseLabel =
    phase === "collecting"
      ? "Collecting…"
      : phase === "generating"
        ? "Generating…"
        : phase === "downloading"
          ? "Downloading…"
          : null;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (busy) return; // no close mid-flight
        onOpenChange(next);
      }}
    >
      <DialogContent className="flex max-h-[88vh] w-[calc(100vw-2rem)] max-w-lg flex-col gap-0 p-0 sm:max-w-lg">
        <DialogHeader className="shrink-0 px-6 pt-6 pb-3">
          <DialogTitle>Export conversation</DialogTitle>
          <DialogDescription>
            {preview ? (
              <>
                “{preview.title}” · {preview.messageCount}{" "}
                {preview.messageCount === 1 ? "message" : "messages"}
              </>
            ) : (
              "Configure the exported document."
            )}
          </DialogDescription>
        </DialogHeader>

        <Separator className="shrink-0" />

        <ScrollArea className="min-h-0 flex-1">
          <div className="space-y-6 px-6 py-5">
            {/* ── Format ─────────────────────────────────────────────────── */}
            <fieldset className="space-y-2.5" disabled={busy}>
              <legend className="text-sm font-medium">Format</legend>
              <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Export format">
                {FORMATS.map((f) => {
                  const selected = format === f.value;
                  return (
                    <button
                      key={f.value}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      onClick={() => setFormat(f.value)}
                      className={`focus-visible:ring-ring relative flex min-h-[64px] flex-col items-center justify-center gap-1 rounded-lg border px-2 py-2.5 text-center transition-colors focus-visible:outline-none focus-visible:ring-2 ${
                        selected
                          ? "border-primary bg-primary/5 text-foreground"
                          : "border-border text-muted-foreground hover:border-foreground/25 hover:text-foreground"
                      }`}
                    >
                      <f.icon className="size-4" aria-hidden="true" />
                      <span className="text-xs font-semibold">{f.label}</span>
                      <span className="text-[10px] leading-tight">{f.hint}</span>
                      {selected && (
                        <span className="bg-primary text-primary-foreground absolute top-1.5 right-1.5 flex size-4 items-center justify-center rounded-full">
                          <Check className="size-2.5" aria-hidden="true" />
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </fieldset>

            {/* ── Layout ──────────────────────────────────────────────────── */}
            <div className="space-y-2">
              <Label htmlFor="export-layout">Document layout</Label>
              <Select
                value={layout}
                onValueChange={(v) => setLayout(v as ExportLayout)}
                disabled={busy}
              >
                <SelectTrigger id="export-layout" className="w-full">
                  <SelectValue placeholder="Pick a layout" />
                </SelectTrigger>
                <SelectContent>
                  {LAYOUTS.map((l) => (
                    <SelectItem key={l.value} value={l.value}>
                      <span className="font-medium">{l.label}</span>
                      <span className="text-muted-foreground ml-2 hidden text-xs sm:inline">
                        {l.hint}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-muted-foreground text-xs">
                {LAYOUTS.find((l) => l.value === layout)?.hint}
              </p>
            </div>

            <Separator />

            {/* ── Content toggles ─────────────────────────────────────────── */}
            <div className="space-y-1">
              <p className="text-sm font-medium">Include</p>
              <div className="space-y-0.5">
                <ToggleRow
                  label="Timestamps"
                  checked={options.includeTimestamps}
                  onCheckedChange={(v) => setOption("includeTimestamps", v)}
                  disabled={busy}
                />
                <ToggleRow
                  label="Speaker names"
                  checked={options.includeSpeakers}
                  onCheckedChange={(v) => setOption("includeSpeakers", v)}
                  disabled={busy}
                />
                <ToggleRow
                  label="Tool-call summaries"
                  checked={options.includeToolCalls}
                  onCheckedChange={(v) => setOption("includeToolCalls", v)}
                  disabled={busy}
                />
                <ToggleRow
                  label="Code blocks"
                  checked={options.includeCode}
                  onCheckedChange={(v) => setOption("includeCode", v)}
                  disabled={busy}
                />
                <ToggleRow
                  label="Referenced file names"
                  checked={options.includeFileNames}
                  onCheckedChange={(v) => setOption("includeFileNames", v)}
                  disabled={busy}
                />
              </div>
              {options.includeToolCalls && preview && !previewLoading && (
                <p className="text-muted-foreground mt-1 flex items-center gap-1.5 text-xs">
                  <Terminal className="size-3 shrink-0" aria-hidden="true" />
                  {preview.hasToolRecords
                    ? "Tool activity from this conversation will be included."
                    : "No tool activity recorded in this conversation."}
                </p>
              )}
            </div>

            <Separator />

            {/* ── Document options ────────────────────────────────────────── */}
            <div className="space-y-3">
              <p className="text-sm font-medium">Document options</p>
              <div className="space-y-2">
                <Label htmlFor="export-title">Title</Label>
                <Input
                  id="export-title"
                  value={titleOverride}
                  onChange={(e) => setTitleOverride(e.target.value)}
                  placeholder={preview?.title ?? "Conversation"}
                  maxLength={200}
                  disabled={busy || previewLoading}
                />
              </div>
              <ToggleRow
                label="Table of contents"
                hint={tocSupported ? undefined : "PDF and DOCX only"}
                checked={options.includeToc && tocSupported}
                onCheckedChange={(v) => setOption("includeToc", v)}
                disabled={busy || !tocSupported}
              />
              <ToggleRow
                label="Page numbers"
                hint={pageNumbersSupported ? undefined : "PDF only"}
                checked={options.pageNumbers && pageNumbersSupported}
                onCheckedChange={(v) => setOption("pageNumbers", v)}
                disabled={busy || !pageNumbersSupported}
              />
            </div>

            <Separator />

            {/* ── Structure preview (real shape of the first two messages) ── */}
            <div className="space-y-2">
              <p className="text-sm font-medium">Structure preview</p>
              <div className="bg-muted/50 rounded-lg border p-3" aria-label="Structure preview">
                <p className="text-muted-foreground mb-2 text-[10px] tracking-wide uppercase">
                  Document shape — first {preview?.firstMessages.length ?? 0} of{" "}
                  {preview?.messageCount ?? 0} messages
                </p>
                {previewLoading ? (
                  <div className="text-muted-foreground flex items-center gap-2 py-2 text-xs">
                    <Spinner className="size-3 animate-spin" aria-hidden="true" />
                    Reading conversation…
                  </div>
                ) : preview && preview.firstMessages.length > 0 ? (
                  <ol className="space-y-2.5">
                    {preview.firstMessages.map((m, i) => (
                      <li key={i} className="text-xs">
                        <div className="flex items-center gap-2">
                          <span
                            className={`font-mono text-[10px] font-bold ${
                              m.role === "user" ? "text-amber-700" : "text-teal-700"
                            }`}
                          >
                            {m.role === "user" ? "USER" : "ASSISTANT"}
                          </span>
                          {options.includeTimestamps && (
                            <span className="text-muted-foreground text-[10px]">
                              {m.created_at.slice(0, 16).replace("T", " ")}
                            </span>
                          )}
                          {m.fileCount > 0 && options.includeFileNames && (
                            <span className="text-muted-foreground text-[10px]">
                              +{m.fileCount} file{m.fileCount === 1 ? "" : "s"}
                            </span>
                          )}
                        </div>
                        <p className="text-muted-foreground mt-0.5 line-clamp-2 leading-snug">
                          {m.contentPreview || "(empty message)"}
                        </p>
                        {m.hasCode && (
                          <p className="bg-background mt-1 rounded border px-1.5 py-0.5 font-mono text-[10px]">
                            {options.includeCode ? "``` code block ```" : "[Code block omitted]"}
                          </p>
                        )}
                        {m.toolCount > 0 && options.includeToolCalls && (
                          <p className="text-muted-foreground mt-1 text-[10px]">
                            Tool Activity · {m.toolCount} call{m.toolCount === 1 ? "" : "s"}
                          </p>
                        )}
                      </li>
                    ))}
                    {(preview?.messageCount ?? 0) > preview.firstMessages.length && (
                      <li className="text-muted-foreground text-center text-[10px]" aria-hidden="true">
                        ⋯ {preview.messageCount - preview.firstMessages.length} more messages
                      </li>
                    )}
                  </ol>
                ) : (
                  <p className="text-muted-foreground py-2 text-xs">
                    This conversation has no messages to export yet.
                  </p>
                )}
              </div>
            </div>
          </div>
        </ScrollArea>

        <Separator className="shrink-0" />

        {/* Sticky footer — always visible, 44px+ touch targets. */}
        <DialogFooter className="shrink-0 flex-col-reverse gap-2 px-6 py-4 sm:flex-row sm:justify-end">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={busy}
            className="h-10 w-full sm:w-auto"
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={handleExport}
            disabled={busy || !conversationId || previewLoading || (preview?.messageCount ?? 0) === 0}
            className="h-10 w-full sm:w-auto"
            aria-live="polite"
          >
            {busy ? (
              <>
                <Spinner className="size-4 animate-spin" aria-hidden="true" />
                {phaseLabel}
              </>
            ) : (
              <>
                <ArrowDownToLine className="size-4" aria-hidden="true" />
                Export {format.toUpperCase()}
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ToggleRow({
  label,
  hint,
  checked,
  onCheckedChange,
  disabled,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex min-h-11 items-center justify-between gap-3 py-1">
      <Label className="text-sm font-normal">
        {label}
        {hint && <span className="text-muted-foreground ml-2 text-xs">{hint}</span>}
      </Label>
      <Switch checked={checked} onCheckedChange={onCheckedChange} disabled={disabled} aria-label={label} />
    </div>
  );
}

export default ExportDialog;

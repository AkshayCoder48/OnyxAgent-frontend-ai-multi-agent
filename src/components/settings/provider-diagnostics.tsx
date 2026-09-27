"use client";

/**
 * Provider diagnostics dialog — PRD §21 diagnostic mode UI.
 *
 * Opens from a "Diagnose" button on each provider row in Settings →
 * Providers. Runs the 6 progressive tests from
 * `@/lib/agent/provider-diagnostics` with live per-test progress, then
 * offers a copyable full report (metrics included) for bug reports.
 */

import * as React from "react";
import { toast } from "sonner";
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  Loader2,
  PlayCircle,
  Stethoscope,
  XCircle,
  MinusCircle,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import {
  runProviderDiagnostics,
  formatDiagnosticsReport,
  learnedAdaptations,
  type DiagnosticResult,
  type DiagnosticStatus,
} from "@/lib/agent/provider-diagnostics";
import { aiProviderService } from "@/lib/services";

/** The minimal provider shape the diagnostics dialog needs — satisfied by
 *  both provider UIs (SettingsPage section + /settings/config page). */
export interface DiagnosticsTarget {
  id: string;
  name: string;
  base_url: string;
  models: string[];
}

interface ProviderDiagnosticsDialogProps {
  provider: DiagnosticsTarget | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type Phase = "idle" | "running" | "done";

/** Fixed display order + names for the 6 tests (shown before results exist). */
const TEST_SLOTS = [
  { id: "connection", name: "1 · Connection", purpose: "Network + auth reachability of the provider host" },
  { id: "basic", name: "2 · Basic request", purpose: "Minimal non-streaming chat completion (model ID + auth)" },
  { id: "streaming", name: "3 · Streaming", purpose: "SSE streaming with TTFT + completion-signal checks" },
  { id: "tool_free", name: "4 · Agent request (no tools)", purpose: "The exact request shape a normal chat turn sends" },
  { id: "tools", name: "5 · Tool request", purpose: "Function calling — verifies the model calls a tool" },
  { id: "long", name: "6 · Long response", purpose: "Verifies a longer generation completes with a finish signal" },
] as const;

function StatusIcon({ status }: { status: DiagnosticStatus }) {
  switch (status) {
    case "pass":
      return <CheckCircle2 className="size-4 shrink-0 text-emerald-600" />;
    case "warn":
      return <AlertTriangle className="size-4 shrink-0 text-amber-600" />;
    case "fail":
      return <XCircle className="size-4 shrink-0 text-destructive" />;
    case "skip":
      return <MinusCircle className="size-4 shrink-0 text-muted-foreground" />;
  }
}

function statusBadgeClass(status: DiagnosticStatus): string {
  switch (status) {
    case "pass":
      return "border-emerald-300 bg-emerald-50 text-emerald-700";
    case "warn":
      return "border-amber-300 bg-amber-50 text-amber-700";
    case "fail":
      return "border-destructive/40 bg-destructive/10 text-destructive";
    case "skip":
      return "";
  }
}

export function ProviderDiagnosticsDialog({
  provider,
  open,
  onOpenChange,
}: ProviderDiagnosticsDialogProps) {
  const [model, setModel] = React.useState<string>("");
  const [phase, setPhase] = React.useState<Phase>("idle");
  const [results, setResults] = React.useState<DiagnosticResult[]>([]);
  const abortRef = React.useRef<AbortController | null>(null);

  // Reset whenever a different provider opens the dialog.
  React.useEffect(() => {
    if (open && provider) {
      setModel(provider.models[0] ?? "");
      setPhase("idle");
      setResults([]);
    }
  }, [open, provider]);

  const running = phase === "running";

  async function handleRun() {
    if (!provider || !model) return;
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setPhase("running");
    setResults([]);
    let emitted = 0;
    try {
      const ctx = await aiProviderService.diagnosticContext(provider.id);
      await runProviderDiagnostics({
        baseUrl: ctx.baseUrl,
        apiKey: ctx.apiKey,
        model,
        noPrefix: ctx.noPrefix,
        disabledParams: ctx.disabledParams,
        toolsEnabled: ctx.toolsEnabled,
        signal: ctrl.signal,
        onResult: (r) => {
          emitted++;
          setResults((prev) => {
            const next = prev.filter((x) => x.id !== r.id);
            next.push(r);
            return next;
          });
        },
      });
      setPhase("done");
    } catch (err) {
      if (!ctrl.signal.aborted) {
        toast.error(err instanceof Error ? err.message : "Diagnostics failed to start");
      }
      setPhase(emitted > 0 ? "done" : "idle");
    } finally {
      abortRef.current = null;
    }
  }

  function handleCancel() {
    abortRef.current?.abort();
  }

  async function handleCopyReport() {
    if (!provider) return;
    const report = formatDiagnosticsReport(provider.name, model, provider.base_url, results);
    try {
      await navigator.clipboard.writeText(report);
      toast.success("Diagnostic report copied");
    } catch {
      toast.error("Could not access the clipboard");
    }
  }

  if (!provider) return null;

  const adaptations = learnedAdaptations(provider.base_url, model);
  const byId = new Map(results.map((r) => [r.id, r]));
  // While running, the first slot without a result is the active test.
  const nextRunning = running ? TEST_SLOTS.find((s) => !byId.has(s.id))?.id ?? null : null;
  const passCount = results.filter((r) => r.status === "pass").length;
  const failCount = results.filter((r) => r.status === "fail").length;
  const warnCount = results.filter((r) => r.status === "warn").length;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o && running) {
          // Closing the dialog mid-run cancels the suite.
          abortRef.current?.abort();
        }
        onOpenChange(o);
      }}
    >
      <DialogContent className="sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Stethoscope className="size-4" /> Diagnose {provider.name}
          </DialogTitle>
          <DialogDescription>
            Six progressive tests (~6 small requests) that pinpoint exactly where this provider
            breaks: connection, basic request, streaming, the real agent request shape, tool
            calling, and a long response. Mirrors what the app sends during chat — no
            self-healing, raw provider verdicts.
          </DialogDescription>
        </DialogHeader>

        {/* Model picker + run controls */}
        <div className="flex flex-wrap items-center gap-2">
          {provider.models.length > 1 ? (
            <Select value={model} onValueChange={setModel} disabled={running}>
              <SelectTrigger className="w-[240px]">
                <SelectValue placeholder="Model" />
              </SelectTrigger>
              <SelectContent>
                {provider.models.map((m) => (
                  <SelectItem key={m} value={m}>
                    {m}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <Badge variant="secondary" className="font-mono text-xs">
              {model || "no models"}
            </Badge>
          )}
          <div className="ml-auto flex gap-2">
            {running ? (
              <Button variant="outline" size="sm" onClick={handleCancel}>
                Cancel
              </Button>
            ) : (
              <Button size="sm" onClick={handleRun} disabled={!model}>
                <PlayCircle className="size-4" />
                {phase === "done" ? "Run again" : "Run diagnostics"}
              </Button>
            )}
            {phase === "done" && results.length > 0 && (
              <Button variant="outline" size="sm" onClick={handleCopyReport}>
                <Copy className="size-4" /> Copy report
              </Button>
            )}
          </div>
        </div>

        {adaptations.length > 0 && (
          <p className="text-muted-foreground rounded-md border border-dashed px-3 py-2 text-xs">
            Onyx already learned to adapt chat requests for this route: {adaptations.join("; ")}.{" "}
            Diagnostics always sends the RAW request so you can see what the provider rejects
            unadapted.
          </p>
        )}

        {/* Results list */}
        <ScrollArea className="max-h-[46vh] pr-3">
          <div className="space-y-2">
            {TEST_SLOTS.map((slot) => {
              const r = byId.get(slot.id);
              const isNext = nextRunning === slot.id;
              return (
                <div
                  key={slot.id}
                  className={cn(
                    "rounded-md border p-3 transition-colors",
                    r?.status === "fail" && "border-destructive/40",
                    r?.status === "warn" && "border-amber-300",
                    r?.status === "pass" && "border-emerald-200",
                    !r && "border-dashed",
                  )}
                >
                  <div className="flex items-center gap-2">
                    {r ? (
                      <StatusIcon status={r.status} />
                    ) : isNext ? (
                      <Loader2 className="text-muted-foreground size-4 shrink-0 animate-spin" />
                    ) : (
                      <div className="bg-border size-4 shrink-0 rounded-full" />
                    )}
                    <span className="text-sm font-medium">{slot.name}</span>
                    {r && (
                      <Badge
                        variant="outline"
                        className={cn("ml-auto shrink-0 text-[10px] uppercase", statusBadgeClass(r.status))}
                      >
                        {r.status} · {r.durationMs}ms
                      </Badge>
                    )}
                    {isNext && !r && (
                      <span className="text-muted-foreground ml-auto text-xs">running…</span>
                    )}
                  </div>
                  {r ? (
                    <div className="mt-1.5 space-y-1.5">
                      <p className="text-muted-foreground text-xs">{r.detail}</p>
                      {r.advice && (
                        <p className="text-xs text-amber-700 dark:text-amber-400">→ {r.advice}</p>
                      )}
                      {r.metrics &&
                        (r.metrics.ttftMs !== undefined ||
                          r.metrics.chunks !== undefined ||
                          r.metrics.chars !== undefined ||
                          r.metrics.finishReason !== undefined ||
                          r.metrics.sawDone !== undefined ||
                          r.metrics.toolCallCount !== undefined) && (
                          <div className="flex flex-wrap gap-1 pt-0.5">
                            {r.metrics.httpStatus !== undefined && (
                              <Badge variant="secondary" className="text-[10px]">
                                HTTP {r.metrics.httpStatus}
                              </Badge>
                            )}
                            {r.metrics.ttftMs !== undefined && (
                              <Badge variant="secondary" className="text-[10px]">
                                TTFT {r.metrics.ttftMs}ms
                              </Badge>
                            )}
                            {r.metrics.chunks !== undefined && (
                              <Badge variant="secondary" className="text-[10px]">
                                {r.metrics.chunks} chunks
                              </Badge>
                            )}
                            {r.metrics.chars !== undefined && (
                              <Badge variant="secondary" className="text-[10px]">
                                {r.metrics.chars} chars
                              </Badge>
                            )}
                            {r.metrics.finishReason !== undefined && r.metrics.finishReason !== null && (
                              <Badge variant="secondary" className="text-[10px]">
                                finish: {r.metrics.finishReason}
                              </Badge>
                            )}
                            {r.metrics.sawDone !== undefined && (
                              <Badge variant="secondary" className="text-[10px]">
                                {r.metrics.sawDone ? "[DONE] ✓" : "no [DONE]"}
                              </Badge>
                            )}
                            {r.metrics.toolCallCount !== undefined && (
                              <Badge variant="secondary" className="text-[10px]">
                                {r.metrics.toolCallCount} tool call(s)
                              </Badge>
                            )}
                          </div>
                        )}
                      {r.requestUrl && (
                        <p className="text-muted-foreground/70 truncate font-mono text-[10px]">
                          POST {r.requestUrl}
                        </p>
                      )}
                    </div>
                  ) : (
                    !isNext && (
                      <p className="text-muted-foreground/70 mt-1 text-xs">{slot.purpose}</p>
                    )
                  )}
                </div>
              );
            })}
          </div>
        </ScrollArea>

        {phase === "done" && results.length > 0 && (
          <>
            <Separator />
            <p className="text-muted-foreground text-xs">
              <strong className="text-foreground">
                {passCount}/{results.length} passed
              </strong>
              {failCount > 0 && <> · {failCount} failed</>}
              {warnCount > 0 && <> · {warnCount} warning{warnCount === 1 ? "" : "s"}</>}
              {failCount === 0 && warnCount === 0
                ? " — this provider works end-to-end exactly the way OnyxAgent calls it."
                : " — copy the report and check the advice lines; the first failing test is where the problem lives."}
            </p>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

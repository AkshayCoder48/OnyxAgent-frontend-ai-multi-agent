"use client";
import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { Card, CardContent, Button } from "@/components/ui";
import type { ToolCall } from "@/types";
import {
  Wrench,
  Clock,
  Search,
  Globe,
  ChevronDown,
  ChevronUp,
  Code2,
  MessageCircleQuestion,
  Loader2,
  CheckCircle2,
  XCircle,
  BarChart3,
  Download,
  ImageIcon,
  Newspaper,
  Video,
  MapPin,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { toolCaption } from "@/lib/agent-step-captions";
import { WritingCursor } from "./writing-cursor";
import { ChartMessage, parseChartResult } from "./chart-message";
import { DateTimeResult } from "./tool-results/datetime";
import { RAGSearchResults } from "./tool-results/rag";
import { WebSearchResults, parseWebSearch } from "./tool-results/web-search";
import { LoadSkillResult, formatSkillName } from "./tool-results/skills";
import { AskUserResult } from "./tool-results/ask-user";
import { GenericToolResult, RawToolView } from "./tool-results/generic";
import { RunPythonResult } from "./tool-results/run-python";
import { FileDownloadResult, parseFileDownloadResult } from "./tool-results/file-download";
import {
  ToolResultRenderer,
  WebSearchResults as DDGWebResults,
  ImageSearchResults as DDGImageResults,
  NewsSearchResults as DDGNewsResults,
  VideoSearchResults as DDGVideoResults,
  MapSearchResults as DDGMapResults,
} from "./tool-results";

interface ToolCallCardProps {
  toolCall: ToolCall;
}

export function ToolCallCard({ toolCall }: ToolCallCardProps) {
  // Collapsed by default — the bar acts as the toggle. `showRaw` swaps the
  // formatted view for args + raw output (the </> button). Charts are the
  // exception: they're only useful when visible, so expand them by default.
  const isRunPython = toolCall.name === "run_python";
  // DDG search tools — detect and auto-expand
  const isDDGWebSearch = toolCall.name === "web_search" && toolCall.status === "completed";
  const isDDGImageSearch = toolCall.name === "image_search" && toolCall.status === "completed";
  const isDDGNewsSearch = toolCall.name === "news_search" && toolCall.status === "completed";
  const isDDGVideoSearch = toolCall.name === "video_search" && toolCall.status === "completed";
  const isDDGMapSearch = toolCall.name === "map_search" && toolCall.status === "completed";
  const isAnyDDGSearch =
    isDDGWebSearch || isDDGImageSearch || isDDGNewsSearch || isDDGVideoSearch || isDDGMapSearch;

  const [expanded, setExpanded] = useState(
    toolCall.name === "ask_user" ||
      (isRunPython && toolCall.status === "completed") ||
      (toolCall.name === "create_chart" &&
        toolCall.status === "completed" &&
        parseChartResult(toolCall.result) !== null) ||
      (toolCall.name === "preview_image" && toolCall.status === "completed") ||
      ((toolCall.name === "send_file" || toolCall.name === "send_folder") &&
        toolCall.status === "completed" &&
        parseFileDownloadResult(toolCall.result) !== null) ||
      isAnyDDGSearch,
  );
  const [showRaw, setShowRaw] = useState(false);

  // Auto-expand while a long-running tool (run_terminal, run_python, etc.)
  // is in flight so the user can see the "Running…" body without having to
  // click. Collapse it again when the tool completes so the final view
  // matches the original "collapsed summary bar" default — but only if the
  // user hasn't manually expanded it in the meantime (which would override
  // the auto-collapse).
  const isRunning = toolCall.status === "running" || toolCall.status === "pending";
  const wasRunningRef = useRef(isRunning);
  useEffect(() => {
    // Auto-expand on running transition (idle → running).
    if (isRunning && !wasRunningRef.current) {
      setExpanded(true);
    }
    // Track for next render.
    wasRunningRef.current = isRunning;
  }, [isRunning]);

  // Short input hint shown in the collapsed bar — the query for search
  // tools, the URL for fetch_url, etc. (any tool with a url/query arg).
  const urlArg = toolCall.args?.url;
  const queryArg = toolCall.args?.query;
  const inputHint =
    typeof urlArg === "string" ? urlArg : typeof queryArg === "string" ? queryArg : null;

  const resultText =
    toolCall.result !== undefined
      ? typeof toolCall.result === "string"
        ? toolCall.result
        : JSON.stringify(toolCall.result, null, 2)
      : "";

  const isDateTime =
    (toolCall.name === "get_current_datetime" || toolCall.name === "current_datetime") &&
    toolCall.status === "completed";
  const isRAGSearch =
    (toolCall.name === "search_knowledge_base" || toolCall.name === "search_documents") &&
    toolCall.status === "completed" &&
    typeof toolCall.result === "string";
  const webResults =
    (toolCall.name === "web_search_tool" ||
      toolCall.name === "search_web" ||
      toolCall.name === "web_search") &&
    toolCall.status === "completed" &&
    typeof toolCall.result === "string"
      ? parseWebSearch(toolCall.result)
      : null;
  const isWebSearch = webResults !== null;
  const isAskUser = toolCall.name === "ask_user";
  const isLoadSkill = toolCall.name === "load_skill";
  const isListSkills = toolCall.name === "list_skills";
  const loadedSkillName =
    isLoadSkill && typeof toolCall.args?.skill_name === "string" ? toolCall.args.skill_name : null;
  // Memoize the parsed chart spec — `parseChartResult` does `JSON.parse` for
  // string results, returning a NEW object each call. Without this memo, every
  // streaming delta (text/thinking) re-renders ToolCallCard → new spec ref →
  // ChartMessage re-renders → Recharts re-layouts → ResponsiveContainer
  // briefly reports -1 dimensions → `RenderedTicksReporter` setState → React
  // detects too-many updates and bails with "Maximum update depth exceeded".
  const chartSpec = useMemo(
    () =>
      toolCall.name === "create_chart" && toolCall.status === "completed"
        ? parseChartResult(toolCall.result)
        : null,
    [toolCall.name, toolCall.status, toolCall.result],
  );
  const isChart = chartSpec !== null;

  // Parse image preview result — same pattern as chartSpec. The tool result
  // may be a JSON string (not a parsed object), so we parse it here.
  const imagePreviewSpec = useMemo(() => {
    if (toolCall.name !== "preview_image" || toolCall.status !== "completed") return null;
    const result = toolCall.result;
    if (!result) return null;
    // If already an object, use directly.
    if (typeof result === "object") {
      const obj = result as { kind?: string; url?: string; alt?: string; error?: string };
      if (obj.kind === "image_preview" || obj.url) return obj;
    }
    // If a string, try JSON.parse.
    if (typeof result === "string") {
      try {
        const obj = JSON.parse(result) as { kind?: string; url?: string; alt?: string; error?: string };
        if (obj.url) return obj;
      } catch {
        // not JSON — maybe it's a raw URL
        if (result.startsWith("http://") || result.startsWith("https://") || result.startsWith("data:image/")) {
          return { url: result, alt: "" };
        }
      }
    }
    return null;
  }, [toolCall.name, toolCall.status, toolCall.result]);
  const isImagePreview = imagePreviewSpec !== null;
  // send_file / send_folder return a JSON payload the frontend renders as a
  // clickable download card. Detect it once and memoize.
  const fileDownloadSpec = useMemo(
    () =>
      (toolCall.name === "send_file" || toolCall.name === "send_folder") &&
      toolCall.status === "completed"
        ? parseFileDownloadResult(toolCall.result)
        : null,
    [toolCall.name, toolCall.status, toolCall.result],
  );
  const isFileDownload = fileDownloadSpec !== null;
  // A chart that finishes after this card mounted (live streaming) won't
  // have triggered the initial-state default — expand it on transition.
  // Same for file_download cards.
  useEffect(() => {
    if (isChart || isFileDownload) setExpanded(true);
  }, [isChart, isFileDownload]);

  const hasSpecialRenderer =
    isDateTime || isRAGSearch || isWebSearch || isAskUser || isChart || isRunPython || isFileDownload || isAnyDDGSearch;
  const friendlyName = isDateTime
    ? "Current Date & Time"
    : isRAGSearch
      ? "Knowledge Base Search"
      : isWebSearch
        ? "Web Search"
        : isDDGWebSearch
          ? "Web Search"
          : isDDGImageSearch
            ? "Image Search"
            : isDDGNewsSearch
              ? "News Search"
              : isDDGVideoSearch
                ? "Video Search"
                : isDDGMapSearch
                  ? "Map Search"
                  : isChart
          ? "Chart"
          : isAskUser
            ? "Question"
            : isFileDownload
              ? fileDownloadSpec?.item_type === "folder"
                ? "Folder Download"
                : "File Download"
              : isLoadSkill
                ? loadedSkillName
                  ? formatSkillName(loadedSkillName)
                  : "Load Skill"
                : isListSkills
                  ? "Available Skills"
                  : toolCall.name === "run_python"
                    ? "Run Python"
                    : toolCall.name.startsWith("pending-")
                      ? "Composing…"
                      : toolCall.name;

  const ToolIcon = isDateTime
    ? Clock
    : isRAGSearch
      ? Search
      : isWebSearch
        ? Globe
        : isChart
          ? BarChart3
          : isAskUser
            ? MessageCircleQuestion
            : isFileDownload
              ? Download
              : isRunPython
                ? Code2
                : Wrench;

  const toggleExpanded = () => {
    setExpanded((prev) => {
      const next = !prev;
      if (!next) setShowRaw(false);
      return next;
    });
  };

  const toggleRaw = (e: MouseEvent) => {
    e.stopPropagation();
    setShowRaw((r) => !r);
    setExpanded(true);
  };

  // While still running: narrate what the agent is doing instead of the finished label,
  // and swap the chevron/raw toggle for a spinner — the header becomes a step caption.
  // (Note: `isRunning` is declared up top so the auto-expand useEffect can read it.)
  const isError = toolCall.status === "error";
  const liveCaption = toolCaption(toolCall.name);

  return (
    <Card
      className={cn(
        "bg-muted/50 step-card-in",
        isRunning && "border-brand/50 relative overflow-hidden",
      )}
    >
      <div
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onClick={toggleExpanded}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            toggleExpanded();
          }
        }}
        className="hover:bg-foreground/[0.03] flex w-full cursor-pointer items-center justify-between gap-2 px-3 py-2 text-left transition-colors"
      >
        <div className="flex min-w-0 items-center gap-2">
          <ToolIcon
            className={cn(
              "h-4 w-4 shrink-0",
              isRunning
                ? "text-brand animate-pulse"
                : hasSpecialRenderer
                  ? "text-primary"
                  : "text-muted-foreground",
            )}
          />
          {isRunning ? (
            <span className="text-foreground/80 flex min-w-0 items-center gap-1.5 text-sm font-medium">
              <span className="truncate">{liveCaption}</span>
              <span className="flex shrink-0 gap-0.5" aria-hidden="true">
                <span className="bg-brand/70 h-1 w-1 animate-bounce rounded-full [animation-delay:0ms]" />
                <span className="bg-brand/70 h-1 w-1 animate-bounce rounded-full [animation-delay:150ms]" />
                <span className="bg-brand/70 h-1 w-1 animate-bounce rounded-full [animation-delay:300ms]" />
              </span>
            </span>
          ) : (
            <span className="truncate text-sm font-medium">{friendlyName}</span>
          )}
          {inputHint && !isRunning ? (
            <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs italic">
              {inputHint}
            </span>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {isRunning ? (
            <Loader2 className="text-brand h-4 w-4 animate-spin" aria-label="Running" />
          ) : (
            <>
              {isError ? (
                <XCircle className="text-destructive pop-in h-4 w-4 shrink-0" aria-label="Failed" />
              ) : (
                <CheckCircle2 className="text-brand pop-in h-4 w-4 shrink-0" aria-label="Done" />
              )}
              <Button
                variant="ghost"
                size="icon"
                className={cn(
                  "text-muted-foreground hover:bg-foreground/10 hover:text-foreground h-6 w-6 transition-colors",
                  showRaw && "text-primary",
                )}
                onClick={toggleRaw}
                title={showRaw ? "Show formatted view" : "Show arguments + raw output"}
                aria-label={showRaw ? "Show formatted view" : "Show arguments and raw output"}
              >
                <Code2 className="h-3.5 w-3.5" />
              </Button>
              {expanded ? (
                <ChevronUp className="text-muted-foreground h-4 w-4" />
              ) : (
                <ChevronDown className="text-muted-foreground h-4 w-4" />
              )}
            </>
          )}
        </div>
      </div>

      {/* Live progress shimmer — only while the step is in flight. */}
      {isRunning && (
        <div className="step-progress pointer-events-none absolute inset-x-0 bottom-0 h-0.5" />
      )}

      {expanded && (
        <CardContent className="px-3 pt-0 pb-3">
          {showRaw ? (
            <RawToolView toolCall={toolCall} resultText={resultText} />
          ) : isRunning ? (
            // While the tool is still running, show a prominent "Running…"
            // panel regardless of the tool's specialized renderer — the
            // renderer branches below all gate on `status === "completed"` and
            // would otherwise render an empty body. The panel surfaces the
            // tool's command/args so the user can see exactly what's
            // executing (e.g. the shell command for `run_terminal`).
            <RunningToolPanel toolCall={toolCall} liveCaption={liveCaption} />
          ) : toolCall.status === "completed" && isDateTime ? (
            <DateTimeResult result={resultText} />
          ) : toolCall.status === "completed" && isRAGSearch ? (
            <RAGSearchResults result={resultText} />
          ) : toolCall.status === "completed" && isWebSearch && webResults ? (
            <WebSearchResults data={webResults} />
          ) : toolCall.status === "completed" && isChart && chartSpec ? (
            <ChartMessage spec={chartSpec} />
          ) : toolCall.status === "completed" && isImagePreview && imagePreviewSpec ? (
            <ImagePreviewResult spec={imagePreviewSpec} />
          ) : toolCall.status === "completed" && isFileDownload && fileDownloadSpec ? (
            <FileDownloadResult payload={fileDownloadSpec} />
          ) : toolCall.status === "completed" && isDDGWebSearch ? (
            <DDGWebResults result={toolCall.result} />
          ) : toolCall.status === "completed" && isDDGImageSearch ? (
            <DDGImageResults result={toolCall.result} />
          ) : toolCall.status === "completed" && isDDGNewsSearch ? (
            <DDGNewsResults result={toolCall.result} />
          ) : toolCall.status === "completed" && isDDGVideoSearch ? (
            <DDGVideoResults result={toolCall.result} />
          ) : toolCall.status === "completed" && isDDGMapSearch ? (
            <DDGMapResults result={toolCall.result} />
          ) : isAskUser ? (
            <AskUserResult args={toolCall.args} resultText={resultText} />
          ) : isRunPython ? (
            <RunPythonResult toolCall={toolCall} resultText={resultText} />
          ) : isLoadSkill ? (
            <LoadSkillResult resultText={resultText} status={toolCall.status} />
          ) : isListSkills ? null : (
            <GenericToolResult toolCall={toolCall} resultText={resultText} />
          )}
        </CardContent>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// RunningToolPanel — prominent "Running…" body shown while a tool executes.
// Long-running tools (run_terminal, run_python) sit in this state for tens of
// seconds; without a dedicated panel the expanded card would be visually
// empty. The panel surfaces:
//   - A spinner + the live caption (e.g. "Running a terminal command")
//   - The most relevant arg (command / code / url / query) so the user can
//     see exactly what's executing
//   - LIVE streaming output (stdout/stderr) as it arrives via `tool_output`
//     WSEvents — the SDK's runCodeStream / commands.run pipe output chunks
//     through the runtime into `toolCall.streamingOutput` /
//     `toolCall.streamingError` in real time. We render them here as a
//     monospace log tail (capped to the last ~6 KB so the DOM doesn't choke
//     on huge logs).
// ---------------------------------------------------------------------------

const STREAM_TAIL_BYTES = 6 * 1024;

function tailText(s: string | undefined, max: number = STREAM_TAIL_BYTES): string {
  if (!s) return "";
  if (s.length <= max) return s;
  return "…" + s.slice(s.length - max);
}

function RunningToolPanel({
  toolCall,
  liveCaption,
}: {
  toolCall: ToolCall;
  liveCaption: string;
}) {
  // Handle streaming args (when tool call is still being built by the LLM)
  const isStreaming = toolCall.status === "pending";
  const streamingArgs = (toolCall.args as { _streaming?: string })?._streaming;

  // Pick the most informative arg to display
  const previewArg =
    (typeof toolCall.args?.command === "string" && toolCall.args.command) ||
    (typeof toolCall.args?.code === "string" && toolCall.args.code) ||
    (typeof toolCall.args?.cmd === "string" && toolCall.args.cmd) ||
    (typeof toolCall.args?.url === "string" && toolCall.args.url) ||
    (typeof toolCall.args?.query === "string" && toolCall.args.query) ||
    (typeof toolCall.args?.path === "string" && toolCall.args.path) ||
    null;

  const stdout = toolCall.streamingOutput ?? "";
  const stderr = toolCall.streamingError ?? "";
  const hasLiveOutput = stdout.length > 0 || stderr.length > 0;

  // PERF+UX: Show "Writing tool_name…" for ALL tools (including custom tools)
  // during BOTH the pending phase (LLM composing args) AND the running phase
  // (tool executing). Previously only write_file/create_file showed "Writing"
  // because their large `content` args kept them in "pending" longer. Other
  // tools flashed through pending too fast to see the label, then showed only
  // the liveCaption (e.g. "Running a terminal command…") during execution.
  // Now every tool shows "Writing tool_name…" with the streaming cursor +
  // spinner, so the user always sees what's being composed/executed.
  // If the tool name is a "pending-N" placeholder (LLM sent args before the
  // function name), show "Composing…" instead of the raw placeholder.
  const displayName = toolCall.name.startsWith("pending-")
    ? "tool"
    : toolCall.name;
  const writingLabel = `Writing ${displayName}…`;

  return (
    <div className="space-y-2 py-1">
      <div className="flex items-center gap-2 text-sm">
        <Loader2 className="text-brand h-3.5 w-3.5 animate-spin" aria-hidden="true" />
        <span className="text-foreground/80 font-medium">
          {writingLabel}
        </span>
      </div>
      {/* Show streaming args while LLM is composing the tool call */}
      {isStreaming && streamingArgs && (
        <StreamingArgsDisplay args={streamingArgs} />
      )}
      {/* Show the final args when the tool is running */}
      {!isStreaming && previewArg && (
        <pre className="scrollbar-thin max-h-64 overflow-auto border border-foreground/10 bg-background/60 rounded-lg p-2.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words">
          {previewArg}
        </pre>
      )}
      {hasLiveOutput && (
        <div className="border-foreground/10 bg-background/60 scrollbar-thin overflow-hidden rounded-lg border">
          <div className="border-foreground/8 text-foreground/55 flex items-center justify-between border-b px-3 py-1.5 font-mono text-[10px] tracking-wider uppercase">
            <span className="flex items-center gap-1.5">
              <span className="bg-brand/70 inline-block h-1.5 w-1.5 animate-pulse rounded-full" />
              Live output
            </span>
            <span className="text-muted-foreground">
              {stdout.length + stderr.length} bytes
            </span>
          </div>
          <pre className="text-foreground/85 max-h-72 scrollbar-thin overflow-y-auto p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words">
            {stderr && (
              <span className="text-destructive">{tailText(stderr)}</span>
            )}
            {stdout && <span>{tailText(stdout)}</span>}
            {!hasLiveOutput && (
              <span className="text-muted-foreground italic">Waiting for output…</span>
            )}
          </pre>
        </div>
      )}
      <p className="text-muted-foreground text-[11px] italic">
        The agent is waiting for this tool to finish. Long-running commands
        (installs, builds, network ops) can take a few minutes.
      </p>
    </div>
  );
}

/** Image preview — renders an inline image from a URL or base64 data URI.
 *  Used by the `preview_image` tool. Receives the already-parsed spec. */
function ImagePreviewResult({ spec }: { spec: { url: string; alt?: string; error?: string } }) {
  if (spec.error) {
    return <p className="text-destructive text-xs py-2">{spec.error}</p>;
  }
  if (!spec.url) {
    return <p className="text-muted-foreground text-xs py-2">No image data.</p>;
  }
  return (
    <div className="py-2 space-y-2">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={spec.url}
        alt={spec.alt ?? "AI-generated image preview"}
        className="max-w-full rounded-xl border border-border animate-fade-scale"
        style={{ maxHeight: "500px" }}
        loading="lazy"
        onError={(e) => {
          (e.target as HTMLImageElement).style.display = "none";
          const parent = (e.target as HTMLImageElement).parentElement;
          if (parent) {
            parent.innerHTML = '<p class="text-destructive text-xs py-2">Failed to load image. The URL may be invalid or blocked by CORS.</p>';
          }
        }}
      />
      {spec.alt && (
        <p className="text-muted-foreground text-xs text-center">{spec.alt}</p>
      )}
    </div>
  );
}

/** Streaming args display — shows the LLM writing tool call arguments in
 *  realtime. Auto-scrolls to the bottom so the user always sees the latest
 *  text. Only shows the last 2000 characters to prevent DOM bloat. */
function StreamingArgsDisplay({ args }: { args: string }) {
  const preRef = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (preRef.current) {
      preRef.current.scrollTop = preRef.current.scrollHeight;
    }
  }, [args]);
  return (
    <pre
      ref={preRef}
      className="scrollbar-thin max-h-48 overflow-auto border border-foreground/10 bg-background/60 rounded-lg p-2.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words"
    >
      {args.slice(-2000)}
      <WritingCursor size="0.85em" />
    </pre>
  );
}

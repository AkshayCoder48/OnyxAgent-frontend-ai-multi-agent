// ============================================================================
// Tool result renderers — specialized views for different tool types.
// Adapted from the original repo's tool-results/* components.
// ============================================================================
"use client";

import * as React from "react";
import { CheckCircle2, XCircle, Download, FileText, Terminal, Search, BarChart3, MessageCircleQuestion, Globe, ImageIcon, Video, ExternalLink, Eye, ThumbsUp, Play } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface ResultProps {
  args?: Record<string, unknown>;
  result?: unknown;
  status?: string;
}

// ---- Generic result (fallback) ----
export function GenericToolResult({ result }: ResultProps) {
  const text = React.useMemo(() => {
    if (typeof result === "string") return result;
    if (result === undefined || result === null) return "";
    try {
      return JSON.stringify(result, null, 2);
    } catch {
      return String(result);
    }
  }, [result]);

  // EMPTY-RECTANGLE PREVENTION (PRD §3): never render an unexplained empty
  // box — when no result data is available, say so explicitly.
  if (!text.trim()) {
    return (
      <p className="text-muted-foreground flex items-center gap-2 py-2 text-xs italic">
        <Search className="h-3.5 w-3.5 shrink-0" aria-hidden />
        No result data recorded for this tool call.
      </p>
    );
  }

  return (
    <pre className="max-h-64 overflow-auto rounded bg-muted p-2 font-mono text-[11px] leading-relaxed">
      {text}
    </pre>
  );
}

// ---- run_python result ----
export function RunPythonResult({ result }: ResultProps) {
  const r = result as { output?: { stdout?: string; stderr?: string; exit_code?: number; duration_ms?: number }; error?: string } | undefined;
  if (!r) return <GenericToolResult result={result} />;
  const out = r.output;
  if (!out) return <div className="text-xs text-rose-500">{r.error ?? "No output"}</div>;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-[11px]">
        <Badge variant={out.exit_code === 0 ? "secondary" : "destructive"} className="text-[10px]">
          exit {out.exit_code}
        </Badge>
        {out.duration_ms != null && (
          <span className="text-muted-foreground">{out.duration_ms}ms</span>
        )}
      </div>
      {out.stdout && (
        <div>
          <div className="mb-0.5 text-[10px] font-medium uppercase text-muted-foreground">stdout</div>
          <pre className="max-h-40 overflow-auto rounded bg-zinc-950 p-2 font-mono text-[11px] text-zinc-200">
            {out.stdout}
          </pre>
        </div>
      )}
      {out.stderr && (
        <div>
          <div className="mb-0.5 text-[10px] font-medium uppercase text-muted-foreground">stderr</div>
          <pre className="max-h-40 overflow-auto rounded bg-rose-950/30 p-2 font-mono text-[11px] text-rose-300">
            {out.stderr}
          </pre>
        </div>
      )}
    </div>
  );
}

// ---- run_terminal result ----
export function RunTerminalResult({ args, result }: ResultProps) {
  const cmd = (args?.command as string) ?? "";
  const r = result as { output?: { stdout?: string; stderr?: string; exit_code?: number }; error?: string } | undefined;
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 rounded bg-zinc-950 px-2 py-1 font-mono text-[11px] text-zinc-300">
        <Terminal className="h-3 w-3 shrink-0 text-emerald-400" />
        <span className="truncate">$ {cmd}</span>
      </div>
      {r?.output && (
        <>
          {r.output.stdout && (
            <pre className="max-h-40 overflow-auto rounded bg-muted p-2 font-mono text-[11px]">
              {r.output.stdout}
            </pre>
          )}
          {r.output.stderr && (
            <pre className="max-h-40 overflow-auto rounded bg-rose-950/20 p-2 font-mono text-[11px] text-rose-400">
              {r.output.stderr}
            </pre>
          )}
        </>
      )}
      {r?.error && <div className="text-[11px] text-rose-500">{r.error}</div>}
    </div>
  );
}

// ---- search_documents result (RAG) ----
export function RAGSearchResult({ args, result }: ResultProps) {
  const query = (args?.query as string) ?? "";
  const r = result as { output?: { matches?: Array<{ file: string; line: number; text: string }>; count?: number } } | undefined;
  const matches = r?.output?.matches ?? [];

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-[11px]">
        <Search className="h-3 w-3 text-muted-foreground" />
        <span className="truncate font-mono">{query}</span>
        <Badge variant="secondary" className="ml-auto text-[10px]">{matches.length} matches</Badge>
      </div>
      {matches.length > 0 && (
        <div className="max-h-48 space-y-1 overflow-y-auto">
          {matches.slice(0, 10).map((m, i) => (
            <div key={i} className="rounded border-l-2 border-primary/40 bg-muted/40 px-2 py-1 text-[11px]">
              <div className="font-mono text-[10px] text-muted-foreground">{m.file}:{m.line}</div>
              <div className="truncate">{m.text}</div>
            </div>
          ))}
          {matches.length > 10 && (
            <div className="text-center text-[10px] text-muted-foreground">
              +{matches.length - 10} more…
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---- create_chart result ----
export function ChartResult({ result }: ResultProps) {
  const r = result as { output?: { chart?: Record<string, unknown>; title?: string } } | undefined;
  const chart = r?.output?.chart;
  if (!chart) return <GenericToolResult result={result} />;

  // We render a preview badge — the actual chart is rendered by ChartMessage
  // in the message content (the agent includes the chart in its response).
  return (
    <div className="flex items-center gap-2 rounded-md border border-primary/20 bg-primary/5 p-2 text-xs">
      <BarChart3 className="h-4 w-4 text-primary" />
      <span>Chart generated</span>
      {r?.output?.title && <span className="text-muted-foreground">— {r.output.title}</span>}
    </div>
  );
}

// ---- send_file / send_folder result (file download) ----
export function FileDownloadResult({ result }: ResultProps) {
  const r = result as { output?: { download_url?: string; filename?: string; size?: number; mime_type?: string } } | undefined;
  const f = r?.output;
  if (!f?.download_url) return <GenericToolResult result={result} />;

  return (
    <a
      href={f.download_url}
      download={f.filename}
      className="flex items-center gap-3 rounded-md border border-border bg-card p-3 transition-colors hover:bg-accent"
    >
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary/10">
        <Download className="h-4 w-4 text-primary" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{f.filename}</div>
        <div className="text-[11px] text-muted-foreground">
          {f.mime_type} · {f.size != null ? `${(f.size / 1024).toFixed(1)} KB` : ""}
        </div>
      </div>
      <Button variant="ghost" size="sm" className="shrink-0">
        <Download className="h-3.5 w-3.5" />
      </Button>
    </a>
  );
}

// ---- ask_user result (transcript view inside ToolCallCard) ----
export function AskUserResult({ args, result, status }: ResultProps) {
  const questions = ((args?.questions as Array<{ question?: string; choices?: string[] }>) || []) ;
  const r = result as { output?: { answer?: string } } | undefined;

  return (
    <div className="space-y-2">
      {questions.map((q, i) => (
        <div key={i} className="rounded-md border border-border p-2 text-xs">
          <div className="flex items-start gap-2">
            <MessageCircleQuestion className="mt-0.5 h-3 w-3 shrink-0 text-primary" />
            <div className="min-w-0 flex-1">
              <div className="font-medium">{q.question}</div>
              {q.choices && q.choices.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-1">
                  {q.choices.map((c, j) => (
                    <Badge key={j} variant="outline" className="text-[10px]">{c}</Badge>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      ))}
      {status === "completed" && r?.output?.answer ? (
        <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 p-2 text-xs">
          <div className="mb-0.5 text-[10px] font-medium uppercase text-emerald-600">Answer</div>
          <div>{r.output.answer}</div>
        </div>
      ) : (
        <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
          Waiting for user response…
        </div>
      )}
    </div>
  );
}

// ---- list_files / read_file / write_file etc. (generic file ops) ----
export function FileOpResult({ args, result, status }: ResultProps) {
  const path = (args?.path as string) || "";
  const r = result as { success?: boolean; output?: unknown; error?: string } | undefined;

  return (
    <div className="space-y-1.5">
      {path && (
        <div className="flex items-center gap-2 font-mono text-[11px] text-muted-foreground">
          <FileText className="h-3 w-3" />
          <span className="truncate">{path}</span>
        </div>
      )}
      {status === "completed" && r?.success && (
        <div className="flex items-center gap-1.5 text-[11px] text-emerald-600">
          <CheckCircle2 className="h-3 w-3" /> Done
        </div>
      )}
      {status === "failed" && (
        <div className="flex items-center gap-1.5 text-[11px] text-rose-500">
          <XCircle className="h-3 w-3" /> {r?.error ?? "Failed"}
        </div>
      )}
    </div>
  );
}

// ---- Tool renderer dispatcher ----
// ---- Helper: parse tool result (handles both JSON string and object) ----
/**
 * The runtime emits tool results as JSON STRINGS (via `tool_result` SSE event
 * with `content: string`). The renderers need to parse them back into objects
 * to access `.output.results`. This helper handles both cases safely.
 */
function parseResult<T = Record<string, unknown>>(result: unknown): T | null {
  if (!result) return null;
  if (typeof result === "string") {
    try {
      return JSON.parse(result) as T;
    } catch {
      return null;
    }
  }
  if (typeof result === "object") {
    return result as T;
  }
  return null;
}

// ---- Web Search Results (LangSearch + Miklium) ----
// Handles results from both LangSearch (has title, domain, icon, description)
// and Miklium (has url, snippet, snippetType, symbols).
export function WebSearchResults({ result }: ResultProps) {
  const parsed = parseResult<{
    output?: {
      results?: Array<{
        title?: string;
        url?: string;
        description?: string;
        snippet?: string;
        domain?: string;
        icon?: string;
        source?: string;
        provider?: string;
        snippetType?: string;
        symbols?: number;
      }>;
      provider?: string;
      query?: string;
    };
  }>(result);
  const results = parsed?.output?.results ?? [];
  const provider = parsed?.output?.provider ?? "miklium";
  if (results.length === 0) return <GenericToolResult result={result} />;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
          <Globe className="h-3 w-3" /> {results.length} web result{results.length !== 1 ? "s" : ""}
        </div>
        <Badge variant="secondary" className="text-[9px] font-mono uppercase tracking-wider">
          {provider}
        </Badge>
      </div>
      <div className="space-y-1.5">
        {results.slice(0, 8).map((item, i) => {
          const title = item.title || item.domain || item.url;
          const desc = item.description || item.snippet;
          const domain = item.domain || (item.url ? domainOf(item.url) : "");
          return (
            <a
              key={i}
              href={item.url}
              target="_blank"
              rel="noopener noreferrer"
              className="group flex gap-2.5 rounded-xl border border-border bg-card/50 p-2.5 hover:bg-accent hover:border-primary/30 transition-all"
            >
              <span className="bg-primary/10 text-primary flex h-6 w-6 shrink-0 items-center justify-center rounded-lg text-[10px] font-bold tabular-nums">
                {i + 1}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  {item.icon ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={item.icon} alt="" className="h-3.5 w-3.5 shrink-0 rounded-sm" />
                  ) : null}
                  <p className="text-foreground truncate text-xs font-semibold group-hover:text-primary transition-colors">{title}</p>
                </div>
                <div className="text-muted-foreground mt-0.5 flex items-center gap-1 text-[10px]">
                  <ExternalLink className="h-2.5 w-2.5 shrink-0" />
                  <span className="truncate">{domain}</span>
                </div>
                {desc && (
                  <p className="text-muted-foreground mt-1 line-clamp-2 text-[11px] leading-relaxed">{desc}</p>
                )}
              </div>
            </a>
          );
        })}
      </div>
    </div>
  );
}

// ---- Image Search Results (Miklium) — Swipeable Carousel ----
// Miklium returns: { imageUrl, title, referenceUrl, size: {width, height}, query }
export function ImageSearchResults({ result }: ResultProps) {
  const parsed = parseResult<{
    output?: {
      results?: Array<{
        title?: string;
        imageUrl?: string;
        thumbnail?: string;
        url?: string;
        width?: number;
        height?: number;
        source?: string;
        domain?: string;
      }>;
    };
  }>(result);
  const results = parsed?.output?.results ?? [];
  const [currentIdx, setCurrentIdx] = React.useState(0);
  const touchStartX = React.useRef<number | null>(null);

  if (results.length === 0) return <GenericToolResult result={result} />;

  const total = results.length;
  // Clamp index in case results shrank
  const idx = Math.min(currentIdx, total - 1);
  const current = results[idx];
  if (!current) return <GenericToolResult result={result} />;

  const linkUrl = current.url || current.imageUrl || current.thumbnail || "#";

  const goPrev = () => setCurrentIdx((i) => (i - 1 + total) % total);
  const goNext = () => setCurrentIdx((i) => (i + 1) % total);

  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartX.current = e.touches[0]?.clientX ?? null;
  };
  const handleTouchEnd = (e: React.TouchEvent) => {
    if (touchStartX.current === null) return;
    const endX = e.changedTouches[0]?.clientX ?? touchStartX.current;
    const delta = endX - touchStartX.current;
    if (Math.abs(delta) > 40) {
      if (delta > 0) goPrev();
      else goNext();
    }
    touchStartX.current = null;
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
          <ImageIcon className="h-3 w-3" /> {total} image{total !== 1 ? "s" : ""}
        </div>
        <Badge variant="secondary" className="text-[9px] font-mono uppercase tracking-wider">miklium</Badge>
      </div>

      {/* Swipeable image carousel */}
      <div
        className="relative overflow-hidden rounded-xl border border-border bg-muted select-none"
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
      >
        <div
          className="flex transition-transform duration-300 ease-out"
          style={{ transform: `translateX(-${idx * 100}%)` }}
        >
          {results.map((item, i) => {
            const src = item.imageUrl || item.thumbnail;
            return (
              <div key={i} className="relative w-full shrink-0" style={{ aspectRatio: "16 / 11" }}>
                {src ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={src}
                    alt={item.title || ""}
                    className="h-full w-full object-cover"
                    loading={i === idx ? "eager" : "lazy"}
                    draggable={false}
                  />
                ) : (
                  <div className="flex h-full w-full items-center justify-center">
                    <ImageIcon className="text-muted-foreground h-8 w-8" />
                  </div>
                )}
                {/* Gradient overlay with title */}
                {(item.title || item.width || item.height) && (
                  <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 via-black/30 to-transparent p-2.5">
                    {item.title && (
                      <p className="text-[10px] text-white line-clamp-1 leading-tight font-medium">{item.title}</p>
                    )}
                    {(item.width || item.height) && (
                      <p className="text-[9px] text-white/60 mt-0.5">{item.width}×{item.height}</p>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Left/Right nav arrows (desktop) */}
        {total > 1 && (
          <>
            <button
              type="button"
              onClick={goPrev}
              className="absolute left-1.5 top-1/2 -translate-y-1/2 flex h-7 w-7 items-center justify-center rounded-full bg-black/50 text-white hover:bg-black/70 transition-colors backdrop-blur-sm"
              aria-label="Previous image"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
              </svg>
            </button>
            <button
              type="button"
              onClick={goNext}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 flex h-7 w-7 items-center justify-center rounded-full bg-black/50 text-white hover:bg-black/70 transition-colors backdrop-blur-sm"
              aria-label="Next image"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
              </svg>
            </button>
          </>
        )}

        {/* Dot indicators — small, subtle */}
        {total > 1 && (
          <div className="absolute bottom-1.5 left-1/2 -translate-x-1/2 flex gap-0.5">
            {results.map((_, i) => (
              <button
                key={i}
                type="button"
                onClick={() => setCurrentIdx(i)}
                className={cn(
                  "h-1 rounded-full transition-all",
                  i === idx ? "w-3 bg-white" : "w-1 bg-white/40 hover:bg-white/60",
                )}
                aria-label={`Go to image ${i + 1}`}
              />
            ))}
          </div>
        )}

        {/* Counter badge — small */}
        <div className="absolute top-1.5 right-1.5 rounded-full bg-black/60 px-1.5 py-0.5 font-mono text-[8px] text-white backdrop-blur-sm">
          {idx + 1}/{total}
        </div>
      </div>

      {/* Open source link */}
      <a
        href={linkUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="text-muted-foreground hover:text-primary flex items-center justify-center gap-1 text-[10px] transition-colors"
      >
        <ExternalLink className="h-2.5 w-2.5" />
        <span className="truncate">Open source: {domainOf(linkUrl)}</span>
      </a>
    </div>
  );
}

// ---- Video Search Results (Miklium) ----
// Miklium returns: { videoUrl, thumbUrl, title, description, duration, query, additionalData: { channelTitle, statistics } }
export function VideoSearchResults({ result }: ResultProps) {
  const parsed = parseResult<{
    output?: {
      results?: Array<{
        title?: string;
        url?: string;
        videoUrl?: string;
        imageUrl?: string;
        thumbUrl?: string;
        thumbnail?: string;
        source?: string;
        channelTitle?: string;
        duration?: string;
        description?: string;
        viewCount?: string;
        likeCount?: string;
        domain?: string;
      }>;
    };
  }>(result);
  const results = parsed?.output?.results ?? [];
  if (results.length === 0) return <GenericToolResult result={result} />;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
          <Video className="h-3 w-3" /> {results.length} video{results.length !== 1 ? "s" : ""}
        </div>
        <Badge variant="secondary" className="text-[9px] font-mono uppercase tracking-wider">miklium</Badge>
      </div>
      <div className="space-y-1.5">
        {results.slice(0, 5).map((item, i) => {
          const thumb = item.thumbUrl || item.imageUrl || item.thumbnail;
          const linkUrl = item.videoUrl || item.url || "#";
          const channel = item.channelTitle || item.source;
          return (
            <a
              key={i}
              href={linkUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="group flex gap-3 rounded-xl border border-border bg-card/50 p-2 hover:bg-accent hover:border-primary/30 transition-all"
            >
              <div className="relative h-16 w-24 shrink-0 overflow-hidden rounded-lg bg-muted">
                {thumb ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={thumb} alt="" className="h-full w-full object-cover" loading="lazy" />
                ) : (
                  <div className="flex h-full w-full items-center justify-center">
                    <Video className="text-muted-foreground h-5 w-5" />
                  </div>
                )}
                <div className="absolute inset-0 flex items-center justify-center bg-black/30 group-hover:bg-black/40 transition-colors">
                  <Play className="h-5 w-5 fill-white text-white" />
                </div>
                {item.duration && (
                  <div className="absolute bottom-1 right-1 rounded bg-black/80 px-1 py-0.5 font-mono text-[8px] text-white">
                    {item.duration}
                  </div>
                )}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-foreground group-hover:text-primary line-clamp-2 text-xs font-semibold transition-colors">{item.title}</p>
                {channel && (
                  <p className="text-muted-foreground mt-0.5 truncate text-[10px]">{channel}</p>
                )}
                <div className="mt-1 flex items-center gap-2 text-[9px] text-muted-foreground">
                  {item.viewCount && (
                    <span className="flex items-center gap-0.5">
                      <Eye className="h-2.5 w-2.5" />
                      {formatCount(item.viewCount)}
                    </span>
                  )}
                  {item.likeCount && (
                    <span className="flex items-center gap-0.5">
                      <ThumbsUp className="h-2.5 w-2.5" />
                      {formatCount(item.likeCount)}
                    </span>
                  )}
                  {item.domain && (
                    <span className="truncate">{item.domain}</span>
                  )}
                </div>
              </div>
            </a>
          );
        })}
      </div>
    </div>
  );
}

export function ToolResultRenderer({ toolName, ...props }: ResultProps & { toolName: string }) {
  switch (toolName) {
    case "run_python":
      return <RunPythonResult {...props} />;
    case "run_terminal":
      return <RunTerminalResult {...props} />;
    case "search_documents":
      return <RAGSearchResult {...props} />;
    case "create_chart":
      return <ChartResult {...props} />;
    case "send_file":
    case "send_folder":
      return <FileDownloadResult {...props} />;
    case "ask_user":
      return <AskUserResult {...props} />;
    case "read_file":
    case "write_file":
    case "create_file":
    case "edit_file":
    case "delete_file":
    case "create_folder":
    case "delete_folder":
    case "list_folder":
      return <FileOpResult {...props} />;
    case "list_chats":
    case "read_chat":
    case "current_datetime":
    case "manage_todos":
    case "create_tool":
    case "edit_tool":
    case "delete_tool":
    case "list_env_vars":
    case "add_env_var":
    case "set_env_var":
    case "edit_env_var":
    case "delete_env_var":
    case "list_skills":
    case "read_skill":
    case "create_skill":
    case "edit_skill":
    case "delete_skill":
    case "list_mcps":
    case "create_mcp":
    case "edit_mcp":
    case "delete_mcp":
    // Merged multi-function tools (tool-count cap) — same generic rendering
    // as the families they absorbed.
    case "manage_chats":
    case "manage_env_var":
    case "manage_skill":
    case "manage_mcp":
    case "manage_memory":
    case "manage_custom_tool":
    case "manage_subagent_chat":
    case "ocr_document":
      return <GenericToolResult {...props} />;
    case "web_search":
      return <WebSearchResults {...props} />;
    case "image_search":
      return <ImageSearchResults {...props} />;
    case "video_search":
      return <VideoSearchResults {...props} />;
    default:
      return <GenericToolResult {...props} />;
  }
}

// ---- Helper functions ----

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** Format a view/like count string (e.g. "1450239102") into "1.5B", "1.2M", "12K". */
function formatCount(countStr: string): string {
  const n = parseInt(countStr, 10);
  if (isNaN(n)) return countStr;
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(1).replace(/\.0$/, "") + "B";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "K";
  return String(n);
}

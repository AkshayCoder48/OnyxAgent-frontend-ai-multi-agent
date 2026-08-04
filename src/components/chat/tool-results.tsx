// ============================================================================
// Tool result renderers — specialized views for different tool types.
// Adapted from the original repo's tool-results/* components.
// ============================================================================
"use client";

import * as React from "react";
import { CheckCircle2, XCircle, Download, FileText, Terminal, Search, BarChart3, MessageCircleQuestion, Globe, ImageIcon, Newspaper, Video, MapPin, ExternalLink } from "lucide-react";
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
    try {
      return JSON.stringify(result, null, 2);
    } catch {
      return String(result);
    }
  }, [result]);

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
// ---- DuckDuckGo Search Results ----
export function WebSearchResults({ result }: ResultProps) {
  const r = result as { output?: { results?: Array<{ title?: string; url?: string; description?: string; domain?: string; icon?: string }> } } | undefined;
  const results = r?.output?.results ?? [];
  if (results.length === 0) return <GenericToolResult result={result} />;
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
        <Globe className="h-3 w-3" /> {results.length} web results
      </div>
      {results.slice(0, 8).map((item, i) => (
        <a
          key={i}
          href={item.url}
          target="_blank"
          rel="noopener noreferrer"
          className="flex gap-2 rounded-lg border border-border p-2 hover:bg-accent transition-colors"
        >
          {item.icon && <img src={item.icon} alt="" className="h-4 w-4 shrink-0 rounded-sm mt-0.5" />}
          <div className="min-w-0 flex-1">
            <div className="text-xs font-medium text-foreground truncate">{item.title}</div>
            <div className="text-[10px] text-muted-foreground truncate">{item.domain}</div>
            {item.description && <div className="text-[10px] text-muted-foreground line-clamp-2 mt-0.5">{item.description}</div>}
          </div>
          <ExternalLink className="h-3 w-3 text-muted-foreground shrink-0 mt-0.5" />
        </a>
      ))}
    </div>
  );
}

export function ImageSearchResults({ result }: ResultProps) {
  const r = result as { output?: { results?: Array<{ title?: string; imageUrl?: string; thumbnail?: string; width?: number; height?: number; source?: string }> } } | undefined;
  const results = r?.output?.results ?? [];
  if (results.length === 0) return <GenericToolResult result={result} />;
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
        <ImageIcon className="h-3 w-3" /> {results.length} images
      </div>
      <div className="grid grid-cols-3 gap-1.5">
        {results.slice(0, 9).map((item, i) => (
          <a
            key={i}
            href={item.imageUrl || item.thumbnail}
            target="_blank"
            rel="noopener noreferrer"
            className="group relative aspect-square overflow-hidden rounded-lg border border-border"
          >
            <img
              src={item.imageUrl || item.thumbnail}
              alt={item.title}
              className="h-full w-full object-cover transition-transform group-hover:scale-105"
              loading="lazy"
            />
            <div className="absolute inset-0 bg-black/60 opacity-0 transition-opacity group-hover:opacity-100 flex items-end p-1">
              <span className="text-[9px] text-white line-clamp-2">{item.title}</span>
            </div>
          </a>
        ))}
      </div>
    </div>
  );
}

export function NewsSearchResults({ result }: ResultProps) {
  const r = result as { output?: { results?: Array<{ title?: string; url?: string; description?: string; domain?: string; date?: string }> } } | undefined;
  const results = r?.output?.results ?? [];
  if (results.length === 0) return <GenericToolResult result={result} />;
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
        <Newspaper className="h-3 w-3" /> {results.length} news articles
      </div>
      {results.slice(0, 6).map((item, i) => (
        <a
          key={i}
          href={item.url}
          target="_blank"
          rel="noopener noreferrer"
          className="block rounded-lg border border-border p-2 hover:bg-accent transition-colors"
        >
          <div className="text-xs font-medium text-foreground">{item.title}</div>
          {item.description && <div className="text-[10px] text-muted-foreground line-clamp-2 mt-0.5">{item.description}</div>}
          <div className="text-[10px] text-muted-foreground mt-0.5">{item.domain}{item.date ? ` · ${item.date}` : ""}</div>
        </a>
      ))}
    </div>
  );
}

export function VideoSearchResults({ result }: ResultProps) {
  const r = result as { output?: { results?: Array<{ title?: string; url?: string; imageUrl?: string; source?: string; date?: string; description?: string }> } } | undefined;
  const results = r?.output?.results ?? [];
  if (results.length === 0) return <GenericToolResult result={result} />;
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
        <Video className="h-3 w-3" /> {results.length} videos
      </div>
      {results.slice(0, 5).map((item, i) => (
        <a
          key={i}
          href={item.url}
          target="_blank"
          rel="noopener noreferrer"
          className="flex gap-2 rounded-lg border border-border p-2 hover:bg-accent transition-colors"
        >
          {item.imageUrl && (
            <div className="relative h-12 w-16 shrink-0 overflow-hidden rounded">
              <img src={item.imageUrl} alt="" className="h-full w-full object-cover" loading="lazy" />
              <div className="absolute inset-0 flex items-center justify-center bg-black/30">
                <Video className="h-4 w-4 text-white" />
              </div>
            </div>
          )}
          <div className="min-w-0 flex-1">
            <div className="text-xs font-medium text-foreground line-clamp-2">{item.title}</div>
            <div className="text-[10px] text-muted-foreground mt-0.5">{item.source}{item.date ? ` · ${item.date}` : ""}</div>
          </div>
        </a>
      ))}
    </div>
  );
}

export function MapSearchResults({ result }: ResultProps) {
  const r = result as { output?: { results?: Array<{ title?: string; url?: string; description?: string; domain?: string }>; map_url?: string } } | undefined;
  const results = r?.output?.results ?? [];
  const mapUrl = r?.output?.map_url;
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
        <MapPin className="h-3 w-3" /> {results.length} places
      </div>
      {mapUrl && (
        <a href={mapUrl} target="_blank" rel="noopener noreferrer" className="block rounded-lg border border-primary/30 bg-primary/5 p-2 text-center text-xs font-medium text-primary hover:bg-primary/10 transition-colors">
          View on DuckDuckGo Maps →
        </a>
      )}
      {results.slice(0, 5).map((item, i) => (
        <a
          key={i}
          href={item.url}
          target="_blank"
          rel="noopener noreferrer"
          className="flex gap-2 rounded-lg border border-border p-2 hover:bg-accent transition-colors"
        >
          <MapPin className="h-3 w-3 text-primary shrink-0 mt-0.5" />
          <div className="min-w-0 flex-1">
            <div className="text-xs font-medium text-foreground truncate">{item.title}</div>
            {item.description && <div className="text-[10px] text-muted-foreground line-clamp-1">{item.description}</div>}
          </div>
        </a>
      ))}
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
      return <GenericToolResult {...props} />;
    case "web_search":
      return <WebSearchResults {...props} />;
    case "image_search":
      return <ImageSearchResults {...props} />;
    case "news_search":
      return <NewsSearchResults {...props} />;
    case "video_search":
      return <VideoSearchResults {...props} />;
    case "map_search":
      return <MapSearchResults {...props} />;
    default:
      return <GenericToolResult {...props} />;
  }
}

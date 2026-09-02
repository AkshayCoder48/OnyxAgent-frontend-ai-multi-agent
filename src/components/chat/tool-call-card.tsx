"use client";
import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import type { ToolCall } from "@/types";
import {
  ArrowRight,
  Wrench,
  Check,
  Clock,
  Search,
  Globe,
  ChevronRight,
  Code2,
  Download,
  FileMinus,
  FilePlus,
  FileSearch,
  FolderOpen,
  FolderPlus,
  ListChecks,
  ListTodo,
  MessageCircleQuestion,
  Loader2,
  BarChart3,
  PenLine,
  Brain,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { ShimmerLabel, chipClass, CollapsePanel } from "@/components/assistant-ui/elements";
import { toolCaption } from "@/lib/agent-step-captions";
import { friendlySentence } from "@/lib/agent-friendly-steps";
import { useToolDisplayStore } from "@/stores/tool-display-store";
import { OrbCursor } from "@/components/assistant-ui/elements";
import { TodoPreview, parseTodoResult } from "./todo-preview";
import { ChartMessage, parseChartResult } from "./chart-message";
import { DateTimeResult } from "./tool-results/datetime";
import { RAGSearchResults } from "./tool-results/rag";
import { WebSearchResults, parseWebSearch } from "./tool-results/web-search";
import { LoadSkillResult, formatSkillName } from "./tool-results/skills";
import { AskUserResult } from "./tool-results/ask-user";
import { GenericToolResult, RawToolView, SimpleToolResult } from "./tool-results/generic";
import { RunPythonResult } from "./tool-results/run-python";
import { FileDownloadResult, parseFileDownloadResult } from "./tool-results/file-download";
import { EditFileDiff } from "./tool-results/edit-diff";
import { MemoryResult } from "./tool-results/memory";
import {
  FileCreatedCard,
  FileDeletedCard,
  FileMoveCard,
  FileReadCard,
  FolderCreatedCard,
  FolderListCard,
  PathVerifyCard,
  WebFetchCard,
} from "./tool-results/file-ops";
import { deriveEditDiff } from "@/lib/agent-tool-steps";
import {
  WebSearchResults as DDGWebResults,
  ImageSearchResults as DDGImageResults,
  VideoSearchResults as DDGVideoResults,
} from "./tool-results";

interface ToolCallCardProps {
  toolCall: ToolCall;
  /** Conversation id — used by the todo tools to read the LIVE todo store
   *  so TodoPreview statuses update in real time (PRD §7). */
  turnId?: string | null;
}

export function ToolCallCard({ toolCall, turnId }: ToolCallCardProps) {
  // Display mode — "simple" renders plain-language sentences with no tool
  // names, no code, and no raw output (for people who don't read code);
  // "technical" is the full detail view. The header sentence, the raw
  // toggle, and the body renderers all branch on this one preference.
  const displayMode = useToolDisplayStore((s) => s.mode);
  const isSimple = displayMode === "simple";

  // Collapsed by default — the bar acts as the toggle. `showRaw` swaps the
  // formatted view for args + raw output (the </> button — technical mode
  // only; the button is hidden in simple mode). Charts are the
  // exception: they're only useful when visible, so expand them by default.
  const isRunPython = toolCall.name === "run_python";
  // DDG search tools — detect and auto-expand
  const isDDGWebSearch = toolCall.name === "web_search" && toolCall.status === "completed";
  const isDDGImageSearch = toolCall.name === "image_search" && toolCall.status === "completed";
  const isDDGVideoSearch = toolCall.name === "video_search" && toolCall.status === "completed";
  const isAnyDDGSearch =
    isDDGWebSearch || isDDGImageSearch || isDDGVideoSearch;

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
      isAnyDDGSearch ||
      // edit_file: the CodeDiff is the payload — expand when it landed AND
      // the technical view is active (simple mode has no diff to show).
      (toolCall.name === "edit_file" &&
        toolCall.status === "completed" &&
        !isSimple &&
        deriveEditDiff(toolCall) !== null),
  );
  const [showRaw, setShowRaw] = useState(false);

  // Auto-expand while a long-running tool (run_terminal, run_python, etc.)
  // is in flight so the user can see the "Running…" body without having to
  // click. Collapse it again when the tool completes so the final view
  // matches the original "collapsed summary bar" default — but only if the
  // user hasn't manually expanded it in the meantime (which would override
  // the auto-collapse).
  //
  // Implemented with the render-time "adjust state when a prop changes"
  // pattern from the React docs instead of a useEffect + setState (which
  // triggers cascading renders and is flagged by the React Compiler lint).
  const isRunning = toolCall.status === "running" || toolCall.status === "pending";
  const [prevIsRunning, setPrevIsRunning] = useState(isRunning);
  if (isRunning !== prevIsRunning) {
    setPrevIsRunning(isRunning);
    // Auto-expand on running transition (idle → running).
    if (isRunning) {
      setExpanded(true);
    }
  }

  // Short input hint shown in the collapsed bar — the query for search
  // tools, the URL for fetch_url, etc. (any tool with a url/query arg).
  const urlArg = toolCall.args?.url;
  const queryArg = toolCall.args?.query;
  // Todo tools — chip shows the todo IDs involved (PRD §18: the primary
  // argument rides next to the label; the tool name stays visible).
  const isShowTodo = toolCall.name === "show_todo";
  const isManageTodo =
    toolCall.name === "manage_todo" || toolCall.name === "manage_todos";
  const todoHint = useMemo(() => {
    if (isShowTodo) {
      const ids =
        (Array.isArray(toolCall.args?.todo_ids) && toolCall.args.todo_ids) ||
        (Array.isArray(toolCall.args?.todoIds) && toolCall.args.todoIds) ||
        [];
      if (toolCall.args?.all === true || ids.length === 0) return "all";
      return ids.map((v) => String(v)).join(", ");
    }
    if (isManageTodo) {
      const argId = toolCall.args?.todo_id ?? toolCall.args?.id;
      if (typeof argId === "string" && argId) return argId;
      // create action → the new ID is in the result; surface it once settled.
      if (toolCall.status === "completed" && toolCall.result != null) {
        const parsed = parseTodoResult(toolCall.result);
        if (parsed?.todos.length) return parsed.todos[0]!.id;
      }
      const action = toolCall.args?.action;
      return typeof action === "string" ? action : null;
    }
    return null;
  }, [isShowTodo, isManageTodo, toolCall.args, toolCall.status, toolCall.result]);
  const inputHint =
    typeof urlArg === "string" ? urlArg : typeof queryArg === "string" ? queryArg : todoHint;

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
  // edit_file — the find/replace pair renders as a CodeDiff (assistant-ui
  // "Code diff" element) once the edit completes successfully.
  const isEditFile = toolCall.name === "edit_file";
  // Workspace file & web tools — each gets a parsed "nice UI" card
  // (tool-results/file-ops.tsx) built from the real result, in technical
  // display mode. Terminal/command tools are deliberately excluded: their
  // output is freeform, so they keep the live log view.
  const isCreateFile =
    toolCall.name === "create_file" ||
    toolCall.name === "write_file" ||
    toolCall.name === "create_file_chunk";
  const isReadFile =
    toolCall.name === "read_file" || toolCall.name === "read_file_section";
  const isVerifyPath = toolCall.name === "verify_path";
  const isListFolder =
    toolCall.name === "list_folder" ||
    toolCall.name === "list_files" ||
    toolCall.name === "list_workspace_files";
  const isDeleteFile =
    toolCall.name === "delete_file" || toolCall.name === "delete_folder";
  const isCreateFolder = toolCall.name === "create_folder";
  const isMoveFile =
    toolCall.name === "move_file" || toolCall.name === "rename_file";
  const isWebFetch = toolCall.name === "web_fetch" || toolCall.name === "fetch_url";
  const isFileOp =
    isCreateFile ||
    isReadFile ||
    isVerifyPath ||
    isListFolder ||
    isDeleteFile ||
    isCreateFolder ||
    isMoveFile ||
    isWebFetch;
  // Memory tools — the chips render via the MemoryChips element, with the
  // forget button deleting the real OPFS file the save tool wrote.
  const isMemorySave = toolCall.name === "memory_save";
  const isMemoryList = toolCall.name === "memory_list";
  const isMemorySearch = toolCall.name === "memory_search";
  const isMemoryTool = isMemorySave || isMemoryList || isMemorySearch;
  // show_todo / manage_todo specialized renderers (PRD §19) — the parsed
  // todos drive the TodoPreview table; memoized so streaming deltas don't
  // re-parse on every render.
  const parsedTodo = useMemo(
    () => (isShowTodo || isManageTodo) ? parseTodoResult(toolCall.result) : null,
    [isShowTodo, isManageTodo, toolCall.result],
  );
  const showTodoIds = useMemo(() => {
    if (!isShowTodo) return undefined;
    const ids =
      (Array.isArray(toolCall.args?.todo_ids) && toolCall.args.todo_ids) ||
      (Array.isArray(toolCall.args?.todoIds) && toolCall.args.todoIds) ||
      [];
    if (toolCall.args?.all === true || ids.length === 0) return undefined;
    return ids.map((v) => String(v));
  }, [isShowTodo, toolCall.args]);
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
  // The tool returns { success: true, output: { kind: "image_preview", url, alt } }
  // so the actual spec is at `.output`, not the top level.
  const imagePreviewSpec = useMemo(() => {
    if (toolCall.name !== "preview_image" || toolCall.status !== "completed") return null;
    const result = toolCall.result;
    if (!result) return null;

    // Helper to extract spec from a parsed object — handles both
    // { output: { kind, url } } (full ToolResult) and { kind, url } (bare spec)
    const extractSpec = (obj: Record<string, unknown>): { url: string; alt?: string; error?: string } | null => {
      // Case 1: full ToolResult wrapper { success, output: { kind, url } }
      const output = obj.output as Record<string, unknown> | undefined;
      if (output && typeof output === "object") {
        const url = String(output.url || "");
        if (url || output.error) {
          return { url, alt: output.alt as string | undefined, error: output.error as string | undefined };
        }
      }
      // Case 2: bare spec { kind, url }
      const url2 = String(obj.url || "");
      if (url2 || obj.error) {
        return { url: url2, alt: obj.alt as string | undefined, error: obj.error as string | undefined };
      }
      return null;
    };

    // If already an object, use directly.
    if (typeof result === "object") {
      return extractSpec(result as Record<string, unknown>);
    }
    // If a string, try JSON.parse.
    if (typeof result === "string") {
      try {
        const obj = JSON.parse(result) as Record<string, unknown>;
        const spec = extractSpec(obj);
        if (spec) return spec;
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
  // edit_file CodeDiff — memoized so streaming deltas don't re-derive the
  // find/replace lines on every render (the store swaps the toolCall object
  // immutably on every status/result change, so identity is the right dep).
  const editDiffSpec = useMemo(
    () =>
      isEditFile && toolCall.status === "completed"
        ? deriveEditDiff(toolCall)
        : null,
    [isEditFile, toolCall],
  );
  const isEditDiff = editDiffSpec !== null;
  // The parsed card for workspace file / web tools (technical mode only —
  // simple mode keeps its plain sentences). Memoized so streaming deltas
  // don't re-derive; each card component itself returns null when the call
  // didn't land or has nothing presentable, so the branch below also gates
  // on status and falls through to the generic renderer otherwise.
  const fileOpElement = useMemo(() => {
    if (isSimple || !isFileOp || toolCall.status !== "completed") return null;
    if (isCreateFile) return <FileCreatedCard toolCall={toolCall} />;
    if (isReadFile) return <FileReadCard toolCall={toolCall} />;
    if (isVerifyPath) return <PathVerifyCard toolCall={toolCall} />;
    if (isListFolder) return <FolderListCard toolCall={toolCall} />;
    if (isDeleteFile) return <FileDeletedCard toolCall={toolCall} />;
    if (isCreateFolder) return <FolderCreatedCard toolCall={toolCall} />;
    if (isMoveFile) return <FileMoveCard toolCall={toolCall} />;
    if (isWebFetch) return <WebFetchCard toolCall={toolCall} />;
    return null;
  }, [
    isSimple,
    isFileOp,
    isCreateFile,
    isReadFile,
    isVerifyPath,
    isListFolder,
    isDeleteFile,
    isCreateFolder,
    isMoveFile,
    isWebFetch,
    toolCall,
  ]);
  // A chart that finishes after this card mounted (live streaming) won't
  // have triggered the initial-state default — expand it on transition.
  // Same for file_download cards and the file-op payload cards (the card IS
  // the content, like the edit_file diff). Uses the same render-time
  // adjustment pattern as the running auto-expand above (no effect → no
  // cascading render).
  const [prevAutoExpand, setPrevAutoExpand] = useState(false);
  const autoExpand =
    isChart || isFileDownload || (isEditDiff && !isSimple) || fileOpElement !== null;
  if (autoExpand !== prevAutoExpand) {
    setPrevAutoExpand(autoExpand);
    if (autoExpand) setExpanded(true);
  }

  const hasSpecialRenderer =
    isDateTime || isRAGSearch || isWebSearch || isAskUser || isChart || isRunPython || isFileDownload || isAnyDDGSearch || isShowTodo || isManageTodo || isEditDiff || isMemoryTool || isFileOp;
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
            : isDDGVideoSearch
              ? "Video Search"
              : isChart
          ? "Chart"
          : isEditDiff
            ? "Edit File"
            : isMemorySave
              ? "Memory"
              : isMemoryList
                ? "Memories"
                : isMemorySearch
                  ? "Memory Search"
                  : isShowTodo
            ? "Show Todo"
            : isManageTodo
              ? "Manage Todo"
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
                  : isCreateFile
                    ? toolCall.name === "create_file"
                      ? "Create File"
                      : "Write File"
                    : isReadFile
                      ? "Read File"
                      : isVerifyPath
                        ? "Path Check"
                        : isListFolder
                          ? "Folder Contents"
                          : isDeleteFile
                            ? "Delete File"
                            : isCreateFolder
                              ? "Create Folder"
                              : isMoveFile
                                ? toolCall.name === "move_file"
                                  ? "Move File"
                                  : "Rename File"
                                : isWebFetch
                                  ? "Web Page"
                                  : toolCall.name === "run_python"
                    ? "Run Python"
                    : !toolCall.name || toolCall.name.startsWith("pending-")
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
          : isEditDiff
            ? PenLine
            : isMemoryTool
              ? Brain
              : isShowTodo
            ? ListChecks
            : isManageTodo
              ? ListTodo
              : isAskUser
                ? MessageCircleQuestion
                : isFileDownload
                  ? Download
                  : isRunPython
                    ? Code2
                    : isCreateFile
                      ? FilePlus
                      : isReadFile || isVerifyPath
                        ? FileSearch
                        : isListFolder
                          ? FolderOpen
                          : isDeleteFile
                            ? FileMinus
                            : isCreateFolder
                              ? FolderPlus
                              : isMoveFile
                                ? ArrowRight
                                : isWebFetch
                                  ? Globe
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
  // (Note: `isRunning` is declared up top so the auto-expand render-time adjustment can read it.)
  const isError = toolCall.status === "error";
  const liveCaption = toolCaption(toolCall.name);

  // Simple mode swaps the tool name for a plain sentence — "Searched the
  // web for “weather in Mumbai”" — with the friendly detail inline (normal
  // font, never the mono chip).
  const settledLabel = isSimple ? friendlySentence(toolCall) : friendlyName;

  return (
    /* assistant-ui "Tool call" element anatomy — SIMPLE TOOL NAME line, no
       card chrome: chevron · shimmering label (while running) · primary-arg
       chip · checkmark once settled, with the request/result tucked behind
       the disclosure. Tapping the line collapses / enlarges it. */
    <div
      data-slot="tool-call"
      className={cn(
        "step-card-in min-w-0 max-w-full overflow-visible",
        isError && "rounded-lg",
      )}
    >
      <button
        type="button"
        aria-expanded={expanded}
        onClick={toggleExpanded}
        className={cn(
          "flex min-h-7 w-full cursor-pointer items-center gap-2 rounded-lg px-1 py-1 text-left transition-colors hover:bg-accent/40",
          isError && "bg-destructive/[0.05] hover:bg-destructive/10",
        )}
      >
        {/* Disclosure chevron */}
        <ChevronRight
          className={cn(
            "text-muted-foreground h-3.5 w-3.5 shrink-0 transition-transform duration-200",
            expanded && "rotate-90",
          )}
          aria-hidden
        />

        {/* Simple tool name — a small muted glyph for recognition, then the
            label. NO icon box, NO card border: just the name on the line. */}
        {isRunning ? (
          <>
            <ToolIcon className="text-muted-foreground h-3.5 w-3.5 shrink-0" aria-hidden />
            <ShimmerLabel className="min-w-0 truncate text-sm font-medium text-foreground/90">
              {liveCaption}
            </ShimmerLabel>
          </>
        ) : (
          <>
            <ToolIcon
              className={cn(
                "h-3.5 w-3.5 shrink-0",
                hasSpecialRenderer ? "text-primary" : "text-muted-foreground",
              )}
              aria-hidden
            />
            <span className="text-foreground/90 min-w-0 truncate text-sm font-medium">
              {settledLabel}
            </span>
          </>
        )}
        {/* The mono argument chip is technical-mode only — simple mode
            carries the detail inside the sentence itself. */}
        {inputHint && !isRunning && !isSimple ? (
          <span className={cn(chipClass, "shrink truncate")}>{inputHint}</span>
        ) : null}

        {/* Right actions — settle state + raw toggle (technical mode only;
            simple mode never offers raw output). */}
        <span className="ml-auto flex shrink-0 items-center gap-0.5">
          {!isRunning && (
            <>
              {isError ? (
                <span className="text-destructive text-xs font-medium">Failed</span>
              ) : (
                <Check className="text-primary h-3.5 w-3.5" aria-label="Done" />
              )}
              {!isSimple && (
                <span
                  role="button"
                  tabIndex={0}
                  onClick={toggleRaw}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      e.stopPropagation();
                      toggleRaw(e as unknown as MouseEvent);
                    }
                  }}
                  title={showRaw ? "Show formatted view" : "Show details"}
                  aria-label={showRaw ? "Show formatted view" : "Show details"}
                  className={cn(
                    "text-muted-foreground hover:bg-foreground/10 hover:text-foreground inline-flex h-6 w-6 items-center justify-center rounded-md transition-colors",
                    showRaw && "text-primary",
                  )}
                >
                  <Code2 className="h-3.5 w-3.5" />
                </span>
              )}
            </>
          )}
        </span>
      </button>

      {/* INLINE TODO PLAN (show_todo): the todo list UI renders directly in
          the MAIN RESPONSE — always visible beneath the tool bar, never
          hidden inside the disclosure. Enlarging (expanding) the bar reveals
          the PARSED CODE (raw JSON) via the panel below. */}
      {isShowTodo && toolCall.status === "completed" && (
        <TodoPreview
          turnId={turnId ?? undefined}
          todoIds={showTodoIds}
          fallbackTodos={parsedTodo?.todos}
          className="px-1.5 sm:px-2"
        />
      )}

      {/* INLINE MEMORY CHIPS (memory_save / memory_list): what the agent
          now remembers renders directly in the MAIN RESPONSE — always
          visible beneath the tool bar, never hidden inside the disclosure
          (same placement rule as the todo preview). The forget button
          deletes the real OPFS file memory_save wrote. Enlarging the bar
          reveals the raw JSON via the panel below. */}
      {(isMemorySave || isMemoryList) && toolCall.status === "completed" && (
        <MemoryResult toolCall={toolCall} />
      )}

      {/* Disclosure panel — the request/result and every specialized
          renderer live behind the simple line. Height animates open/closed
          via the CollapsePanel grid trick. */}
      <CollapsePanel open={expanded}>
        <div className="px-1.5 pt-0.5 pb-2 sm:px-2">
          {showRaw ? (
            <RawToolView toolCall={toolCall} resultText={resultText} />
          ) : isRunning ? (
            // Simple mode: spinner + the plain-language caption only — no
            // arguments, no code, no live log tail. Technical mode keeps the
            // full running panel below.
            isSimple ? (
              <FriendlyRunningPanel caption={liveCaption} />
            ) : (
              // While the tool is still running, show a prominent "Running…"
              // panel regardless of the tool's specialized renderer — the
              // renderer branches below all gate on `status === "completed"` and
              // would otherwise render an empty body. The panel surfaces the
              // tool's command/args so the user can see exactly what's
              // executing (e.g. the shell command for `run_terminal`).
              <RunningToolPanel toolCall={toolCall} />
            )
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
          ) : toolCall.status === "completed" && isDDGVideoSearch ? (
            <DDGVideoResults result={toolCall.result} />
          ) : isAskUser ? (
            <AskUserResult args={toolCall.args} resultText={resultText} />
          ) : isRunPython ? (
            <RunPythonResult toolCall={toolCall} resultText={resultText} simple={isSimple} />
          ) : isShowTodo && toolCall.status === "completed" ? (
            // Enlarging the show_todo tool shows the PARSED CODE (raw JSON
            // request/result) — the todo LIST UI itself renders inline above
            // (outside this panel), always visible in the main response.
            // Simple mode already has the list UI — nothing more to show.
            isSimple ? null : <RawToolView toolCall={toolCall} resultText={resultText} />
          ) : isManageTodo && toolCall.status === "completed" && parsedTodo?.todos.length ? (
            // One-row preview of the affected todo (create/update) with its
            // live status.
            <TodoPreview
              turnId={turnId ?? undefined}
              todoIds={parsedTodo.todos.map((t) => t.id)}
              fallbackTodos={parsedTodo.todos}
            />
          ) : isEditDiff ? (
            // edit_file → the find/replace pair as a unified CodeDiff
            // (assistant-ui "Code diff" element) — tinted, gutter-marked,
            // line-staggered. Simple mode shows one reassuring sentence
            // instead: the header already said which file changed.
            isSimple ? (
              <p className="text-foreground/70 py-2 text-[13px] leading-relaxed">
                The file was updated.
              </p>
            ) : (
              <EditFileDiff toolCall={toolCall} />
            )
          ) : isMemorySearch && toolCall.status === "completed" ? (
            // memory_search → the matching memories as chips behind the
            // disclosure (search results can be many; not auto-shown).
            <MemoryResult toolCall={toolCall} />
          ) : fileOpElement ? (
            // Workspace file & web tools → the parsed "nice UI" cards
            // (FileCreatedCard / FileReadCard / FolderListCard / …) built
            // from the real result. Technical mode only — simple mode keeps
            // its plain sentences (the memo already returned null).
            fileOpElement
          ) : isLoadSkill ? (
            <LoadSkillResult resultText={resultText} status={toolCall.status} />
          ) : isListSkills ? null : isSimple ? (
            // Simple mode — plain language for every tool without a
            // specialized friendly renderer: no arguments, no JSON dumps.
            <SimpleToolResult toolCall={toolCall} resultText={resultText} />
          ) : (
            <GenericToolResult toolCall={toolCall} resultText={resultText} />
          )}
        </div>
      </CollapsePanel>
    </div>
  );
}

// ---------------------------------------------------------------------------
// FriendlyRunningPanel — the simple-mode running body: spinner + the
// plain-language caption. Deliberately shows NO arguments, NO code, and NO
// live log tail — non-coders watch the sentence, not the stream.
// ---------------------------------------------------------------------------

function FriendlyRunningPanel({ caption }: { caption: string }) {
  return (
    <div className="flex items-center gap-2.5 py-2" role="status" aria-live="polite">
      <Loader2 className="text-primary h-4 w-4 shrink-0 animate-spin" aria-hidden="true" />
      <span className="text-foreground/90 text-sm font-medium">{caption}</span>
      <span className="streaming-dots" aria-hidden="true">
        <span /> <span /> <span />
      </span>
    </div>
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
}: {
  toolCall: ToolCall;
}) {
  // Handle streaming args (when tool call is still being built by the LLM).
  // Show streaming args when the tool is pending (LLM composing) OR running
  // (tool executing but _streaming args haven't been replaced yet).
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
  const liveCaptionForPanel = toolCaption(toolCall.name);

  return (
    <div className="space-y-3 py-2">
      {/* Header — tool name + spinner */}
      <div className="flex items-center gap-2.5">
        <Loader2 className="text-primary h-4 w-4 shrink-0 animate-spin" aria-hidden="true" />
        <span className="text-foreground/90 text-sm font-medium">
          {liveCaptionForPanel}
        </span>
        <span className="streaming-dots" aria-hidden="true">
          <span /> <span /> <span />
        </span>
      </div>

      {/* Streaming args — keep visible while pending OR running.
          DON'T delete when the tool starts running — the user wants to see
          what command/code is being executed. Only hide if the final parsed
          args replace them (previewArg is shown instead). */}
      {streamingArgs && (
        <div className="bg-foreground/[0.03] rounded-lg border border-foreground/8 p-3">
          <div className="text-muted-foreground mb-1.5 text-[10px] font-medium tracking-wide uppercase">
            {toolCall.status === "pending" ? "Composing" : "Arguments"}
          </div>
          <StreamingArgsDisplay args={streamingArgs} />
        </div>
      )}
      {/* Show the final args when the tool is running AND streaming args
          are gone (replaced by parsed args). If streaming args still exist,
          they're shown above — don't duplicate. */}
      {!streamingArgs && previewArg && (
        <div className="bg-foreground/[0.03] rounded-lg border border-foreground/8 p-3">
          <div className="text-muted-foreground mb-1.5 text-[10px] font-medium tracking-wide uppercase">
            Arguments
          </div>
          <pre className="scrollbar-thin max-h-64 overflow-auto font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words">
            {previewArg}
          </pre>
        </div>
      )}
      {hasLiveOutput && (
        <div className="bg-foreground/[0.03] scrollbar-thin overflow-hidden rounded-lg border border-foreground/8">
          <div className="text-muted-foreground flex items-center justify-between border-b border-foreground/8 px-3 py-2 text-[10px] font-medium tracking-wide uppercase">
            <span className="flex items-center gap-1.5">
              <span className="bg-primary/70 inline-block h-1.5 w-1.5 animate-pulse rounded-full" />
              Live output
            </span>
            <span>
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
      {/* eslint-disable-next-line @next/next/no-img-element, jsx-a11y/no-noninteractive-element-interactions -- raw <img> for sandbox-generated data URLs; onError is a load-failure handler, not an interaction */}
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
      <OrbCursor variant="C2" size={12} />
    </pre>
  );
}

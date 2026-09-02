import type { LucideIcon } from "lucide-react";
import {
  BarChart3,
  Brain,
  Clock,
  FileMinus,
  FilePlus,
  FileSearch,
  FolderOpen,
  Globe,
  ListChecks,
  ListTodo,
  MessageCircleQuestion,
  PenLine,
  Search,
  Terminal,
  Wrench,
} from "lucide-react";
import type { ToolCall } from "@/types";
import type { TimelineStat, TimelineStep } from "@/components/assistant-ui/elements/tool-timeline";
import type { FileTreeNode } from "@/components/assistant-ui/elements/file-tree";
import type { DiffLine } from "@/components/assistant-ui/elements/code-diff";

/**
 * Shared derivation for the assistant-ui "tool use" elements —
 * `ToolTimeline`, `FileTree` and `CodeDiff` — turning a list of raw tool
 * calls into the shapes those props-driven components consume.
 *
 * Used by:
 *  - `CollapsibleToolGroup` (chat message flow): one ToolTimeline per
 *    consecutive group of tool calls, verbs/chips/stats derived here.
 *  - `TimelineDialog` (header zoomed view): the whole session as one trace.
 *  - `MessageItem`: the end-of-turn FileTree ("N files changed").
 *  - `ToolCallCard`: the `edit_file` CodeDiff.
 *
 * Dependency-free (only types + icons) — safe to import anywhere.
 */

// ---------------------------------------------------------------------------
// Verbs — one per tool name (past tense, assistant-ui recipe).
// ---------------------------------------------------------------------------

interface VerbRule {
  verb: string;
  icon: LucideIcon;
}

export const VERB_RULES: Record<string, VerbRule> = {
  read_file: { verb: "Read", icon: FileSearch },
  read_file_section: { verb: "Read", icon: FileSearch },
  verify_path: { verb: "Read", icon: FileSearch },
  web_search: { verb: "Searched", icon: Search },
  image_search: { verb: "Searched", icon: Search },
  video_search: { verb: "Searched", icon: Search },
  search_documents: { verb: "Searched", icon: Search },
  search_knowledge_base: { verb: "Searched", icon: Search },
  search_workspace: { verb: "Searched", icon: Search },
  run_terminal: { verb: "Ran", icon: Terminal },
  run_python: { verb: "Ran", icon: Terminal },
  edit_file: { verb: "Edited", icon: PenLine },
  create_file: { verb: "Created", icon: FilePlus },
  write_file: { verb: "Wrote", icon: FilePlus },
  create_file_chunk: { verb: "Wrote", icon: FilePlus },
  delete_file: { verb: "Deleted", icon: FileMinus },
  list_folder: { verb: "Listed", icon: FolderOpen },
  list_files: { verb: "Listed", icon: FolderOpen },
  list_workspace_files: { verb: "Listed", icon: FolderOpen },
  manage_todo: { verb: "Planned", icon: ListTodo },
  manage_todos: { verb: "Planned", icon: ListTodo },
  show_todo: { verb: "Listed", icon: ListChecks },
  web_fetch: { verb: "Fetched", icon: Globe },
  fetch_url: { verb: "Fetched", icon: Globe },
  create_chart: { verb: "Charted", icon: BarChart3 },
  ask_user: { verb: "Asked", icon: MessageCircleQuestion },
  // Memory + time (client-side tools — always available).
  memory_save: { verb: "Remembered", icon: Brain },
  memory_list: { verb: "Listed", icon: Brain },
  memory_search: { verb: "Recalled", icon: Brain },
  get_current_datetime: { verb: "Checked", icon: Clock },
  current_datetime: { verb: "Checked", icon: Clock },
};

/** Tools that change a file in the workspace (feed FileTree + timeline stats). */
export const FILE_TOOLS = new Set([
  "edit_file",
  "create_file",
  "write_file",
  "create_file_chunk",
  "delete_file",
]);

function humanize(name: string): string {
  const words = name.replace(/_tool$/, "").split("_").filter(Boolean);
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

/** The primary argument shown as a step's chip. */
export function toolChip(toolCall: ToolCall): string {
  const args = toolCall.args ?? {};
  const candidates = [
    "path",
    "file_path",
    "command",
    "query",
    "url",
    "todo_id",
    "content",
    "prompt",
    "title",
  ];
  for (const key of candidates) {
    const v = args[key];
    if (typeof v === "string" && v.trim()) {
      // Truncate long values so chips never blow the layout (PRD §27).
      return v.length > 42 ? `${v.slice(0, 39)}…` : v;
    }
  }
  // show_todo → the requested IDs (or "all").
  if (toolCall.name === "show_todo") {
    const ids =
      (Array.isArray(args.todo_ids) && args.todo_ids) ||
      (Array.isArray(args.todoIds) && args.todoIds) ||
      [];
    return ids.length ? ids.map(String).join(", ") : "all todos";
  }
  if (typeof args.action === "string") return args.action;
  return toolCall.name;
}

/** Best-effort object view of a tool result (handles JSON-string results). */
function asObject(result: unknown): Record<string, unknown> | null {
  if (result == null) return null;
  if (typeof result === "object") return result as Record<string, unknown>;
  if (typeof result === "string") {
    try {
      const parsed = JSON.parse(result);
      return typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** File path a tool touched, or null. */
function touchedFile(toolCall: ToolCall): string | null {
  const args = toolCall.args ?? {};
  const file =
    (typeof args.path === "string" && args.path) ||
    (typeof args.file_path === "string" && args.file_path) ||
    null;
  return file && file.trim() ? file : null;
}

/** Shorten a path for chip display (keep the tail — filenames matter most). */
function shortPath(file: string, max = 28): string {
  return file.length > max ? `…${file.slice(-(max - 2))}` : file;
}

/** True when a tool call finished successfully (no error, not in flight). */
function landed(toolCall: ToolCall): boolean {
  if (toolCall.status !== "completed") return false;
  const parsed = asObject(toolCall.result);
  if (parsed && parsed.error !== undefined) return false;
  return true;
}

/** File-change stat for file-affecting tools, with counts when derivable. */
export function fileStat(toolCall: ToolCall): TimelineStat | null {
  if (!FILE_TOOLS.has(toolCall.name)) return null;
  // Only LANDED changes count — a failed write never touched the file, and
  // the UI must never claim a state the app hasn't reached.
  if (!landed(toolCall)) return null;
  const file = touchedFile(toolCall);
  if (!file) return null;
  let added: number | undefined;
  let removed: number | undefined;
  if (toolCall.name === "edit_file") {
    const args = toolCall.args ?? {};
    const find = typeof args.find === "string" ? args.find : "";
    const replace = typeof args.replace === "string" ? args.replace : "";
    if (find) removed = countLines(find);
    if (replace) added = countLines(replace);
    // Only report counts when the edit actually landed (replacements > 0).
    const parsed = asObject(toolCall.result);
    const reps =
      typeof parsed?.replacements === "number" ? parsed.replacements : undefined;
    if (parsed && reps === 0) {
      added = undefined;
      removed = undefined;
    }
  } else if (
    toolCall.name === "create_file" ||
    toolCall.name === "write_file" ||
    toolCall.name === "create_file_chunk"
  ) {
    const args = toolCall.args ?? {};
    const content = typeof args.content === "string" ? args.content : "";
    if (content) added = countLines(content);
  }
  return { file: shortPath(file), added, removed };
}

/** Line count that doesn't count the phantom line after a trailing newline. */
function countLines(text: string): number {
  if (!text) return 0;
  return text.replace(/\n$/, "").split("\n").length;
}

// ---------------------------------------------------------------------------
// ToolTimeline derivation.
// ---------------------------------------------------------------------------

export interface TimelineDerivation {
  steps: TimelineStep[];
  stats: TimelineStat[];
  filesChanged: number;
}

/**
 * Turn a list of tool calls into the ToolTimeline props: one step (verb,
 * chip, icon) per call, plus aggregated file-change stats.
 */
export function deriveTimeline(toolCalls: readonly ToolCall[]): TimelineDerivation {
  const steps: TimelineStep[] = [];
  const stats = new Map<string, TimelineStat>();
  for (const tc of toolCalls) {
    if (!tc || !tc.name || tc.name.startsWith("pending-")) continue;
    const rule = VERB_RULES[tc.name] ?? { verb: humanize(tc.name), icon: Wrench };
    steps.push({ verb: rule.verb, chip: toolChip(tc), icon: rule.icon });
    const stat = fileStat(tc);
    if (stat) {
      const prev = stats.get(stat.file);
      stats.set(stat.file, {
        file: stat.file,
        added: (prev?.added ?? 0) + (stat.added ?? 0) || undefined,
        removed: (prev?.removed ?? 0) + (stat.removed ?? 0) || undefined,
      });
    }
  }
  return { steps, stats: [...stats.values()], filesChanged: stats.size };
}

// ---------------------------------------------------------------------------
// FileTree derivation — "everything a run touched, as a tree".
// ---------------------------------------------------------------------------

export interface FileTreeDerivation {
  nodes: FileTreeNode[];
  totalAdditions: number;
  totalDeletions: number;
  /** Distinct files (kind: "file" rows) — folder headers never count. */
  fileCount: number;
}

/**
 * Build the FileTree row list from file-affecting tool calls.
 *
 * Every distinct touched file becomes one `kind: "file"` row (additions /
 * deletions aggregated across calls — e.g. a file written in 5 chunks sums
 * to one row). Each distinct parent folder becomes a static `kind:
 * "folder"` header row placed before its files, in first-touch order.
 * `depth` is assigned per node: a file's depth is its parent's segment
 * count; a folder's depth is (its own segment count − 1). Root files have
 * no folder header and depth 0.
 */
export function deriveFileTree(toolCalls: readonly ToolCall[]): FileTreeDerivation {
  // Aggregate per full path, in first-touch order.
  interface FileEntry {
    path: string;
    name: string;
    additions: number;
    deletions: number;
    hasCounts: boolean;
  }
  const files = new Map<string, FileEntry>();
  for (const tc of toolCalls) {
    if (!tc || !tc.name || !FILE_TOOLS.has(tc.name)) continue;
    // Only LANDED changes become tree rows — the tree answers "everything a
    // run TOUCHED", and a failed write touched nothing.
    if (!landed(tc)) continue;
    const path = touchedFile(tc);
    if (!path) continue;
    const name = path.split("/").pop() ?? path;
    let additions = 0;
    let deletions = 0;
    if (tc.name === "edit_file") {
      const args = tc.args ?? {};
      const find = typeof args.find === "string" ? args.find : "";
      const replace = typeof args.replace === "string" ? args.replace : "";
      const parsed = asObject(tc.result);
      const reps = typeof parsed?.replacements === "number" ? parsed.replacements : 1;
      if (parsed && reps === 0) continue; // edit didn't land — not a change
      if (find) deletions += countLines(find) * Math.max(1, reps);
      if (replace) additions += countLines(replace) * Math.max(1, reps);
    } else if (
      tc.name === "create_file" ||
      tc.name === "write_file" ||
      tc.name === "create_file_chunk"
    ) {
      const args = tc.args ?? {};
      const content = typeof args.content === "string" ? args.content : "";
      if (content) additions += countLines(content);
    } else if (tc.name === "delete_file") {
      // No line counts available — the file row itself is the signal.
    }
    const prev = files.get(path);
    if (prev) {
      prev.additions += additions;
      prev.deletions += deletions;
      prev.hasCounts = prev.hasCounts || additions > 0 || deletions > 0;
    } else {
      files.set(path, {
        path,
        name,
        additions,
        deletions,
        hasCounts: additions > 0 || deletions > 0,
      });
    }
  }

  // Group files by parent folder, folders in first-touch order.
  const folderOrder: string[] = [];
  const byFolder = new Map<string, FileEntry[]>();
  for (const [path, entry] of files) {
    const idx = path.lastIndexOf("/");
    const folder = idx === -1 ? "." : path.slice(0, idx);
    if (!byFolder.has(folder)) {
      byFolder.set(folder, []);
      folderOrder.push(folder);
    }
    byFolder.get(folder)!.push(entry);
  }

  const nodes: FileTreeNode[] = [];
  let totalAdditions = 0;
  let totalDeletions = 0;
  for (const folder of folderOrder) {
    if (folder !== ".") {
      const segments = folder.split("/");
      nodes.push({
        path: folder,
        name: folder,
        depth: segments.length - 1,
        kind: "folder",
      });
    }
    const fileDepth = folder === "." ? 0 : folder.split("/").length;
    for (const entry of byFolder.get(folder)!) {
      nodes.push({
        path: entry.path,
        name: entry.name,
        depth: fileDepth,
        kind: "file",
        // Omitted (not zero) when no counts were derivable — e.g. deletions
        // without line info (FileTree recipe: "omitted, not shown as zero").
        additions: entry.hasCounts && entry.additions > 0 ? entry.additions : undefined,
        deletions: entry.hasCounts && entry.deletions > 0 ? entry.deletions : undefined,
      });
      totalAdditions += entry.additions;
      totalDeletions += entry.deletions;
    }
  }

  return {
    nodes,
    totalAdditions,
    totalDeletions,
    fileCount: files.size,
  };
}

// ---------------------------------------------------------------------------
// CodeDiff derivation — an `edit_file` call's find/replace as a diff.
// ---------------------------------------------------------------------------

export interface EditDiff {
  filename: string;
  additions: number;
  deletions: number;
  lines: DiffLine[];
}

/** Cap the rendered diff body so huge replacements can't bloat the DOM. */
const MAX_DIFF_LINES = 300;

/**
 * Turn an `edit_file` tool call into CodeDiff props: the `find` string's
 * lines as removals and the `replace` string's lines as additions. Counts
 * in the header are the TRUE line counts; the body is capped at
 * MAX_DIFF_LINES rows with an explicit "… N more lines" marker row.
 * Returns null when the call isn't a completed, successful edit_file.
 */
export function deriveEditDiff(toolCall: ToolCall): EditDiff | null {
  if (toolCall.name !== "edit_file" || toolCall.status !== "completed") return null;
  const args = toolCall.args ?? {};
  const path = typeof args.path === "string" ? args.path : null;
  const find = typeof args.find === "string" ? args.find : null;
  const replace = typeof args.replace === "string" ? args.replace : null;
  if (!path || find === null || replace === null) return null;

  // The edit must have landed — a "substring not found" result is not a
  // change, and errors fall back to the raw view.
  const parsed = asObject(toolCall.result);
  if (parsed) {
    if (parsed.error !== undefined) return null;
    if (parsed.replacements === 0) return null;
  }

  const removedLines = find ? find.split("\n") : [];
  const addedLines = replace ? replace.split("\n") : [];
  // Cap the body: removals first, then additions, then an explicit marker.
  const cappedRemoved = removedLines.slice(0, MAX_DIFF_LINES);
  const remaining = Math.max(0, MAX_DIFF_LINES - cappedRemoved.length);
  const cappedAdded = addedLines.slice(0, remaining);
  const hidden =
    removedLines.length + addedLines.length - cappedRemoved.length - cappedAdded.length;
  const lines: DiffLine[] = [
    ...cappedRemoved.map((text) => ({ kind: "removed" as const, text })),
    ...cappedAdded.map((text) => ({ kind: "added" as const, text })),
  ];
  if (hidden > 0) {
    lines.push({ kind: "context", text: `… ${hidden} more line${hidden === 1 ? "" : "s"}` });
  }

  return {
    filename: path,
    additions: addedLines.length,
    deletions: removedLines.length,
    lines,
  };
}

// ---------------------------------------------------------------------------
// Elapsed clock — "0:04" style (m:ss) for AgentStatus.
// ---------------------------------------------------------------------------

/** Seconds → `m:ss` (the AgentStatus docs' elapsed format). */
export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

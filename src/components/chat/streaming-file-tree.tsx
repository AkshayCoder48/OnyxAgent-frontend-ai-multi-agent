"use client";

import * as React from "react";
import type { DeepPartial } from "@stream.ui/react";
import { Stream } from "@stream.ui/react";
import {
  ChevronRight,
  File,
  FileCode,
  FileMinus,
  FileText,
  Folder,
  FolderOpen,
  Image as ImageIcon,
  Settings,
  User,
} from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { FILE_TOOLS } from "@/lib/agent-tool-steps";
import type { ToolCall } from "@/types";

/**
 * StreamingFileTree — Beta V1.2 (streamui "Tree" recipe).
 *
 * When the agent creates/edits files, this card streams the workspace tree
 * LIVE: every file operation adds its node the moment the call arrives
 * (in-flight files show a "writing…" shimmer), folders expand with animated
 * height transitions + rotating chevrons, and the whole card wears a state
 * border — blue while the turn streams, green when it settles.
 *
 * Data: derived from the message's file tool calls (create_file, write_file,
 * create_file_chunk, edit_file, delete_file) — same source the end-of-turn
 * summary used, but computed DURING the turn so nodes pop in progressively.
 */

// ── Tree types (streamui schema shape + our status extension) ──────────────

export interface StreamingTreeNode {
  id: string;
  label: string;
  icon?: string;
  description?: string;
  /** "writing" while the tool call is in flight; "error" on failure;
   *  "deleted" for removals; absent = landed. */
  state?: "writing" | "error" | "deleted";
  children?: StreamingTreeNode[];
}

export interface StreamingTreeData {
  title?: string;
  nodes: StreamingTreeNode[];
}

// ── Icons ───────────────────────────────────────────────────────────────────

const iconMap: Record<string, React.ComponentType<{ className?: string }>> = {
  folder: Folder,
  "folder-open": FolderOpen,
  file: File,
  "file-code": FileCode,
  "file-text": FileText,
  "file-minus": FileMinus,
  image: ImageIcon,
  user: User,
  settings: Settings,
};

const CODE_EXTS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "rb", "go", "rs", "java",
  "kt", "swift", "c", "h", "cpp", "hpp", "cs", "php", "sh", "bash", "zsh",
  "sql", "html", "css", "scss", "vue", "svelte", "yaml", "yml", "toml", "json",
]);
const TEXT_EXTS = new Set(["md", "mdx", "txt", "rst", "log", "csv", "env", "gitignore", "lock"]);
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "svg", "webp", "ico", "bmp", "avif"]);

function iconForFile(name: string): string {
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  if (IMAGE_EXTS.has(ext)) return "image";
  if (CODE_EXTS.has(ext)) return "file-code";
  if (TEXT_EXTS.has(ext)) return "file-text";
  return "file";
}

function getIcon(iconName: string | undefined, isOpen: boolean, hasChildren: boolean): string {
  if (iconName && iconMap[iconName]) return iconName;
  if (hasChildren) return isOpen ? "folder-open" : "folder";
  return "file";
}

/** Renders a glyph by NAME (fixed component set — nothing is created during
 *  render, which keeps the React Compiler happy). */
function NodeGlyph({ name, className }: { name: string; className?: string }) {
  switch (name) {
    case "folder":
      return <Folder className={className} />;
    case "folder-open":
      return <FolderOpen className={className} />;
    case "file-code":
      return <FileCode className={className} />;
    case "file-text":
      return <FileText className={className} />;
    case "file-minus":
      return <FileMinus className={className} />;
    case "image":
      return <ImageIcon className={className} />;
    case "user":
      return <User className={className} />;
    case "settings":
      return <Settings className={className} />;
    default:
      return <File className={className} />;
  }
}

// ── Derivation: tool calls → nested tree ────────────────────────────────────

function countLines(s: string): number {
  if (!s) return 0;
  return s.replace(/\n+$/, "").split("\n").length;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  if (v == null) return null;
  let obj: unknown = v;
  // Tool results reach the store BOTH as objects (in-browser runtime
  // backfills `part.toolCall.result = result`) and as JSON strings (bg
  // replay / legacy persistence) — parse the string form too, or every
  // `{ error }` result would be invisible and failures would render as
  // successful creations.
  if (typeof v === "string") {
    const s = v.trim();
    if (!s.startsWith("{") && !s.startsWith("[")) return null;
    try {
      obj = JSON.parse(s);
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  return obj as Record<string, unknown>;
}

interface FileEntry {
  path: string;
  additions: number;
  deletions: number;
  /** The file is (or will soon be) in the workspace: a create/write/edit
   *  call landed, or one is in flight. Failed calls alone don't count —
   * "3 files created" must never describe three error results. */
  exists: boolean;
  /** The LATEST call's outcome, for display (latest wins: a retry after a
   *  failure recovers; a failed edit after a good create still flags). */
  lastState: "writing" | "error" | "deleted" | "done";
}

/** Build the nested tree from file-affecting tool calls — in-flight calls
 *  included (state "writing") so the tree streams as the agent works. */
export function deriveStreamingTree(
  toolCalls: readonly ToolCall[],
): { root: StreamingTreeNode[]; fileCount: number; totalAdditions: number; totalDeletions: number } {
  const files = new Map<string, FileEntry>();

  for (const tc of toolCalls) {
    if (!tc || !tc.name || !FILE_TOOLS.has(tc.name)) continue;
    const args = (tc.args ?? {}) as Record<string, unknown>;
    const path =
      (typeof args.path === "string" && args.path) ||
      (typeof args.file_path === "string" && args.file_path) ||
      null;
    if (!path || !path.trim()) continue;

    const isDelete = tc.name === "delete_file";
    // A call "lands" when it completed without an error payload. In-flight
    // calls are neither — they stream as "writing…".
    let landed = false;
    let inFlight = false;
    if (tc.status === "error") {
      // transport/execution failure
    } else if (tc.status !== "completed") {
      inFlight = true;
    } else {
      const parsed = asRecord(tc.result);
      const failed =
        (parsed !== null && typeof parsed.error === "string") ||
        (tc.name === "edit_file" &&
          parsed !== null &&
          typeof parsed.replacements === "number" &&
          parsed.replacements === 0);
      landed = !failed;
    }

    let additions = 0;
    let deletions = 0;
    if (isDelete) {
      // deletions carry no churn; a landed delete removes the file
    } else if (inFlight) {
      // churn is only counted once the call lands (content is final then)
    } else if (landed) {
      if (tc.name === "create_file" || tc.name === "write_file" || tc.name === "create_file_chunk") {
        additions = countLines(String(args.content ?? ""));
      } else if (tc.name === "edit_file") {
        deletions = countLines(String(args.find ?? ""));
        additions = countLines(String(args.replace ?? ""));
      }
    }

    const lastState: FileEntry["lastState"] = isDelete
      ? landed
        ? "deleted"
        : inFlight
          ? "writing"
          : "error"
      : inFlight
        ? "writing"
        : landed
          ? "done"
          : "error";

    const prev = files.get(path);
    if (prev) {
      // Latest call wins for state (retries recover, late failures flag);
      // churn accumulates; existence only ever grows, except a landed delete.
      prev.lastState = lastState;
      if (!isDelete && landed) prev.exists = true;
      if (isDelete && landed) prev.exists = false;
      prev.additions += additions;
      prev.deletions += deletions;
    } else {
      files.set(path, {
        path,
        additions,
        deletions,
        exists: !isDelete && (landed || inFlight),
        lastState,
      });
    }
  }

  // Build the nested structure, inserting in first-touch order.
  const root: StreamingTreeNode[] = [];
  const folderByPath = new Map<string, StreamingTreeNode>();
  let totalAdditions = 0;
  let totalDeletions = 0;
  let fileCount = 0;

  const ensureFolder = (folderPath: string): StreamingTreeNode[] => {
    if (!folderPath || folderPath === ".") return root;
    const existing = folderByPath.get(folderPath);
    if (existing) return existing.children!;
    const segments = folderPath.split("/");
    const name = segments[segments.length - 1]!;
    const parentPath = segments.slice(0, -1).join("/");
    const siblings = ensureFolder(parentPath);
    const node: StreamingTreeNode = {
      id: folderPath,
      label: name,
      icon: "folder",
      children: [],
    };
    siblings.push(node);
    folderByPath.set(folderPath, node);
    return node.children!;
  };

  for (const entry of files.values()) {
    // Only files that exist (or are being written) are part of the workspace
    // story — pure failures are told by their tool cards, not the tree, and
    // must not fake a "N files created" count.
    if (!entry.exists && entry.lastState !== "writing") continue;
    fileCount += 1;
    totalAdditions += entry.additions;
    totalDeletions += entry.deletions;
    const segments = entry.path.split("/");
    const name = segments[segments.length - 1]!;
    const parentPath = segments.slice(0, -1).join("/");
    const siblings = ensureFolder(parentPath);
    const description =
      entry.lastState === "writing"
        ? "writing…"
        : entry.lastState === "error"
          ? "failed"
          : entry.lastState === "deleted"
            ? "deleted"
            : entry.additions > 0 || entry.deletions > 0
              ? `+${entry.additions}${entry.deletions > 0 ? ` −${entry.deletions}` : ""}`
              : undefined;
    siblings.push({
      id: entry.path,
      label: name,
      icon: entry.lastState === "deleted" ? "file-minus" : iconForFile(name),
      description,
      state: entry.lastState === "done" ? undefined : entry.lastState,
    });
  }

  return { root, fileCount, totalAdditions, totalDeletions };
}

// ── Rendering ───────────────────────────────────────────────────────────────

function TreeNodeSkeleton({ depth }: { depth: number }) {
  return (
    <div className="flex items-center gap-2 py-1.5" style={{ paddingLeft: depth * 20 + 8 }}>
      <Skeleton className="h-4 w-4 rounded" />
      <Skeleton className="h-4 w-24" />
    </div>
  );
}

function NodeIcon({
  icon,
  isOpen,
  hasChildren,
  writing,
}: {
  icon?: string;
  isOpen: boolean;
  hasChildren: boolean;
  writing?: boolean;
}) {
  return (
    <NodeGlyph
      name={getIcon(icon, isOpen, hasChildren)}
      className={cn(
        "h-4 w-4 shrink-0",
        hasChildren ? "text-amber-500 dark:text-amber-400" : "text-muted-foreground",
        writing && "animate-pulse",
      )}
    />
  );
}

function TreeNode({
  node,
  depth,
}: {
  node: DeepPartial<StreamingTreeNode>;
  depth: number;
}) {
  const [isOpen, setIsOpen] = React.useState(true);
  const hasChildren = node.children && node.children.length > 0;
  const validChildren = React.useMemo(() => {
    const list = node.children ?? [];
    return list.filter(
      (child): child is DeepPartial<StreamingTreeNode> =>
        child !== null && child !== undefined && typeof child.label === "string",
    );
  }, [node.children]);
  const isComplete = node.id !== undefined && node.label !== undefined;
  if (!isComplete) {
    return <TreeNodeSkeleton depth={depth} />;
  }

  const stateClass =
    node.state === "writing"
      ? "text-foreground"
      : node.state === "error"
        ? "text-destructive/80"
        : node.state === "deleted"
          ? "text-muted-foreground/60 line-through"
          : "";

  const rowContent = (
    <>
      {hasChildren ? (
        <motion.span
          animate={{ rotate: isOpen ? 90 : 0 }}
          className="flex h-4 w-4 shrink-0 items-center justify-center"
        >
          <ChevronRight className="text-muted-foreground h-3.5 w-3.5" />
        </motion.span>
      ) : (
        <span className="h-4 w-4 shrink-0" aria-hidden />
      )}
      <NodeIcon icon={node.icon} isOpen={isOpen} hasChildren={Boolean(hasChildren)} writing={node.state === "writing"} />
      <span className={cn("truncate text-sm", stateClass)}>{node.label}</span>
      {node.description && (
        <span
          className={cn(
            "text-muted-foreground ml-2 truncate font-mono text-[10px] tabular-nums opacity-0 transition-opacity group-hover:opacity-100",
            // Keep in-flight descriptions always visible — the "writing…" state
            // is the live story of the stream.
            node.state === "writing" && "text-primary opacity-100",
            node.state === "error" && "text-destructive/80 opacity-100",
          )}
        >
          {node.description}
        </span>
      )}
    </>
  );

  return (
    <motion.div initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.2, ease: "easeOut" }}>
      {hasChildren ? (
        <button
          type="button"
          className="group relative flex w-full cursor-pointer items-center gap-1 rounded-md py-1 pr-2 text-left transition-colors hover:bg-muted/50"
          style={{ paddingLeft: depth * 20 + 8 }}
          onClick={() => setIsOpen(!isOpen)}
          aria-expanded={isOpen}
        >
          {rowContent}
        </button>
      ) : (
        <div
          className="group relative flex cursor-default items-center gap-1 rounded-md py-1 pr-2 transition-colors"
          style={{ paddingLeft: depth * 20 + 8 }}
        >
          {rowContent}
        </div>
      )}
      <AnimatePresence initial={false}>
        {isOpen && validChildren.length > 0 && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            style={{ overflow: "hidden" }}
          >
            {validChildren.map((child, index) => (
              <TreeNode key={child.id ?? index} node={child} depth={depth + 1} />
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

export function StreamingFileTree({
  nodes,
  fileCount,
  totalAdditions,
  totalDeletions,
  isStreaming,
  className,
}: {
  nodes: readonly StreamingTreeNode[];
  fileCount: number;
  totalAdditions: number;
  totalDeletions: number;
  /** True while the message is still streaming — blue border + skeleton row. */
  isStreaming?: boolean;
  className?: string;
}) {
  const data: DeepPartial<StreamingTreeData> | undefined = React.useMemo(
    () => ({ title: `${fileCount} file${fileCount === 1 ? "" : "s"} ${isStreaming ? "being created…" : "created"}`, nodes: [...nodes] }),
    [fileCount, isStreaming, nodes],
  );
  const isLoading = Boolean(isStreaming);

  const currentState = isLoading ? "streaming" : "complete";
  const borderColors = {
    streaming: "border-blue-500/50",
    complete: "border-green-500/50",
  } as const;

  const nodesList = data?.nodes;
  const validNodes = React.useMemo(() => {
    if (!nodesList) return [];
    return nodesList.filter(
      (node): node is DeepPartial<StreamingTreeNode> =>
        node !== null && node !== undefined && typeof node.label === "string",
    );
  }, [nodesList]);

  return (
    <Stream.Root data={data} isLoading={isLoading}>
      <Card
        className={cn(
          "w-full max-w-md transition-colors",
          borderColors[currentState],
          "bg-secondary/60",
          className,
        )}
      >
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm font-medium">
            <Stream.Field fallback={<Skeleton className="h-5 w-36" />}>
              {data?.title as string | undefined}
            </Stream.Field>
            {!isLoading && (totalAdditions > 0 || totalDeletions > 0) && (
              <span className="text-muted-foreground ml-auto font-mono text-[10px] tabular-nums">
                <span className="text-emerald-600 dark:text-emerald-400">+{totalAdditions}</span>
                {totalDeletions > 0 && <span className="text-destructive/80"> −{totalDeletions}</span>}
              </span>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="min-h-[36px]">
            {validNodes.map((node, index) => (
              <TreeNode key={node.id ?? index} node={node} depth={0} />
            ))}
            {isLoading && <TreeNodeSkeleton depth={0} />}
          </div>
        </CardContent>
      </Card>
    </Stream.Root>
  );
}

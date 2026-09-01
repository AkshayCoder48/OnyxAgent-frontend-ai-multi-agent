"use client";

import * as React from "react";
import { FileText, Folder } from "lucide-react";
import { cn } from "@/lib/utils";
import { DeltaChip, paperCardClass } from "./surfaces";

export interface FileTreeNode {
  /** Used only as the React key. */
  path: string;
  name: string;
  depth: number;
  kind: "folder" | "file";
  additions?: number;
  deletions?: number;
}

/**
 * FileTree — everything a run touched, as a tree, with churn spelled out
 * per file. A "N files changed" header with net totals, then one indented
 * row per node (assistant-ui `elements-file-tree` recipe, Terra retheme).
 */
export function FileTree({
  nodes,
  visibleCount,
  totalAdditions,
  totalDeletions,
  className,
  ...props
}: {
  nodes: readonly FileTreeNode[];
  visibleCount: number;
  totalAdditions: number;
  totalDeletions: number;
  className?: string;
} & Omit<React.ComponentPropsWithoutRef<"div">, "children">) {
  const shown = Math.max(0, Math.min(Math.floor(visibleCount) || 0, nodes.length));
  const fileCount = nodes.filter((n) => n.kind === "file").length;

  return (
    <div
      data-slot="file-tree"
      className={cn("max-w-md overflow-hidden", paperCardClass, className)}
      {...props}
    >
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <span className="text-xs font-medium text-foreground/85">
          {fileCount} file{fileCount === 1 ? "" : "s"} changed
        </span>
        <span className="ml-auto flex items-center gap-1.5">
          <DeltaChip value={totalAdditions} kind="added" />
          <DeltaChip value={totalDeletions} kind="removed" />
        </span>
      </div>
      <div className="py-1.5">
        {Array.from({ length: shown }, (_, i) => {
          const node = nodes[i]!;
          const Icon = node.kind === "folder" ? Folder : FileText;
          return (
            <div
              key={node.path}
              className="animate-[line-in_0.2s_ease-out_both] flex items-center gap-2 py-0.5 pr-3 text-sm"
              style={{ paddingLeft: `${node.depth * 0.85 + 0.75}rem` }}
            >
              <Icon
                className={cn(
                  "h-3.5 w-3.5 shrink-0",
                  node.kind === "folder" ? "text-primary" : "text-muted-foreground",
                )}
              />
              <span
                className={cn(
                  "min-w-0 flex-1 truncate",
                  node.kind === "folder"
                    ? "text-xs font-medium text-foreground/85"
                    : "font-mono text-[11px] text-foreground/75",
                )}
              >
                {node.name}
              </span>
              {node.additions !== undefined && <DeltaChip value={node.additions} kind="added" />}
              {node.deletions !== undefined && <DeltaChip value={node.deletions} kind="removed" />}
            </div>
          );
        })}
      </div>
    </div>
  );
}

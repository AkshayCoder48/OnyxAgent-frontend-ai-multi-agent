"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { TodoListBeta } from "@/components/chat/todo-list-beta";

export interface TodoItem {
  id: string;
  text: string;
  status: "pending" | "active" | "done";
  /** Optional nesting depth (0 = root). Rows indent by depth × 0.9rem. */
  depth?: number;
}

/**
 * TodoList — the agent's own working list, rewritten mid-run as it
 * discovers work.
 *
 * Beta V1.2: the checked-box/spinner recipe is replaced by the Cursor-style
 * To-do List (collapsible header, rolling done/total count, dashed / arrow /
 * check glyphs, growing strike line). Kept API-compatible with the previous
 * element — `items`, optional `revision` (shown as a subtle `rev` suffix in
 * the header) and `className` — so the ResearchPanel keeps working.
 */
export function TodoList({
  items,
  revision,
  className,
  ...props
}: {
  items: readonly TodoItem[];
  revision?: number;
  className?: string;
} & Omit<React.ComponentPropsWithoutRef<"div">, "children">) {
  const doneCount = items.filter((i) => i.status === "done").length;
  const anyActive = items.some((i) => i.status === "active");

  return (
    <div
      data-slot="todo-list"
      className={cn("max-w-md", className)}
      aria-label={`To-dos — ${doneCount}/${items.length} done`}
      {...props}
    >
      <TodoListBeta items={items} title="To-dos" />
      {typeof revision === "number" && (anyActive || items.length > 0) && (
        <div className="text-muted-foreground mt-1 px-2 font-mono text-[10px] tabular-nums">
          rev {revision}
        </div>
      )}
    </div>
  );
}

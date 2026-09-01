"use client";

import * as React from "react";
import { Check, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { paperCardClass } from "./surfaces";

export interface TodoItem {
  id: string;
  text: string;
  status: "pending" | "active" | "done";
  /** Optional nesting depth (0 = root). Rows indent by depth × 1.1rem —
   *  a backward-compatible extension for hierarchical agent plans; items
   *  without a depth render exactly per the reference anatomy. */
  depth?: number;
}

/**
 * TodoList — the agent's own working list, rewritten mid-run as it
 * discovers work: checked box for done, spinner for active, empty outlined
 * box for pending (assistant-ui `elements-todo-list` recipe, Terra retheme).
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

  return (
    <div
      data-slot="todo-list"
      className={cn("max-w-md gap-2 p-3", paperCardClass, "flex flex-col", className)}
      {...props}
    >
      <div className="flex items-center justify-between">
        <span className="font-mono text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
          Todos
        </span>
        <span className="font-mono text-[10px] tabular-nums text-foreground/70">
          {doneCount}/{items.length}
          {typeof revision === "number" ? ` · rev ${revision}` : ""}
        </span>
      </div>
      <ul className="space-y-1">
        {items.map((item) => (
          <li
            key={item.id}
            className="animate-[line-in_0.2s_ease-out_both] flex items-center gap-2.5 text-sm"
            style={
              item.depth
                ? { paddingLeft: `${item.depth * 1.1}rem` }
                : undefined
            }
          >
            {item.status === "done" ? (
              <span className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[4px] bg-primary text-primary-foreground">
                <Check className="h-2.5 w-2.5" strokeWidth={3} />
              </span>
            ) : item.status === "active" ? (
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" />
            ) : (
              <span className="h-3.5 w-3.5 shrink-0 rounded-[4px] border border-foreground/30" />
            )}
            <span
              className={cn(
                item.status === "done" && "text-muted-foreground line-through opacity-70",
                item.status === "active" && "text-foreground",
                item.status === "pending" && "text-foreground/60",
              )}
            >
              {item.text}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

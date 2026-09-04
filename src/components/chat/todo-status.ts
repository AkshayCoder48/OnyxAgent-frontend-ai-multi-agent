"use client";

import { Check, Circle, CircleX, Loader2 } from "lucide-react";
import type { TodoStatus } from "@/types";
import { TODO_STATUS_LABELS } from "@/types";
import { cn } from "@/lib/utils";

/** Status glyph map for the agent's todo statuses (chips / compact rows).
 *  The full todo card itself is the Beta V1.2 TodoListBeta component. */
export function todoStatusIcon(status: TodoStatus): {
  icon: typeof Check;
  className: string;
  label: string;
} {
  switch (status) {
    case "done":
      return { icon: Check, className: "text-emerald-600", label: TODO_STATUS_LABELS.done };
    case "in_progress":
      return { icon: Loader2, className: "text-primary animate-spin", label: TODO_STATUS_LABELS.in_progress };
    case "not_done":
      return { icon: CircleX, className: "text-destructive", label: TODO_STATUS_LABELS.not_done };
    default:
      return { icon: Circle, className: cn("text-muted-foreground/60"), label: TODO_STATUS_LABELS.not_planned };
  }
}

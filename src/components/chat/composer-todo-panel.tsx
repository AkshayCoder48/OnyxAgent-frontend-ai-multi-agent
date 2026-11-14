"use client";

import { useState } from "react";
import { ChevronDown, ListChecks } from "lucide-react";
import { cn } from "@/lib/utils";
import { persistTodos } from "@/lib/tools/todos";
import { useResearchStore } from "@/stores";
import type { Todo } from "@/types";

/**
 * COMPOSER TODO PANEL — the connected "Plan" dock (user-uploaded design).
 *
 * The live agent plan attaches DIRECTLY ABOVE the prompt box: a frosted
 * glass panel (the adaptive material tokens — never a hand-rolled glass)
 * that tucks under the composer with a negative margin so the two read as
 * ONE stack, exactly like the reference:
 *
 *   ┌─────────────────────────────┐
 *   │ ✓ Plan        2 of 5 done ⌄ │  ← this panel (z-1, border-b-0)
 *   │ ○ Sync repo…                 │
 *   │ ● Fix python output          │  ← scrollable (max-h, thin bar)
 *   ├─────────────────────────────┤
 *   │ Reply to OnyxAgent…      ↑  │  ← composer-dock (z-2, overlaps 14px)
 *   └─────────────────────────────┘
 *
 * Data: the agent Todo system (`manage_todo` / `todo_event` snapshots) —
 * the same `byTurn[turnId].agentTodos` bucket the inline TodoPreview
 * tables read, rehydrated from Dexie across refreshes. Rows are LIVE:
 * tapping one flips its status in the store + persists the snapshot.
 *
 * Settle contract (same as ToolStackGroup / "Thought for Ns"): the panel
 * auto-expands while any step is active and folds itself when the plan
 * completes; a manual toggle between transitions always wins.
 */
export function ComposerTodoPanel() {
  const currentTurnId = useResearchStore((s) => s.currentTurnId);
  const activeTurnId = currentTurnId ?? "default";
  const turn = useResearchStore((s) => s.byTurn[activeTurnId]);
  const setAgentTodos = useResearchStore((s) => s.setAgentTodos);
  const items: Todo[] = turn?.agentTodos ?? [];

  const total = items.length;
  const doneCount = items.filter((t) => t.status === "done").length;
  const anyActive = doneCount < total;

  // Auto-expand on activity, auto-fold on settle (render-time adjust —
  // no effect, no cascading renders; manual toggles in between persist).
  const [expanded, setExpanded] = useState(anyActive);
  const [prevActive, setPrevActive] = useState(anyActive);
  if (total > 0 && anyActive !== prevActive) {
    setPrevActive(anyActive);
    setExpanded(anyActive);
  }

  if (total === 0) return null; // no plan yet → no chrome above the composer

  const toggle = (id: string) => {
    const next = items.map((t) =>
      t.id === id
        ? {
            ...t,
            status: t.status === "done" ? ("not_planned" as const) : ("done" as const),
            updatedAt: Date.now(),
          }
        : t,
    );
    setAgentTodos(activeTurnId, next);
    if (activeTurnId !== "default") {
      void persistTodos(activeTurnId, next).catch(() => {
        /* IndexedDB unavailable — the store update already landed */
      });
    }
  };

  const onHeaderKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setExpanded((v) => !v);
    }
  };

  return (
    <section
      aria-label="Plan"
      className="mb-object-in relative z-[1] mx-auto mb-[-14px] w-[calc(100%-24px)] rounded-t-[19px] rounded-b-[14px] border border-b-0 pb-[14px] pt-[2px] sm:w-[calc(100%-32px)]"
      style={{
        backgroundColor: "var(--glass-frost-fill)",
        borderColor: "var(--glass-border)",
        backdropFilter: "var(--glass-blur-frost)",
        WebkitBackdropFilter: "var(--glass-blur-frost)",
        boxShadow: "var(--glass-shadow-1)",
      }}
    >
      {/* HEADER — whole row toggles; progress reads "N of M complete" */}
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
        onKeyDown={onHeaderKey}
        className="flex min-h-[46px] w-full items-center gap-2.5 px-4 text-left outline-none transition-colors hover:bg-foreground/[0.035] focus-visible:ring-2 focus-visible:ring-primary/40"
      >
        <ListChecks className="h-[18px] w-[18px] shrink-0 text-muted-foreground" />
        <span className="text-sm font-semibold tracking-tight text-foreground/90">Plan</span>
        <span className="ml-auto whitespace-nowrap text-xs text-muted-foreground">
          {doneCount} of {total} complete
        </span>
        <ChevronDown
          aria-hidden
          className={cn(
            "h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-300 [transition-timing-function:cubic-bezier(.2,.8,.2,1)] motion-reduce:transition-none",
            expanded && "rotate-180",
          )}
        />
      </button>

      {/* EXPANDABLE LIST — grid-rows 0fr→1fr height animation */}
      <div
        className={cn(
          "grid transition-[grid-template-rows] duration-300 [transition-timing-function:cubic-bezier(.2,.8,.2,1)] motion-reduce:transition-none",
          expanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
        )}
      >
        <div className="min-h-0 overflow-hidden">
          <ul className="scrollbar-thin max-h-[205px] list-none overflow-y-auto overscroll-contain px-3 pb-2">
            {items.map((item) => {
              const isDone = item.status === "done";
              const isActive = item.status === "in_progress";
              return (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => toggle(item.id)}
                    aria-pressed={isDone}
                    className="flex min-h-10 w-full items-center gap-2.5 rounded-lg px-2 py-1 text-left text-[13px] text-foreground/80 transition-colors hover:bg-foreground/[0.05]"
                  >
                    {/* STATUS CIRCLE — done: accent + check · active: pulsing
                        accent dot · pending: quiet hairline ring */}
                    <span
                      aria-hidden
                      className={cn(
                        "grid h-[17px] w-[17px] shrink-0 place-items-center rounded-full border-[1.5px] transition-colors duration-200",
                        isDone
                          ? "border-primary bg-primary"
                          : isActive
                            ? "border-primary/60"
                            : "border-muted-foreground/40",
                      )}
                    >
                      {isDone ? (
                        <svg viewBox="0 0 10 6" className="h-[6px] w-[9px] fill-none">
                          <path
                            d="M1 3l2.6 2.4L9 1"
                            stroke="var(--button-foreground, #fff)"
                            strokeWidth="1.6"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      ) : isActive ? (
                        <span className="h-[7px] w-[7px] animate-pulse rounded-full bg-primary [animation-duration:2s]" />
                      ) : null}
                    </span>
                    <span
                      className={cn(
                        "min-w-0 flex-1",
                        isDone && "text-muted-foreground/70 line-through",
                      )}
                    >
                      {item.title}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </section>
  );
}

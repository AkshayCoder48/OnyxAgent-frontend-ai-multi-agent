"use client";

import { useEffect, useState } from "react";
import { ChevronDown, ListChecks } from "lucide-react";
import { cn } from "@/lib/utils";
import { useResearchStore } from "@/stores";
import type { Todo } from "@/types";

/**
 * COMPOSER TODO PANEL — the connected "Todos" dock (user-uploaded design).
 *
 * The live todo list attaches DIRECTLY ABOVE the prompt box: a frosted
 * glass panel (the adaptive material tokens — never a hand-rolled glass)
 * that tucks under the composer with a negative margin so the two read as
 * ONE stack, exactly like the reference:
 *
 *   ┌─────────────────────────────┐
 *   │ ✓ Todos       2 of 5 done ⌄ │  ← this panel (z-1, border-b-0)
 *   │ ◐ Sync repo…                 │
 *   │ ◑ Fix python output          │  ← scrollable (max-h, thin bar)
 *   ├─────────────────────────────┤
 *   │ Reply to OnyxAgent…      ↑  │  ← composer-dock (z-2, overlaps 14px)
 *   └─────────────────────────────┘
 *
 * ONE data source (2026-11-14: "it's all todos, not a separate plan
 * thing"): the agent Todo system (`manage_todo` / `todo_event` snapshots)
 * — the same `byTurn[turnId].agentTodos` bucket the inline TodoPreview
 * tables read, rehydrated from Dexie across refreshes.
 *
 * AGENT-OWNED STATUSES (2026-11-14 directive: "remove manually ticking
 * option in todo — show a striped loading icon when the AI sets pending,
 * a tick when it sets completed"): rows are READ-ONLY — the agent flips
 * statuses through manage_todo. pending/not_planned → muted striped
 * spinner · in_progress → accent striped spinner · done → accent tick ·
 * not_done → destructive cross.
 *
 * VANISH ON CLEAR (2026-11-14 directive: clear_todo "clears from the ui
 * with a vanish animation, motion blur"): when the list transitions
 * non-empty → empty (clear_todo, manage_todo clear, or every todo
 * deleted), the panel plays `.mb-object-out` — the motion-blur vanish —
 * on a frozen snapshot of the last state, then unmounts.
 *
 * Settle contract (same as ToolStackGroup / "Thought for Ns"): the panel
 * auto-expands while any step is active and folds itself when the list
 * completes; a manual toggle between transitions always wins.
 */

/** The vanish exit duration — matches .mb-object-out's default 300ms. */
const VANISH_MS = 320;

/**
 * STABLE EMPTY LIST (the 2026-11-14 production crash, minified React #301 /
 * dev "Too many re-renders"): `turn?.agentTodos ?? []` allocates a NEW
 * array every render while the turn bucket is absent (the mobile chat loads
 * before any todo exists), so the render-time `items !== prevItems`
 * comparison never converged and the panel re-render looped until React
 * threw — mobile only, because the dock mounts just there. One shared
 * frozen reference lets the comparison settle on the first render.
 */
const NO_TODOS: Todo[] = Object.seal([]) as Todo[];

export function ComposerTodoPanel() {
  const currentTurnId = useResearchStore((s) => s.currentTurnId);
  const activeTurnId = currentTurnId ?? "default";
  const turn = useResearchStore((s) => s.byTurn[activeTurnId]);
  const items: Todo[] = turn?.agentTodos ?? NO_TODOS;

  const total = items.length;
  const doneCount = items.filter((t) => t.status === "done").length;
  const anyActive = doneCount < total;

  // ── VANISH SNAPSHOT — freeze the last non-empty state when the list is
  // cleared, play .mb-object-out on it, then unmount (render-time adjust
  // pattern, same as the expand/collapse state below — no effect needed
  // for the transition itself; one timeout effect settles the snapshot).
  const [vanishing, setVanishing] = useState<Todo[] | null>(null);
  const [prevItems, setPrevItems] = useState<Todo[]>(items);
  if (items !== prevItems) {
    setPrevItems(items);
    if (items.length === 0 && prevItems.length > 0) {
      setVanishing(prevItems);
    }
  }
  useEffect(() => {
    if (!vanishing) return;
    const t = window.setTimeout(() => setVanishing(null), VANISH_MS);
    return () => window.clearTimeout(t);
  }, [vanishing]);

  // Auto-expand on activity, auto-fold on settle (render-time adjust —
  // no effect, no cascading renders; manual toggles in between persist).
  const [expanded, setExpanded] = useState(anyActive);
  const [prevActive, setPrevActive] = useState(anyActive);
  if (total > 0 && anyActive !== prevActive) {
    setPrevActive(anyActive);
    setExpanded(anyActive);
  }

  // No todos and nothing vanishing → no chrome above the composer.
  if (total === 0 && !vanishing) return null;

  // While vanishing, render the frozen snapshot with the exit class.
  const isVanishing = total === 0 && vanishing !== null;
  const shown = isVanishing ? vanishing! : items;
  const shownTotal = shown.length;
  const shownDone = shown.filter((t) => t.status === "done").length;

  const onHeaderKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setExpanded((v) => !v);
    }
  };

  return (
    <section
      aria-label="Todos"
      aria-hidden={isVanishing || undefined}
      className={cn(
        "mb-object-in relative z-[1] mx-auto mb-[-14px] w-[calc(100%-24px)] rounded-t-[19px] rounded-b-[14px] border border-b-0 pb-[14px] pt-[2px] sm:w-[calc(100%-32px)]",
        isVanishing && "mb-object-out",
      )}
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
        <span className="text-sm font-semibold tracking-tight text-foreground/90">Todos</span>
        <span className="ml-auto whitespace-nowrap text-xs text-muted-foreground">
          {shownDone} of {shownTotal} complete
        </span>
        <ChevronDown
          aria-hidden
          className={cn(
            "h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-300 [transition-timing-function:cubic-bezier(.2,.8,.2,1)] motion-reduce:transition-none",
            expanded && "rotate-180",
          )}
        />
      </button>

      {/* EXPANDABLE LIST — grid-rows 0fr→1fr height animation. Rows are
          READ-ONLY status readouts (the agent owns the statuses). */}
      <div
        className={cn(
          "grid transition-[grid-template-rows] duration-300 [transition-timing-function:cubic-bezier(.2,.8,.2,1)] motion-reduce:transition-none",
          expanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
        )}
      >
        <div className="min-h-0 overflow-hidden">
          <ul className="scrollbar-thin max-h-[205px] list-none overflow-y-auto overscroll-contain px-3 pb-2">
            {shown.map((item) => {
              const isDone = item.status === "done";
              const isActive = item.status === "in_progress";
              const isFailed = item.status === "not_done";
              return (
                <li
                  key={item.id}
                  className="flex min-h-10 w-full items-center gap-2.5 rounded-lg px-2 py-1 text-left text-[13px] text-foreground/80"
                >
                  {/* STATUS GLYPH — done: accent tick · in_progress: accent
                      striped spinner · pending: muted striped spinner ·
                      not_done: destructive cross. Agent-driven only. */}
                  <span
                    aria-hidden
                    className={cn(
                      "grid h-[17px] w-[17px] shrink-0 place-items-center rounded-full border-[1.5px] transition-colors duration-200",
                      isDone
                        ? "border-primary bg-primary"
                        : isActive
                          ? "border-primary/60"
                          : isFailed
                            ? "border-destructive/50"
                            : "border-muted-foreground/30",
                    )}
                  >
                    {isDone ? (
                      <svg viewBox="0 0 10 6" className="h-[6px] w-[9px] fill-none" data-glyph="done">
                        <path
                          d="M1 3l2.6 2.4L9 1"
                          stroke="var(--button-foreground, #fff)"
                          strokeWidth="1.6"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    ) : isFailed ? (
                      <svg viewBox="0 0 10 10" className="h-[7px] w-[7px] fill-none" data-glyph="failed">
                        <path
                          d="M2 2l6 6M8 2l-6 6"
                          stroke="var(--color-destructive, #e5484d)"
                          strokeWidth="1.6"
                          strokeLinecap="round"
                        />
                      </svg>
                    ) : (
                      <span
                        role="img"
                        aria-label={isActive ? "In progress" : "Pending"}
                        className="striped-spinner block"
                        data-accent={isActive || undefined}
                        style={{ width: 10, height: 10 }}
                      />
                    )}
                  </span>
                  <span
                    className={cn(
                      "min-w-0 flex-1",
                      isDone && "text-muted-foreground/70 line-through",
                      isFailed && "text-muted-foreground/80",
                    )}
                  >
                    {item.title}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </section>
  );
}

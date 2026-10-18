"use client";

/**
 * ProjectEmptyState (Task 1-b, PRD §5) — the project workspace's OWN welcome
 * screen, deliberately unlike the generic chat empty state:
 *
 *   - the PersonalityOrb inside a ring tinted with the project's accent
 *     (identity, not decoration),
 *   - the project name as the H1 + a goal-derived welcome line + the goal
 *     itself (no fabricated statistics — PRD §5 "no fake activity"),
 *   - three suggested-start chips derived from the goal that POPULATE the
 *     REAL composer below (never auto-send),
 *   - Chat History (the project drawer) + Project settings shortcuts.
 *
 * The composer itself is the ChatContainer's real one — this component lives
 * in the same slot ChatEmptyState occupies, above it.
 *
 * Motion: one subtle ≤300ms fade/rise on mount; `prefers-reduced-motion`
 * renders everything static (framer-motion's useReducedMotion).
 */

import { useMemo, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { ArrowUpRight, History, Settings2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { PersonalityOrb } from "@/components/assistant-ui/elements";
import { cn } from "@/lib/utils";
import { useProjectsStore } from "@/lib/projects/store";
import type { Project } from "@/types";
import {
  accentAlpha,
  normalizeAccent,
  deriveProjectSuggestions,
  deriveProjectWelcome,
  populateComposer,
} from "./project-identity";
import { CreateProjectDialog } from "./create-project-dialog";

export interface ProjectEmptyStateProps {
  project: Project;
}

export function ProjectEmptyState({ project }: ProjectEmptyStateProps) {
  const reduceMotion = useReducedMotion();
  const setHistoryDrawerOpen = useProjectsStore((s) => s.setHistoryDrawerOpen);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const accent = normalizeAccent(project.accent_color);
  const suggestions = useMemo(
    () => deriveProjectSuggestions(project.goal),
    [project.goal],
  );
  const welcome = useMemo(() => deriveProjectWelcome(project.goal), [project.goal]);

  // ≤300ms settle; reduced-motion → no transform/opacity animation at all.
  const entrance = reduceMotion
    ? {}
    : {
        initial: { opacity: 0, y: 10 },
        animate: { opacity: 1, y: 0 },
        transition: { duration: 0.28, ease: [0.32, 0.72, 0, 1] as const },
      };

  return (
    /* Same mobile-safe scroller + m-auto centering as the chat empty state:
       centers when it fits, scrolls from the top when it doesn't. */
    <div
      className="scrollbar-thin mx-auto h-full w-full max-w-2xl overflow-y-auto px-3 py-4 sm:px-4 sm:py-8"
      data-project-empty-state={project.id}
    >
      <motion.div
        {...entrance}
        className="m-auto flex w-full flex-col items-center"
      >
        {/* Identity: the personality orb in an accent-tinted ring. */}
        <span
          aria-hidden
          className="flex items-center justify-center rounded-full border p-2.5"
          style={{
            borderColor: accentAlpha(accent, 0.45),
            backgroundColor: accentAlpha(accent, 0.08),
            boxShadow: `0 0 0 4px ${accentAlpha(accent, 0.06)}`,
          }}
        >
          <PersonalityOrb size={40} />
        </span>

        <h1 className="mt-3 max-w-md text-center text-xl font-bold tracking-tight sm:text-2xl">
          {project.name}
        </h1>
        <p className="mt-1.5 max-w-md text-center text-xs leading-relaxed text-muted-foreground sm:text-sm">
          {welcome}
        </p>

        {/* The goal itself — honest, clipped to two lines. */}
        {project.goal && (
          <p
            className="mt-2.5 max-w-md rounded-xl border px-3.5 py-2 text-center text-xs leading-relaxed sm:text-[13px]"
            style={{
              borderColor: accentAlpha(accent, 0.25),
              backgroundColor: accentAlpha(accent, 0.05),
            }}
          >
            <span className="mr-1.5 font-mono text-[10px] font-medium uppercase tracking-[0.14em]" style={{ color: accent }}>
              Goal
            </span>
            <span className="text-foreground/80 line-clamp-2">{project.goal}</span>
          </p>
        )}

        {/* Suggested starts — POPULATE the real composer, never auto-send. */}
        <div className="mt-4 grid w-full max-w-lg grid-cols-1 gap-2 sm:grid-cols-3">
          {suggestions.map((text) => (
            <button
              key={text}
              type="button"
              onClick={() => populateComposer(text)}
              className={cn(
                "glass-card hover-lift ripple-tap group flex min-h-[44px] items-center gap-2 rounded-xl border border-border px-3 py-2 text-left",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              )}
              style={{ borderColor: accentAlpha(accent, 0.22) }}
              aria-label={`Start with: ${text}`}
            >
              <span className="min-w-0 flex-1 text-xs leading-snug">{text}</span>
              <ArrowUpRight
                className="h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 motion-reduce:transition-none"
                aria-hidden
              />
            </button>
          ))}
        </div>

        {/* Chat history + project settings shortcuts. */}
        <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setHistoryDrawerOpen(true)}
            className="h-9 rounded-xl gap-1.5 text-xs"
            style={{ borderColor: accentAlpha(accent, 0.35) }}
          >
            <History className="h-3.5 w-3.5" aria-hidden />
            Chat History
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setSettingsOpen(true)}
            className="h-9 rounded-xl gap-1.5 text-xs"
          >
            <Settings2 className="h-3.5 w-3.5" aria-hidden />
            Project settings
          </Button>
        </div>
      </motion.div>

      {/* Settings shortcut opens the SAME create/edit dialog (edit mode). */}
      <CreateProjectDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        project={project}
      />
    </div>
  );
}

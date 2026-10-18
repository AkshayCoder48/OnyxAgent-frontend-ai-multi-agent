"use client";

/**
 * ProjectChrome (Task 1-b, PRD §6.2) — the persistent project identity bar
 * rendered above the chat column whenever a project workspace is open
 * (`useProjectsStore.activeProjectId`):
 *
 *   - the project's icon + name (accent-tinted, PRD §4.6 identity),
 *   - a real activity dot — lit while ANY running execution belongs to one of
 *     the project's conversations (live from the execution hub, not a timer),
 *   - Chat History (the project drawer), Project settings (the edit dialog),
 *     and Back to general (leaves project context cleanly).
 *
 * Height ≤48px, mobile-safe: the name truncates, buttons are 40px icon
 * targets, and the bar respects the safe-area inset at the bottom of notched
 * phones only when it is the last element (it never is — the composer is).
 */

import { useMemo, useState } from "react";
import { ArrowLeft, History, Settings2 } from "lucide-react";
import { motion, useReducedMotion } from "framer-motion";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useProjectsStore } from "@/lib/projects/store";
import { useRunningExecutions } from "@/lib/agent/execution-hub";
import { accentAlpha, normalizeAccent, ProjectGlyph } from "./project-identity";
import { useProjectConversations, resetToNewChatState } from "./project-conversations";
import { CreateProjectDialog } from "./create-project-dialog";
import type { Project } from "@/types";

export function ProjectChrome({ project }: { project: Project }) {
  const closeProject = useProjectsStore((s) => s.closeProject);
  const setHistoryDrawerOpen = useProjectsStore((s) => s.setHistoryDrawerOpen);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // REAL activity: a running execution whose conversation belongs to this
  // project. (RunningExecutionsSection in the sidebar uses the same source.)
  const running = useRunningExecutions();
  const { conversations } = useProjectConversations(project.id);
  const projectActive = useMemo(() => {
    if (running.length === 0) return false;
    const ids = new Set(conversations.map((c) => c.id));
    return running.some((e) => e.conversationId != null && ids.has(e.conversationId));
  }, [running, conversations]);

  const accent = normalizeAccent(project.accent_color);
  const reduceMotion = useReducedMotion();

  const handleBackToGeneral = () => {
    closeProject();
    resetToNewChatState();
  };

  return (
    <motion.div
      initial={reduceMotion ? false : { opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, ease: [0.32, 0.72, 0, 1] }}
      role="region"
      aria-label={`Project workspace: ${project.name}`}
      data-project-chrome={project.id}
      className="flex h-11 min-h-11 shrink-0 items-center gap-1.5 border-b px-2 sm:px-3"
      style={{
        borderColor: accentAlpha(accent, 0.3),
        backgroundColor: accentAlpha(accent, 0.05),
      }}
    >
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={handleBackToGeneral}
        className="text-muted-foreground hover:text-foreground h-10 w-10 shrink-0 rounded-xl p-0"
        title="Back to general chats"
        aria-label="Back to general chats"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden />
      </Button>

      <ProjectGlyph iconKey={project.icon} accent={project.accent_color} size={24} className="shrink-0" />

      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        <span className="truncate text-[13px] font-semibold sm:text-sm">{project.name}</span>
        {/* Live activity indicator (PRD §3.2) — only while work runs. */}
        <span
          className={cn("flex items-center gap-1 text-[10px] font-medium", !projectActive && "sr-only")}
          style={{ color: accent }}
          role="status"
          aria-label={projectActive ? "Agent working in this project" : undefined}
        >
          <span
            aria-hidden
            className={cn(
              "inline-block h-2 w-2 rounded-full",
              projectActive && !reduceMotion && "animate-pulse",
            )}
            style={{ backgroundColor: accent }}
          />
          {projectActive && <span className="hidden sm:inline">active</span>}
        </span>
      </div>

      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => setHistoryDrawerOpen(true)}
        className="h-10 shrink-0 gap-1.5 rounded-xl px-2.5 text-xs sm:px-3"
        style={{ color: accent }}
        title="Project chat history"
        aria-label={`Open ${project.name} chat history`}
        aria-expanded={false}
      >
        <History className="h-4 w-4" aria-hidden />
        <span className="hidden sm:inline">Chat History</span>
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => setSettingsOpen(true)}
        className="text-muted-foreground hover:text-foreground h-10 w-10 shrink-0 rounded-xl p-0"
        title="Project settings"
        aria-label={`Open ${project.name} settings`}
      >
        <Settings2 className="h-4 w-4" aria-hidden />
      </Button>

      <CreateProjectDialog open={settingsOpen} onOpenChange={setSettingsOpen} project={project} />
    </motion.div>
  );
}

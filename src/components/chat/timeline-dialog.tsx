"use client";

import { useMemo, useState } from "react";
import type { ToolCall } from "@/types";
import { useChatStore } from "@/stores/chat-store";
import { ToolTimeline, type TimelineStat, type TimelineStep } from "@/components/assistant-ui/elements";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  BarChart3,
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
  type LucideIcon,
} from "lucide-react";

/**
 * TimelineDialog — the conversation's whole working session summarized as
 * verbs, targets, and file stats (assistant-ui "Tool timeline"), opened from
 * the chat header's timeline button. Every tool call across every assistant
 * turn becomes one step; file-affecting tools also produce stats chips.
 */

interface VerbRule {
  verb: string;
  icon: LucideIcon;
}

const VERB_RULES: Record<string, VerbRule> = {
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
};

const FILE_TOOLS = new Set([
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

/** The primary argument shown as the step's chip. */
function toolChip(toolCall: ToolCall): string {
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

/** File-change stat for file-affecting tools, with counts when the result
 *  carries them (edit_file → replacements; else just the file). */
function fileStat(toolCall: ToolCall): TimelineStat | null {
  if (!FILE_TOOLS.has(toolCall.name)) return null;
  const args = toolCall.args ?? {};
  const file =
    (typeof args.path === "string" && args.path) ||
    (typeof args.file_path === "string" && args.file_path) ||
    null;
  if (!file) return null;
  let added: number | undefined;
  let removed: number | undefined;
  if (toolCall.name === "edit_file" && typeof toolCall.result !== "undefined") {
    try {
      const parsed =
        typeof toolCall.result === "string"
          ? (JSON.parse(toolCall.result) as { replacements?: number; output?: { replacements?: number } })
          : (toolCall.result as { replacements?: number; output?: { replacements?: number } });
      const reps = parsed?.replacements ?? parsed?.output?.replacements;
      if (typeof reps === "number" && reps > 0) added = reps;
    } catch {
      // not JSON — no counts
    }
  }
  const short = file.length > 28 ? `…${file.slice(-26)}` : file;
  return { file: short, added, removed };
}

export function TimelineDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const messages = useChatStore((s) => s.messages);
  const [expanded, setExpanded] = useState(true);

  const { steps, stats, filesChanged } = useMemo(() => {
    const steps: TimelineStep[] = [];
    const stats = new Map<string, TimelineStat>();
    for (const msg of messages) {
      if (msg.role !== "assistant") continue;
      // Prefer parts (ordered); fall back to the flat toolCalls list.
      const toolCalls: ToolCall[] =
        msg.parts?.length
          ? msg.parts
              .filter((p) => p.type === "tool" && p.toolCall)
              .map((p) => p.toolCall!)
          : msg.toolCalls ?? [];
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
    }
    return {
      steps,
      stats: [...stats.values()],
      filesChanged: stats.size,
    };
  }, [messages]);

  const restingLabel =
    steps.length === 0
      ? "No tool calls yet"
      : `${steps.length} step${steps.length !== 1 ? "s" : ""}${
          filesChanged > 0 ? ` · ${filesChanged} file${filesChanged !== 1 ? "s" : ""} changed` : ""
        }`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg gap-0 overflow-y-auto p-0 sm:max-w-md">
        <DialogHeader className="border-b px-4 pt-4 pb-3">
          <DialogTitle className="font-display text-base font-medium tracking-tight">
            Tool timeline
          </DialogTitle>
          <DialogDescription className="text-muted-foreground text-[12px] leading-relaxed">
            The whole session as verbs, targets, and file changes.
          </DialogDescription>
        </DialogHeader>
        <div className="px-2 py-3">
          {steps.length === 0 ? (
            <p className="text-muted-foreground px-3 py-6 text-center text-[13px]">
              The agent hasn&apos;t used any tools in this conversation yet.
            </p>
          ) : (
            <ToolTimeline
              steps={steps}
              visibleSteps={steps.length}
              streaming={false}
              open={expanded}
              onOpenChange={setExpanded}
              restingLabel={restingLabel}
              activeLabel="Working"
              stats={stats}
              className="max-w-none"
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

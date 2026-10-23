"use client";

/**
 * Business Mode — compact activity timeline row (Task 4-b).
 *
 * Renders a role="activity" chat message as a slim muted row. Rows carrying a
 * task or draft reference become buttons that jump to the matching workspace
 * tab. Timestamps are REAL message timestamps only — no synthetic times.
 */

import { useRouter } from "next/navigation";
import { CircleDot } from "lucide-react";
import type { BusinessChatMessageRow } from "@/lib/business/types";

/** HH:MM for today's rows, short date otherwise (real created_at only). */
function formatActivityTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  return d.toDateString() === now.toDateString()
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString([], { month: "short", day: "numeric" });
}

export function BusinessActivityItem({ message }: { message: BusinessChatMessageRow }) {
  const router = useRouter();
  const taskId = message.metadata?.taskId;
  const draftId = message.metadata?.draftId;
  const time = formatActivityTime(message.created_at);

  const body = (
    <>
      <CircleDot className="mt-0.5 size-4 shrink-0 text-muted-foreground/70" aria-hidden />
      <p className="min-w-0 flex-1 text-sm leading-snug text-muted-foreground">{message.content}</p>
      {time && (
        <time dateTime={message.created_at} className="shrink-0 text-xs tabular-nums text-muted-foreground/60">
          {time}
        </time>
      )}
    </>
  );

  // Clickable when the activity references a task or a draft.
  if (taskId || draftId) {
    return (
      <button
        type="button"
        onClick={() =>
          router.push(`/business/${message.business_id}/${draftId ? "drafts" : "tasks"}`)
        }
        className="-mx-2 flex w-full items-start gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-accent/50"
      >
        {body}
      </button>
    );
  }

  return <div className="-mx-2 flex items-start gap-2.5 px-2 py-1.5">{body}</div>;
}

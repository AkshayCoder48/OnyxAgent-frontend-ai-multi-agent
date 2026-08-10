"use client";

import * as React from "react";
import { Bot } from "lucide-react";
import { Badge } from "@/components/ui";
import { GenUIComponentProps, str } from "./helpers";

/**
 * `agent_card` — subagent identity card.
 *
 * Props:
 *   - name (string, required)
 *   - role (string)
 *   - description (string)
 *   - avatar (URL)
 *   - href (URL)
 *   - status (string) — "running" | "completed" | "failed" | "idle"
 */
export function AgentCard({ props, streaming }: GenUIComponentProps) {
  const name = str(props.name);
  const role = str(props.role || props.model);
  const description = str(props.description || props.prompt || props.task);
  const avatar = str(props.avatar || props.avatarUrl);
  const href = str(props.href);
  const status = str(props.status || props.state);
  const tasksDone = props.tasks_done as number | undefined;
  const accuracy = str(props.accuracy);
  const toolsList = Array.isArray(props.tools) ? (props.tools as unknown[]).map(String) : [];

  if (streaming && !name) {
    return (
      <div className="bg-card flex items-center gap-3 rounded-xl border p-3">
        <div className="shimmer h-10 w-10 rounded-full" />
        <div className="flex-1 space-y-1.5">
          <div className="shimmer h-3 w-24 rounded" />
          <div className="shimmer h-2.5 w-32 rounded" />
        </div>
      </div>
    );
  }

  const statusVariant =
    status === "completed"
      ? "success"
      : status === "failed"
        ? "destructive"
        : status === "running"
          ? "default"
          : "secondary";

  const inner = (
    <div className="bg-card flex items-start gap-3 rounded-xl border p-3">
      <div className="bg-primary/10 text-primary flex h-10 w-10 shrink-0 items-center justify-center rounded-full overflow-hidden">
        {avatar ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={avatar} alt={name} className="h-full w-full object-cover" />
        ) : (
          <Bot className="h-5 w-5" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-foreground truncate text-sm font-semibold">{name}</span>
          {status && (
            <Badge variant={statusVariant as "default" | "secondary" | "destructive"} className="text-[10px]">
              {status}
            </Badge>
          )}
        </div>
        {role && (
          <div className="text-primary text-xs font-medium">{role}</div>
        )}
        {description && (
          <p className="text-muted-foreground mt-1 text-xs leading-relaxed line-clamp-2">
            {description}
          </p>
        )}
        {(tasksDone != null || accuracy) && (
          <div className="mt-1.5 flex items-center gap-3 text-[10px] text-muted-foreground">
            {tasksDone != null && (
              <span className="flex items-center gap-0.5">
                <span className="font-semibold text-foreground">{tasksDone}</span> tasks
              </span>
            )}
            {accuracy && (
              <span className="flex items-center gap-0.5">
                <span className="font-semibold text-foreground">{accuracy}</span> accuracy
              </span>
            )}
          </div>
        )}
        {toolsList.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {toolsList.slice(0, 5).map((t, i) => (
              <span key={i} className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 font-mono text-[9px]">
                {t}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );

  if (href) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className="block">
        {inner}
      </a>
    );
  }
  return inner;
}

export default AgentCard;

"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { GenUIComponentProps, str, arr, obj, bool } from "./helpers";

interface ListItem {
  text?: string;
  icon?: string;
  href?: string;
  status?: "default" | "success" | "warn" | "error";
}

/**
 * `list` — rich list with icons.
 *
 * Props:
 *   - ordered (boolean, default false) — numbered vs bulleted
 *   - items (Array<{ text, icon, href, status }>)
 *
 * `icon` is a short emoji or single character. `status` colors the icon.
 */
export function List({ props, streaming }: GenUIComponentProps) {
  const ordered = bool(props.ordered, false);
  const itemsRaw = arr<unknown>(props.items);
  const items: ListItem[] = itemsRaw.map((it) => {
    if (typeof it === "string") return { text: it } as ListItem;
    const o = obj(it);
    return {
      text: str(o.text || o.label),
      icon: str(o.icon),
      href: str(o.href),
      status: str(o.status, "default") as ListItem["status"],
    };
  });

  if (streaming && items.length === 0) {
    return (
      <div className="space-y-2 py-1">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="shimmer h-3.5 w-full rounded" style={{ width: `${85 - i * 10}%` }} />
        ))}
      </div>
    );
  }

  if (items.length === 0) return null;

  const ListTag = ordered ? "ol" : "ul";

  return (
    <ListTag className={cn("space-y-1.5", ordered && "list-none")}>
      {items.map((it, i) => {
        const iconColor =
          it.status === "success"
            ? "text-brand"
            : it.status === "error"
              ? "text-destructive"
              : it.status === "warn"
                ? "text-yellow-500"
                : "text-muted-foreground";

        const content = (
          <span className="text-foreground text-sm leading-relaxed">{it.text}</span>
        );

        return (
          <li key={i} className="flex items-start gap-2">
            <span className={cn("mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center text-xs", iconColor)}>
              {ordered ? (
                <span className="font-mono text-[10px] font-semibold">{i + 1}.</span>
              ) : it.icon ? (
                <span>{it.icon}</span>
              ) : (
                <span className="bg-current inline-block h-1 w-1 rounded-full" />
              )}
            </span>
            {it.href ? (
              <a href={it.href} target="_blank" rel="noopener noreferrer" className="hover:underline">
                {content}
              </a>
            ) : (
              content
            )}
          </li>
        );
      })}
    </ListTag>
  );
}

export default List;

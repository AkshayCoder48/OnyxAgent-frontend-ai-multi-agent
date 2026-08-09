"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { Checkbox } from "@/components/ui";
import { GenUIComponentProps, str, arr, obj, bool } from "./helpers";

interface ChecklistItem {
  text?: string;
  checked?: boolean;
}

/**
 * `checklist` — interactive checklist (state is local to the component).
 *
 * Props:
 *   - title (string)
 *   - items (Array<{ text, checked }>)
 */
export function Checklist({ props, streaming }: GenUIComponentProps) {
  const title = str(props.title);
  const itemsRaw = arr<Record<string, unknown>>(props.items);
  const initialItems: ChecklistItem[] = itemsRaw.map((it) => {
    const o = obj(it);
    return { text: str(o.text), checked: bool(o.checked, false) };
  });

  const [items, setItems] = React.useState<ChecklistItem[]>(initialItems);
  React.useEffect(() => {
    setItems(initialItems);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(initialItems)]);

  if (streaming && items.length === 0) {
    return (
      <div className="space-y-2 py-1">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="shimmer h-4 w-full rounded" style={{ width: `${85 - i * 10}%` }} />
        ))}
      </div>
    );
  }

  if (items.length === 0) return null;

  const completed = items.filter((i) => i.checked).length;

  return (
    <div className="bg-card rounded-xl border p-3">
      {title && (
        <div className="text-foreground mb-2 flex items-center justify-between">
          <span className="text-sm font-semibold">{title}</span>
          <span className="text-muted-foreground text-xs tabular-nums">
            {completed}/{items.length}
          </span>
        </div>
      )}
      <ul className="space-y-1.5">
        {items.map((it, i) => (
          <li key={i} className="flex items-start gap-2">
            <Checkbox
              checked={it.checked}
              onCheckedChange={(checked) => {
                setItems((prev) =>
                  prev.map((p, idx) => (idx === i ? { ...p, checked: checked === true } : p)),
                );
              }}
              className="mt-0.5"
            />
            <span
              className={cn(
                "text-sm leading-relaxed",
                it.checked ? "text-muted-foreground line-through" : "text-foreground",
              )}
            >
              {it.text}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default Checklist;

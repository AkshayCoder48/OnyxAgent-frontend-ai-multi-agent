"use client";

import * as React from "react";
import { GenUIComponentProps, str, arr, obj } from "./helpers";

interface KVPair {
  label?: string;
  value?: string;
}

/**
 * `key_value` — list of label/value pairs.
 *
 * Props:
 *   - title (string)
 *   - pairs (Array<{ label, value }>)
 */
export function KeyValue({ props, streaming }: GenUIComponentProps) {
  const title = str(props.title);
  const pairsRaw = arr<Record<string, unknown>>(props.pairs);
  const pairs: KVPair[] = pairsRaw.map((p) => {
    const o = obj(p);
    return {
      label: str(o.label),
      value: typeof o.value === "number" ? String(o.value) : str(o.value),
    };
  });

  if (streaming && pairs.length === 0) {
    return (
      <div className="bg-card rounded-xl border p-3">
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="shimmer h-4 w-full rounded" />
          ))}
        </div>
      </div>
    );
  }

  if (pairs.length === 0) return null;

  return (
    <div className="bg-card rounded-xl border p-3">
      {title && (
        <h3 className="text-foreground mb-2 text-sm font-semibold">{title}</h3>
      )}
      <dl className="divide-y divide-border/60">
        {pairs.map((p, i) => (
          <div key={i} className="flex items-baseline justify-between gap-4 py-1.5">
            <dt className="text-muted-foreground shrink-0 text-xs font-medium tracking-wide uppercase">
              {p.label}
            </dt>
            <dd className="text-foreground text-right text-sm font-medium tabular-nums">
              {p.value}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export default KeyValue;

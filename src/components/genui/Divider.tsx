"use client";

import * as React from "react";
import { GenUIComponentProps, str } from "./helpers";

/**
 * `divider` — labeled separator.
 *
 * Props:
 *   - label (string) — centered text on the line
 */
export function Divider({ props }: GenUIComponentProps) {
  const label = str(props.label || props.text);

  if (!label) {
    return <hr className="bg-border my-2 h-px w-full border-0" />;
  }

  return (
    <div className="my-2 flex items-center gap-2">
      <div className="bg-border h-px flex-1" />
      <span className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
        {label}
      </span>
      <div className="bg-border h-px flex-1" />
    </div>
  );
}

export default Divider;

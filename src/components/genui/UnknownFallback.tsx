"use client";

import * as React from "react";
import { AlertCircle } from "lucide-react";
import { CopyButton } from "@/components/chat/copy-button";
import { GenUIComponentProps, str } from "./helpers";

/**
 * Fallback renderer for unknown GenUI types. Shows the raw JSON in a `<pre>`
 * so the user can see what the AI emitted, with a copy button for debugging.
 *
 * Invoked when `validate.ts` encounters a node whose `type` isn't in the
 * registry — it rewrites the type to `unknown_json` and stashes the raw spec
 * in `props.__raw` (and the original type in `props.__type`).
 */
export function UnknownFallback({ props }: GenUIComponentProps) {
  const raw = str(props.__raw);
  const originalType = str(props.__type, "unknown");

  return (
    <div className="bg-muted/40 border-destructive/30 rounded-xl border p-3">
      <div className="flex items-center gap-2">
        <AlertCircle className="text-destructive h-4 w-4 shrink-0" />
        <span className="text-destructive text-xs font-semibold tracking-wide uppercase">
          Unknown block: {originalType}
        </span>
        {raw && <CopyButton text={raw} className="ml-auto" />}
      </div>
      {raw && (
        <pre className="scrollbar-thin bg-muted/60 text-foreground/80 mt-2 max-h-64 overflow-auto rounded-lg p-2.5 font-mono text-[11px] leading-relaxed">
          {raw}
        </pre>
      )}
    </div>
  );
}

export default UnknownFallback;

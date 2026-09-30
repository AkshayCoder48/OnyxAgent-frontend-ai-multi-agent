"use client";

import { useEffect } from "react";

import { setCodeMode } from "@/lib/code-mode";

/**
 * OnyxCode layout — the mode frame under the dashboard header. Also owns the
 * imperative Code Mode flag used by the agent runtime to stamp newly created
 * conversations with `mode: "code"`.
 *
 * There is no tab bar anymore: Database and the live web Preview are docked
 * panels opened from the workspace's glass sub-header (next to Files /
 * Timeline), exactly like every other right-hand panel — no route change, no
 * remount, the chat keeps its scroll and streaming state. The legacy
 * /code/database and /code/preview routes redirect here and open the
 * matching panel.
 */
export default function CodeLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  useEffect(() => {
    setCodeMode(true);
    return () => setCodeMode(false);
  }, []);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {children}
    </div>
  );
}

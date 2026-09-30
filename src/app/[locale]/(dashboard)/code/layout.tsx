"use client";

import { useEffect } from "react";

import { CodeTabs } from "@/components/code/code-tabs";
import { setCodeMode } from "@/lib/code-mode";

/**
 * OnyxCode layout — mirrors the (dashboard) layout's Header above and adds
 * the Code Mode tab bar (Chat / Database / Preview) below it. Also owns the
 * imperative Code Mode flag used by the agent runtime to stamp newly created
 * conversations with `mode: "code"`.
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
      <CodeTabs />
      {/* Flex column (not a plain block): ChatWorkspace's root relies on
          flex-1 to stretch to the full height. With a block wrapper the
          chat column collapsed to content height, leaving the prompt box
          floating mid-screen instead of pinned to the device bottom —
          exactly like /chat, the workspace must fill the remaining space. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{children}</div>
    </div>
  );
}

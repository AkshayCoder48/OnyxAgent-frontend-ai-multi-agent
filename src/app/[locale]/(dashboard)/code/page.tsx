"use client";

import { ChatWorkspace } from "@/components/chat/chat-workspace";

/**
 * OnyxCode — Code Mode chat tab (/code). The full agent workspace (sidebar,
 * panels, runtime) with `mode="code"`: separate code-mode conversations, the
 * OnyxCode empty state ("What do you want to create?") and all agent
 * capabilities (providers, tools, skills, MCP, sub-agents, sandbox).
 */
export default function CodePage() {
  return <ChatWorkspace mode="code" />;
}

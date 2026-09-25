"use client";

import { useState, useCallback } from "react";
import { ChatContainer, ConversationSidebar } from "@/components/chat";
import { FileSidebar } from "@/components/chat/file-sidebar";
import { SubAgentSidebar } from "@/components/chat/subagent-sidebar";
import { DockedPanel } from "@/components/chat/docked-panel";
import { Button } from "@/components/ui/button";
import { useChatSidebarStore, useConversationStore } from "@/stores";
import { useSubagentStore } from "@/stores/subagent-store";
import { useConversations } from "@/hooks";
import { TimelineSidebar } from "@/components/chat/timeline-sidebar";
import { FolderOpen, Menu, Bot, ListTree } from "lucide-react";

type SidePanel = "files" | "timeline" | null;

export default function ChatPage() {
  // Files / timeline panels — the user's last right-panel choice, closed by
  // default. The DockedPanel container renders each as a docked column on
  // lg+ and a full-height drawer below, so this single state drives both.
  const [sidePanel, setSidePanel] = useState<SidePanel>(null);
  const { open: openChatSidebar } = useChatSidebarStore();
  const currentConversationId = useConversationStore((s) => s.currentConversationId);
  const { conversations } = useConversations();
  const conversationTitle =
    conversations.find((c) => c.id === currentConversationId)?.title ?? null;

  // Subagent panel — the store is the single source of truth: the event
  // processor flips `sidebarOpen` the moment a sub-agent tool call starts
  // (PRD §15), and the docked panel reads it directly (no mirroring into
  // local panel state).
  const subagentOpen = useSubagentStore((s) => s.sidebarOpen);
  const setSubagentOpen = useSubagentStore((s) => s.setSidebarOpen);

  // Only one right-hand panel VISIBLE at a time — fully DERIVED during
  // render (no state syncing, so it is React-Compiler-safe): while the
  // subagent panel is open (manually or auto-opened by the agent) it takes
  // over the dock; closing it restores the panel that was open before.
  const filesOpen = sidePanel === "files" && !subagentOpen;
  const timelineOpen = sidePanel === "timeline" && !subagentOpen;

  const closeSubagent = useCallback(() => {
    setSubagentOpen(false);
  }, [setSubagentOpen]);

  const toggleSubagents = () => setSubagentOpen(!subagentOpen);
  const toggleSidePanel = (panel: Exclude<SidePanel, null>) => {
    // Opening a side panel takes over the dock from the subagent panel
    // (setSubagentOpen is a no-op when the value is unchanged).
    setSubagentOpen(false);
    const wasVisible = panel === "files" ? filesOpen : timelineOpen;
    setSidePanel(wasVisible ? null : panel);
  };

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <ConversationSidebar />
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {/* Glass top bar (Terra spec): serif conversation title on the left,
            panel toggles on the right, over a hairline. Chat history lives
            in the conversation sidebar (left rail + its mobile sheet), not
            here (PRD §11). */}
        <div className="glass-header flex h-12 shrink-0 items-center justify-between border-b px-2 sm:px-4">
          <div className="flex min-w-0 items-center gap-1.5">
            <Button
              variant="ghost"
              size="sm"
              onClick={openChatSidebar}
              className="h-8 w-8 p-0 md:hidden"
              title="Open conversations"
              aria-label="Open conversations"
            >
              <Menu className="h-4 w-4" />
            </Button>
            {currentConversationId && !conversationTitle ? (
              /* PRD §12 — the naming call is in flight: a shimmer skeleton
                 holds the empty title space (no layout jump when the title
                 lands). */
              <span
                aria-hidden
                className="shimmer mt-0.5 h-4 w-28 rounded-sm sm:h-5 sm:w-36"
              />
            ) : (
              /* The title reveals with a fade/slide/blur-to-sharp settle
                 (keyed on the text so the generated title, renames, and
                 chat switches all animate in seamlessly). */
              <h1
                key={conversationTitle ?? "new"}
                className="title-reveal font-display truncate text-[17px] font-medium tracking-tight sm:text-lg"
              >
                {conversationTitle || "New conversation"}
              </h1>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-0.5">
            {/* Tool timeline — a DOCKED SIDEBAR (not a popup): the whole
                working session as a fixed, scrollable, real-time panel on
                the right. */}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => toggleSidePanel("timeline")}
              className={timelineOpen ? "h-8 w-8 bg-foreground/5 p-0" : "text-muted-foreground hover:text-foreground h-8 w-8 p-0"}
              title="Tool timeline"
              aria-label="Show tool timeline"
              aria-expanded={timelineOpen}
              aria-controls="timeline-panel"
            >
              <ListTree className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={toggleSubagents}
              className={subagentOpen ? "h-8 w-8 bg-foreground/5 p-0" : "text-muted-foreground hover:text-foreground h-8 w-8 p-0"}
              title="Subagent chat"
              aria-label="Toggle subagent panel"
              aria-expanded={subagentOpen}
              aria-controls="subagent-panel"
            >
              <Bot className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => toggleSidePanel("files")}
              className={filesOpen ? "h-8 w-8 bg-foreground/5 p-0" : "text-muted-foreground hover:text-foreground h-8 w-8 p-0"}
              title="Show files"
              aria-label="Toggle files panel"
              aria-expanded={filesOpen}
              aria-controls="files-panel"
            >
              <FolderOpen className="h-4 w-4" />
            </Button>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-hidden">
          <ChatContainer />
        </div>
      </div>

      {/* Right-hand docked panels (PRD §16/§17): in-flow columns on lg+
          whose open/close is an animated width change (the main chat
          column shrinks seamlessly — no overlay, no backdrop, no blur),
          and full-height drawers below lg. One at a time; each is
          resizable with the width persisted. */}
      <DockedPanel
        id="subagent-panel"
        label="Subagent chat"
        open={subagentOpen}
        onClose={closeSubagent}
        storageKey="subagent-sidebar-width"
        defaultWidth={360}
        minWidth={280}
        maxWidth={600}
        sheetClassName="w-[90vw] max-w-md"
      >
        <SubAgentSidebar onClose={closeSubagent} />
      </DockedPanel>

      <DockedPanel
        id="files-panel"
        label="Files"
        open={filesOpen}
        onClose={() => setSidePanel(null)}
        storageKey="file-sidebar-width"
        defaultWidth={320}
        minWidth={240}
        maxWidth={600}
        sheetCloseButton
        sheetClassName="w-[85vw] max-w-sm"
      >
        <FileSidebar />
      </DockedPanel>

      <DockedPanel
        id="timeline-panel"
        label="Tool timeline"
        open={timelineOpen}
        onClose={() => setSidePanel(null)}
        storageKey="timeline-sidebar-width"
        defaultWidth={340}
        minWidth={280}
        maxWidth={600}
        sheetClassName="w-[85vw] max-w-sm"
      >
        <TimelineSidebar onClose={() => setSidePanel(null)} />
      </DockedPanel>
    </div>
  );
}

"use client";

import { useState, useCallback } from "react";
import { ChatContainer, ConversationSidebar } from "@/components/chat";
import { FileSidebar } from "@/components/chat/file-sidebar";
import { SubAgentSidebar } from "@/components/chat/subagent-sidebar";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { useResizableSidebar } from "@/components/ui/resize-handle";
import { useChatSidebarStore, useConversationStore } from "@/stores";
import { useSubagentStore } from "@/stores/subagent-store";
import { useConversations } from "@/hooks";
import { TimelineDialog } from "@/components/chat/timeline-dialog";
import { FolderOpen, Menu, Bot, X, ListTree, History } from "lucide-react";

/** Resizable right sidebar wrapper — drag the left edge to resize. */
function ResizableRightPanel({
  storageKey,
  defaultWidth,
  minWidth,
  maxWidth,
  children,
}: {
  storageKey: string;
  defaultWidth: number;
  minWidth: number;
  maxWidth: number;
  children: React.ReactNode;
}) {
  const [width, setWidth] = useResizableSidebar(storageKey, defaultWidth, minWidth, maxWidth);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = width;
      const handleMouseMove = (moveEvent: MouseEvent) => {
        const delta = startX - moveEvent.clientX;
        setWidth(startWidth + delta);
      };
      const handleMouseUp = () => {
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", handleMouseUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };
      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [width, setWidth],
  );

  return (
    <aside
      className="hidden shrink-0 animate-slide-in-right md:block relative overflow-visible"
      style={{ width: `${width}px` }}
    >
      <div
        onMouseDown={handleMouseDown}
        className="absolute top-0 bottom-0 left-0 z-50 cursor-col-resize transition-colors hover:bg-primary/40 group"
        style={{ width: "4px", marginLeft: "-2px" }}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
      >
        {/* Invisible wider hit area for easier grabbing */}
        <div className="absolute inset-y-0 -inset-x-2" />
      </div>
      {children}
    </aside>
  );
}

type RightPanel = "files" | "subagents" | null;

export default function ChatPage() {
  const [rightPanel, setRightPanel] = useState<RightPanel>(null);
  const [mobilePanel, setMobilePanel] = useState<RightPanel>(null);
  const [timelineOpen, setTimelineOpen] = useState(false);
  const { open: openChatSidebar } = useChatSidebarStore();
  const currentConversationId = useConversationStore((s) => s.currentConversationId);
  const { conversations } = useConversations();
  const conversationTitle =
    conversations.find((c) => c.id === currentConversationId)?.title ?? null;

  const subagentSidebarOpen = useSubagentStore((s) => s.sidebarOpen);
  const setSubagentSidebarOpen = useSubagentStore((s) => s.setSidebarOpen);
  // SUB-AGENT SIDEBAR AUTO-OPEN (PRD §15): `use-chat` flips `sidebarOpen` on
  // the subagent store the moment a sub-agent tool call starts — mirror it
  // into the local panel state (both desktop and mobile) so the sidebar
  // opens automatically and streams the sub-agent's progress. Closing the
  // panel (header Bot button, X, or Sheet onOpenChange) writes false back
  // to the store so a NEW invocation re-opens it.
  //
  // Uses the render-time "adjust state when a prop changes" pattern from
  // the React docs instead of a useEffect + setState (which triggers
  // cascading renders and is flagged by the React Compiler lint).
  const [prevSubagentOpen, setPrevSubagentOpen] = useState(subagentSidebarOpen);
  if (subagentSidebarOpen !== prevSubagentOpen) {
    setPrevSubagentOpen(subagentSidebarOpen);
    if (subagentSidebarOpen) {
      setRightPanel("subagents");
      setMobilePanel("subagents");
    } else {
      setRightPanel((p) => (p === "subagents" ? null : p));
      setMobilePanel((p) => (p === "subagents" ? null : p));
    }
  }

  const closeSubagentSidebar = useCallback(() => {
    setSubagentSidebarOpen(false);
  }, [setSubagentSidebarOpen]);

  const togglePanel = (panel: RightPanel) => {
    if (window.innerWidth >= 768) {
      if (panel === "subagents") {
        // Manual toggle writes through to the store so the auto-open effect
        // stays in sync (closing here must not be re-opened by a stale flag).
        setSubagentSidebarOpen(!subagentSidebarOpen);
      } else {
        setRightPanel((prev) => (prev === panel ? null : panel));
      }
    } else {
      if (panel === "subagents") {
        setSubagentSidebarOpen(!subagentSidebarOpen);
      } else {
        setMobilePanel(panel);
      }
    }
  };

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <ConversationSidebar />
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {/* Glass top bar (Terra spec): serif conversation title on the left,
            history / share / more affordances on the right, over a hairline. */}
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
            <h1 className="font-display truncate text-[17px] font-medium tracking-tight sm:text-lg">
              {conversationTitle || "New conversation"}
            </h1>
          </div>
          <div className="flex shrink-0 items-center gap-0.5">
            <Button
              variant="ghost"
              size="sm"
              onClick={openChatSidebar}
              className="h-8 w-8 p-0 text-muted-foreground hover:text-foreground"
              title="Chat history"
              aria-label="Chat history"
            >
              <History className="h-4 w-4" />
            </Button>
            {/* Tool timeline (assistant-ui "Tool timeline") — replaces the old
                share button: one glance at the whole working session as verbs,
                targets, and file stats. */}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setTimelineOpen(true)}
              className="h-8 w-8 p-0 text-muted-foreground hover:text-foreground"
              title="Tool timeline"
              aria-label="Show tool timeline"
            >
              <ListTree className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => togglePanel("subagents")}
              className={rightPanel === "subagents" ? "h-8 w-8 p-0 bg-foreground/5" : "h-8 w-8 p-0 text-muted-foreground hover:text-foreground"}
              title="Subagent chat"
              aria-label="Toggle subagent panel"
            >
              <Bot className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => togglePanel("files")}
              className={rightPanel === "files" ? "h-8 w-8 p-0 bg-foreground/5" : "h-8 w-8 p-0 text-muted-foreground hover:text-foreground"}
              title="Show files"
              aria-label="Toggle files panel"
            >
              <FolderOpen className="h-4 w-4" />
            </Button>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-hidden">
          <ChatContainer />
        </div>
      </div>

      {/* Desktop right panel — files or subagents (resizable) */}
      {rightPanel === "files" && (
        <ResizableRightPanel storageKey="file-sidebar-width" defaultWidth={320} minWidth={240} maxWidth={600}>
          <FileSidebar />
        </ResizableRightPanel>
      )}
      {rightPanel === "subagents" && (
        <ResizableRightPanel storageKey="subagent-sidebar-width" defaultWidth={360} minWidth={280} maxWidth={600}>
          <SubAgentSidebar open onClose={closeSubagentSidebar} />
        </ResizableRightPanel>
      )}

      {/* Mobile sheet — files */}
      <Sheet open={mobilePanel === "files"} onOpenChange={(o) => !o && setMobilePanel(null)}>
        <SheetContent side="right" className="w-[85vw] max-w-sm p-0">
          <button
            type="button"
            onClick={() => setMobilePanel(null)}
            aria-label="Close files panel"
            title="Close"
            className="bg-background/80 hover:bg-foreground/5 text-foreground/60 hover:text-foreground absolute right-2 top-2 z-10 inline-flex h-7 w-7 items-center justify-center rounded-md backdrop-blur-sm transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
          <FileSidebar />
        </SheetContent>
      </Sheet>

      {/* Mobile sheet — subagents */}
      <Sheet
        open={mobilePanel === "subagents"}
        onOpenChange={(o) => {
          if (!o) {
            setMobilePanel(null);
            setSubagentSidebarOpen(false);
          }
        }}
      >
        <SheetContent side="right" className="w-[90vw] max-w-md p-0">
          <SubAgentSidebar open onClose={() => { setMobilePanel(null); setSubagentSidebarOpen(false); }} />
        </SheetContent>
      </Sheet>

      {/* Tool timeline (header button) */}
      <TimelineDialog open={timelineOpen} onOpenChange={setTimelineOpen} />
    </div>
  );
}

"use client";

import { useState, useCallback } from "react";
import { ChatContainer, ConversationSidebar } from "@/components/chat";
import { FileSidebar } from "@/components/chat/file-sidebar";
import { SubAgentSidebar } from "@/components/chat/subagent-sidebar";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { useResizableSidebar } from "@/components/ui/resize-handle";
import { useChatSidebarStore } from "@/stores";
import { FolderOpen, Menu, Bot, X } from "lucide-react";

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
      className="hidden shrink-0 animate-slide-in-right md:block relative"
      style={{ width: `${width}px` }}
    >
      {children}
      <div
        onMouseDown={handleMouseDown}
        className="absolute top-0 bottom-0 left-0 z-30 w-1.5 cursor-col-resize transition-colors hover:bg-primary/30"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
      >
        <div className="absolute inset-y-0 -inset-x-1" />
      </div>
    </aside>
  );
}

type RightPanel = "files" | "subagents" | null;

export default function ChatPage() {
  const [rightPanel, setRightPanel] = useState<RightPanel>(null);
  const [mobilePanel, setMobilePanel] = useState<RightPanel>(null);
  const { open: openChatSidebar } = useChatSidebarStore();

  const togglePanel = (panel: RightPanel) => {
    if (window.innerWidth >= 768) {
      setRightPanel((prev) => (prev === panel ? null : panel));
    } else {
      setMobilePanel(panel);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <ConversationSidebar />
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {/* Sub-toolbar: conversation menu (mobile) + Files/Agents toggles. */}
        <div className="glass flex h-11 shrink-0 items-center justify-between border-b px-2 sm:px-3">
          <div className="flex items-center gap-1">
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
            <div className="hidden md:block w-8" />
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => togglePanel("subagents")}
              className={rightPanel === "subagents" ? "h-8 gap-2 px-3 text-xs font-medium bg-foreground/5" : "h-8 gap-2 px-3 text-xs font-medium"}
              title="Subagent chat"
              aria-label="Toggle subagent panel"
            >
              <Bot className="h-4 w-4" />
              <span>Agents</span>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => togglePanel("files")}
              className={rightPanel === "files" ? "h-8 gap-2 px-3 text-xs font-medium bg-foreground/5" : "h-8 gap-2 px-3 text-xs font-medium"}
              title="Show files"
              aria-label="Toggle files panel"
            >
              <FolderOpen className="h-4 w-4" />
              <span>Files</span>
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
          <SubAgentSidebar open onClose={() => setRightPanel(null)} />
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
      <Sheet open={mobilePanel === "subagents"} onOpenChange={(o) => !o && setMobilePanel(null)}>
        <SheetContent side="right" className="w-[90vw] max-w-md p-0">
          <SubAgentSidebar open onClose={() => setMobilePanel(null)} />
        </SheetContent>
      </Sheet>
    </div>
  );
}

"use client";

import { useEffect } from "react";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { CodeShell } from "@/components/code/code-shell";
import { Composer } from "@/components/terra/composer";
import { SettingsSheet } from "@/components/terra/settings-sheet";
import { Sidebar, SidebarContent } from "@/components/terra/sidebar";
import { Thread } from "@/components/terra/thread";
import { TopBar } from "@/components/terra/top-bar";
import { useTerra } from "@/components/terra/store";

export default function Page() {
  const mobileNavOpen = useTerra((s) => s.mobileNavOpen);
  const appMode = useTerra((s) => s.appMode);
  const setMobileNav = useTerra((s) => s.setMobileNav);
  const newConversation = useTerra((s) => s.newConversation);
  const hydrate = useTerra((s) => s.hydrate);

  // Restore the local snapshot instantly, then reconcile with the cloud.
  useEffect(() => {
    hydrate();
  }, [hydrate]);

  // ⌘N / Ctrl+N starts a new conversation (mode-aware: new app in Code Mode).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "n") {
        event.preventDefault();
        newConversation();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [newConversation]);

  return (
    <div className="flex h-dvh w-full overflow-hidden bg-background text-ink">
      <Sidebar />

      {/* Mobile navigation drawer */}
      <Sheet open={mobileNavOpen} onOpenChange={setMobileNav}>
        <SheetContent
          side="left"
          className="w-[264px] max-w-[85vw] gap-0 border-r border-hairline bg-paper p-0 sm:max-w-none"
        >
          <SheetTitle className="sr-only">Chat navigation</SheetTitle>
          <SheetDescription className="sr-only">Conversations and account</SheetDescription>
          <SidebarContent onNavigate={() => setMobileNav(false)} />
        </SheetContent>
      </Sheet>

      {/* Main column — OnyxCode swaps in its own shell (Chat / Database / Preview) */}
      <main className="relative h-full min-w-0 flex-1">
        {appMode === "code" ? (
          <CodeShell />
        ) : (
          <div className="terra-scroll flex h-full flex-col overflow-y-auto">
            <TopBar />
            <Thread />
            <Composer />
          </div>
        )}
      </main>

      <SettingsSheet />
    </div>
  );
}

"use client";

import { useEffect } from "react";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Composer } from "@/components/terra/composer";
import { SettingsSheet } from "@/components/terra/settings-sheet";
import { Sidebar, SidebarContent } from "@/components/terra/sidebar";
import { Thread } from "@/components/terra/thread";
import { TopBar } from "@/components/terra/top-bar";
import { useTerra } from "@/components/terra/store";

export default function Page() {
  const mobileNavOpen = useTerra((s) => s.mobileNavOpen);
  const setMobileNav = useTerra((s) => s.setMobileNav);
  const newConversation = useTerra((s) => s.newConversation);
  const hydrate = useTerra((s) => s.hydrate);

  // Restore the local snapshot instantly, then reconcile with the cloud.
  useEffect(() => {
    hydrate();
  }, [hydrate]);

  // `/` is the Terra agent's route — Code Mode lives at /code*. If the last
  // snapshot left Code Mode active (or a sync restores it), clear it so the
  // sidebar always matches the page the user is actually on.
  useEffect(() => {
    const clearStaleCodeMode = () => {
      if (useTerra.getState().appMode === "code") {
        useTerra.getState().exitCodeMode();
      }
    };
    clearStaleCodeMode();
    return useTerra.subscribe(clearStaleCodeMode);
  }, []);

  // ⌘N / Ctrl+N starts a new conversation.
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

      {/* Main column — the Terra agent. OnyxCode has its own shell at /code. */}
      <main className="relative h-full min-w-0 flex-1">
        <div className="terra-scroll flex h-full flex-col overflow-y-auto">
          <TopBar />
          <Thread />
          <Composer />
        </div>
      </main>

      <SettingsSheet />
    </div>
  );
}

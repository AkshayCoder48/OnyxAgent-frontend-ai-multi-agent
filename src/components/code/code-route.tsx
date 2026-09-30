"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { CodeShell } from "@/components/code/code-shell";
import { tabFromPathname } from "@/components/code/code-paths";
import { SettingsSheet } from "@/components/terra/settings-sheet";
import { Sidebar, SidebarContent } from "@/components/terra/sidebar";
import { useTerra } from "@/components/terra/store";

/**
 * Route-driven frame for the OnyxCode pages (/code, /code/database,
 * /code/preview). The URL decides the active tab; the shared store is kept
 * in sync so every Code Mode surface (sidebar, tool cards, settings)
 * observes the same state. Entering any /code* URL engages Code Mode —
 * same runtime, same settings, same conversations, just the OnyxCode shell.
 */
export function CodeRoute() {
  const router = useRouter();
  const pathname = usePathname();

  const mobileNavOpen = useTerra((s) => s.mobileNavOpen);
  const setMobileNav = useTerra((s) => s.setMobileNav);
  const newConversation = useTerra((s) => s.newConversation);
  const hydrate = useTerra((s) => s.hydrate);

  // The tab comes from the URL at render time — no flash of a stale tab.
  const tab = tabFromPathname(pathname);

  // Restore the local snapshot instantly, then reconcile with the cloud.
  useEffect(() => {
    hydrate();
  }, [hydrate]);

  // Any /code* URL engages Code Mode (idempotent — it reuses the active app
  // or the most recent code conversation).
  useEffect(() => {
    useTerra.getState().enterCodeMode();
  }, []);

  // The route is the source of truth for the tab. enterCodeMode resets the
  // store to "chat", so re-assert the route's tab on every mount.
  useEffect(() => {
    if (useTerra.getState().codeTab !== tab) {
      useTerra.getState().setCodeTab(tab);
    }
  }, [tab]);

  // If anything flips the app back to agent mode while on /code* (wordmark,
  // settings toggle, sidebar), return to the Terra home route.
  useEffect(() => {
    const unsub = useTerra.subscribe((state, prev) => {
      if (state.appMode === "agent" && prev.appMode === "code") router.push("/");
    });
    return unsub;
  }, [router]);

  // ⌘N / Ctrl+N starts a new app (Code Mode is mode-aware).
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
          <SheetTitle className="sr-only">OnyxCode navigation</SheetTitle>
          <SheetDescription className="sr-only">Apps, database and account</SheetDescription>
          <SidebarContent onNavigate={() => setMobileNav(false)} />
        </SheetContent>
      </Sheet>

      {/* Main column — OnyxCode shell (Chat / Database / Preview) */}
      <main className="relative h-full min-w-0 flex-1">
        <CodeShell tab={tab} />
      </main>

      <SettingsSheet />
    </div>
  );
}

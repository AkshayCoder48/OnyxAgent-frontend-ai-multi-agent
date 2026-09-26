"use client";

import { useEffect, useState } from "react";
import { Bug } from "lucide-react";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { installGlobalErrorCapture } from "@/lib/client-logger";
import { LogsViewer } from "@/components/dev/logs-viewer";
import { useLogStore } from "@/stores/log-store";

/**
 * ErrorLogCollector — a singleton mounted once in Providers.
 *
 * 1. Installs the global error nets (window.onerror, unhandled rejections,
 *    resource load failures) so NOTHING crashes silently.
 * 2. Renders the floating Logs button (bottom-left, above the mobile tab
 *    bar) with a red badge counting unseen errors. Works on every page —
 *    including Settings, where provider test failures happen. Clicking it
 *    opens the full LogsViewer in a drawer.
 *
 * The chat page additionally docks the same LogsViewer as a side panel.
 */

export function ErrorLogCollector() {
  const [open, setOpen] = useState(false);
  const unseen = useLogStore((s) => s.unseenErrors);
  const markSeen = useLogStore((s) => s.markSeen);

  useEffect(() => {
    installGlobalErrorCapture();
  }, []);

  const openLogs = () => {
    setOpen(true);
    markSeen();
  };

  return (
    <>
      <button
        type="button"
        onClick={openLogs}
        aria-label={`Open error logs${unseen > 0 ? ` (${unseen} unseen errors)` : ""}`}
        title="Error logs"
        className={
          "bg-card text-muted-foreground hover:text-foreground fixed bottom-20 left-4 z-40 flex h-10 w-10 items-center justify-center rounded-full border shadow-lg backdrop-blur transition-all hover:scale-105 active:scale-95 " +
          // bottom-20 clears the Next.js dev indicator (dev-only) AND the
          // mobile tab bar; in production it simply sits comfortably low.
          (unseen > 0 ? "border-destructive/50 text-destructive" : "border-border")
        }
      >
        <Bug className="h-[18px] w-[18px]" aria-hidden />
        {unseen > 0 && (
          <span className="bg-destructive text-destructive-foreground absolute -top-1 -right-1 flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1 font-mono text-[10px] leading-none font-bold">
            {unseen > 99 ? "99+" : unseen}
          </span>
        )}
      </button>

      <Sheet
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (o) markSeen();
        }}
      >
        <SheetContent
          side="right"
          className="border-border flex flex-col border-l p-0 sm:max-w-md w-[92vw]"
        >
          <LogsViewer />
        </SheetContent>
      </Sheet>
    </>
  );
}

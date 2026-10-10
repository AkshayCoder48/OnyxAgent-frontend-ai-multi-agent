"use client";

import { Clock, Menu, MoreHorizontal, Share2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTerra } from "./store";

const ICON_BUTTON =
  "flex h-9 w-9 items-center justify-center rounded-lg text-ink-soft transition-colors hover:bg-terra-soft hover:text-ink";

export function TopBar() {
  const booted = useTerra((s) => s.booted);
  const title = useTerra(
    (s) => s.conversations.find((c) => c.id === s.activeId)?.title ?? "Terra",
  );
  const setMobileNav = useTerra((s) => s.setMobileNav);

  return (
    <div className="terra-glass sticky top-0 z-10 flex h-14 shrink-0 items-center gap-1 border-b border-hairline px-3 sm:px-4">
      <button
        type="button"
        onClick={() => setMobileNav(true)}
        aria-label="Open navigation"
        title="Navigation"
        className={cn(ICON_BUTTON, "md:hidden")}
      >
        <Menu className="h-5 w-5" aria-hidden />
      </button>
      <h1 className="truncate pl-1 font-serif text-[18px] font-semibold text-ink">{booted ? title : "Terra"}</h1>
      <div className="ml-auto flex items-center gap-0.5">
        <button type="button" aria-label="Conversation history" title="History" className={ICON_BUTTON}>
          <Clock className="h-[18px] w-[18px]" aria-hidden />
        </button>
        <button type="button" aria-label="Share conversation" title="Share" className={ICON_BUTTON}>
          <Share2 className="h-[18px] w-[18px]" aria-hidden />
        </button>
        <button type="button" aria-label="More options" title="More" className={ICON_BUTTON}>
          <MoreHorizontal className="h-[18px] w-[18px]" aria-hidden />
        </button>
      </div>
    </div>
  );
}

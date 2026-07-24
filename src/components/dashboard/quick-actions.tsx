import Link from "next/link";
import { MessageSquare, Settings, Wrench } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { ROUTES } from "@/lib/constants";
import { cn } from "@/lib/utils";

interface Action {
  label: string;
  icon: LucideIcon;
  href: string;
  external?: boolean;
  featured?: boolean;
}

// Backendless mode has no API docs endpoint to link to — dropped the
// "API docs" pill entirely. Only in-app destinations remain.
const ACTIONS: Action[] = [
  { label: "Start a chat", icon: MessageSquare, href: ROUTES.CHAT, featured: true },
  { label: "Skills", icon: Wrench, href: ROUTES.SETTINGS_SKILLS },
  { label: "Settings", icon: Settings, href: ROUTES.SETTINGS },
];

export function QuickActions() {
  return (
    <div className="border-border bg-card rounded-xl border p-4 sm:p-5">
      <h2 className="text-foreground/55 mb-2.5 font-mono text-[11px] tracking-wider uppercase">
        Quick actions
      </h2>
      <div className="flex flex-wrap gap-1.5">
        {ACTIONS.map((action) => (
          <ActionPill key={action.label} action={action} />
        ))}
      </div>
    </div>
  );
}

function ActionPill({ action }: { action: Action }) {
  const inner = (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
        action.featured
          ? "bg-foreground text-background border-foreground hover:bg-foreground/90"
          : "border-foreground/15 text-foreground hover:border-foreground/40 hover:bg-foreground/[0.04]",
      )}
    >
      <action.icon className="h-3.5 w-3.5 shrink-0" />
      {action.label}
    </span>
  );

  if (action.external) {
    return (
      <a href={action.href} target="_blank" rel="noopener noreferrer">
        {inner}
      </a>
    );
  }
  return <Link href={action.href}>{inner}</Link>;
}

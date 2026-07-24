"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import { APP_NAME, ROUTES } from "@/lib/constants";
import { LayoutDashboard, MessageSquare, UserCircle, Settings } from "lucide-react";
import { useSidebarStore } from "@/stores";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetClose } from "@/components/ui";

const navigation = [
  { nameKey: "dashboard", href: ROUTES.DASHBOARD, icon: LayoutDashboard },
  { nameKey: "chat", href: ROUTES.CHAT, icon: MessageSquare },
  { nameKey: "profile", href: ROUTES.PROFILE, icon: UserCircle },
  { nameKey: "settings", href: ROUTES.SETTINGS, icon: Settings },
];

function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const t = useTranslations("nav");

  return (
    <nav className="flex-1 space-y-1 p-4">
      {navigation.map((item) => {
        const isActive = pathname === item.href;
        return (
          <Link
            key={item.nameKey}
            href={item.href}
            onClick={onNavigate}
            className={cn(
              "flex items-center gap-3 rounded-lg px-3 py-3 text-sm font-medium transition-colors",
              "min-h-[44px]",
              isActive
                ? "bg-secondary text-secondary-foreground"
                : "text-muted-foreground hover:bg-secondary/50 hover:text-secondary-foreground",
            )}
          >
            <item.icon className="h-5 w-5" />
            {t(item.nameKey)}
          </Link>
        );
      })}
    </nav>
  );
}

export function Sidebar() {
  const { isOpen, close } = useSidebarStore();

  return (
    <Sheet open={isOpen} onOpenChange={close}>
      <SheetContent side="left" className="w-72 p-0">
        <SheetHeader className="h-14 px-4">
          <SheetTitle>{APP_NAME}</SheetTitle>
          <SheetClose onClick={close} />
        </SheetHeader>
        <NavLinks onNavigate={close} />
      </SheetContent>
    </Sheet>
  );
}

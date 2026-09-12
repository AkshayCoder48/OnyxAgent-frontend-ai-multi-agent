"use client";

// ============================================================================
// SchedulerHeartbeat — an invisible client component mounted once in the
// dashboard layout. While the app is open it POSTs /api/scheduler/tick every
// 60s (fire-and-forget, silent). When a tick FIRES a task or FINALIZES a
// finished run, it surfaces a toast (with a shortcut to /scheduled-tasks).
// Never throws — every failure is swallowed so it can never break a page.
// Exposes nothing; renders null.
// ============================================================================

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { CalendarClock } from "lucide-react";
import { useAuth } from "@/hooks";
import { tickHeartbeat } from "@/lib/scheduler/client";
import { ROUTES } from "@/lib/constants";

export function SchedulerHeartbeat() {
  // useAuth (not the raw store) — its mount effect runs authStore.init(),
  // which rehydrates the real user + vault before the first tick resolves
  // its key (the same cold-navigation race SectionCloudWorkspace documents).
  const { user } = useAuth();
  const router = useRouter();
  const userId = user?.id ?? null;

  useEffect(() => {
    if (!userId) return; // guard: only with a user

    let cancelled = false;

    const beat = async () => {
      try {
        const res = await tickHeartbeat(userId);
        if (cancelled || !res || !res.ok || !res.ticked) return;
        if (res.finalized > 0) {
          toast("Scheduled task finished — view it in Scheduled Tasks", {
            icon: <CalendarClock className="size-4" />,
            action: {
              label: "View",
              onClick: () => router.push(ROUTES.SCHEDULED_TASKS),
            },
          });
        } else if (res.fired > 0) {
          toast("A scheduled task just started", {
            icon: <CalendarClock className="size-4" />,
            description: "It runs in a background sandbox — progress lands in its run history.",
            action: {
              label: "View",
              onClick: () => router.push(ROUTES.SCHEDULED_TASKS),
            },
          });
        }
      } catch {
        // never throws — heartbeat is silent
      }
    };

    void beat();
    const id = window.setInterval(() => void beat(), 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [userId, router]);

  return null;
}

"use client";

// ============================================================================
// SchedulerHeartbeat — an invisible client component mounted once in the
// dashboard layout. While the app is open it POSTs /api/scheduler/tick every
// 60s (fire-and-forget, silent). When a tick FIRES a task or FINALIZES a
// finished run, it surfaces a toast pointing at the task's DEDICATED CHAT
// (chat-only model: executions and results land there — there is no separate
// task dashboard). Never throws — every failure is swallowed so it can never
// break a page. Exposes nothing; renders null.
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
    // When the last tick actually RAN (0 = never) — drives the catch-up
    // tick when the tab becomes visible again.
    let lastTickAt = 0;

    const beat = async () => {
      lastTickAt = Date.now();
      try {
        const res = await tickHeartbeat(userId);
        if (cancelled || !res || !res.ok || !res.ticked) return;
        if (res.finalized > 0) {
          toast("Scheduled task finished — the result landed in its chat", {
            icon: <CalendarClock className="size-4" />,
            action: {
              label: "Open chats",
              onClick: () => router.push(ROUTES.CHAT),
            },
          });
        } else if (res.fired > 0) {
          toast("A scheduled task just started", {
            icon: <CalendarClock className="size-4" />,
            description: "It runs in a background sandbox — progress lands in its dedicated chat.",
            action: {
              label: "Open chats",
              onClick: () => router.push(ROUTES.CHAT),
            },
          });
        }
      } catch {
        // never throws — heartbeat is silent
      }
    };

    // ── VISIBILITY GATING ────────────────────────────────────────────────
    // Background tabs skip every tick (no silent 60s POST /api/scheduler/
    // tick while the tab is hidden). On visibilitychange→visible, if a tick
    // was missed (last tick older than the interval — including "never",
    // when the app mounted hidden), fire ONE immediate catch-up tick; the
    // regular cadence resumes from there.
    const beatIfVisible = () => {
      if (document.visibilityState !== "visible") return;
      void beat();
    };

    beatIfVisible();
    const id = window.setInterval(beatIfVisible, 60_000);

    const onVisibilityChange = () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - lastTickAt > 60_000) void beat();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      cancelled = true;
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [userId, router]);

  return null;
}

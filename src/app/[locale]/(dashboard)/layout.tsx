import { Header } from "@/components/layout";
import { AuthGuard } from "@/components/layout/auth-guard";
import { PageTransition } from "@/components/layout/page-transition";

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <AuthGuard>
      {/* h-dvh (dynamic viewport height) instead of h-screen: on mobile,
          100vh includes the area behind the browser's collapsing address
          bar, which made the app taller than the real viewport — the page
          could then scroll at the BODY level alongside the chat container,
          producing the competing-scroll "viewport pushes up and down"
          jank during streaming (GenUI PRD §12). dvh tracks the live visual
          viewport, so the chat container is the ONLY scrollable surface. */}
      <div className="flex h-dvh flex-col">
        <Header />
        <main
          id="main"
          tabIndex={-1}
          className="relative flex min-h-0 flex-1 flex-col overflow-hidden"
        >
          {/*
            PAGE TRANSITIONS (Motion spec §3.3, mounted 2026-11-14): the
            component existed but was never wired into any layout — every
            dashboard route changed with a hard cut. One mount here covers
            every page: subtle fade + 6px rise, keyed on pathname (query
            params excluded, so conversation switches inside /chat do NOT
            re-key), disabled under prefers-reduced-motion via .page-enter.
          */}
          <PageTransition>{children}</PageTransition>
        </main>
      </div>
    </AuthGuard>
  );
}

import { Header } from "@/components/layout";
import { AuthGuard } from "@/components/layout/auth-guard";

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
          className="flex min-h-0 flex-1 flex-col overflow-hidden"
        >
          {children}
        </main>
      </div>
    </AuthGuard>
  );
}

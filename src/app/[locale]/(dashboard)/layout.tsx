import { Header } from "@/components/layout";
import { AuthGuard } from "@/components/layout/auth-guard";
import { SchedulerHeartbeat } from "@/components/scheduled/scheduler-heartbeat";
import { ServerChatSync } from "@/components/chat/server-chat-sync";
import { ExecutionRehydrator } from "@/components/chat/execution-rehydrator";
import { OnyxAiBridgeRuntime } from "@/components/onyxai/bridge-runtime-mount";

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
        {/* Invisible: keeps the server-side scheduler ticking every 60s while
            the app is open + toasts when tasks fire or finish. Renders null. */}
        <SchedulerHeartbeat />
        {/* Invisible: the browser half of the unified chat records — pulls
            server-appended messages (scheduled-run results) into Dexie/live
            store every 45s and mirrors the browser's chat state to the server
            on view-change / execution-finish. Renders null. */}
        <ServerChatSync />
        {/* Invisible: on app start, resumes EVERY persisted E2B background
            job (browser refresh must not terminate backend execution —
            spec §14). Renders null. */}
        <ExecutionRehydrator />
        {/* Invisible: the OnyxAI Browser Runtime — heartbeats presence and
            serves remote model calls (Telegram / scheduled tasks) against
            the user's local QVAC server while an app tab is open. Renders
            null. */}
        <OnyxAiBridgeRuntime />
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

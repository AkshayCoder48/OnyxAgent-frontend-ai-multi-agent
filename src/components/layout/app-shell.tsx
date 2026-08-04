"use client";

import * as React from "react";
import { Loader2 } from "lucide-react";
import { useAuthStore } from "@/stores/auth-store";
import { AuthScreen } from "@/components/auth/auth-screen";
import { OnboardingFlow } from "@/components/onboarding/onboarding-flow";
import { ChatContainer } from "@/components/chat/chat-container";
import { SettingsPage } from "@/components/settings/settings-page";
import { SharedView } from "@/components/chat/shared-view";

export function AppShell() {
  const init = useAuthStore((s) => s.init);
  const loading = useAuthStore((s) => s.isLoading);
  const user = useAuthStore((s) => s.user);
  const vaultUnlocked = useAuthStore((s) => s.vaultUnlocked);

  React.useEffect(() => {
    void init();
  }, [init]);

  // Check for ?share= URL param (shared conversation view, no auth needed)
  const [shareParam, setShareParam] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    const s = url.searchParams.get("share");
    if (s) setShareParam(s);
  }, []);

  if (shareParam) {
    return (
      <SharedView
        compressed={shareParam}
        onExit={() => {
          const url = new URL(window.location.href);
          url.searchParams.delete("share");
          window.history.replaceState({}, "", url.toString());
          setShareParam(null);
        }}
      />
    );
  }

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background text-muted-foreground">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="size-6 animate-spin" />
          <p className="text-sm">Loading your workspace…</p>
        </div>
      </div>
    );
  }

  if (!user || !vaultUnlocked) return <AuthScreen />;
  if (!user.onboarding_completed_at) return <OnboardingFlow />;

  return <MainApp />;
}

export default AppShell;

// ---------------------------------------------------------------------------
// MainApp — always renders ChatContainer (sidebar + chat view with empty state)
// Settings rendered as a full-screen overlay when requested
// ---------------------------------------------------------------------------
function MainApp() {
  const [settingsOpen, setSettingsOpen] = React.useState(false);

  if (settingsOpen) {
    return <SettingsPage onClose={() => setSettingsOpen(false)} />;
  }

  return <ChatContainer onOpenSettings={() => setSettingsOpen(true)} />;
}

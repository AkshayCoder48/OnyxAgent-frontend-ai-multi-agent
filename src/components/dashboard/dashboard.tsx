"use client";

import * as React from "react";
import { formatDistanceToNow } from "date-fns";
import {
  MessageSquare,
  MessagesSquare,
  Plug,
  Plus,
  Settings as SettingsIcon,
  Sparkles,
  ArrowRight,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";

import { db } from "@/lib/db/index";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { LoadingState } from "@/components/states/loading-state";

import { useAuthStore } from "@/stores/auth-store";
import { useConversations } from "@/hooks/use-conversations";
import type { Conversation } from "@/types";

export interface DashboardProps {
  /** Quick action: start a new chat. */
  onNewChat?: () => void;
  /** Quick action: open settings. */
  onOpenSettings?: () => void;
}

interface Stats {
  totalConversations: number;
  totalMessages: number;
  activeProviders: number;
}

async function fetchStats(userId: string): Promise<Stats> {
  const [totalConversations, totalMessages, activeProviders] = await Promise.all([
    db.conversations.where("user_id").equals(userId).count(),
    // Messages don't have user_id; join via conversations.
    (async () => {
      const convs = await db.conversations.where("user_id").equals(userId).toArray();
      if (convs.length === 0) return 0;
      const ids = convs.map((c) => c.id);
      return db.messages.where("conversation_id").anyOf(ids).count();
    })(),
    db.ai_providers.where("user_id").equals(userId).filter((p) => p.is_active).count(),
  ]);
  return { totalConversations, totalMessages, activeProviders };
}

// Page-load timestamp captured at module scope — reading the clock during
// render is impure (flagged by the React Compiler lint). The banner check
// below only needs "completed within 1h", and the memo recomputes solely
// when the user changes, so a load-time reference is equivalent.
const PAGE_LOADED_AT = Date.now();

export function Dashboard({ onNewChat, onOpenSettings }: DashboardProps) {
  const { user } = useAuthStore();
  const { conversations, selectConversation: select } = useConversations();

  const statsQuery = useQuery({
    queryKey: ["dashboard-stats", user?.id],
    queryFn: () => fetchStats(user!.id),
    enabled: !!user?.id,
    staleTime: 30_000,
  });

  // Onboarding banner: show only if completed within the last hour.
  const onboardingCompletedAt = user?.onboarding_completed_at;
  const showOnboardingBanner = React.useMemo(() => {
    if (!onboardingCompletedAt) return false;
    const completed = new Date(onboardingCompletedAt).getTime();
    if (Number.isNaN(completed)) return false;
    return PAGE_LOADED_AT - completed < 60 * 60 * 1000; // < 1h
  }, [onboardingCompletedAt]);

  const recent = React.useMemo<Conversation[]>(
    () => conversations.slice(0, 5),
    [conversations],
  );

  if (!user) {
    return <LoadingState label="Loading your dashboard…" className="min-h-[60vh]" />;
  }

  const stats = statsQuery.data;
  const statsLoading = statsQuery.isLoading;

  const greetingName = user.full_name?.trim() || user.email;

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 sm:py-10">
      {/* Header */}
      <header className="mb-6 flex flex-col gap-1 sm:mb-8">
        <p className="text-sm text-muted-foreground">Welcome back</p>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
          {greetingName}
        </h1>
        <p className="text-sm text-muted-foreground">
          Your conversations are stored locally in your browser. No server, no
          account, no telemetry.
        </p>
      </header>

      {/* Onboarding banner */}
      {showOnboardingBanner ? (
        <Card className="mb-6 border-primary/40 bg-primary/5 sm:mb-8">
          <CardContent className="flex flex-col items-start gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-3">
              <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                <Sparkles className="size-5" aria-hidden="true" />
              </div>
              <div className="space-y-0.5">
                <p className="text-sm font-semibold">
                  Welcome! Try creating your first chat.
                </p>
                <p className="text-xs text-muted-foreground">
                  Click “New chat” to start a conversation with your agent.
                  Configure a provider in Settings to enable AI responses.
                </p>
              </div>
            </div>
            <Button type="button" size="sm" onClick={onNewChat}>
              <Plus className="size-4" aria-hidden="true" />
              New chat
            </Button>
          </CardContent>
        </Card>
      ) : null}

      {/* Stat cards */}
      <section
        aria-label="Statistics"
        className="mb-6 grid grid-cols-1 gap-4 sm:mb-8 sm:grid-cols-3"
      >
        <StatCard
          label="Total conversations"
          icon={<MessageSquare className="size-4" aria-hidden="true" />}
          value={stats?.totalConversations}
          loading={statsLoading}
        />
        <StatCard
          label="Total messages"
          icon={<MessagesSquare className="size-4" aria-hidden="true" />}
          value={stats?.totalMessages}
          loading={statsLoading}
        />
        <StatCard
          label="Active providers"
          icon={<Plug className="size-4" aria-hidden="true" />}
          value={stats?.activeProviders}
          loading={statsLoading}
        />
      </section>

      {/* Quick actions */}
      <section aria-label="Quick actions" className="mb-6 sm:mb-8">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Card className="hover:border-primary/40 transition-colors">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Plus className="size-4" aria-hidden="true" />
                New chat
              </CardTitle>
              <CardDescription>
                Start a fresh conversation with your agent.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button type="button" onClick={onNewChat}>
                Start now
                <ArrowRight className="size-4" aria-hidden="true" />
              </Button>
            </CardContent>
          </Card>

          <Card className="hover:border-primary/40 transition-colors">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <SettingsIcon className="size-4" aria-hidden="true" />
                Browse settings
              </CardTitle>
              <CardDescription>
                Manage providers, slash commands, MCP servers, and tools.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button type="button" variant="outline" onClick={onOpenSettings}>
                Open settings
                <ArrowRight className="size-4" aria-hidden="true" />
              </Button>
            </CardContent>
          </Card>
        </div>
      </section>

      {/* Recent activity */}
      <section aria-label="Recent activity">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-foreground">Recent activity</h2>
          {recent.length > 0 ? (
            <Badge variant="secondary" className="text-[11px]">
              Last {recent.length}
            </Badge>
          ) : null}
        </div>

        {conversations.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
              <div className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
                <MessageSquare className="size-5" aria-hidden="true" />
              </div>
              <div className="space-y-1">
                <p className="text-sm font-medium">No conversations yet</p>
                <p className="text-xs text-muted-foreground">
                  Start your first chat to see it here.
                </p>
              </div>
              <Button type="button" size="sm" variant="outline" onClick={onNewChat}>
                <Plus className="size-4" aria-hidden="true" />
                New chat
              </Button>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <ul className="divide-y">
              {recent.map((conv) => (
                <li key={conv.id}>
                  <button
                    type="button"
                    onClick={() => select(conv.id)}
                    className={cn(
                      "flex w-full items-center gap-3 px-4 py-3 text-left",
                      "hover:bg-accent transition-colors",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                    )}
                  >
                    <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                      <MessageSquare className="size-4" aria-hidden="true" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-foreground">
                        {conv.title}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        Updated{" "}
                        {formatDistanceToNow(new Date(conv.updated_at), {
                          addSuffix: true,
                        })}
                      </p>
                    </div>
                    <ArrowRight
                      className="size-4 shrink-0 text-muted-foreground"
                      aria-hidden="true"
                    />
                  </button>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </section>
    </div>
  );
}

interface StatCardProps {
  label: string;
  icon: React.ReactNode;
  value?: number;
  loading?: boolean;
}

function StatCard({ label, icon, value, loading }: StatCardProps) {
  return (
    <Card>
      <CardHeader>
        <CardDescription className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide">
          {icon}
          {label}
        </CardDescription>
        <CardTitle className="text-3xl font-semibold tabular-nums">
          {loading ? (
            <Skeleton className="h-8 w-16" />
          ) : (
            (value ?? 0).toLocaleString()
          )}
        </CardTitle>
      </CardHeader>
    </Card>
  );
}

export default Dashboard;

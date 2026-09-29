"use client";

import { useState, type ReactNode } from "react";
import {
  Bell,
  Bot,
  Brain,
  Cable,
  Cloud,
  CloudOff,
  Database,
  FileJson,
  KeyRound,
  Loader2,
  Lock,
  Palette,
  RefreshCw,
  Route,
  Sparkles,
  SquareSlash,
  Type,
  Wrench,
  Zap,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { useTerra } from "./store";

function SettingsGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="py-6 first:pt-0 last:pb-0">
      <h3 className="mb-3 flex items-center gap-2 font-serif text-[14px] font-semibold text-ink">
        <span className="h-4 w-[3px] rounded-full bg-terra" aria-hidden />
        {title}
      </h3>
      <div className="divide-y divide-hairline overflow-hidden rounded-xl border border-hairline bg-paper">
        {children}
      </div>
    </section>
  );
}

function RowIcon({ children }: { children: ReactNode }) {
  return (
    <span
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-terra-soft-border bg-terra-soft"
      aria-hidden
    >
      {children}
    </span>
  );
}

function InfoRow({
  icon,
  name,
  description,
  value,
}: {
  icon: ReactNode;
  name: string;
  description: string;
  value: ReactNode;
}) {
  return (
    <div className="flex min-h-14 items-center gap-3 px-4 py-3">
      <RowIcon>{icon}</RowIcon>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-ink">{name}</p>
        <p className="text-[12px] leading-snug text-ink-muted">{description}</p>
      </div>
      <span className="shrink-0 text-[12px] text-ink-muted">{value}</span>
    </div>
  );
}

function relativeTime(at: number | null): string {
  if (at === null) return "never";
  const seconds = Math.max(0, (Date.now() - at) / 1000);
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${Math.floor(seconds)}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

function CloudSyncSection() {
  const syncStatus = useTerra((s) => s.syncStatus);
  const lastSyncedAt = useTerra((s) => s.lastSyncedAt);
  const autoSync = useTerra((s) => s.autoSync);
  const setAutoSync = useTerra((s) => s.setAutoSync);
  const pullSync = useTerra((s) => s.pullSync);
  const pushSync = useTerra((s) => s.pushSync);
  const conversations = useTerra((s) => s.conversations);

  const busy = syncStatus === "syncing";
  const offline = syncStatus === "offline" || syncStatus === "error";
  const statusLabel = busy
    ? "Syncing…"
    : offline
      ? "Offline — will retry"
      : autoSync
        ? "Up to date"
        : "Paused";

  let snapshotKb = "—";
  try {
    const raw = window.localStorage.getItem("terra.v1.snapshot");
    snapshotKb = raw ? `${Math.max(1, Math.round(raw.length / 1024))} KB` : "empty";
  } catch {
    snapshotKb = "unavailable";
  }

  const onSyncNow = () => {
    if (busy) return;
    void pullSync().then(() => {
      void pushSync();
      toast("Cloud sync complete");
    });
  };

  return (
    <SettingsGroup title="Cloud sync">
      <InfoRow
        icon={
          offline ? (
            <CloudOff className="h-4 w-4 text-terra" />
          ) : busy ? (
            <Loader2 className="h-4 w-4 animate-spin text-terra" />
          ) : (
            <Cloud className="h-4 w-4 text-terra" />
          )
        }
        name={statusLabel}
        description={`Conversations sync to the cloud · last sync ${relativeTime(lastSyncedAt)}`}
        value={`${conversations.length} chats`}
      />
      <div className="flex min-h-14 items-center gap-3 px-4 py-3">
        <RowIcon>
          <RefreshCw className="h-4 w-4 text-terra" />
        </RowIcon>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-ink">Auto-sync</p>
          <p className="text-[12px] leading-snug text-ink-muted">
            Push changes as you type, pull on return
          </p>
        </div>
        <Switch
          checked={autoSync}
          onCheckedChange={(checked) => {
            setAutoSync(checked);
            toast(`Auto-sync ${checked ? "enabled" : "disabled"}`);
          }}
          aria-label="Toggle auto-sync"
        />
      </div>
      <div className="flex min-h-14 items-center gap-3 px-4 py-3">
        <RowIcon>
          <Database className="h-4 w-4 text-terra" />
        </RowIcon>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-ink">Local snapshot</p>
          <p className="text-[12px] leading-snug text-ink-muted">
            Instant-restore cache on this device
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={onSyncNow}
          disabled={busy}
          className="h-8 border-hairline bg-background px-3 text-[12px] text-ink-soft hover:bg-terra-soft hover:text-terra"
        >
          {busy ? "Syncing…" : "Sync now"}
        </Button>
      </div>
      <InfoRow
        icon={<Database className="h-4 w-4 text-terra" />}
        name="Snapshot size"
        description="Local storage footprint"
        value={snapshotKb}
      />
    </SettingsGroup>
  );
}

function ModelRouterSection() {
  const modelId = useTerra((s) => s.modelId);
  const setModel = useTerra((s) => s.setModel);
  const routeStats = useTerra((s) => s.routeStats);
  const autoRouting = modelId === "auto";

  const total = routeStats.fast + routeStats.balanced + routeStats.deep;

  return (
    <SettingsGroup title="Model router">
      <div className="flex min-h-14 items-center gap-3 px-4 py-3">
        <RowIcon>
          <Route className="h-4 w-4 text-terra" />
        </RowIcon>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-ink">Auto routing</p>
          <p className="text-[12px] leading-snug text-ink-muted">
            Picks fast, balanced or deep per message
          </p>
        </div>
        <Switch
          checked={autoRouting}
          onCheckedChange={(checked) => {
            setModel(checked ? "auto" : "balanced");
            toast(checked ? "Router on — profiles chosen automatically" : "Router off — using Terra 1.5");
          }}
          aria-label="Toggle automatic model routing"
        />
      </div>
      <InfoRow
        icon={<Sparkles className="h-4 w-4 text-terra" />}
        name="Routing history"
        description="How the router has classified your messages"
        value={
          <span className="flex items-center gap-2 font-mono text-[11px]">
            <span className="inline-flex items-center gap-1">
              <Zap className="h-3 w-3 text-[#8A7E6C]" aria-hidden />
              {routeStats.fast}
            </span>
            <span className="inline-flex items-center gap-1">
              <Route className="h-3 w-3 text-terra" aria-hidden />
              {routeStats.balanced}
            </span>
            <span className="inline-flex items-center gap-1">
              <Brain className="h-3 w-3 text-terra-deep" aria-hidden />
              {routeStats.deep}
            </span>
          </span>
        }
      />
      <InfoRow
        icon={<Brain className="h-4 w-4 text-terra" />}
        name="Current profile"
        description={
          total === 0
            ? "Send a message to see routing in action"
            : "Each reply carries its route — see the badge beside Terra's name"
        }
        value={autoRouting ? "Auto" : modelId === "fast" ? "Fast" : modelId === "deep" ? "Deep" : "Balanced"}
      />
    </SettingsGroup>
  );
}

function LocalToggleRow({
  icon,
  name,
  description,
  defaultOn,
}: {
  icon: ReactNode;
  name: string;
  description: string;
  defaultOn: boolean;
}) {
  const [on, setOn] = useState(defaultOn);
  return (
    <div className="flex min-h-14 items-center gap-3 px-4 py-3">
      <RowIcon>{icon}</RowIcon>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-ink">{name}</p>
        <p className="text-[12px] leading-snug text-ink-muted">{description}</p>
      </div>
      <Switch
        checked={on}
        onCheckedChange={(checked) => {
          setOn(checked);
          toast(`${name} ${checked ? "enabled" : "disabled"}`);
        }}
        aria-label={`Toggle ${name}`}
      />
    </div>
  );
}

export function SettingsSheet() {
  const open = useTerra((s) => s.settingsOpen);
  const setOpen = useTerra((s) => s.setSettingsOpen);
  const [density, setDensity] = useState("comfortable");
  const [fontSize, setFontSize] = useState(15);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetContent side="right" className="terra-scroll w-full gap-0 overflow-y-auto border-hairline p-0 sm:max-w-md">
        <SheetHeader className="border-b border-hairline px-5 py-4">
          <SheetTitle className="font-serif text-xl font-semibold text-ink">Settings</SheetTitle>
          <SheetDescription className="text-[13px] text-ink-muted">
            Preferences for your Terra workspace.
          </SheetDescription>
        </SheetHeader>

        <div className="divide-y divide-hairline px-5 py-5">
          {/* Account */}
          <SettingsGroup title="Account">
            <div className="space-y-1.5 px-4 py-3">
              <label htmlFor="terra-settings-name" className="text-[12px] font-medium text-ink-soft">
                Name
              </label>
              <Input id="terra-settings-name" defaultValue="Terra Lopez" className="h-9 bg-background" />
            </div>
            <div className="space-y-1.5 px-4 py-3">
              <label htmlFor="terra-settings-email" className="text-[12px] font-medium text-ink-soft">
                Email
              </label>
              <Input
                id="terra-settings-email"
                type="email"
                defaultValue="terra.lopez@editorial.studio"
                className="h-9 bg-background"
              />
            </div>
            <LocalToggleRow
              icon={<Bell className="h-4 w-4 text-terra" />}
              name="Notifications"
              description="Digest of shared threads and mentions"
              defaultOn
            />
          </SettingsGroup>

          {/* Cloud sync */}
          <CloudSyncSection />

          {/* Model router */}
          <ModelRouterSection />

          {/* Appearance */}
          <SettingsGroup title="Appearance">
            <div className="flex min-h-14 items-center gap-3 px-4 py-3">
              <RowIcon>
                <Palette className="h-4 w-4 text-terra" />
              </RowIcon>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-ink">Theme</p>
                <p className="text-[12px] leading-snug text-ink-muted">Editorial light</p>
              </div>
              <Select defaultValue="light" aria-label="Theme">
                <SelectTrigger className="h-9 w-[128px] bg-background text-[13px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="light">Light</SelectItem>
                </SelectContent>
              </Select>
              <Lock className="h-3 w-3 shrink-0 text-ink-muted" aria-label="Theme locked to light" />
            </div>
            <div className="flex min-h-14 items-center gap-3 px-4 py-3">
              <RowIcon>
                <Sparkles className="h-4 w-4 text-terra" />
              </RowIcon>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-ink">Density</p>
                <p className="text-[12px] leading-snug text-ink-muted">Row height across the app</p>
              </div>
              <Select value={density} onValueChange={setDensity} aria-label="Density">
                <SelectTrigger className="h-9 w-[128px] bg-background text-[13px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="comfortable">Comfortable</SelectItem>
                  <SelectItem value="compact">Compact</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="px-4 py-3.5">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-3">
                  <RowIcon>
                    <Type className="h-4 w-4 text-terra" />
                  </RowIcon>
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-ink">Font size</p>
                    <p className="text-[12px] leading-snug text-ink-muted">Thread text scale</p>
                  </div>
                </div>
                <span className="shrink-0 font-mono text-xs text-ink-muted">{fontSize}px</span>
              </div>
              <Slider
                value={[fontSize]}
                onValueChange={(values) => setFontSize(values[0] ?? 15)}
                min={13}
                max={18}
                step={1}
                aria-label="Font size"
              />
            </div>
          </SettingsGroup>

          {/* Agents & Tools — consolidated into one group */}
          <SettingsGroup title="Agents & Tools">
            <LocalToggleRow
              icon={<Wrench className="h-4 w-4 text-terra" />}
              name="Tools"
              description="Web search, code interpreter, file tools"
              defaultOn
            />
            <LocalToggleRow
              icon={<Bot className="h-4 w-4 text-terra" />}
              name="Subagents"
              description="Specialized agents for research and drafts"
              defaultOn
            />
            <LocalToggleRow
              icon={<Sparkles className="h-4 w-4 text-terra" />}
              name="Skills"
              description="Reusable prompt skills from the library"
              defaultOn={false}
            />
            <LocalToggleRow
              icon={<Cable className="h-4 w-4 text-terra" />}
              name="MCPs"
              description="Model context protocol servers"
              defaultOn={false}
            />
            <LocalToggleRow
              icon={<SquareSlash className="h-4 w-4 text-terra" />}
              name="Slash commands"
              description="Custom shortcuts in the composer"
              defaultOn
            />
          </SettingsGroup>

          {/* Advanced */}
          <SettingsGroup title="Advanced">
            <InfoRow
              icon={<KeyRound className="h-4 w-4 text-terra" />}
              name="Environment variables"
              description="Secrets injected into agent runtimes"
              value="4 configured"
            />
            <InfoRow
              icon={<FileJson className="h-4 w-4 text-terra" />}
              name="Config"
              description="terra.config.json · workspace defaults"
              value="Edited 2h ago"
            />
          </SettingsGroup>
        </div>
      </SheetContent>
    </Sheet>
  );
}

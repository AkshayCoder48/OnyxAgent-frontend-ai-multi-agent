"use client";

import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import {
  Bell,
  Bot,
  Cable,
  FileJson,
  KeyRound,
  Lock,
  Palette,
  Sparkles,
  SquareSlash,
  Type,
  Wrench,
} from "lucide-react";
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

function ToggleRow({
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

function InfoRow({
  icon,
  name,
  description,
  value,
}: {
  icon: ReactNode;
  name: string;
  description: string;
  value: string;
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

export function SettingsSheet() {
  const open = useTerra((s) => s.settingsOpen);
  const setOpen = useTerra((s) => s.setSettingsOpen);
  const [notifications, setNotifications] = useState(true);
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
            <div className="flex min-h-14 items-center gap-3 px-4 py-3">
              <RowIcon>
                <Bell className="h-4 w-4 text-terra" />
              </RowIcon>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-ink">Notifications</p>
                <p className="text-[12px] leading-snug text-ink-muted">
                  Digest of shared threads and mentions
                </p>
              </div>
              <Switch
                checked={notifications}
                onCheckedChange={(checked) => {
                  setNotifications(checked);
                  toast(`Notifications ${checked ? "enabled" : "disabled"}`);
                }}
                aria-label="Toggle notifications"
              />
            </div>
          </SettingsGroup>

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
            <ToggleRow
              icon={<Wrench className="h-4 w-4 text-terra" />}
              name="Tools"
              description="Web search, code interpreter, file tools"
              defaultOn
            />
            <ToggleRow
              icon={<Bot className="h-4 w-4 text-terra" />}
              name="Subagents"
              description="Specialized agents for research and drafts"
              defaultOn
            />
            <ToggleRow
              icon={<Sparkles className="h-4 w-4 text-terra" />}
              name="Skills"
              description="Reusable prompt skills from the library"
              defaultOn={false}
            />
            <ToggleRow
              icon={<Cable className="h-4 w-4 text-terra" />}
              name="MCPs"
              description="Model context protocol servers"
              defaultOn={false}
            />
            <ToggleRow
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

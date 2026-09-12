"use client";

// ============================================================================
// TaskFormDialog — create / edit a scheduled task.
//
// Schedule type drives dynamic fields (once → datetime-local, interval →
// minutes, daily → HH:MM, weekly → weekday chips + time, monthly → day + time,
// cron → raw expression). The timezone Select defaults to the browser's zone
// and offers common IANA zones (Asia/Kolkata first). A live PREVIEW line
// computes the next run with the same math the server uses (tz-cron).
// ============================================================================

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { CalendarClock, Globe, Info, Loader2, MessageSquare, Save, Send } from "lucide-react";
import { Button } from "@/components/ui";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui";
import { Input } from "@/components/ui";
import { Label } from "@/components/ui";
import { Switch } from "@/components/ui";
import { Textarea } from "@/components/ui";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui";
import { cn } from "@/lib/utils";
import { computeNextRun, normalizeSchedule } from "@/lib/scheduler/tz-cron";
import type {
  CreateTaskPayload,
  SafeScheduledTask,
  ScheduleType,
  TaskSchedule,
} from "@/lib/scheduler/types";
import {
  buildChatContext,
  DEFAULT_CHAT_TASK_INSTRUCTIONS,
} from "@/lib/scheduler/chat-context";
import {
  addLinkedChat,
  mirrorChatToServer,
  removeLinkedChat,
} from "@/lib/scheduler/chat-sync";
import { schedulerApi, getTelegramStatus, resolveProviderSnapshot } from "@/lib/scheduler/client";
import { ROUTES } from "@/lib/constants";
import type { Conversation } from "@/types";
import { formatNextRun, formatRelativeAgo } from "./time-format";

const BROWSER_TZ = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
})();

/** The chat context payload attached to creates (shared shape). */
type CreateTaskPayloadChatContext = CreateTaskPayload["chatContext"];

// Common IANA zones — Asia/Kolkata first, then the global spread.
const COMMON_TZ = [
  "Asia/Kolkata",
  "UTC",
  "America/New_York",
  "America/Los_Angeles",
  "Europe/London",
  "Europe/Berlin",
  "Asia/Tokyo",
  "Asia/Singapore",
  "Asia/Dubai",
  "Australia/Sydney",
];

const SCHEDULE_TYPES: { value: ScheduleType; label: string }[] = [
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
  { value: "interval", label: "Interval" },
  { value: "once", label: "One time" },
  { value: "cron", label: "Cron" },
];

const WEEKDAY_LABELS = ["S", "M", "T", "W", "T", "F", "S"];

function isoToLocalInput(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

interface FormState {
  name: string;
  description: string;
  instructions: string;
  /** UNIFIED CHAT MODE: the conversation the schedule attaches to ("" =
   *  standalone instructions). */
  chatId: string;
  type: ScheduleType;
  onceAt: string;
  intervalMinutes: string;
  dailyTime: string;
  weeklyDays: number[];
  weeklyTime: string;
  monthlyDay: string;
  monthlyTime: string;
  cronExpression: string;
  timezone: string;
  enabled: boolean;
  notifyTelegram: boolean;
}

function initialState(task: SafeScheduledTask | null): FormState {
  if (!task) {
    return {
      name: "",
      description: "",
      instructions: "",
      chatId: "",
      type: "daily",
      onceAt: "",
      intervalMinutes: "30",
      dailyTime: "09:00",
      weeklyDays: [1],
      weeklyTime: "09:00",
      monthlyDay: "1",
      monthlyTime: "09:00",
      cronExpression: "",
      timezone: BROWSER_TZ,
      enabled: true,
      notifyTelegram: true,
    };
  }
  const meta = task.scheduleMeta ?? {};
  return {
    name: task.name,
    description: task.description ?? "",
    instructions: task.instructions,
    chatId: task.chatId ?? "",
    type: task.scheduleType,
    onceAt: isoToLocalInput(task.scheduleExpression),
    intervalMinutes: String(Math.max(1, Math.round((meta.intervalSec ?? 3600) / 60))),
    dailyTime: (meta.time ?? task.scheduleExpression ?? "09:00").trim(),
    weeklyDays: meta.weekdays?.length ? meta.weekdays : [1],
    weeklyTime: (meta.time ?? "09:00").trim(),
    monthlyDay: String(meta.dayOfMonth ?? 1),
    monthlyTime: (meta.time ?? "09:00").trim(),
    cronExpression: task.scheduleType === "cron" ? task.scheduleExpression : "",
    timezone: task.timezone || BROWSER_TZ,
    enabled: task.enabled,
    notifyTelegram: task.notificationConfig?.telegram !== false,
  };
}

interface TaskFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Existing task when editing; null when creating. */
  task: SafeScheduledTask | null;
  userId: string;
  /** Current task list (used to keep the chat-link registry accurate when
   *  re-attaching a conversation another task might still reference). */
  tasks?: SafeScheduledTask[];
  onSaved: (saved: SafeScheduledTask) => void;
}

export function TaskFormDialog({
  open,
  onOpenChange,
  task,
  userId,
  tasks,
  onSaved,
}: TaskFormDialogProps) {
  const [form, setForm] = useState<FormState>(() => initialState(task));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [telegramConnected, setTelegramConnected] = useState<boolean | null>(null);
  /** Conversations for the "Run in chat" picker (fetched on dialog open). */
  const [conversations, setConversations] = useState<Conversation[] | null>(null);
  const /** one-shot guard so the create-mode default (most recent conversation)
      applies only once per dialog open, never over a user's explicit choice */
    chatTouchedRef = useRef(false);

  // Reset whenever the dialog (re)opens for a task.
  useEffect(() => {
    if (open) {
      setForm(initialState(task));
      setError(null);
      setConversations(null);
      chatTouchedRef.current = false;
    }
  }, [open, task]);

  // Telegram connection hint (no secrets — masked status only).
  useEffect(() => {
    if (!open || !userId) return;
    let cancelled = false;
    (async () => {
      const res = await getTelegramStatus(userId);
      if (cancelled) return;
      setTelegramConnected(res.ok && !!res.telegram?.connected);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, userId]);

  // Conversations for the "Run in chat" picker — fetched when the dialog
  // opens (newest first). Chat mode is the primary flow, so CREATE defaults
  // to the most recent conversation; editing preselects the task's chat.
  useEffect(() => {
    if (!open || !userId) return;
    let cancelled = false;
    (async () => {
      try {
        const { conversationService } = await import("@/lib/services");
        const list = await conversationService.list(userId, { limit: 30 });
        if (cancelled) return;
        setConversations(list);
        // Default: the most recent conversation when creating (chat mode is
        // the primary flow) — only when the user hasn't picked anything yet.
        if (!task && !chatTouchedRef.current && list.length > 0) {
          setForm((f) => (f.chatId === "" ? { ...f, chatId: list[0]!.id } : f));
        }
      } catch {
        if (!cancelled) setConversations([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, userId, task]);

  const patch = (p: Partial<FormState>) => setForm((f) => ({ ...f, ...p }));

  const schedulePayload: TaskSchedule = useMemo(() => {
    switch (form.type) {
      case "once":
        return { type: "once", expression: form.onceAt ? new Date(form.onceAt).toISOString() : "", timezone: form.timezone };
      case "interval":
        return {
          type: "interval",
          expression: String(Math.max(60, Math.round((Number(form.intervalMinutes) || 0) * 60))),
          timezone: form.timezone,
        };
      case "daily":
        return { type: "daily", expression: form.dailyTime, timezone: form.timezone };
      case "weekly":
        return {
          type: "weekly",
          expression: (form.weeklyDays.length ? [...form.weeklyDays].sort() : [1]).join(","),
          time: form.weeklyTime,
          timezone: form.timezone,
        };
      case "monthly":
        return { type: "monthly", expression: form.monthlyDay, time: form.monthlyTime, timezone: form.timezone };
      case "cron":
        return { type: "cron", expression: form.cronExpression.trim(), timezone: form.timezone };
    }
  }, [form]);

  // Live next-run preview — same math the server runs (tz-cron).
  const preview = useMemo(() => {
    try {
      const norm = normalizeSchedule(schedulePayload);
      const ts = computeNextRun(
        { ...norm, time: schedulePayload.time, timezone: form.timezone },
        norm.meta,
        Date.now(),
      );
      if (ts == null) return "No upcoming run";
      return `Next run: ${formatNextRun(ts, form.timezone)}`;
    } catch {
      return "Invalid schedule expression";
    }
  }, [schedulePayload, form.timezone]);

  function validate(): string | null {
    if (!form.name.trim()) return "Give the task a name.";
    // With a chat attached, instructions are OPTIONAL (the standing-task
    // default continues the conversation); standalone mode requires them.
    if (!form.chatId && !form.instructions.trim()) {
      return "Instructions are required — they are the complete job the agent runs unattended.";
    }
    switch (form.type) {
      case "once":
        if (!form.onceAt || Number.isNaN(new Date(form.onceAt).getTime())) return "Pick a date and time for the one-time run.";
        return null;
      case "interval": {
        const mins = Number(form.intervalMinutes);
        if (!Number.isFinite(mins) || mins < 1) return "Interval must be at least 1 minute.";
        return null;
      }
      case "daily":
        if (!/^\d{1,2}:\d{2}$/.test(form.dailyTime.trim())) return "Daily needs a time (HH:MM).";
        return null;
      case "weekly":
        if (!form.weeklyDays.length) return "Pick at least one weekday.";
        if (!/^\d{1,2}:\d{2}$/.test(form.weeklyTime.trim())) return "Weekly needs a time (HH:MM).";
        return null;
      case "monthly": {
        const day = Number(form.monthlyDay);
        if (!Number.isFinite(day) || day < 1 || day > 31) return "Day of month must be between 1 and 31.";
        if (!/^\d{1,2}:\d{2}$/.test(form.monthlyTime.trim())) return "Monthly needs a time (HH:MM).";
        return null;
      }
      case "cron":
        try {
          normalizeSchedule({ type: "cron", expression: form.cronExpression, timezone: form.timezone });
          return null;
        } catch {
          return "Cron expression must be 5 fields: minute hour day-of-month month day-of-week (e.g. 30 9 * * 1-5).";
        }
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const problem = validate();
    if (problem) {
      setError(problem);
      return;
    }
    setError(null);
    setSaving(true);
    try {
      // Provider snapshot — resolved client-side from the settings store
      // (same source as the chat). Scheduled runs need it to authenticate
      // unattended; block the create with a clear message when missing.
      const provider = await resolveProviderSnapshot();
      if (!provider) {
        toast.error("No AI provider configured");
        setError(
          "Scheduled tasks need an AI provider to run unattended. Add one in Settings → Config first (the currently selected provider/model is snapshotted onto the task).",
        );
        return;
      }
      // UNIFIED CHAT MODE — the conversation the schedule attaches to.
      const chatId = form.chatId.trim() || null;
      // Chat context (systemPrompt + title + recent messages) assembled
      // EXACTLY like the tool's browser-side assembly (shared helper). Sent
      // with CREATE so the server writes the initial mirror; on UPDATE the
      // engine only re-attaches the chat, so a forced mirror converges it.
      let chatContext: CreateTaskPayloadChatContext = null;
      if (chatId && !task) {
        chatContext = await buildChatContext(userId, chatId);
      }
      const instructions = form.chatId.trim()
        ? form.instructions.trim() || DEFAULT_CHAT_TASK_INSTRUCTIONS
        : form.instructions;
      const payload: Record<string, unknown> = {
        name: form.name.trim(),
        description: form.description.trim() || undefined,
        instructions,
        schedule: schedulePayload,
        enabled: form.enabled,
        notifyTelegram: form.notifyTelegram,
        runtime: { provider },
        chatId,
        ...(chatContext ? { chatContext } : {}),
      };
      const res = task
        ? await schedulerApi(userId, "update", { id: task.id, ...payload })
        : await schedulerApi(userId, "create", payload);
      if (!res.ok || !res.task) {
        toast.error(res.message ?? (task ? "Update failed" : "Creation failed"));
        setError(res.message ?? "Something went wrong.");
        return;
      }
      // Keep the local chat-link registry accurate: register the attached
      // conversation; drop a DETACHED/switched one only when no other task
      // still references it.
      const prevChatId = task?.chatId ?? null;
      if (chatId) addLinkedChat(chatId);
      if (prevChatId && prevChatId !== chatId) {
        const stillHeld = (tasks ?? []).some(
          (t) => t.id !== task?.id && (t.chatId ?? null) === prevChatId,
        );
        if (!stillHeld) removeLinkedChat(prevChatId);
      }
      // The update path does not rewrite the server-side mirror — push the
      // browser's current state for the (new) conversation now.
      if (task && chatId) {
        void mirrorChatToServer(userId, chatId, { force: true });
      }
      onSaved(res.task);
      toast.success(task ? "Task updated" : "Scheduled task created", {
        description: `${res.task.name} — next run ${res.task.nextRunAt ? formatNextRun(res.task.nextRunAt, res.task.timezone) : "pending"}.`,
      });
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setSaving(false);
    }
  }

  const tzOptions = useMemo(() => {
    const list = [BROWSER_TZ, ...COMMON_TZ];
    return [...new Set(list)];
  }, []);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="font-display tracking-tight">
            {task ? "Edit scheduled task" : "New scheduled task"}
          </DialogTitle>
          <DialogDescription>
            {task
              ? "Adjust the job, the schedule, or the delivery. The next run is recomputed from the new schedule."
              : "A full agent job that runs on schedule — even with the app closed. It executes in its own sandbox, restores your workspace, and syncs the result back."}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Name + description */}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="sched-name">Name</Label>
              <Input
                id="sched-name"
                value={form.name}
                onChange={(e) => patch({ name: e.target.value })}
                placeholder="Daily Railway Research"
                maxLength={120}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sched-desc">Description (optional)</Label>
              <Input
                id="sched-desc"
                value={form.description}
                onChange={(e) => patch({ description: e.target.value })}
                placeholder="One line about what it does"
                maxLength={240}
              />
            </div>
          </div>

          {/* Run in chat — the unified chat mode picker */}
          <div className="space-y-1.5">
            <Label htmlFor="sched-chat" className="flex items-center gap-1.5">
              <MessageSquare className="size-3.5 text-muted-foreground" aria-hidden />
              Run in chat
            </Label>
            <Select
              value={form.chatId || "none"}
              onValueChange={(v) => {
                chatTouchedRef.current = true;
                patch({ chatId: v === "none" ? "" : v });
              }}
            >
              <SelectTrigger id="sched-chat" className="h-10 w-full" aria-label="Run in chat">
                <SelectValue placeholder="No chat (standalone instructions)" />
              </SelectTrigger>
              <SelectContent className="max-h-64">
                <SelectItem value="none">No chat (standalone instructions)</SelectItem>
                {(conversations ?? []).map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    <span className="max-w-[380px] truncate">
                      {c.title || "Untitled chat"} · {formatRelativeAgo(c.updated_at || c.created_at)}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[11.5px] text-muted-foreground">
              {form.chatId
                ? "Runs inside that conversation — the agent gets the chat's history and each run's result is appended to the chat."
                : "Standalone mode — the instructions below are the complete autonomous job (no conversation history)."}
            </p>
          </div>

          {/* Instructions */}
          <div className="space-y-1.5">
            <Label htmlFor="sched-instructions">
              Instructions{form.chatId ? " (optional when a chat is attached)" : ""}
            </Label>
            <Textarea
              id="sched-instructions"
              value={form.instructions}
              onChange={(e) => patch({ instructions: e.target.value })}
              placeholder={
                form.chatId
                  ? "Optional — what each run should do. Defaults to continuing this conversation's standing task."
                  : "The COMPLETE agent job executed at run time: what to research/do, files to create (with paths), what to send on Telegram. Written for an autonomous agent with no user available."
              }
              className="min-h-[140px] resize-y font-mono text-[13px] leading-relaxed"
              required={!form.chatId}
            />
            <p className="text-[11.5px] text-muted-foreground">
              {form.chatId
                ? "With a chat attached, empty instructions continue the conversation's standing task; written instructions run verbatim each time."
                : "Executed verbatim in an isolated sandbox with your persistent workspace."}
            </p>
          </div>

          {/* Schedule */}
          <div className="space-y-3 rounded-lg border bg-muted/30 p-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>Repeat</Label>
                <Select value={form.type} onValueChange={(v) => patch({ type: v as ScheduleType })}>
                  <SelectTrigger className="h-10 w-full" aria-label="Schedule type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SCHEDULE_TYPES.map((st) => (
                      <SelectItem key={st.value} value={st.value}>
                        {st.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Timezone */}
              <div className="space-y-1.5">
                <Label className="flex items-center gap-1.5">
                  <Globe className="size-3.5 text-muted-foreground" aria-hidden />
                  Timezone
                </Label>
                <Select value={form.timezone} onValueChange={(v) => patch({ timezone: v })}>
                  <SelectTrigger className="h-10 w-full font-mono text-xs" aria-label="Timezone">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="max-h-64">
                    {tzOptions.map((tz) => (
                      <SelectItem key={tz} value={tz} className="font-mono text-xs">
                        {tz === BROWSER_TZ ? `${tz} · browser default` : tz}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* Dynamic per-type fields */}
            {form.type === "once" && (
              <div className="space-y-1.5">
                <Label htmlFor="sched-once">Run at</Label>
                <Input
                  id="sched-once"
                  type="datetime-local"
                  value={form.onceAt}
                  onChange={(e) => patch({ onceAt: e.target.value })}
                  className="h-10"
                />
              </div>
            )}

            {form.type === "interval" && (
              <div className="space-y-1.5">
                <Label htmlFor="sched-interval">Run every (minutes)</Label>
                <Input
                  id="sched-interval"
                  type="number"
                  min={1}
                  step={1}
                  value={form.intervalMinutes}
                  onChange={(e) => patch({ intervalMinutes: e.target.value })}
                  className="h-10"
                />
                <p className="text-[11.5px] text-muted-foreground">
                  Stored as seconds (minimum 60s between runs).
                </p>
              </div>
            )}

            {form.type === "daily" && (
              <div className="space-y-1.5">
                <Label htmlFor="sched-daily">Run at (task timezone)</Label>
                <Input
                  id="sched-daily"
                  type="time"
                  value={form.dailyTime}
                  onChange={(e) => patch({ dailyTime: e.target.value })}
                  className="h-10 sm:max-w-[180px]"
                />
              </div>
            )}

            {form.type === "weekly" && (
              <>
                <div className="space-y-1.5">
                  <Label>Run on</Label>
                  <div className="flex flex-wrap gap-1.5" role="group" aria-label="Weekdays">
                    {WEEKDAY_LABELS.map((label, day) => {
                      const active = form.weeklyDays.includes(day);
                      return (
                        <button
                          key={day}
                          type="button"
                          aria-pressed={active}
                          aria-label={["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][day]}
                          onClick={() =>
                            patch({
                              weeklyDays: active
                                ? form.weeklyDays.filter((d) => d !== day)
                                : [...form.weeklyDays, day],
                            })
                          }
                          className={cn(
                            "h-11 w-11 rounded-lg border font-mono text-sm font-medium transition-colors",
                            active
                              ? "border-primary/40 bg-primary/10 text-primary"
                              : "border-border text-muted-foreground hover:border-primary/25 hover:text-foreground",
                          )}
                        >
                          {label}
                        </button>
                      );
                    })}
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="sched-weekly-time">Run at (task timezone)</Label>
                  <Input
                    id="sched-weekly-time"
                    type="time"
                    value={form.weeklyTime}
                    onChange={(e) => patch({ weeklyTime: e.target.value })}
                    className="h-10 sm:max-w-[180px]"
                  />
                </div>
              </>
            )}

            {form.type === "monthly" && (
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="sched-monthly-day">Day of month (1–31)</Label>
                  <Input
                    id="sched-monthly-day"
                    type="number"
                    min={1}
                    max={31}
                    step={1}
                    value={form.monthlyDay}
                    onChange={(e) => patch({ monthlyDay: e.target.value })}
                    className="h-10"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="sched-monthly-time">Run at (task timezone)</Label>
                  <Input
                    id="sched-monthly-time"
                    type="time"
                    value={form.monthlyTime}
                    onChange={(e) => patch({ monthlyTime: e.target.value })}
                    className="h-10"
                  />
                </div>
              </div>
            )}

            {form.type === "cron" && (
              <div className="space-y-1.5">
                <Label htmlFor="sched-cron">Cron expression</Label>
                <Input
                  id="sched-cron"
                  value={form.cronExpression}
                  onChange={(e) => patch({ cronExpression: e.target.value })}
                  placeholder="30 9 * * 1-5"
                  spellCheck={false}
                  className="h-10 font-mono"
                />
                <p className="text-[11.5px] text-muted-foreground">
                  5 fields: minute hour day-of-month month day-of-week — evaluated in the task&apos;s timezone.
                </p>
              </div>
            )}

            {/* Live preview */}
            <p className="flex items-center gap-1.5 border-t pt-2.5 text-[12.5px] font-medium text-primary">
              <CalendarClock className="size-3.5 shrink-0" aria-hidden />
              {preview}
            </p>
          </div>

          {/* Toggles */}
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3 rounded-lg border p-3">
              <div className="min-w-0">
                <p className="text-sm font-medium">Active</p>
                <p className="text-xs text-muted-foreground">
                  {form.enabled ? "Runs on its schedule." : "Paused — nothing fires until resumed."}
                </p>
              </div>
              <Switch
                checked={form.enabled}
                onCheckedChange={(v) => patch({ enabled: v })}
                aria-label="Task enabled"
              />
            </div>

            <div className="flex items-center justify-between gap-3 rounded-lg border p-3">
              <div className="min-w-0">
                <p className="flex items-center gap-1.5 text-sm font-medium">
                  <Send className="size-3.5 text-primary/70" aria-hidden />
                  Telegram notifications
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {telegramConnected == null ? (
                    "Checking connection…"
                  ) : telegramConnected ? (
                    "Connected — the result is delivered to your chat after every run."
                  ) : (
                    <>
                      {"Not connected — "}
                      <Link
                        href={ROUTES.SETTINGS_INTEGRATIONS}
                        className="font-medium text-primary underline underline-offset-2"
                      >
                        connect Telegram in Settings → Integrations
                      </Link>
                    </>
                  )}
                </p>
              </div>
              <Switch
                checked={form.notifyTelegram}
                onCheckedChange={(v) => patch({ notifyTelegram: v })}
                aria-label="Telegram notifications"
              />
            </div>
          </div>

          {error && (
            <p className="flex items-start gap-1.5 rounded-md border border-destructive/30 bg-destructive/5 p-2.5 text-[13px] text-destructive" role="alert">
              <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              {error}
            </p>
          )}

          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} className="h-11">
              Cancel
            </Button>
            <Button type="submit" disabled={saving} className="h-11">
              {saving ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Save className="size-4" aria-hidden />}
              {task ? "Save changes" : "Create task"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

"use client";

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import { CalendarClock, Loader2, Pencil, Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import { SettingsRow, SettingsSection } from "./settings-section";
import { MoreOptions } from "./more-options";
import { useTaskSchedules, useCloudOrchestrator } from "@/hooks";
import { ROUTES } from "@/lib/constants";
import {
  describeCron,
  nextCronRun,
  validateCron,
  type BackgroundTaskType,
  type TaskScheduleInput,
  type TaskScheduleRecord,
} from "@/lib/tasks/protocol";

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

/** Format a date in an IANA timezone — "Mon, Jan 5, 09:30" (EEE, MMM d, HH:mm). */
function formatDateInTz(date: Date | string, timezone: string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  if (Number.isNaN(d.getTime())) return "—";
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(d);
  } catch {
    return d.toLocaleString();
  }
}

function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

const TASK_TYPE_LABELS: Record<BackgroundTaskType, string> = {
  agent_run: "Agent task",
  scheduled_business: "Business task",
  terminal_command: "Terminal command",
};

/** Short mono pill label per task type (card badge). */
const TASK_TYPE_PILL: Record<BackgroundTaskType, string> = {
  agent_run: "agent",
  scheduled_business: "business",
  terminal_command: "terminal",
};

/** Status pill — the section-e2b convention (sky mono uppercase). */
function TypePill({ type }: { type: BackgroundTaskType }) {
  return (
    <span
      className="inline-flex items-center rounded-full bg-sky-500/10 px-2 py-0.5 font-mono text-[10px] uppercase text-sky-600 dark:text-sky-400"
      title={TASK_TYPE_LABELS[type]}
    >
      {TASK_TYPE_PILL[type]}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Schedule form (create + edit share one dialog).
// ---------------------------------------------------------------------------

interface ScheduleFormValues {
  name: string;
  cronExpr: string;
  taskType: BackgroundTaskType;
  prompt: string;
  timezone: string;
  command: string;
}

const EMPTY_FORM: ScheduleFormValues = {
  name: "",
  cronExpr: "",
  taskType: "agent_run",
  prompt: "",
  timezone: "",
  command: "",
};

interface ScheduleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The record being edited, or null for create. */
  editing: TaskScheduleRecord | null;
}

function ScheduleDialog({ open, onOpenChange, editing }: ScheduleDialogProps) {
  const { create, update } = useTaskSchedules();
  const [form, setForm] = React.useState<ScheduleFormValues>(EMPTY_FORM);
  const [submitting, setSubmitting] = React.useState(false);

  // Seed the form whenever the dialog opens (create → defaults, edit → record).
  React.useEffect(() => {
    if (!open) return;
    setForm(
      editing
        ? {
            name: editing.name,
            cronExpr: editing.cronExpr,
            taskType: editing.taskType,
            prompt: editing.prompt,
            timezone: editing.timezone,
            command: editing.config?.command ?? "",
          }
        : { ...EMPTY_FORM, timezone: browserTimezone() },
    );
  }, [open, editing]);

  const patch = (next: Partial<ScheduleFormValues>) =>
    setForm((f) => ({ ...f, ...next }));

  const trimmedCron = form.cronExpr.trim();
  const cronError = trimmedCron ? validateCron(trimmedCron) : null;
  const tz = form.timezone.trim() || browserTimezone();
  const cronNext = React.useMemo(
    () => (trimmedCron && !cronError ? nextCronRun(trimmedCron, tz) : null),
    [trimmedCron, cronError, tz],
  );

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name.trim()) {
      toast.error("Give the schedule a name first");
      return;
    }
    if (!trimmedCron || cronError) {
      toast.error("Fix the cron expression first", {
        description: cronError ?? "A 5-field cron expression or @daily/@hourly shorthand is required.",
      });
      return;
    }
    if (form.taskType !== "terminal_command" && !form.prompt.trim()) {
      toast.error("Add a prompt describing what each run should do");
      return;
    }
    if (form.taskType === "terminal_command" && !form.command.trim()) {
      toast.error("Add the terminal command (under Advanced)");
      return;
    }
    const input: TaskScheduleInput = {
      name: form.name.trim(),
      cronExpr: trimmedCron,
      timezone: tz,
      taskType: form.taskType,
      prompt:
        form.taskType === "terminal_command" && !form.prompt.trim()
          ? `Terminal: ${form.command.trim().slice(0, 200)}`
          : form.prompt.trim(),
      ...(form.taskType === "terminal_command"
        ? { config: { command: form.command.trim() } }
        : {}),
    };
    setSubmitting(true);
    try {
      if (editing) {
        await update({ id: editing.id, patch: input });
        toast.success("Schedule updated");
      } else {
        await create(input);
        toast.success("Schedule created", {
          description: `${describeCron(trimmedCron)} (${tz})`,
        });
      }
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save the schedule");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit schedule" : "New schedule"}</DialogTitle>
          <DialogDescription>
            A cron-driven background task — runs fire from this app&apos;s server, even while
            this app is closed.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="sched-name">Name</Label>
            <Input
              id="sched-name"
              value={form.name}
              onChange={(e) => patch({ name: e.target.value })}
              placeholder="Daily news digest"
              autoComplete="off"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="sched-cron">Cron expression</Label>
            <Input
              id="sched-cron"
              value={form.cronExpr}
              onChange={(e) => patch({ cronExpr: e.target.value })}
              placeholder="0 9 * * 1-5"
              className="font-mono"
              autoComplete="off"
              aria-invalid={!!cronError}
            />
            {cronError ? (
              <p className="text-xs text-destructive">
                Invalid — {cronError}.
              </p>
            ) : cronNext ? (
              <p className="text-muted-foreground text-xs">
                Next run: {formatDateInTz(cronNext, tz)} ({describeCron(trimmedCron)})
              </p>
            ) : (
              <p className="text-muted-foreground text-xs">
                5-field cron (min hour day month weekday) or @daily / @hourly / @weekly /
                @monthly.
              </p>
            )}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Task type</Label>
              <Select
                value={form.taskType}
                onValueChange={(v) => patch({ taskType: v as BackgroundTaskType })}
              >
                <SelectTrigger aria-label="Task type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="agent_run">Agent task</SelectItem>
                  <SelectItem value="scheduled_business">Business task</SelectItem>
                  <SelectItem value="terminal_command">Terminal command</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sched-tz">Timezone</Label>
              <Input
                id="sched-tz"
                value={form.timezone}
                onChange={(e) => patch({ timezone: e.target.value })}
                placeholder={browserTimezone()}
                className="font-mono text-xs"
                autoComplete="off"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="sched-prompt">
              {form.taskType === "terminal_command" ? "Prompt (optional)" : "Prompt"}
            </Label>
            <Textarea
              id="sched-prompt"
              rows={3}
              value={form.prompt}
              onChange={(e) => patch({ prompt: e.target.value })}
              placeholder="What should each run do? Its result syncs back into the linked conversation."
            />
          </div>

          {form.taskType === "terminal_command" && (
            <MoreOptions label="Advanced" defaultOpen={editing?.taskType === "terminal_command"}>
              <div className="space-y-1.5 rounded-lg border p-3">
                <Label htmlFor="sched-command">Terminal command</Label>
                <Input
                  id="sched-command"
                  value={form.command}
                  onChange={(e) => patch({ command: e.target.value })}
                  placeholder="python report.py"
                  className="font-mono"
                  autoComplete="off"
                />
                <p className="text-muted-foreground text-xs">
                  Runs in the background sandbox (up to 30 minutes); its output and any
                  files it writes come back as artifacts.
                </p>
              </div>
            </MoreOptions>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Plus className="size-4" />
              )}
              {editing ? "Save changes" : "Create schedule"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Section.
// ---------------------------------------------------------------------------

export function SectionSchedules() {
  const { schedules, isLoading, update, remove } = useTaskSchedules();
  const { status: orchestration } = useCloudOrchestrator();
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<TaskScheduleRecord | null>(null);
  const [deleting, setDeleting] = React.useState<TaskScheduleRecord | null>(null);
  const [busyId, setBusyId] = React.useState<string | null>(null);

  const openCreate = () => {
    setEditing(null);
    setDialogOpen(true);
  };
  const openEdit = (rec: TaskScheduleRecord) => {
    setEditing(rec);
    setDialogOpen(true);
  };

  async function handleToggle(rec: TaskScheduleRecord, next: boolean) {
    setBusyId(rec.id);
    try {
      await update({ id: rec.id, patch: { active: next } });
      toast.success(next ? "Schedule activated" : "Schedule paused", {
        description: rec.name,
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update the schedule");
    } finally {
      setBusyId(null);
    }
  }

  async function handleDelete() {
    if (!deleting) return;
    setBusyId(deleting.id);
    try {
      await remove(deleting.id);
      toast.success("Schedule deleted", { description: deleting.name });
      setDeleting(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete the schedule");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-4">
      <SettingsSection
        title="Schedules"
        description="Cron-driven background tasks. Each firing runs in an isolated sandbox on the server and its artifacts sync back into the linked conversation."
        action={
          <Button size="sm" onClick={openCreate}>
            <Plus className="size-4" />
            New schedule
          </Button>
        }
      >
        <SettingsRow
          label="Orchestrator"
          description={
            orchestration?.mode === "cloud"
              ? "Trigger.dev Cloud is connected — scheduled runs execute on trigger.dev's infrastructure (Settings → Cloud Tasks)."
              : orchestration?.mode === "selfhosted"
                ? "A self-hosted Trigger.dev worker owns firing (TRIGGER_DEV_URL/TRIGGER_DEV_TOKEN env)."
                : "Runs fire from this app's server (local orchestrator). Connect Trigger.dev Cloud — or deploy the worker — for durable cloud execution."
          }
          control={
            <span
              className={
                "inline-flex items-center rounded-full px-2 py-0.5 font-mono text-[10px] uppercase " +
                (orchestration?.mode === "cloud"
                  ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                  : orchestration?.mode === "selfhosted"
                    ? "bg-amber-500/10 text-amber-600 dark:text-amber-400"
                    : "bg-sky-500/10 text-sky-600 dark:text-sky-400")
              }
            >
              {orchestration?.mode ?? "local"}
            </span>
          }
          className="mb-5"
        />
        {orchestration?.mode !== "cloud" && (
          <p className="text-muted-foreground -mt-3 mb-5 text-xs">
            Want durable cloud execution without self-hosting?{" "}
            <Link href={ROUTES.SETTINGS_CLOUD_TASKS} className="text-foreground underline underline-offset-4">
              Connect a Trigger.dev Cloud key →
            </Link>
          </p>
        )}

        {isLoading ? (
          <div className="text-muted-foreground flex items-center gap-2 py-6 text-sm">
            <Loader2 className="size-4 animate-spin" /> Loading…
          </div>
        ) : schedules.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed px-4 py-8 text-center">
            <CalendarClock className="text-muted-foreground size-5" />
            <p className="text-sm font-medium">No schedules yet</p>
            <p className="text-muted-foreground max-w-sm text-xs leading-relaxed">
              Create a cron schedule to run agent or terminal tasks automatically — runs
              fire from the server, so they keep going while this app is closed.
            </p>
            <Button variant="outline" size="sm" onClick={openCreate}>
              <Plus className="size-3.5" />
              New schedule
            </Button>
          </div>
        ) : (
          <ul className="scrollbar-thin max-h-96 space-y-2 overflow-y-auto pr-2">
            {schedules.map((rec) => (
              <li key={rec.id} className="rounded-lg border px-3.5 py-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="truncate text-sm font-medium">{rec.name}</p>
                      <TypePill type={rec.taskType} />
                      {!rec.active && (
                        <span className="inline-flex items-center rounded-full bg-foreground/[0.06] px-2 py-0.5 font-mono text-[10px] uppercase text-muted-foreground">
                          paused
                        </span>
                      )}
                    </div>
                    <p className="text-muted-foreground mt-1 font-mono text-[11px]">
                      {describeCron(rec.cronExpr)}
                    </p>
                    <p className="text-muted-foreground mt-1 text-[11px]">
                      Next: {rec.nextRunAt ? formatDateInTz(rec.nextRunAt, rec.timezone) : "—"}
                      {" · "}
                      Last: {rec.lastRunAt ? formatDateInTz(rec.lastRunAt, rec.timezone) : "never"}
                      {" · "}
                      {rec.runCount} {rec.runCount === 1 ? "run" : "runs"}
                      {" · "}
                      {rec.timezone}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Switch
                      checked={rec.active}
                      onCheckedChange={(v) => void handleToggle(rec, v)}
                      disabled={busyId === rec.id}
                      aria-label={`${rec.active ? "Pause" : "Activate"} schedule ${rec.name}`}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-7"
                      onClick={() => openEdit(rec)}
                      aria-label={`Edit schedule ${rec.name}`}
                    >
                      <Pencil className="size-3.5" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="text-destructive hover:text-destructive size-7"
                      onClick={() => setDeleting(rec)}
                      aria-label={`Delete schedule ${rec.name}`}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </SettingsSection>

      <ScheduleDialog open={dialogOpen} onOpenChange={setDialogOpen} editing={editing} />

      <AlertDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete schedule?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleting
                ? `"${deleting.name}" (${describeCron(deleting.cronExpr)}) will be deleted. Already-running tasks are not affected.`
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={(e) => {
                e.preventDefault();
                void handleDelete();
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export default SectionSchedules;

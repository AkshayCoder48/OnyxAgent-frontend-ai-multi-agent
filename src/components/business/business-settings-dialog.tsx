"use client";

/**
 * Business Mode — BusinessSettingsDialog (Task 4-c).
 *
 * Stacked sections in one scrollable dialog: General, Main Agent (provider /
 * model / temperature), Limits (concurrency, collaboration depth, per-task
 * timeout, draft-approval gate), Notifications (config.notifyOn) and a
 * destructive Danger zone (archive / delete). Values load from activeBusiness
 * on open; Save persists via businessService.update + business.updated event.
 */

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useLocale } from "next-intl";
import { toast } from "sonner";
import { Archive, Bell, SlidersHorizontal, Trash2 } from "lucide-react";

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
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Slider } from "@/components/ui/slider";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";

import { businessEventService, businessService } from "@/lib/business/data";
import { bt } from "@/lib/business/ui-text";
import type { BusinessConfiguration, BusinessRow } from "@/lib/business/types";
import { useBusinessStore } from "@/stores/business-store";
import { useAuthStore } from "@/stores/auth-store";
import { aiProviderService } from "@/lib/services";
import type { AIProviderRow } from "@/lib/db";

const PROVIDER_INHERIT = "__inherit__";

/** notifyOn keys in the configuration. */
const NOTIFY_KEYS = ["draftReady", "needsInput", "taskFailed", "milestone"] as const;
type NotifyKey = (typeof NOTIFY_KEYS)[number];

const NOTIFY_LABELS: Record<NotifyKey, string> = {
  draftReady: "settings.notify.draftReady",
  needsInput: "settings.notify.needsInput",
  taskFailed: "settings.notify.taskFailed",
  milestone: "settings.notify.milestone",
};

interface SettingsForm {
  name: string;
  description: string;
  providerId: string; // PROVIDER_INHERIT | provider id
  modelId: string;
  temperature: number;
  maxConcurrentTasks: number;
  collaborationDepth: number;
  perTaskTimeoutMin: number;
  requireDraftApproval: boolean;
  notify: Record<NotifyKey, boolean>;
}

const DEFAULT_FORM: SettingsForm = {
  name: "",
  description: "",
  providerId: PROVIDER_INHERIT,
  modelId: "",
  temperature: 0.7,
  maxConcurrentTasks: 3,
  collaborationDepth: 2,
  perTaskTimeoutMin: 3,
  requireDraftApproval: true,
  notify: {
    draftReady: true,
    needsInput: true,
    taskFailed: true,
    milestone: true,
  },
};

function formFromBusiness(business: BusinessRow): SettingsForm {
  const c: Partial<BusinessConfiguration> = business.configuration ?? {};
  const notifyOn = c.notifyOn ?? [];
  return {
    name: business.name,
    description: business.description,
    providerId: c.mainProviderId || PROVIDER_INHERIT,
    modelId: c.mainModel || "",
    temperature: c.mainTemperature ?? 0.7,
    maxConcurrentTasks: c.maxConcurrentTasks ?? 3,
    collaborationDepth: c.collaborationDepth ?? 2,
    perTaskTimeoutMin: Math.round((c.perTaskTimeoutMs ?? 180_000) / 60_000),
    requireDraftApproval: c.requireDraftApproval ?? true,
    notify: {
      draftReady: notifyOn.includes("draftReady"),
      needsInput: notifyOn.includes("needsInput"),
      taskFailed: notifyOn.includes("taskFailed"),
      milestone: notifyOn.includes("milestone"),
    },
  };
}

export function BusinessSettingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const locale = useLocale();
  const router = useRouter();
  const activeBusiness = useBusinessStore((s) => s.activeBusiness);
  const setBusiness = useBusinessStore((s) => s.setBusiness);
  const openBusiness = useBusinessStore((s) => s.openBusiness);
  const userId = useAuthStore((s) => s.user?.id) ?? "local-user";

  const [form, setForm] = useState<SettingsForm>(() =>
    activeBusiness ? formFromBusiness(activeBusiness) : DEFAULT_FORM,
  );
  const [providers, setProviders] = useState<AIProviderRow[]>([]);
  const [saving, setSaving] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Load current values + provider list each time the dialog opens.
  useEffect(() => {
    if (!open) return;
    if (activeBusiness) setForm(formFromBusiness(activeBusiness));
    let alive = true;
    (async () => {
      try {
        const rows = await aiProviderService.list(userId);
        if (alive) setProviders(rows);
      } catch {
        // Provider select falls back to the inherit option.
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, activeBusiness?.id, userId]);

  const selectedProvider = useMemo(
    () => providers.find((p) => p.id === form.providerId),
    [providers, form.providerId],
  );

  const dashboardHref = `/${locale}/business`;

  async function handleSave() {
    if (!activeBusiness) return;
    setSaving(true);
    try {
      const existing = activeBusiness.configuration ?? ({} as BusinessConfiguration);
      const notifyOn = NOTIFY_KEYS.filter((k) => form.notify[k]);
      const configuration: BusinessConfiguration = {
        ...existing,
        mainProviderId: form.providerId === PROVIDER_INHERIT ? "" : form.providerId,
        mainModel: form.providerId === PROVIDER_INHERIT ? "" : form.modelId,
        mainTemperature: form.temperature,
        maxConcurrentTasks: form.maxConcurrentTasks,
        collaborationDepth: form.collaborationDepth,
        perTaskTimeoutMs: form.perTaskTimeoutMin * 60_000,
        requireDraftApproval: form.requireDraftApproval,
        notifyOn,
      };
      const name = form.name.trim() || activeBusiness.name;
      await businessService.update(activeBusiness.id, { name, description: form.description.trim(), configuration });
      const updated: BusinessRow = {
        ...activeBusiness,
        name,
        description: form.description.trim(),
        configuration,
        updated_at: new Date().toISOString(),
      };
      setBusiness(updated);
      await businessEventService.append({
        business_id: activeBusiness.id,
        event_type: "business.updated",
        payload: { name },
      });
      toast.success(bt("settings.saved"));
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleArchive() {
    if (!activeBusiness) return;
    setArchiving(true);
    try {
      await businessService.update(activeBusiness.id, { status: "archived" });
      setBusiness({
        ...activeBusiness,
        status: "archived",
        updated_at: new Date().toISOString(),
      });
      await businessEventService.append({
        business_id: activeBusiness.id,
        event_type: "business.updated",
        payload: { status: "archived" },
      });
      toast.success(bt("dashboard.archived"));
      router.push(dashboardHref);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setArchiving(false);
    }
  }

  async function handleDelete() {
    if (!activeBusiness) return;
    setDeleting(true);
    try {
      await businessService.remove(activeBusiness.id);
      await openBusiness(null);
      toast.success(bt("toast.businessDeleted"));
      router.push(dashboardHref);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setDeleting(false);
      setDeleteOpen(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto scrollbar-thin sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{bt("settings.title")}</DialogTitle>
          <DialogDescription>{activeBusiness?.description || bt("settings.general")}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-6">
          {/* General */}
          <section className="flex flex-col gap-3" aria-label={bt("settings.general")}>
            <h3 className="text-sm font-semibold">{bt("settings.general")}</h3>
            <div className="flex flex-col gap-2">
              <Label htmlFor="business-settings-name">{bt("agent.name")}</Label>
              <Input
                id="business-settings-name"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                className="h-11"
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="business-settings-description">{bt("agent.description")}</Label>
              <Textarea
                id="business-settings-description"
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                rows={2}
              />
            </div>
          </section>

          <Separator />

          {/* Main Agent */}
          <section className="flex flex-col gap-3" aria-label={bt("settings.mainAgent")}>
            <h3 className="text-sm font-semibold">{bt("settings.mainAgent")}</h3>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-2">
                <Label htmlFor="business-settings-provider">{bt("settings.mainProvider")}</Label>
                <Select
                  value={form.providerId}
                  onValueChange={(v) => setForm((f) => ({ ...f, providerId: v, modelId: "" }))}
                >
                  <SelectTrigger id="business-settings-provider" className="h-11">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={PROVIDER_INHERIT}>Chat default</SelectItem>
                    {providers.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="business-settings-model">{bt("settings.mainModel")}</Label>
                <Select
                  value={form.modelId || undefined}
                  onValueChange={(v) => setForm((f) => ({ ...f, modelId: v }))}
                  disabled={form.providerId === PROVIDER_INHERIT || !selectedProvider}
                >
                  <SelectTrigger id="business-settings-model" className="h-11">
                    <SelectValue placeholder={form.providerId === PROVIDER_INHERIT ? "—" : bt("agent.model")} />
                  </SelectTrigger>
                  <SelectContent>
                    {(selectedProvider?.models ?? []).map((m) => (
                      <SelectItem key={m} value={m}>
                        {m}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="business-settings-temperature">{bt("settings.temperature")}</Label>
                <span className="text-sm tabular-nums text-muted-foreground">
                  {form.temperature.toFixed(1)}
                </span>
              </div>
              <Slider
                id="business-settings-temperature"
                value={[form.temperature]}
                min={0}
                max={2}
                step={0.1}
                onValueChange={(v) => setForm((f) => ({ ...f, temperature: v[0] ?? f.temperature }))}
                aria-label={bt("settings.temperature")}
              />
            </div>
          </section>

          <Separator />

          {/* Limits */}
          <section className="flex flex-col gap-4" aria-label={bt("settings.limits")}>
            <h3 className="flex items-center gap-2 text-sm font-semibold">
              <SlidersHorizontal className="size-4 text-muted-foreground" aria-hidden="true" />
              {bt("settings.limits")}
            </h3>
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="business-settings-concurrency">{bt("settings.maxConcurrent")}</Label>
                <span className="text-sm tabular-nums text-muted-foreground">
                  {form.maxConcurrentTasks}
                </span>
              </div>
              <Slider
                id="business-settings-concurrency"
                value={[form.maxConcurrentTasks]}
                min={1}
                max={6}
                step={1}
                onValueChange={(v) =>
                  setForm((f) => ({ ...f, maxConcurrentTasks: v[0] ?? f.maxConcurrentTasks }))
                }
                aria-label={bt("settings.maxConcurrent")}
              />
            </div>
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="business-settings-depth">{bt("settings.collabDepth")}</Label>
                <span className="text-sm tabular-nums text-muted-foreground">
                  {form.collaborationDepth}
                </span>
              </div>
              <Slider
                id="business-settings-depth"
                value={[form.collaborationDepth]}
                min={1}
                max={4}
                step={1}
                onValueChange={(v) =>
                  setForm((f) => ({ ...f, collaborationDepth: v[0] ?? f.collaborationDepth }))
                }
                aria-label={bt("settings.collabDepth")}
              />
            </div>
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="business-settings-timeout">{bt("settings.taskTimeout")}</Label>
                <span className="text-sm tabular-nums text-muted-foreground">
                  {form.perTaskTimeoutMin}
                </span>
              </div>
              <Slider
                id="business-settings-timeout"
                value={[form.perTaskTimeoutMin]}
                min={1}
                max={10}
                step={1}
                onValueChange={(v) =>
                  setForm((f) => ({ ...f, perTaskTimeoutMin: v[0] ?? f.perTaskTimeoutMin }))
                }
                aria-label={bt("settings.taskTimeout")}
              />
            </div>
            <label className="flex min-h-11 items-center justify-between gap-3 rounded-lg border px-3 py-2">
              <span className="text-sm">{bt("settings.requireApproval")}</span>
              <Switch
                checked={form.requireDraftApproval}
                onCheckedChange={(v) => setForm((f) => ({ ...f, requireDraftApproval: v }))}
                aria-label={bt("settings.requireApproval")}
              />
            </label>
          </section>

          <Separator />

          {/* Notifications */}
          <section className="flex flex-col gap-3" aria-label={bt("settings.notifications")}>
            <h3 className="flex items-center gap-2 text-sm font-semibold">
              <Bell className="size-4 text-muted-foreground" aria-hidden="true" />
              {bt("settings.notifications")}
            </h3>
            <div className="grid gap-2 sm:grid-cols-2">
              {NOTIFY_KEYS.map((key) => (
                <label
                  key={key}
                  className="flex min-h-11 items-center justify-between gap-3 rounded-lg border px-3 py-2"
                >
                  <span className="text-sm">{bt(NOTIFY_LABELS[key])}</span>
                  <Switch
                    checked={form.notify[key]}
                    onCheckedChange={(v) =>
                      setForm((f) => ({ ...f, notify: { ...f.notify, [key]: v } }))
                    }
                    aria-label={bt(NOTIFY_LABELS[key])}
                  />
                </label>
              ))}
            </div>
          </section>

          <Separator />

          {/* Danger zone */}
          <section className="flex flex-col gap-3" aria-label={bt("settings.dangerZone")}>
            <h3 className="text-sm font-semibold text-destructive">{bt("settings.dangerZone")}</h3>
            <div className="flex flex-col gap-2 rounded-lg border border-destructive/40 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{bt("settings.archiveBusiness")}</p>
                  <p className="text-xs text-muted-foreground">{bt("dashboard.archived")}</p>
                </div>
                <Button variant="outline" onClick={() => void handleArchive()} disabled={archiving} className="h-11">
                  {archiving ? <Spinner className="mr-2 size-4" /> : <Archive className="mr-2 size-4" />}
                  {bt("settings.archiveBusiness")}
                </Button>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{bt("settings.deleteBusiness")}</p>
                  <p className="text-xs text-muted-foreground">{bt("dashboard.deleteWarning")}</p>
                </div>
                <Button variant="destructive" onClick={() => setDeleteOpen(true)} className="h-11">
                  <Trash2 className="mr-2 size-4" />
                  {bt("settings.deleteBusiness")}
                </Button>
              </div>
            </div>
          </section>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} className="h-11">
            {bt("common.cancel")}
          </Button>
          <Button onClick={() => void handleSave()} disabled={saving} className="h-11">
            {saving && <Spinner className="mr-2 size-4" />}
            {bt("common.save")}
          </Button>
        </DialogFooter>

        {/* Delete confirm */}
        <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{bt("dashboard.deleteBusiness")}</AlertDialogTitle>
              <AlertDialogDescription>{bt("dashboard.deleteWarning")}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel className="h-11">{bt("common.cancel")}</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => void handleDelete()}
                disabled={deleting}
                className="h-11 bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                {deleting && <Spinner className="mr-2 size-4" />}
                {bt("common.delete")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </DialogContent>
    </Dialog>
  );
}

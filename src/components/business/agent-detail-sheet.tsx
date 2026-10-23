"use client";

/**
 * Business Mode — AgentDetailSheet (Task 4-c, internal to the Swarm view).
 *
 * Right-hand sheet with four tabs:
 *  - Overview: identity (name/description/role/logo), status, metrics and
 *    lifecycle actions (pause/resume, duplicate, guarded delete).
 *  - Prompt:   editable prompt_config with version history + revert.
 *  - Config:   provider/model overrides, skills, connector permissions.
 *  - Test:     run a real sample task via orchestrator.runAgentTest.
 *
 * Every write goes through businessAgentService + businessEventService and is
 * mirrored into the store (upsertAgent / removeAgent).
 */

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { toast } from "sonner";
import {
  AlertTriangle,
  Copy,
  FlaskConical,
  Pause,
  Play,
  Plus,
  Trash2,
  X,
} from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";

import { AGENT_LOGOS, AgentLogo } from "@/components/business/agent-logos";
import { businessAgentService, businessEventService } from "@/lib/business/data";
import { bt } from "@/lib/business/ui-text";
import { runAgentTest } from "@/lib/business/orchestrator";
import type {
  AgentStatus,
  BusinessAgentPromptConfig,
  BusinessAgentRow,
  BusinessAgentPermissions,
} from "@/lib/business/types";
import { useBusinessStore } from "@/stores/business-store";
import { useAuthStore } from "@/stores/auth-store";
import { aiProviderService, skillService } from "@/lib/services";
import type { AIProviderRow } from "@/lib/db";
import type { SkillRow } from "@/lib/db";
import { cn, timeAgo } from "@/lib/utils";

const PROVIDER_INHERIT = "__inherit__";

/** Task statuses that block agent deletion (nothing is silently discarded). */
const UNFINISHED_TASK_STATUSES = [
  "backlog",
  "ready",
  "running",
  "blocked",
  "awaiting_approval",
  "interrupted",
] as const;

/** Max entries kept in the prompt version history. */
const PROMPT_HISTORY_CAP = 20;

type DetailTab = "overview" | "prompt" | "config" | "test";

function statusBadgeClass(status: AgentStatus, paused: boolean): string {
  if (paused || status === "paused" || status === "disabled") {
    return "border-border text-muted-foreground";
  }
  switch (status) {
    case "working":
    case "researching":
    case "planning":
    case "collaborating":
      return "border-amber-500/40 text-amber-600 dark:text-amber-400";
    case "awaiting_approval":
      return "border-primary/50 text-primary";
    case "waiting_input":
      return "border-amber-500/30 text-amber-600/90 dark:text-amber-400/90";
    case "completed":
      return "border-emerald-500/40 text-emerald-600 dark:text-emerald-400";
    case "failed":
      return "border-destructive/50 text-destructive";
    default:
      return "border-border text-muted-foreground";
  }
}

function nowISO(): string {
  return new Date().toISOString();
}

export function AgentDetailSheet({
  agent,
  open,
  onOpenChange,
}: {
  agent: BusinessAgentRow | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const params = useParams<{ businessId?: string }>();
  const activeBusinessId = useBusinessStore((s) => s.activeBusinessId);
  const businessId = params?.businessId ?? activeBusinessId ?? "";
  const tasks = useBusinessStore((s) => s.tasks);
  const upsertAgent = useBusinessStore((s) => s.upsertAgent);
  const removeAgent = useBusinessStore((s) => s.removeAgent);
  const userId = useAuthStore((s) => s.user?.id) ?? "local-user";

  const [tab, setTab] = useState<DetailTab>("overview");

  // -- Overview form -------------------------------------------------------
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [role, setRole] = useState("");
  const [logo, setLogo] = useState("orb");
  const [savingIdentity, setSavingIdentity] = useState(false);

  // -- Prompt form ----------------------------------------------------------
  const [instructions, setInstructions] = useState("");
  const [roleDefinition, setRoleDefinition] = useState("");
  const [goals, setGoals] = useState<string[]>([]);
  const [rules, setRules] = useState<string[]>([]);
  const [outputFormat, setOutputFormat] = useState("");
  const [escalation, setEscalation] = useState("");
  const [goalDraft, setGoalDraft] = useState("");
  const [ruleDraft, setRuleDraft] = useState("");
  const [savingPrompt, setSavingPrompt] = useState(false);

  // -- Config form ----------------------------------------------------------
  const [providerId, setProviderId] = useState<string>(PROVIDER_INHERIT);
  const [modelId, setModelId] = useState("");
  const [skills, setSkills] = useState<string[]>([]);
  const [permissions, setPermissions] = useState<BusinessAgentPermissions>({
    web_search: true,
    create_drafts: true,
    read_memory: true,
    write_memory: true,
  });
  const [providers, setProviders] = useState<AIProviderRow[]>([]);
  const [availableSkills, setAvailableSkills] = useState<SkillRow[]>([]);
  const [savingConfig, setSavingConfig] = useState(false);

  // -- Test -----------------------------------------------------------------
  const [testInput, setTestInput] = useState("");
  const [testRunning, setTestRunning] = useState(false);
  const [testOutput, setTestOutput] = useState<string | null>(null);
  const [testError, setTestError] = useState<string | null>(null);

  // -- Delete ---------------------------------------------------------------
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Initialize every form from the agent when the sheet opens (keyed on the
  // agent id so live store updates never clobber in-progress edits).
  useEffect(() => {
    if (!open || !agent) return;
    setName(agent.name);
    setDescription(agent.description);
    setRole(agent.role);
    setLogo(agent.svg_logo);
    const pc = agent.prompt_config;
    setInstructions(pc.system_instructions);
    setRoleDefinition(pc.role_definition);
    setGoals([...pc.goals]);
    setRules([...pc.behavioral_rules]);
    setOutputFormat(pc.output_format);
    setEscalation(pc.escalation_rules);
    setProviderId(agent.provider_id || PROVIDER_INHERIT);
    setModelId(agent.model_id || "");
    setSkills([...agent.skills]);
    setPermissions({ ...agent.permissions });
    setTab("overview");
    setTestInput("");
    setTestOutput(null);
    setTestError(null);
    setDeleteOpen(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, agent?.id]);

  // Load providers + skills once the sheet opens (Config tab data).
  useEffect(() => {
    if (!open) return;
    let alive = true;
    (async () => {
      try {
        const [providerRows, skillRows] = await Promise.all([
          aiProviderService.list(userId),
          skillService.list(userId),
        ]);
        if (alive) {
          setProviders(providerRows);
          setAvailableSkills(skillRows);
        }
      } catch {
        // Listing failed — selects fall back to the inherit option.
      }
    })();
    return () => {
      alive = false;
    };
  }, [open, userId]);

  const selectedProvider = useMemo(
    () => providers.find((p) => p.id === providerId),
    [providers, providerId],
  );

  const unfinishedTasks = useMemo(() => {
    if (!agent) return [];
    return tasks.filter(
      (t) =>
        t.assigned_agent_id === agent.id &&
        (UNFINISHED_TASK_STATUSES as readonly string[]).includes(t.status),
    );
  }, [agent, tasks]);

  const deleteBlocked = unfinishedTasks.length > 0;

  const promptHistory = useMemo(() => {
    if (!agent) return [];
    return [...agent.prompt_config.history].sort((a, b) => b.version - a.version);
  }, [agent]);

  // -- Actions ---------------------------------------------------------------

  async function emitAgentEvent(
    eventType: "agent.updated" | "agent.status_changed" | "agent.deleted",
    payload: Record<string, unknown>,
  ) {
    if (!agent) return;
    await businessEventService.append({
      business_id: businessId,
      agent_id: agent.id,
      event_type: eventType,
      payload,
    });
  }

  async function handleSaveIdentity() {
    if (!agent) return;
    setSavingIdentity(true);
    try {
      await businessAgentService.update(agent.id, {
        name: name.trim() || agent.name,
        description: description.trim(),
        role: role.trim() || agent.role,
        svg_logo: logo,
      });
      const updated: BusinessAgentRow = {
        ...agent,
        name: name.trim() || agent.name,
        description: description.trim(),
        role: role.trim() || agent.role,
        svg_logo: logo,
        updated_at: nowISO(),
      };
      upsertAgent(updated);
      await emitAgentEvent("agent.updated", { name: updated.name, role: updated.role });
      toast.success(bt("toast.agentUpdated"));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingIdentity(false);
    }
  }

  async function handleTogglePause() {
    if (!agent) return;
    const nextPaused = !agent.paused;
    const nextStatus: AgentStatus = nextPaused ? "paused" : "idle";
    try {
      await businessAgentService.update(agent.id, { paused: nextPaused, status: nextStatus });
      upsertAgent({ ...agent, paused: nextPaused, status: nextStatus, updated_at: nowISO() });
      await emitAgentEvent("agent.status_changed", { status: nextStatus, paused: nextPaused });
      toast.success(nextPaused ? bt("swarm.pause") : bt("swarm.resume"));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleDuplicate() {
    if (!agent) return;
    try {
      const copy = await businessAgentService.duplicate(agent.id);
      if (!copy) return;
      upsertAgent(copy);
      await businessEventService.append({
        business_id: businessId,
        agent_id: copy.id,
        event_type: "agent.created",
        payload: { name: copy.name, role: copy.role, duplicatedFrom: agent.name },
      });
      toast.success(bt("toast.agentCreated"));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleDelete() {
    if (!agent || deleteBlocked) return;
    setDeleting(true);
    try {
      await businessAgentService.remove(agent.id);
      removeAgent(agent.id);
      await emitAgentEvent("agent.deleted", { name: agent.name, role: agent.role });
      toast.success(bt("toast.agentDeleted"));
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setDeleting(false);
    }
  }

  async function handleSavePrompt() {
    if (!agent) return;
    setSavingPrompt(true);
    try {
      const pc = agent.prompt_config;
      const changed = instructions !== pc.system_instructions;
      const historyEntry = {
        version: pc.version,
        system_instructions: pc.system_instructions,
        saved_at: agent.updated_at,
      };
      const nextPc: BusinessAgentPromptConfig = {
        ...pc,
        system_instructions: instructions,
        role_definition: roleDefinition,
        goals: goals.filter((g) => g.trim()),
        behavioral_rules: rules.filter((r) => r.trim()),
        output_format: outputFormat,
        escalation_rules: escalation,
        version: pc.version + 1,
        history: changed
          ? [historyEntry, ...pc.history].slice(0, PROMPT_HISTORY_CAP)
          : pc.history,
      };
      await businessAgentService.update(agent.id, { prompt_config: nextPc });
      upsertAgent({ ...agent, prompt_config: nextPc, updated_at: nowISO() });
      await emitAgentEvent("agent.updated", { promptVersion: nextPc.version });
      toast.success(bt("toast.saved"));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingPrompt(false);
    }
  }

  function handleRevert(version: { system_instructions: string }) {
    setInstructions(version.system_instructions);
  }

  async function handleSaveConfig() {
    if (!agent) return;
    setSavingConfig(true);
    try {
      const nextProviderId = providerId === PROVIDER_INHERIT ? "" : providerId;
      const nextModelId = providerId === PROVIDER_INHERIT ? "" : modelId;
      await businessAgentService.update(agent.id, {
        provider_id: nextProviderId,
        model_id: nextModelId,
        skills,
        permissions,
      });
      upsertAgent({
        ...agent,
        provider_id: nextProviderId,
        model_id: nextModelId,
        skills: [...skills],
        permissions: { ...permissions },
        updated_at: nowISO(),
      });
      await emitAgentEvent("agent.updated", { providerId: nextProviderId, modelId: nextModelId });
      toast.success(bt("toast.agentUpdated"));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingConfig(false);
    }
  }

  async function handleRunTest() {
    if (!agent || !businessId) return;
    setTestRunning(true);
    setTestError(null);
    setTestOutput(null);
    try {
      const output = await runAgentTest(businessId, agent.id, testInput);
      setTestOutput(output);
    } catch (err) {
      // runAgentTest already localizes its message via bt("agent.test.failed").
      setTestError(err instanceof Error ? err.message : String(err));
    } finally {
      setTestRunning(false);
    }
  }

  // -- Render ----------------------------------------------------------------

  const currentTask = agent?.current_task_id
    ? tasks.find((t) => t.id === agent.current_task_id)
    : undefined;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-xl">
        <SheetHeader>
          <div className="flex min-w-0 items-center gap-3">
            {agent && <AgentLogo logo={agent.svg_logo} className="size-9" label={agent.name} />}
            <div className="min-w-0 flex-1">
              <SheetTitle className="truncate">{agent?.name ?? ""}</SheetTitle>
              <SheetDescription className="truncate text-xs">
                {agent ? bt("agent.details") : ""}
              </SheetDescription>
            </div>
            <SheetClose onClick={() => onOpenChange(false)} aria-label={bt("common.close")} />
          </div>
        </SheetHeader>

        {agent && (
          <Tabs value={tab} onValueChange={(v) => setTab(v as DetailTab)} className="flex min-h-0 flex-1 flex-col gap-4 p-4">
            <TabsList className="w-full flex-wrap">
              <TabsTrigger value="overview">{bt("settings.general")}</TabsTrigger>
              <TabsTrigger value="prompt">{bt("agent.prompt")}</TabsTrigger>
              <TabsTrigger value="config">{"Config"}</TabsTrigger>
              <TabsTrigger value="test">{bt("agent.test.title")}</TabsTrigger>
            </TabsList>

            {/* ------------------------- Overview ------------------------- */}
            <TabsContent value="overview" className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
              <div className="flex flex-col gap-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline" className={statusBadgeClass(agent.status, agent.paused)}>
                    {bt(`status.${agent.status}`)}
                  </Badge>
                  <Badge variant="secondary">{agent.role}</Badge>
                  <span className="text-xs text-muted-foreground">
                    {bt("swarm.tasksCompleted", { count: agent.metrics.tasks_completed })}
                    {" · "}
                    {bt("swarm.tasksFailed", { count: agent.metrics.tasks_failed })}
                    {agent.last_activity
                      ? ` · ${bt("swarm.lastActivity")} ${timeAgo(agent.last_activity)}`
                      : ` · ${bt("swarm.lastActivity")} ${bt("common.never")}`}
                  </span>
                </div>

                {currentTask && (
                  <div className="rounded-lg border px-3 py-2 text-sm">
                    <span className="text-muted-foreground">{bt("swarm.currentTask")}: </span>
                    <span className="font-medium">{currentTask.title}</span>
                  </div>
                )}

                <div className="flex flex-col gap-2">
                  <Label htmlFor="agent-detail-name">{bt("agent.name")}</Label>
                  <Input
                    id="agent-detail-name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className="h-11"
                  />
                </div>

                <div className="flex flex-col gap-2">
                  <Label htmlFor="agent-detail-description">{bt("agent.description")}</Label>
                  <Textarea
                    id="agent-detail-description"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    rows={2}
                  />
                </div>

                <div className="flex flex-col gap-2">
                  <Label htmlFor="agent-detail-role">{bt("agent.role")}</Label>
                  <Input
                    id="agent-detail-role"
                    value={role}
                    onChange={(e) => setRole(e.target.value)}
                    className="h-11"
                  />
                </div>

                <div className="flex flex-col gap-2">
                  <Label>{bt("agent.logo")}</Label>
                  <div
                    className="grid grid-cols-8 gap-2"
                    role="radiogroup"
                    aria-label={bt("agent.logo")}
                  >
                    {AGENT_LOGOS.map((l) => (
                      <button
                        key={l.key}
                        type="button"
                        role="radio"
                        aria-checked={logo === l.key}
                        aria-label={l.label}
                        onClick={() => setLogo(l.key)}
                        className={cn(
                          "flex min-h-11 items-center justify-center rounded-lg border p-1.5 transition-colors",
                          logo === l.key
                            ? "border-primary bg-primary/10 text-primary"
                            : "border-border text-muted-foreground hover:border-primary/40 hover:text-foreground",
                        )}
                      >
                        <AgentLogo logo={l.key} className="size-7" />
                      </button>
                    ))}
                  </div>
                </div>

                <Button onClick={handleSaveIdentity} disabled={savingIdentity} className="h-11">
                  {savingIdentity && <Spinner className="mr-2 size-4" />}
                  {bt("common.save")}
                </Button>

                <div className="grid grid-cols-2 gap-2 pt-2">
                  <Button variant="outline" onClick={handleTogglePause} className="h-11">
                    {agent.paused ? <Play className="mr-2 size-4" /> : <Pause className="mr-2 size-4" />}
                    {agent.paused ? bt("swarm.resume") : bt("swarm.pause")}
                  </Button>
                  <Button variant="outline" onClick={() => setTab("test")} className="h-11">
                    <FlaskConical className="mr-2 size-4" />
                    {bt("swarm.test")}
                  </Button>
                  <Button variant="outline" onClick={handleDuplicate} className="h-11">
                    <Copy className="mr-2 size-4" />
                    {bt("swarm.duplicate")}
                  </Button>
                  <Button
                    variant="destructive"
                    onClick={() => setDeleteOpen(true)}
                    disabled={deleteBlocked || deleting}
                    className="h-11"
                  >
                    <Trash2 className="mr-2 size-4" />
                    {bt("swarm.deleteAgent")}
                  </Button>
                </div>

                {deleteBlocked && (
                  <Alert variant="destructive">
                    <AlertTriangle className="size-4" />
                    <AlertTitle>{bt("swarm.deleteAgent")}</AlertTitle>
                    <AlertDescription>
                      {bt("swarm.deleteWarning", {
                        name: agent.name,
                        count: unfinishedTasks.length,
                      })}
                    </AlertDescription>
                  </Alert>
                )}
              </div>
            </TabsContent>

            {/* ------------------------- Prompt ------------------------- */}
            <TabsContent value="prompt" className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
              <div className="flex flex-col gap-4">
                <div className="flex flex-col gap-2">
                  <Label htmlFor="agent-prompt-instructions">
                    {bt("agent.prompt.instructions")}
                  </Label>
                  <Textarea
                    id="agent-prompt-instructions"
                    value={instructions}
                    onChange={(e) => setInstructions(e.target.value)}
                    rows={10}
                    className="font-mono text-xs"
                  />
                </div>

                <div className="flex flex-col gap-2">
                  <Label htmlFor="agent-prompt-role">{bt("agent.prompt.roleDefinition")}</Label>
                  <Textarea
                    id="agent-prompt-role"
                    value={roleDefinition}
                    onChange={(e) => setRoleDefinition(e.target.value)}
                    rows={3}
                  />
                </div>

                <StringListEditor
                  label={bt("agent.prompt.goals")}
                  addLabel={bt("agent.prompt.addGoal")}
                  items={goals}
                  draft={goalDraft}
                  onDraftChange={setGoalDraft}
                  onItemsChange={setGoals}
                />

                <StringListEditor
                  label={bt("agent.prompt.rules")}
                  addLabel={bt("agent.prompt.addRule")}
                  items={rules}
                  draft={ruleDraft}
                  onDraftChange={setRuleDraft}
                  onItemsChange={setRules}
                />

                <div className="flex flex-col gap-2">
                  <Label htmlFor="agent-prompt-output">{bt("agent.prompt.outputFormat")}</Label>
                  <Textarea
                    id="agent-prompt-output"
                    value={outputFormat}
                    onChange={(e) => setOutputFormat(e.target.value)}
                    rows={3}
                  />
                </div>

                <div className="flex flex-col gap-2">
                  <Label htmlFor="agent-prompt-escalation">{bt("agent.prompt.escalation")}</Label>
                  <Textarea
                    id="agent-prompt-escalation"
                    value={escalation}
                    onChange={(e) => setEscalation(e.target.value)}
                    rows={3}
                  />
                </div>

                <div>
                  <Button onClick={handleSavePrompt} disabled={savingPrompt} className="h-11">
                    {savingPrompt && <Spinner className="mr-2 size-4" />}
                    {bt("common.save")}
                  </Button>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {bt("agent.prompt.savedNote")}
                  </p>
                </div>

                {promptHistory.length > 0 && (
                  <div className="flex flex-col gap-2">
                    <Label>{bt("agent.prompt.history")}</Label>
                    <ul className="divide-y rounded-lg border">
                      {promptHistory.map((h) => (
                        <li key={h.version} className="flex items-center gap-2 px-3 py-2">
                          <span className="text-sm font-medium">
                            {bt("agent.prompt.version", { version: h.version })}
                          </span>
                          <span className="flex-1 truncate text-xs text-muted-foreground">
                            {h.system_instructions.slice(0, 80) || "—"}
                          </span>
                          <span className="text-xs text-muted-foreground">{timeAgo(h.saved_at)}</span>
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-9"
                            onClick={() => handleRevert(h)}
                          >
                            {bt("agent.prompt.revert")}
                          </Button>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </TabsContent>

            {/* ------------------------- Config ------------------------- */}
            <TabsContent value="config" className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
              <div className="flex flex-col gap-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="agent-config-provider">{bt("agent.provider")}</Label>
                    <Select
                      value={providerId}
                      onValueChange={(v) => {
                        setProviderId(v);
                        setModelId("");
                      }}
                    >
                      <SelectTrigger id="agent-config-provider" className="h-11">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={PROVIDER_INHERIT}>
                          {bt("agent.providerInherit")}
                        </SelectItem>
                        {providers.map((p) => (
                          <SelectItem key={p.id} value={p.id}>
                            {p.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="agent-config-model">{bt("agent.model")}</Label>
                    <Select
                      value={modelId || undefined}
                      onValueChange={setModelId}
                      disabled={providerId === PROVIDER_INHERIT || !selectedProvider}
                    >
                      <SelectTrigger id="agent-config-model" className="h-11">
                        <SelectValue
                          placeholder={
                            providerId === PROVIDER_INHERIT
                              ? bt("swarm.inheritModel")
                              : bt("agent.model")
                          }
                        />
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
                  <Label>{bt("agent.skills")}</Label>
                  {availableSkills.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{bt("agent.skillsEmpty")}</p>
                  ) : (
                    <div className="flex flex-col gap-1 rounded-lg border p-2">
                      {availableSkills.map((s) => {
                        const checked = skills.includes(s.id);
                        return (
                          <label
                            key={s.id}
                            className="flex min-h-11 cursor-pointer items-start gap-3 rounded-md px-2 py-2 hover:bg-accent/50"
                          >
                            <Checkbox
                              checked={checked}
                              onCheckedChange={(v) =>
                                setSkills((prev) =>
                                  v === true
                                    ? [...prev, s.id]
                                    : prev.filter((id) => id !== s.id),
                                )
                              }
                              aria-label={s.name}
                              className="mt-0.5"
                            />
                            <span className="min-w-0">
                              <span className="block text-sm font-medium">{s.name}</span>
                              {s.description && (
                                <span className="block truncate text-xs text-muted-foreground">
                                  {s.description}
                                </span>
                              )}
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  )}
                </div>

                <div className="flex flex-col gap-2">
                  <Label>{bt("agent.permissions")}</Label>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {(
                      [
                        ["web_search", "agent.perm.webSearch"],
                        ["create_drafts", "agent.perm.createDrafts"],
                        ["read_memory", "agent.perm.readMemory"],
                        ["write_memory", "agent.perm.writeMemory"],
                      ] as const
                    ).map(([key, labelKey]) => (
                      <label
                        key={key}
                        className="flex min-h-11 items-center justify-between gap-3 rounded-lg border px-3 py-2"
                      >
                        <span className="text-sm">{bt(labelKey)}</span>
                        <Switch
                          checked={permissions[key]}
                          onCheckedChange={(v) =>
                            setPermissions((prev) => ({ ...prev, [key]: v }))
                          }
                          aria-label={bt(labelKey)}
                        />
                      </label>
                    ))}
                  </div>
                </div>

                <Button onClick={handleSaveConfig} disabled={savingConfig} className="h-11">
                  {savingConfig && <Spinner className="mr-2 size-4" />}
                  {bt("common.save")}
                </Button>
              </div>
            </TabsContent>

            {/* ------------------------- Test ------------------------- */}
            <TabsContent value="test" className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
              <div className="flex flex-col gap-4">
                <p className="text-sm text-muted-foreground">{bt("agent.test.hint")}</p>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="agent-test-input">{bt("agent.test.input")}</Label>
                  <Input
                    id="agent-test-input"
                    value={testInput}
                    onChange={(e) => setTestInput(e.target.value)}
                    placeholder={bt("agent.test.inputPlaceholder")}
                    className="h-11"
                  />
                </div>
                <Button
                  onClick={handleRunTest}
                  disabled={testRunning}
                  className="h-11"
                >
                  {testRunning ? <Spinner className="mr-2 size-4" /> : <FlaskConical className="mr-2 size-4" />}
                  {testRunning ? bt("agent.test.running") : bt("agent.test.run")}
                </Button>

                {testError && (
                  <Alert variant="destructive">
                    <AlertTriangle className="size-4" />
                    <AlertDescription>{testError}</AlertDescription>
                  </Alert>
                )}

                {testOutput !== null && (
                  <div className="flex flex-col gap-2">
                    <Label>{bt("agent.test.output")}</Label>
                    <div className="max-h-72 overflow-y-auto scrollbar-thin rounded-lg border bg-muted/30 p-3">
                      <pre className="whitespace-pre-wrap break-words text-sm">{testOutput}</pre>
                    </div>
                  </div>
                )}
              </div>
            </TabsContent>
          </Tabs>
        )}
              <ConfirmDialog
          open={deleteOpen}
          onOpenChange={setDeleteOpen}
          title={bt("swarm.deleteAgent")}
          description={bt("swarm.deleteConfirm", { name: agent?.name ?? "" })}
          destructive
          loading={deleting}
          onConfirm={handleDelete}
        />
      </SheetContent>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// Dynamic string list editor (goals / behavioral rules).
// ---------------------------------------------------------------------------

function StringListEditor({
  label,
  addLabel,
  items,
  draft,
  onDraftChange,
  onItemsChange,
}: {
  label: string;
  addLabel: string;
  items: string[];
  draft: string;
  onDraftChange: (v: string) => void;
  onItemsChange: (items: string[]) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <Label>{label}</Label>
      {items.length > 0 && (
        <ul className="flex flex-col gap-1">
          {items.map((item, i) => (
            <li
              key={`${i}-${item}`}
              className="flex min-h-11 items-center gap-2 rounded-lg border px-3 py-2 text-sm"
            >
              <span className="flex-1 whitespace-pre-wrap break-words">{item}</span>
              <Button
                variant="ghost"
                size="icon"
                className="size-9 shrink-0"
                onClick={() => onItemsChange(items.filter((_, idx) => idx !== i))}
                aria-label={bt("common.delete")}
              >
                <X className="size-4" />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex gap-2">
        <Input
          value={draft}
          onChange={(e) => onDraftChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && draft.trim()) {
              e.preventDefault();
              onItemsChange([...items, draft.trim()]);
              onDraftChange("");
            }
          }}
          aria-label={label}
          className="h-11"
        />
        <Button
          variant="outline"
          className="h-11 shrink-0"
          disabled={!draft.trim()}
          onClick={() => {
            onItemsChange([...items, draft.trim()]);
            onDraftChange("");
          }}
        >
          <Plus className="mr-2 size-4" />
          {addLabel}
        </Button>
      </div>
    </div>
  );
}

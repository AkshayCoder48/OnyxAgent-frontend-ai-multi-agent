"use client";

/**
 * CreateProjectDialog (Task 1-b, PRD §4 + §8 + §9.2/§9.8) — the single,
 * polished, fully-manual project creation AND editing surface.
 *
 *   Basics tab   — required Name + Goal (validated non-empty) with inline
 *                  errors, Instructions editor, icon picker (fixed 12-icon
 *                  set), accent-color swatches (8).
 *   Memory tab   — the PRD §7.4 controls: memory on/off, cross-chat
 *                  retrieval, automatic memory updates + the context budget.
 *   Resources tab— REAL installed resources only (PRD §8.1): built-in tools
 *                  enumerated live from the tool registry, MCP servers, the
 *                  SKILLS DIRECTORY (the 55-skill master library that ships
 *                  with every sandbox — the same source `manage_skill`
 *                  action "list" and Settings → Skills use — plus the
 *                  user's additionally installed skills), Composio
 *                  connectors, and the terminal / browser capabilities —
 *                  each with an explicit tri-state
 *                  (Allowed / Approval required / Denied). Empty categories
 *                  say "None installed" honestly. Explicit non-default
 *                  choices become `ProjectResourceRule`s; everything else
 *                  stays implicit (defaults resolve via permissions.ts, and
 *                  a project can never LOOSEN a stricter global rule).
 *   Model pref   — optional preferred model select (PRD §9.8), reusing the
 *                  same provider source as the chat model picker.
 *
 * EDIT MODE (a `project` prop): every field prefills; saving snapshots
 * changed instructions into `instructions_history` (service-side, cap 20)
 * and a "History" popover lists prior versions with Restore buttons
 * (PRD §9.2).
 *
 * Failure honesty: Create is disabled while busy, and a failed persist keeps
 * the dialog open with an error — nothing is created (PRD §4 creation
 * actions).
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Blocks,
  Check,
  History,
  Loader2,
  Plug,
  Server,
  Sparkles,
  TerminalSquare,
  Globe,
  Wrench,
  FolderCog,
} from "lucide-react";
import { toast } from "sonner";

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
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/stores";
import { useProviders } from "@/hooks/use-data";
import { mcpService, skillService } from "@/lib/services";
import { MASTER_SKILLS } from "@/lib/agent/master-skills";
import { listTools } from "@/lib/tools/registry";
import {
  defaultPermissionFor,
  loadGlobalPolicy,
  PERMISSION_LABELS,
} from "@/lib/projects/permissions";
import { DEFAULT_MEMORY_SETTINGS } from "@/lib/projects/service";
import { useProjectsStore } from "@/lib/projects/store";
import type {
  Project,
  ProjectMemorySettings,
  ProjectResourceRule,
  ResourcePermission,
} from "@/types";
import {
  PROJECT_ACCENTS,
  PROJECT_ICONS,
  PROJECT_ICON_KEYS,
  DEFAULT_PROJECT_ACCENT,
  DEFAULT_PROJECT_ICON,
  ProjectGlyph,
  accentAlpha,
} from "./project-identity";
import { resetToNewChatState } from "./project-conversations";

// ---------------------------------------------------------------------------
// Tri-state permission select
// ---------------------------------------------------------------------------

const PERMISSION_ORDER: ResourcePermission[] = ["allowed", "approval_required", "denied"];

function PermissionSelect({
  value,
  onChange,
  label,
}: {
  value: ResourcePermission;
  onChange: (next: ResourcePermission) => void;
  label: string;
}) {
  return (
    <div className="flex min-w-0 flex-1 items-center justify-between gap-2">
      <span className="truncate text-[13px]" title={label}>
        {label}
      </span>
      <Select value={value} onValueChange={(v) => onChange(v as ResourcePermission)}>
        <SelectTrigger
          aria-label={`Permission for ${label}`}
          className="h-8 w-[132px] shrink-0 rounded-lg text-xs"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {PERMISSION_ORDER.map((p) => (
            <SelectItem key={p} value={p} className="text-xs">
              {PERMISSION_LABELS[p]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Resource tab types
// ---------------------------------------------------------------------------

interface ResourceRow {
  key: string;
  resource_type: ProjectResourceRule["resource_type"];
  resource_id: string;
  label: string;
  /** The permission that applies when the project has NO explicit rule. */
  defaultPermission: ResourcePermission;
  hint?: string;
}

interface ResourcesModel {
  rows: ResourceRow[];
  /** resource key ("type:id") → explicit permission. */
  overrides: Record<string, ResourcePermission>;
}

function ruleKey(r: Pick<ProjectResourceRule, "resource_type" | "resource_id">): string {
  return `${r.resource_type}:${r.resource_id}`;
}

// ---------------------------------------------------------------------------
// The dialog
// ---------------------------------------------------------------------------

export interface CreateProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Pass a project to EDIT it; omit/null to create a new one. */
  project?: Project | null;
  /** Which tab the dialog opens on (the sidebar's "Manage access" opens Resources). */
  initialTab?: "basics" | "memory" | "resources";
}

export function CreateProjectDialog({
  open,
  onOpenChange,
  project = null,
  initialTab = "basics",
}: CreateProjectDialogProps) {
  const isEdit = !!project;
  const userId = useAuthStore((s) => s.user?.id);

  const createProject = useProjectsStore((s) => s.createProject);
  const updateProject = useProjectsStore((s) => s.updateProject);

  // ── form state (re-initialized whenever the dialog opens) ───────────────
  const [tab, setTab] = useState(initialTab);
  const [name, setName] = useState("");
  const [goal, setGoal] = useState("");
  const [instructions, setInstructions] = useState("");
  const [icon, setIcon] = useState<string>(DEFAULT_PROJECT_ICON);
  const [accent, setAccent] = useState<string>(DEFAULT_PROJECT_ACCENT);
  const [memory, setMemory] = useState<ProjectMemorySettings>({ ...DEFAULT_MEMORY_SETTINGS });
  const [preferredModel, setPreferredModel] = useState<string>("none");
  const [resources, setResources] = useState<ResourcesModel>({ rows: [], overrides: {} });
  const [resourcesLoading, setResourcesLoading] = useState(false);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    setTab(initialTab);
    setTouched(false);
    setBusy(false);
    setHistoryOpen(false);
    setName(project?.name ?? "");
    setGoal(project?.goal ?? "");
    setInstructions(project?.instructions ?? "");
    setIcon(project?.icon ?? DEFAULT_PROJECT_ICON);
    setAccent(project?.accent_color ?? DEFAULT_PROJECT_ACCENT);
    setMemory({ ...DEFAULT_MEMORY_SETTINGS, ...(project?.memory_settings ?? {}) });
    setPreferredModel(project?.model_preferences?.preferred_model ?? "none");
    // Existing explicit rules become the override map (default rows load below).
    setResources({ rows: [], overrides: {} });
  }, [open, project, initialTab]);

  // ── resources tab: enumerate the REAL installed resources (once per open) ──
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setResourcesLoading(true);
    void (async () => {
      try {
        const uid = useAuthStore.getState().user?.id;
        const [globalPolicyRaw, mcpRows, skillRows, composioToolkits] = await Promise.all([
          uid ? loadGlobalPolicy(uid).catch(() => ({})) : Promise.resolve({}),
          uid ? mcpService.list(uid, true).catch(() => []) : Promise.resolve([]),
          uid ? skillService.listInstalled(uid).catch(() => []) : Promise.resolve([]),
          (async () => {
            if (!uid) return null;
            try {
              const { resolveComposioHeaders, apiComposioConnections } = await import(
                "@/lib/composio/browser"
              );
              const headers = await resolveComposioHeaders(uid);
              if (!headers) return null;
              const res = await apiComposioConnections(headers);
              return res.items.filter((c) => c.state === "active");
            } catch {
              return null;
            }
          })(),
        ]);

        const globalPolicy: Record<string, ResourcePermission> = globalPolicyRaw;
        const perm = (toolName: string): ResourcePermission =>
          globalPolicy[toolName] ?? defaultPermissionFor(toolName);

        // Built-in tools from the live registry (terminal + browser get their
        // own capability rows below; ask_user is the core interaction channel).
        const EXCLUDE = new Set(["run_terminal", "use_browser", "ask_user"]);
        const toolRows: ResourceRow[] = listTools()
          .filter((t) => !EXCLUDE.has(t.name))
          .map((t) => ({
            key: `tool:${t.name}`,
            resource_type: "tool",
            resource_id: t.name,
            label: t.name,
            defaultPermission: perm(t.name),
            hint: t.description,
          }));

        const mcpRowsTyped = mcpRows as Array<{
          id: string;
          name: string;
          transport?: string;
        }>;
        const mcpResourceRows: ResourceRow[] = mcpRowsTyped.map((s) => ({
          key: `mcp_server:${s.id}`,
          resource_type: "mcp_server",
          resource_id: s.id,
          label: s.name,
          defaultPermission: "allowed",
          hint: `MCP server (${s.transport ?? "stdio"})`,
        }));

        // SKILLS — the skills DIRECTORY is the default source (user request
        // 2026-10-19): the 55-skill MASTER LIBRARY bundled with every sandbox
        // (/home/user/skills — the same list `manage_skill` action "list"
        // and the Settings → Skills page render) PLUS the user's additionally
        // installed skills. Library skills have no DB row, so they are
        // identified BY NAME (stable across sessions); an installed skill
        // with the same name shadows its library copy.
        const installedSkillRows: ResourceRow[] = (
          skillRows as Array<{ id: string; name: string; description?: string | null }>
        )
          .filter((s) => (s as { is_active?: boolean }).is_active !== false)
          .map((s) => ({
            key: `skill:${s.id}`,
            resource_type: "skill",
            resource_id: s.id,
            label: s.name,
            defaultPermission: "allowed",
            hint: s.description ?? undefined,
          }));
        const installedSkillNames = new Set(
          installedSkillRows.map((r) => r.label.trim().toLowerCase()),
        );
        const masterSkillRows: ResourceRow[] = MASTER_SKILLS.map((s) => ({
          key: `skill:${s.name}`,
          resource_type: "skill",
          resource_id: s.name,
          label: s.name,
          defaultPermission: "allowed",
          hint: s.description,
        }));
        const skillResourceRows: ResourceRow[] = [
          ...masterSkillRows.filter(
            (m) => !installedSkillNames.has(m.label.trim().toLowerCase()),
          ),
          ...installedSkillRows,
        ];

        const connectorRows: ResourceRow[] = (composioToolkits ?? []).map((c) => ({
          key: `connector:${c.toolkit}`,
          resource_type: "connector",
          resource_id: c.toolkit,
          label: c.toolkit,
          defaultPermission: perm("composio_execute_tool"),
          hint: "Composio connector",
        }));

        const capabilityRows: ResourceRow[] = [
          {
            key: "terminal:terminal",
            resource_type: "terminal",
            resource_id: "terminal",
            label: "Terminal (run_terminal)",
            defaultPermission: perm("run_terminal"),
            hint: "Command execution inside the sandbox.",
          },
          {
            key: "browser:browser",
            resource_type: "browser",
            resource_id: "browser",
            label: "Browser (use_browser)",
            defaultPermission: perm("use_browser"),
            hint: "Headless browser automation.",
          },
        ];

        if (!alive) return;
        setResources((prev) => ({
          rows: [
            ...capabilityRows,
            ...toolRows,
            ...mcpResourceRows,
            ...skillResourceRows,
            ...connectorRows,
          ],
          overrides: prev.overrides,
        }));
      } finally {
        if (alive) setResourcesLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [open, userId]);

  // Seed the override map from the project's existing rules once rows load.
  useEffect(() => {
    if (!project || resources.rows.length === 0) return;
    setResources((prev) => {
      if (Object.keys(prev.overrides).length > 0 || !project.resources) return prev;
      const overrides: Record<string, ResourcePermission> = {};
      for (const rule of project.resources) {
        overrides[ruleKey(rule)] = rule.permission;
      }
      return { ...prev, overrides };
    });
  }, [project, resources.rows.length]);

  // ── model preference options (same source the chat picker uses) ────────
  const { providers } = useProviders();
  const modelOptions = useMemo(() => {
    const out: Array<{ value: string; label: string; provider: string }> = [];
    for (const p of providers) {
      for (const m of p.models || []) {
        out.push({ value: m, label: m, provider: p.name });
      }
    }
    return out;
  }, [providers]);

  // ── validation ──────────────────────────────────────────────────────────
  const nameError = touched && !name.trim() ? "Project name is required." : null;
  const goalError = touched && !goal.trim() ? "Describe what this project is for." : null;
  const canSubmit = !!name.trim() && !!goal.trim() && !busy;

  const effectiveRules = useCallback((): ProjectResourceRule[] => {
    const ts = new Date().toISOString();
    return resources.rows
      .filter((row) => {
        const explicit = resources.overrides[row.key];
        return explicit !== undefined && explicit !== row.defaultPermission;
      })
      .map((row) => ({
        resource_type: row.resource_type,
        resource_id: row.resource_id,
        permission: resources.overrides[row.key]!,
        updated_at: ts,
      }));
  }, [resources]);

  const handleSubmit = useCallback(async () => {
    setTouched(true);
    if (!name.trim() || !goal.trim() || busy) return;
    setBusy(true);
    try {
      if (isEdit && project) {
        const updated = await updateProject(project.id, {
          name: name.trim(),
          goal: goal.trim(),
          description: project.description ?? null,
          instructions,
          icon,
          accent_color: accent,
          memory_settings: memory,
          model_preferences: { preferred_model: preferredModel === "none" ? null : preferredModel },
          resources: effectiveRules(),
        });
        if (updated) {
          toast.success("Project updated");
          onOpenChange(false);
        } else {
          toast.error(useProjectsStore.getState().error ?? "Failed to update the project");
        }
      } else {
        const created = await createProject({
          name: name.trim(),
          goal: goal.trim(),
          instructions,
          icon,
          accent_color: accent,
          memory_settings: memory,
          model_preferences: { preferred_model: preferredModel === "none" ? null : preferredModel },
          resources: effectiveRules(),
        });
        if (created) {
          // PRD §4 creation actions: persist → refresh (store) → open the
          // project's empty screen. resetToNewChatState clears any open
          // GENERAL conversation so the project context owns the surface.
          resetToNewChatState();
          useProjectsStore.getState().openProject(created.id);
          useProjectsStore.getState().setHistoryDrawerOpen(false);
          toast.success(`Project “${created.name}” created`);
          onOpenChange(false);
        } else {
          toast.error(useProjectsStore.getState().error ?? "Failed to create the project");
        }
      }
    } finally {
      setBusy(false);
    }
  }, [
    isEdit,
    project,
    name,
    goal,
    instructions,
    icon,
    accent,
    memory,
    preferredModel,
    resources,
    busy,
    createProject,
    updateProject,
    effectiveRules,
    onOpenChange,
  ]);

  // Instructions history (edit mode, PRD §9.2): latest first, restore buttons.
  const history = useMemo(
    () => [...(project?.instructions_history ?? [])].reverse(),
    [project],
  );

  const setPermission = useCallback((key: string, next: ResourcePermission) => {
    setResources((prev) => ({ ...prev, overrides: { ...prev.overrides, [key]: next } }));
  }, []);

  const rowCountFor = (filter: (r: ResourceRow) => boolean) => resources.rows.filter(filter).length;

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent
        className={cn(
          // Centered on ALL viewports (the base dialog positioning) — mobile
          // previously pinned this to the bottom edge as a sheet, which read
          // as "stuck to the bottom". dvh-aware max-height keeps it clear of
          // mobile browser chrome; rounded-2xl restores corners on mobile
          // (the base only rounds at sm+); max-w-none un-caps the base
          // max-w-lg (512px) so the intended 600px width applies.
          "flex max-h-[min(88vh,88dvh)] w-[min(94vw,600px)] max-w-none flex-col gap-0 overflow-hidden rounded-2xl p-0",
        )}
      >
        <DialogHeader className="border-b px-5 pt-4 pb-3 text-left">
          <div className="flex items-center gap-3 pr-8">
            <ProjectGlyph iconKey={icon} accent={accent} size={34} />
            <div className="min-w-0 flex-1">
              <DialogTitle className="truncate text-base">
                {isEdit ? `Edit “${project?.name}”` : "Create a project"}
              </DialogTitle>
              <DialogDescription className="mt-0.5 text-xs">
                {isEdit
                  ? "A dedicated workspace with its own instructions, memory and resources."
                  : "A persistent workspace with its own chats, instructions, memory and resources."}
              </DialogDescription>
            </div>
            {isEdit && history.length > 0 && (
              <Popover open={historyOpen} onOpenChange={setHistoryOpen}>
                <PopoverTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-8 shrink-0 gap-1.5 rounded-lg text-xs"
                    aria-label="Instructions version history"
                  >
                    <History className="h-3.5 w-3.5" aria-hidden />
                    History
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="end" className="w-80 p-0" sideOffset={8}>
                  <p className="border-b px-3 py-2 text-xs font-medium">
                    Instructions history ({history.length})
                  </p>
                  <div className="max-h-64 overflow-y-auto p-1.5">
                    {history.map((entry, i) => (
                      <div
                        key={`${entry.saved_at}-${i}`}
                        className="group flex items-start gap-2 rounded-lg px-2 py-1.5 hover:bg-foreground/5"
                      >
                        <div className="min-w-0 flex-1">
                          <p className="text-[11px] text-muted-foreground">
                            {new Date(entry.saved_at).toLocaleString()}
                            {i === 0 && " · current"}
                          </p>
                          <p className="mt-0.5 line-clamp-2 text-xs">{entry.content || "(empty)"}</p>
                        </div>
                        {i !== 0 && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-7 shrink-0 px-2 text-[11px]"
                            onClick={() => {
                              setInstructions(entry.content);
                              setHistoryOpen(false);
                              setTab("basics");
                              toast.success("Instructions restored into the editor");
                            }}
                          >
                            <Check className="h-3 w-3" aria-hidden /> Restore
                          </Button>
                        )}
                      </div>
                    ))}
                  </div>
                </PopoverContent>
              </Popover>
            )}
          </div>
        </DialogHeader>

        <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)} className="flex min-h-0 flex-1 flex-col">
          <div className="border-b px-4 pt-2">
            <TabsList className="h-9 w-full justify-start rounded-lg bg-muted/60 p-0.5">
              <TabsTrigger value="basics" className="flex-1 rounded-md text-xs sm:flex-none sm:px-4">
                Basics
              </TabsTrigger>
              <TabsTrigger value="memory" className="flex-1 rounded-md text-xs sm:flex-none sm:px-4">
                Memory
              </TabsTrigger>
              <TabsTrigger value="resources" className="flex-1 rounded-md text-xs sm:flex-none sm:px-4">
                Resources
              </TabsTrigger>
            </TabsList>
          </div>

          {/* Single scroll area — every tab stays compact (PRD §4). */}
          <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-5 py-4 [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border [&::-webkit-scrollbar-track]:transparent">
            <TabsContent value="basics" className="mt-0 space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="project-name" className="text-xs font-medium">
                  Name <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="project-name"
                  value={name}
                  maxLength={80}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Website Redesign"
                  aria-invalid={!!nameError}
                  aria-describedby={nameError ? "project-name-error" : undefined}
                />
                {nameError && (
                  <p id="project-name-error" className="text-xs text-destructive" role="alert">
                    {nameError}
                  </p>
                )}
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="project-goal" className="text-xs font-medium">
                  Goal <span className="text-destructive">*</span>
                </Label>
                <Textarea
                  id="project-goal"
                  value={goal}
                  maxLength={600}
                  onChange={(e) => setGoal(e.target.value)}
                  placeholder="What is this project intended to accomplish? This stays available to the AI as persistent context."
                  className="min-h-[64px] resize-y text-sm"
                  aria-invalid={!!goalError}
                  aria-describedby={goalError ? "project-goal-error" : undefined}
                />
                {goalError && (
                  <p id="project-goal-error" className="text-xs text-destructive" role="alert">
                    {goalError}
                  </p>
                )}
                <p className="text-[11px] text-muted-foreground">{goal.length}/600</p>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="project-instructions" className="text-xs font-medium">
                  Instructions
                </Label>
                <Textarea
                  id="project-instructions"
                  value={instructions}
                  onChange={(e) => setInstructions(e.target.value)}
                  placeholder={"Project-specific rules, e.g.\n- Inspect relevant files before making changes.\n- Never claim a feature is done without verifying it."}
                  className="min-h-[96px] resize-y text-sm"
                />
                <p className="text-[11px] text-muted-foreground">
                  {isEdit
                    ? "Changes are versioned — restore earlier versions from History."
                    : "Editable after creation; changes are versioned."}
                </p>
              </div>

              <div className="space-y-2">
                <Label className="text-xs font-medium">Icon</Label>
                <div className="grid grid-cols-6 gap-1.5 sm:grid-cols-12">
                  {PROJECT_ICON_KEYS.map((key) => {
                    const Ico = PROJECT_ICONS[key]!;
                    return (
                      <button
                        key={key}
                        type="button"
                        onClick={() => setIcon(key)}
                        aria-pressed={icon === key}
                        aria-label={`Icon: ${key}`}
                        className={cn(
                          "flex h-9 items-center justify-center rounded-lg border transition-colors",
                          icon === key
                            ? "border-primary bg-primary/10 text-primary"
                            : "border-border text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
                        )}
                      >
                        <Ico className="h-4 w-4" aria-hidden />
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="space-y-2">
                <Label className="text-xs font-medium">Accent color</Label>
                <div className="flex flex-wrap items-center gap-2">
                  {PROJECT_ACCENTS.map((hex) => (
                    <button
                      key={hex}
                      type="button"
                      onClick={() => setAccent(hex)}
                      aria-pressed={accent === hex}
                      aria-label={`Accent ${hex}`}
                      className={cn(
                        "flex h-8 w-8 items-center justify-center rounded-full border-2 transition-transform",
                        accent === hex ? "scale-110" : "hover:scale-105",
                      )}
                      style={{ backgroundColor: hex, borderColor: accent === hex ? hex : accentAlpha(hex, 0.35) }}
                    >
                      {accent === hex && <Check className="h-3.5 w-3.5 text-white" aria-hidden />}
                    </button>
                  ))}
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="project-model" className="text-xs font-medium">
                  Preferred model <span className="font-normal text-muted-foreground">(optional)</span>
                </Label>
                <Select value={preferredModel} onValueChange={setPreferredModel}>
                  <SelectTrigger id="project-model" className="h-9 rounded-lg text-sm">
                    <SelectValue placeholder="No preference" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none" className="text-sm">
                      No preference (use chat default)
                    </SelectItem>
                    {modelOptions.length === 0 && (
                      <p className="px-3 py-2 text-xs text-muted-foreground">
                        No models configured — add an AI provider in Settings.
                      </p>
                    )}
                    {modelOptions.map((m) => (
                      <SelectItem key={`${m.provider}-${m.value}`} value={m.value} className="text-sm">
                        {m.label} · {m.provider}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </TabsContent>

            <TabsContent value="memory" className="mt-0 space-y-4">
              <div className="flex items-start justify-between gap-3 rounded-xl border border-border p-3">
                <div className="min-w-0">
                  <p className="text-[13px] font-medium">Project memory</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Let the project keep durable notes (decisions, preferences, references).
                  </p>
                </div>
                <Switch
                  checked={memory.enabled}
                  onCheckedChange={(v) => setMemory((m) => ({ ...m, enabled: v }))}
                  aria-label="Project memory"
                />
              </div>
              <div className="flex items-start justify-between gap-3 rounded-xl border border-border p-3">
                <div className="min-w-0">
                  <p className="text-[13px] font-medium">Cross-chat retrieval</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Retrieve relevant excerpts from this project&apos;s earlier chats when needed.
                  </p>
                </div>
                <Switch
                  checked={memory.cross_chat_retrieval}
                  disabled={!memory.enabled}
                  onCheckedChange={(v) => setMemory((m) => ({ ...m, cross_chat_retrieval: v }))}
                  aria-label="Cross-chat retrieval"
                />
              </div>
              <div className="flex items-start justify-between gap-3 rounded-xl border border-border p-3">
                <div className="min-w-0">
                  <p className="text-[13px] font-medium">Automatic memory updates</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Allow the agent to save and supersede project memories on its own.
                  </p>
                </div>
                <Switch
                  checked={memory.automatic_updates}
                  disabled={!memory.enabled}
                  onCheckedChange={(v) => setMemory((m) => ({ ...m, automatic_updates: v }))}
                  aria-label="Automatic memory updates"
                />
              </div>
              <div className="space-y-1.5 rounded-xl border border-border p-3">
                <div className="flex items-center justify-between gap-3">
                  <Label htmlFor="project-budget" className="text-[13px] font-medium">
                    Context budget
                  </Label>
                  <span className="font-mono text-xs tabular-nums text-muted-foreground">
                    {memory.context_budget_chars.toLocaleString()} chars
                  </span>
                </div>
                <input
                  id="project-budget"
                  type="range"
                  min={500}
                  max={16000}
                  step={500}
                  value={memory.context_budget_chars}
                  disabled={!memory.enabled}
                  onChange={(e) =>
                    setMemory((m) => ({ ...m, context_budget_chars: Number(e.target.value) }))
                  }
                  className="accent-primary w-full"
                  aria-label="Context budget characters"
                />
                <p className="text-[11px] text-muted-foreground">
                  How much retrieved project context a single turn may include.
                </p>
              </div>
            </TabsContent>

            <TabsContent value="resources" className="mt-0 space-y-4">
              <p className="text-xs leading-relaxed text-muted-foreground">
                Access applies to this project only. A project can restrict further, but can never
                loosen a stricter global rule. Unchanged rows follow your global defaults.
              </p>

              {resourcesLoading ? (
                <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading installed
                  resources…
                </div>
              ) : (
                <>
                  {/* Terminal + browser capabilities */}
                  <section className="space-y-1.5">
                    <h4 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      <TerminalSquare className="h-3.5 w-3.5" aria-hidden /> Capabilities
                    </h4>
                    {rowCountFor((r) => r.resource_type === "terminal" || r.resource_type === "browser") === 0 ? (
                      <p className="rounded-lg border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
                        None available.
                      </p>
                    ) : (
                      <div className="divide-y divide-border rounded-xl border border-border">
                        {resources.rows
                          .filter((r) => r.resource_type === "terminal" || r.resource_type === "browser")
                          .map((row) => (
                            <div key={row.key} className="flex items-center gap-2 px-3 py-2">
                              <PermissionSelect
                                label={row.label}
                                value={resources.overrides[row.key] ?? row.defaultPermission}
                                onChange={(next) => setPermission(row.key, next)}
                              />
                            </div>
                          ))}
                      </div>
                    )}
                  </section>

                  {/* Built-in tools */}
                  <section className="space-y-1.5">
                    <h4 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      <Wrench className="h-3.5 w-3.5" aria-hidden /> Built-in tools
                      <span className="font-mono normal-case tracking-normal">
                        ({rowCountFor((r) => r.resource_type === "tool")})
                      </span>
                    </h4>
                    {rowCountFor((r) => r.resource_type === "tool") === 0 ? (
                      <p className="rounded-lg border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
                        No tools registered.
                      </p>
                    ) : (
                      <div className="max-h-64 overflow-y-auto rounded-xl border border-border [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border [&::-webkit-scrollbar-track]:transparent">
                        <div className="divide-y divide-border">
                          {resources.rows
                            .filter((r) => r.resource_type === "tool")
                            .map((row) => (
                              <div key={row.key} className="px-3 py-2">
                                <PermissionSelect
                                  label={row.label}
                                  value={resources.overrides[row.key] ?? row.defaultPermission}
                                  onChange={(next) => setPermission(row.key, next)}
                                />
                              </div>
                            ))}
                        </div>
                      </div>
                    )}
                  </section>

                  {/* MCP servers */}
                  <section className="space-y-1.5">
                    <h4 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      <Server className="h-3.5 w-3.5" aria-hidden /> MCP servers
                    </h4>
                    {rowCountFor((r) => r.resource_type === "mcp_server") === 0 ? (
                      <p className="rounded-lg border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
                        None installed — add servers in Settings → MCP.
                      </p>
                    ) : (
                      <div className="divide-y divide-border rounded-xl border border-border">
                        {resources.rows
                          .filter((r) => r.resource_type === "mcp_server")
                          .map((row) => (
                            <div key={row.key} className="px-3 py-2">
                              <PermissionSelect
                                label={row.label}
                                value={resources.overrides[row.key] ?? row.defaultPermission}
                                onChange={(next) => setPermission(row.key, next)}
                              />
                            </div>
                          ))}
                      </div>
                    )}
                  </section>

                  {/* Skills — the full skills directory (master library + installed) */}
                  <section className="space-y-1.5">
                    <h4 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      <Sparkles className="h-3.5 w-3.5" aria-hidden /> Skills directory
                      <span className="font-mono normal-case tracking-normal">
                        ({rowCountFor((r) => r.resource_type === "skill")})
                      </span>
                    </h4>
                    <p className="text-[11px] leading-relaxed text-muted-foreground">
                      The master skill library that ships with every sandbox, plus skills you
                      installed yourself.
                    </p>
                    {rowCountFor((r) => r.resource_type === "skill") === 0 ? (
                      <p className="rounded-lg border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
                        No skills available.
                      </p>
                    ) : (
                      <div className="max-h-56 overflow-y-auto rounded-xl border border-border [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border [&::-webkit-scrollbar-track]:transparent">
                        <div className="divide-y divide-border">
                          {resources.rows
                            .filter((r) => r.resource_type === "skill")
                            .map((row) => (
                              <div key={row.key} className="px-3 py-2">
                                <PermissionSelect
                                  label={row.label}
                                  value={resources.overrides[row.key] ?? row.defaultPermission}
                                  onChange={(next) => setPermission(row.key, next)}
                                />
                              </div>
                            ))}
                        </div>
                      </div>
                    )}
                  </section>

                  {/* Connectors */}
                  <section className="space-y-1.5">
                    <h4 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      <Plug className="h-3.5 w-3.5" aria-hidden /> Connectors
                    </h4>
                    {rowCountFor((r) => r.resource_type === "connector") === 0 ? (
                      <p className="rounded-lg border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
                        None installed — connect apps with Composio in Settings → Integrations.
                      </p>
                    ) : (
                      <div className="divide-y divide-border rounded-xl border border-border">
                        {resources.rows
                          .filter((r) => r.resource_type === "connector")
                          .map((row) => (
                            <div key={row.key} className="px-3 py-2">
                              <PermissionSelect
                                label={row.label}
                                value={resources.overrides[row.key] ?? row.defaultPermission}
                                onChange={(next) => setPermission(row.key, next)}
                              />
                            </div>
                          ))}
                      </div>
                    )}
                  </section>
                </>
              )}
            </TabsContent>
          </div>
        </Tabs>

        <DialogFooter className="flex-row items-center justify-end gap-2 border-t px-5 py-3">
          <Button
            type="button"
            variant="outline"
            onClick={() => !busy && onOpenChange(false)}
            disabled={busy}
            className="h-9 rounded-lg"
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={!canSubmit}
            className="h-9 min-w-28 rounded-lg"
          >
            {busy ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                {isEdit ? "Saving…" : "Creating…"}
              </>
            ) : isEdit ? (
              <>
                <FolderCog className="h-4 w-4" aria-hidden /> Save changes
              </>
            ) : (
              <>
                <Blocks className="h-4 w-4" aria-hidden /> Create project
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

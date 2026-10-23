"use client";

/**
 * CreateBusinessWizard (Task 4-a) — the 3-step business creation flow.
 *
 *   Step 1 "Describe"    — structured form (or one raw prompt) + automation level
 *   Step 2 "Discovery"   — Main Agent discovery (real web research + LLM) with
 *                          an HONEST progress view: no simulated step advancement,
 *                          one overall spinner + a real elapsed-seconds counter
 *   Step 3 "Blueprint"   — review / edit / regenerate every section, then
 *                          approve to create the business
 *   Success              — created + auto-navigate into the workspace
 *
 * All user-facing copy comes from the business UI dictionary (bt()).
 * Every status reflects real execution only (PRD §31).
 */

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useLocale } from "next-intl";
import { toast } from "sonner";
import { motion, useReducedMotion } from "framer-motion";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Briefcase,
  Building2,
  Check,
  Loader2,
  MapPin,
  Megaphone,
  Microscope,
  Package,
  PenLine,
  Plug,
  Plus,
  RefreshCw,
  Rocket,
  ShoppingCart,
  Sparkles,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react";

import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  Card,
  Input,
  Label,
  Spinner,
  Textarea,
} from "@/components/ui";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import { AGENT_LOGOS, AgentLogo } from "@/components/business/agent-logos";
import { bt, setBusinessTextLocale } from "@/lib/business/ui-text";
import { getBusinessTemplate } from "@/lib/business/templates";
import {
  businessLlmComplete,
  resolveBusinessLlmConfig,
} from "@/lib/business/llm";
import {
  buildBlueprintSectionRegeneratePrompt,
  buildDiscoverySystemPrompt,
} from "@/lib/business/prompts";
import {
  createBusinessFromBlueprint,
  createBusinessFromTemplate,
  runBusinessDiscovery,
} from "@/lib/business/orchestrator";
import type {
  BlueprintProposedAgent,
  BusinessBlueprint,
  BusinessDiscoveryInput,
} from "@/lib/business/types";
import { useAuth } from "@/hooks";
import { useAuthStore } from "@/stores/auth-store";
import { aiProviderService } from "@/lib/services";
import { cn, getErrorMessage } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

type WizardStep = "form" | "discovery" | "blueprint" | "success";
type BusyAction = "skip" | "approve" | null;

const STEPS: readonly { key: WizardStep; labelKey: string }[] = [
  { key: "form", labelKey: "wizard.step1" },
  { key: "discovery", labelKey: "wizard.step2" },
  { key: "blueprint", labelKey: "wizard.step3" },
];

/** Editable text sections of the blueprint (regenerable one by one). */
const TEXT_SECTIONS: readonly {
  key: "overview" | "customer_profile" | "market_research" | "competitor_analysis" | "revenue_model" | "operational_workflow" | "risks";
  labelKey: string;
}[] = [
  { key: "overview", labelKey: "wizard.section.overview" },
  { key: "customer_profile", labelKey: "wizard.section.customer" },
  { key: "market_research", labelKey: "wizard.section.market" },
  { key: "competitor_analysis", labelKey: "wizard.section.competitors" },
  { key: "revenue_model", labelKey: "wizard.section.revenue" },
  { key: "operational_workflow", labelKey: "wizard.section.operations" },
  { key: "risks", labelKey: "wizard.section.risks" },
];

type TextSectionKey = (typeof TEXT_SECTIONS)[number]["key"];

const AUTOMATION_OPTIONS: readonly {
  value: string;
  labelKey: string;
}[] = [
  { value: "suggest", labelKey: "wizard.automation.suggest" },
  { value: "balanced", labelKey: "wizard.automation.balanced" },
  { value: "autonomous", labelKey: "wizard.automation.autonomous" },
];

const DISCOVERY_STEP_KEYS: readonly string[] = [
  "wizard.discoveryStep1",
  "wizard.discoveryStep2",
  "wizard.discoveryStep3",
];

/** Soft minimum for the idea textarea (a nudge, not a hard gate). */
const IDEA_SOFT_MIN = 80;

/** Template quick-start icons (banner in step 1). */
const TEMPLATE_ICONS: Record<string, LucideIcon> = {
  "online-store": ShoppingCart,
  "content-agency": PenLine,
  "software-startup": Rocket,
  "freelance-service": Briefcase,
  "local-service": MapPin,
  "digital-products": Package,
  "marketing-agency": Megaphone,
  "research-workspace": Microscope,
};

interface WizardFormState {
  name: string;
  idea: string;
  industry: string;
  businessModel: string;
  targetCustomers: string;
  objectives: string;
  geography: string;
  budget: string;
  references: string;
  workingStyle: string;
  automation: string;
  rawPrompt: string;
}

const EMPTY_FORM: WizardFormState = {
  name: "",
  idea: "",
  industry: "",
  businessModel: "",
  targetCustomers: "",
  objectives: "",
  geography: "",
  budget: "",
  references: "",
  workingStyle: "",
  automation: "balanced",
  rawPrompt: "",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Robustly parse a {"section": "..."} regenerate reply: direct JSON.parse
 * first, then the outermost {...} block (models sometimes wrap in prose or
 * markdown fences).
 */
function parseSectionText(text: string): string | null {
  const attempt = (raw: string): unknown => {
    try {
      return JSON.parse(raw);
    } catch {
      return undefined;
    }
  };
  let parsed = attempt(text.trim());
  if (parsed === undefined) {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) parsed = attempt(text.slice(start, end + 1));
  }
  if (parsed && typeof parsed === "object" && "section" in parsed) {
    const value = (parsed as { section?: unknown }).section;
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

/** Hostname of a finding source (data, not copy); null when unparseable. */
function sourceHostname(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Wizard
// ---------------------------------------------------------------------------

export function CreateBusinessWizard() {
  const router = useRouter();
  const locale = useLocale();
  // Module-level dictionary locale (EN base, PL overrides) — idempotent.
  setBusinessTextLocale(locale);

  const reduceMotion = useReducedMotion();
  const searchParams = useSearchParams();

  // useAuth's mount effect runs authStore.init(); authResolved gates every
  // Dexie read (same pattern as the other data pages).
  const { user } = useAuth();
  const authResolved = useAuthStore((s) => s.authResolved);
  const userId = user?.id ?? null;

  // Optional ?template=<key> prefill (validated against the registry).
  const template = React.useMemo(() => {
    const raw = searchParams.get("template");
    return raw ? getBusinessTemplate(raw) : undefined;
  }, [searchParams]);

  const [step, setStep] = React.useState<WizardStep>("form");
  const [form, setForm] = React.useState<WizardFormState>(EMPTY_FORM);
  const [ideaError, setIdeaError] = React.useState<string | null>(null);

  // Provider gate: "loading" | "ok" | "missing".
  const [providerState, setProviderState] = React.useState<
    "loading" | "ok" | "missing"
  >("loading");
  const [addingProvider, setAddingProvider] = React.useState(false);

  // Discovery run (honest progress — elapsed seconds, no fake steps).
  const [discoveryRunning, setDiscoveryRunning] = React.useState(false);
  const [discoveryError, setDiscoveryError] = React.useState<string | null>(
    null,
  );
  const [elapsed, setElapsed] = React.useState(0);
  const timerRef = React.useRef<number | null>(null);
  const runIdRef = React.useRef(0);

  // Blueprint (single editable source of truth; approve passes it whole).
  const [blueprint, setBlueprint] = React.useState<BusinessBlueprint | null>(
    null,
  );
  const [regenerating, setRegenerating] = React.useState<string | null>(null);

  const [busyAction, setBusyAction] = React.useState<BusyAction>(null);
  const [createdId, setCreatedId] = React.useState<string | null>(null);
  const navigatedRef = React.useRef(false);

  // ---- Timer (real elapsed seconds) ---------------------------------------

  function stopTimer() {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }

  function startTimer() {
    stopTimer();
    setElapsed(0);
    timerRef.current = window.setInterval(() => setElapsed((s) => s + 1), 1000);
  }

  React.useEffect(() => stopTimer, []);

  // ---- Provider gate --------------------------------------------------------

  const refreshProviders = React.useCallback(async () => {
    if (!authResolved || !userId) return;
    try {
      const rows = await aiProviderService.list(userId);
      setProviderState(rows.length > 0 ? "ok" : "missing");
    } catch {
      // Leave "loading" — discovery itself surfaces the honest provider error.
    }
  }, [authResolved, userId]);

  React.useEffect(() => {
    void refreshProviders();
  }, [refreshProviders]);

  async function handleAddPollinations() {
    if (!userId || addingProvider) return;
    setAddingProvider(true);
    try {
      await aiProviderService.create(userId, {
        name: "Pollinations",
        base_url: "https://gen.pollinations.ai/v1",
        api_key: "", // keyless — Pollinations anonymous tier
        models: ["openai"],
        is_active: true,
        model_type: "chat",
      });
      toast.success(bt("toast.providerAdded"));
      await refreshProviders();
    } catch (e) {
      toast.error(getErrorMessage(e));
    } finally {
      setAddingProvider(false);
    }
  }

  // ---- Input building -------------------------------------------------------

  function buildInput(): BusinessDiscoveryInput {
    const trimmed = (v: string) => v.trim() || undefined;
    return {
      name: form.name.trim(),
      idea: form.idea.trim(),
      industry: trimmed(form.industry),
      businessModel: trimmed(form.businessModel),
      targetCustomers: trimmed(form.targetCustomers),
      objectives: trimmed(form.objectives),
      geography: trimmed(form.geography),
      budget: trimmed(form.budget),
      references: trimmed(form.references),
      workingStyle: trimmed(form.workingStyle),
      automation: form.automation,
      rawPrompt: trimmed(form.rawPrompt),
    };
  }

  // ---- Discovery ------------------------------------------------------------

  async function runDiscovery() {
    const runId = ++runIdRef.current;
    const input = buildInput();
    setDiscoveryError(null);
    setDiscoveryRunning(true);
    startTimer();
    try {
      const result = await runBusinessDiscovery(input);
      if (runIdRef.current !== runId) return; // superseded (user went back)
      setBlueprint(result);
      setStep("blueprint");
    } catch (e) {
      if (runIdRef.current !== runId) return;
      setDiscoveryError(getErrorMessage(e));
    } finally {
      if (runIdRef.current === runId) {
        setDiscoveryRunning(false);
        stopTimer();
      }
    }
  }

  function handleStartDiscovery(e: React.FormEvent) {
    e.preventDefault();
    if (providerState === "missing") return; // the provider alert is showing
    const hasIdea = form.idea.trim().length > 0;
    const hasPrompt = form.rawPrompt.trim().length > 0;
    if (!hasIdea && !hasPrompt) {
      setIdeaError(bt("wizard.ideaRequired"));
      return;
    }
    setIdeaError(null);
    setStep("discovery");
    void runDiscovery();
  }

  function backToForm() {
    runIdRef.current++; // orphan any in-flight run; its result is discarded
    stopTimer();
    setDiscoveryRunning(false);
    setStep("form");
  }

  // ---- Creation paths -------------------------------------------------------

  async function handleSkipTemplate() {
    if (busyAction) return;
    setBusyAction("skip");
    try {
      const id = await createBusinessFromTemplate(
        template?.key || "online-store",
        buildInput(),
      );
      toast.success(bt("toast.businessCreated"), {
        description: bt("wizard.templateTeamNote"),
      });
      goWorkspace(id);
    } catch (e) {
      toast.error(getErrorMessage(e));
      setBusyAction(null);
    }
  }

  async function handleApprove() {
    if (!blueprint || busyAction) return;
    setBusyAction("approve");
    try {
      const id = await createBusinessFromBlueprint(buildInput(), blueprint);
      toast.success(bt("toast.businessCreated"));
      setCreatedId(id);
      setStep("success");
      // Auto-navigate shortly after the success state renders.
      window.setTimeout(() => goWorkspace(id), 800);
    } catch (e) {
      toast.error(getErrorMessage(e));
      setBusyAction(null);
    }
  }

  function goWorkspace(id: string) {
    if (navigatedRef.current) return;
    navigatedRef.current = true;
    router.push(`/business/${id}`);
  }

  // ---- Blueprint editing ------------------------------------------------------

  function updateSection(key: TextSectionKey, value: string) {
    setBlueprint((bp) => (bp ? { ...bp, [key]: value } : bp));
  }

  function updateGoalAt(index: number, value: string) {
    setBlueprint((bp) =>
      bp
        ? {
            ...bp,
            proposed_goals: bp.proposed_goals.map((g, i) =>
              i === index ? value : g,
            ),
          }
        : bp,
    );
  }

  function removeGoal(index: number) {
    setBlueprint((bp) =>
      bp
        ? {
            ...bp,
            proposed_goals: bp.proposed_goals.filter((_, i) => i !== index),
          }
        : bp,
    );
  }

  function addGoal() {
    setBlueprint((bp) =>
      bp ? { ...bp, proposed_goals: [...bp.proposed_goals, ""] } : bp,
    );
  }

  function updateAgentAt(index: number, patch: Partial<BlueprintProposedAgent>) {
    setBlueprint((bp) =>
      bp
        ? {
            ...bp,
            proposed_agents: bp.proposed_agents.map((a, i) =>
              i === index ? { ...a, ...patch } : a,
            ),
          }
        : bp,
    );
  }

  function updateBacklogAt(
    index: number,
    patch: Partial<BusinessBlueprint["initial_task_backlog"][number]>,
  ) {
    setBlueprint((bp) =>
      bp
        ? {
            ...bp,
            initial_task_backlog: bp.initial_task_backlog.map((t, i) =>
              i === index ? { ...t, ...patch } : t,
            ),
          }
        : bp,
    );
  }

  function removeBacklogAt(index: number) {
    setBlueprint((bp) =>
      bp
        ? {
            ...bp,
            initial_task_backlog: bp.initial_task_backlog.filter(
              (_, i) => i !== index,
            ),
          }
        : bp,
    );
  }

  async function handleRegenerate(sectionKey: TextSectionKey) {
    if (!blueprint || regenerating) return;
    setRegenerating(sectionKey);
    try {
      const cfg = await resolveBusinessLlmConfig();
      const res = await businessLlmComplete(cfg, {
        systemPrompt: buildDiscoverySystemPrompt(),
        userPrompt: buildBlueprintSectionRegeneratePrompt(
          sectionKey,
          blueprint,
          buildInput(),
        ),
        jsonMode: true,
        timeoutMs: 120_000,
      });
      const next = parseSectionText(res.text);
      if (next === null) throw new Error("unreadable model response");
      updateSection(sectionKey, next);
    } catch (e) {
      toast.error(bt("wizard.discoveryFailed", { error: getErrorMessage(e) }));
    } finally {
      setRegenerating(null);
    }
  }

  // ---- Derived ---------------------------------------------------------------

  const setField = <K extends keyof WizardFormState>(key: K, value: string) =>
    setForm((f) => ({ ...f, [key]: value }));

  const rawPromptFilled = form.rawPrompt.trim().length > 0;
  const ideaLength = form.idea.trim().length;
  const namePlaceholder = template
    ? bt(template.titleKey)
    : bt("wizard.namePlaceholder");
  const ideaPlaceholder = template
    ? bt(template.descriptionKey)
    : bt("wizard.ideaPlaceholder");
  const TemplateBannerIcon = template
    ? (TEMPLATE_ICONS[template.key] ?? Building2)
    : null;

  /** Roles offered to backlog rows: proposed agents' roles (+ any current). */
  const backlogRoleOptions = React.useMemo(() => {
    if (!blueprint) return [] as string[];
    const roles = blueprint.proposed_agents.map((a) => a.role);
    for (const t of blueprint.initial_task_backlog) {
      if (!roles.includes(t.agent_role)) roles.push(t.agent_role);
    }
    return roles;
  }, [blueprint]);

  const stepIndex = STEPS.findIndex((s) => s.key === step);

  // Subtle entrance (≤300ms); reduced-motion renders static.
  const entrance = reduceMotion
    ? {}
    : {
        initial: { opacity: 0, y: 8 },
        animate: { opacity: 1, y: 0 },
        transition: { duration: 0.25, ease: [0.32, 0.72, 0, 1] as const },
      };

  // ---- Render -----------------------------------------------------------------

  return (
    <div className="scrollbar-thin relative h-full overflow-y-auto px-3 py-4 sm:px-6 sm:py-8">
      <div className="mx-auto max-w-4xl space-y-6 pb-8">
        <header className="space-y-4">
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              asChild
              aria-label={bt("ws.backToDashboard")}
              className="size-9"
            >
              <Link href="/business">
                <ArrowLeft aria-hidden className="size-4" />
              </Link>
            </Button>
            <h1 className="font-display text-xl font-semibold tracking-tight text-foreground">
              {bt("wizard.title")}
            </h1>
          </div>

          {/* Stepper — current step highlighted, finished steps checked. */}
          {step !== "success" && (
            <nav aria-label={bt("wizard.title")}>
              <ol className="flex flex-wrap items-center gap-x-3 gap-y-2 text-xs">
                {STEPS.map((s, i) => {
                  const state =
                    i < stepIndex ? "done" : i === stepIndex ? "current" : "todo";
                  return (
                    <li key={s.key} className="flex items-center gap-2">
                      <span
                        aria-hidden
                        className={cn(
                          "flex size-6 shrink-0 items-center justify-center rounded-full border text-[11px] font-medium",
                          state === "done" &&
                            "border-primary/40 bg-primary/10 text-primary",
                          state === "current" &&
                            "border-primary bg-primary text-primary-foreground",
                          state === "todo" && "border-border text-muted-foreground",
                        )}
                      >
                        {state === "done" ? (
                          <Check className="size-3.5" />
                        ) : (
                          i + 1
                        )}
                      </span>
                      <span
                        className={cn(
                          "font-medium",
                          state === "current"
                            ? "text-foreground"
                            : "text-muted-foreground hidden sm:inline",
                        )}
                      >
                        {bt(s.labelKey)}
                      </span>
                      {i < STEPS.length - 1 && (
                        <span
                          aria-hidden
                          className="hidden h-px w-5 bg-border sm:block"
                        />
                      )}
                    </li>
                  );
                })}
              </ol>
            </nav>
          )}
        </header>

        {/* --------------------------------------------------------------- */}
        {/* Step 1 — Describe                                                */}
        {/* --------------------------------------------------------------- */}
        {step === "form" && (
          <motion.div {...entrance}>
            <Card className="p-4 sm:p-6">
              {/* Template prefill banner. */}
              {template && TemplateBannerIcon && (
                <div className="mb-6 flex items-start gap-3 rounded-xl border border-primary/25 bg-primary/5 p-3">
                  <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-primary/10 text-primary">
                    <TemplateBannerIcon aria-hidden className="size-4" />
                  </span>
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-foreground">
                      {bt(template.titleKey)}
                    </p>
                    <p className="text-muted-foreground mt-0.5 text-xs leading-relaxed">
                      {bt(template.descriptionKey)}
                    </p>
                  </div>
                </div>
              )}

              <form onSubmit={handleStartDiscovery} className="space-y-6" noValidate>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div className="space-y-1.5 sm:col-span-2">
                    <Label htmlFor="wiz-name">
                      {bt("wizard.name")}
                      <span aria-hidden className="text-destructive">
                        {" *"}
                      </span>
                    </Label>
                    <Input
                      id="wiz-name"
                      value={form.name}
                      onChange={(e) => setField("name", e.target.value)}
                      placeholder={namePlaceholder}
                      required
                      maxLength={120}
                      className="min-h-10"
                    />
                  </div>

                  <div className="space-y-1.5 sm:col-span-2">
                    <Label htmlFor="wiz-idea">
                      {bt("wizard.idea")}
                      {!rawPromptFilled && (
                        <span aria-hidden className="text-destructive">
                          {" *"}
                        </span>
                      )}
                    </Label>
                    <Textarea
                      id="wiz-idea"
                      value={form.idea}
                      onChange={(e) => {
                        setField("idea", e.target.value);
                        if (ideaError) setIdeaError(null);
                      }}
                      placeholder={ideaPlaceholder}
                      rows={5}
                      aria-invalid={!!ideaError}
                      aria-describedby={ideaError ? "wiz-idea-error" : undefined}
                      className="min-h-28"
                    />
                    {ideaLength > 0 && ideaLength < IDEA_SOFT_MIN && (
                      <p className="text-muted-foreground text-xs tabular-nums">
                        {ideaLength}/{IDEA_SOFT_MIN}
                      </p>
                    )}
                    {ideaError && (
                      <p
                        id="wiz-idea-error"
                        role="alert"
                        className="text-xs text-destructive"
                      >
                        {ideaError}
                      </p>
                    )}
                  </div>

                  <div className="space-y-1.5">
                    <Label htmlFor="wiz-industry">{bt("wizard.industry")}</Label>
                    <Input
                      id="wiz-industry"
                      value={form.industry}
                      onChange={(e) => setField("industry", e.target.value)}
                      placeholder={bt("wizard.industryPlaceholder")}
                      className="min-h-10"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="wiz-model">
                      {bt("wizard.businessModel")}
                    </Label>
                    <Input
                      id="wiz-model"
                      value={form.businessModel}
                      onChange={(e) => setField("businessModel", e.target.value)}
                      placeholder={bt("wizard.businessModelPlaceholder")}
                      className="min-h-10"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="wiz-customers">
                      {bt("wizard.targetCustomers")}
                    </Label>
                    <Input
                      id="wiz-customers"
                      value={form.targetCustomers}
                      onChange={(e) =>
                        setField("targetCustomers", e.target.value)
                      }
                      placeholder={bt("wizard.targetCustomersPlaceholder")}
                      className="min-h-10"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="wiz-geo">{bt("wizard.geography")}</Label>
                    <Input
                      id="wiz-geo"
                      value={form.geography}
                      onChange={(e) => setField("geography", e.target.value)}
                      placeholder={bt("wizard.geographyPlaceholder")}
                      className="min-h-10"
                    />
                  </div>
                  <div className="space-y-1.5 sm:col-span-2">
                    <Label htmlFor="wiz-objectives">
                      {bt("wizard.objectives")}
                    </Label>
                    <Textarea
                      id="wiz-objectives"
                      value={form.objectives}
                      onChange={(e) => setField("objectives", e.target.value)}
                      placeholder={bt("wizard.objectivesPlaceholder")}
                      rows={3}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="wiz-budget">{bt("wizard.budget")}</Label>
                    <Input
                      id="wiz-budget"
                      value={form.budget}
                      onChange={(e) => setField("budget", e.target.value)}
                      placeholder={bt("wizard.budgetPlaceholder")}
                      className="min-h-10"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="wiz-style">{bt("wizard.workingStyle")}</Label>
                    <Input
                      id="wiz-style"
                      value={form.workingStyle}
                      onChange={(e) => setField("workingStyle", e.target.value)}
                      placeholder={bt("wizard.workingStylePlaceholder")}
                      className="min-h-10"
                    />
                  </div>
                  <div className="space-y-1.5 sm:col-span-2">
                    <Label htmlFor="wiz-refs">{bt("wizard.references")}</Label>
                    <Textarea
                      id="wiz-refs"
                      value={form.references}
                      onChange={(e) => setField("references", e.target.value)}
                      placeholder={bt("wizard.referencesPlaceholder")}
                      rows={2}
                    />
                  </div>
                </div>

                {/* Automation level. */}
                <div className="space-y-2.5">
                  <Label>{bt("wizard.automation")}</Label>
                  <RadioGroup
                    value={form.automation}
                    onValueChange={(v) => setField("automation", v)}
                    className="grid gap-3 sm:grid-cols-3"
                  >
                    {AUTOMATION_OPTIONS.map((o) => (
                      <Label
                        key={o.value}
                        htmlFor={`automation-${o.value}`}
                        className="focus-within:ring-ring/40 has-[[data-state=checked]]:border-primary/50 has-[[data-state=checked]]:bg-primary/5 hover:border-foreground/25 flex min-h-[44px] cursor-pointer items-start gap-3 rounded-xl border p-3 transition-colors focus-within:ring-2"
                      >
                        <RadioGroupItem
                          value={o.value}
                          id={`automation-${o.value}`}
                          className="mt-0.5"
                        />
                        <span className="text-xs leading-relaxed text-foreground/90">
                          {bt(o.labelKey)}
                        </span>
                      </Label>
                    ))}
                  </RadioGroup>
                </div>

                {/* One-prompt alternative. */}
                <div className="space-y-2.5">
                  <div className="flex items-center gap-3">
                    <span aria-hidden className="h-px flex-1 bg-border" />
                    <span className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                      {bt("wizard.orPrompt")}
                    </span>
                    <span aria-hidden className="h-px flex-1 bg-border" />
                  </div>
                  <Textarea
                    value={form.rawPrompt}
                    onChange={(e) => {
                      setField("rawPrompt", e.target.value);
                      if (ideaError) setIdeaError(null);
                    }}
                    placeholder={bt("wizard.orPromptPlaceholder")}
                    rows={4}
                    aria-label={bt("wizard.orPrompt")}
                    className="min-h-24"
                  />
                </div>

                {/* Provider gate — shown inline instead of running discovery. */}
                {providerState === "missing" && (
                  <Alert>
                    <AlertTriangle className="size-4" />
                    <AlertDescription>
                      <p className="font-medium text-foreground">
                        {bt("wizard.noProviderTitle")}
                      </p>
                      <p>{bt("wizard.noProviderBody")}</p>
                      <div className="mt-3 flex flex-wrap items-center gap-2">
                        <Button
                          type="button"
                          size="sm"
                          onClick={handleAddPollinations}
                          disabled={addingProvider}
                          className="min-h-9"
                        >
                          {addingProvider ? (
                            <Loader2 className="size-4 animate-spin" />
                          ) : (
                            <Sparkles className="size-4" />
                          )}
                          {bt("wizard.addPollinations")}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          asChild
                          className="min-h-9"
                        >
                          <Link href="/settings/config">
                            {bt("wizard.goToSettings")}
                          </Link>
                        </Button>
                      </div>
                    </AlertDescription>
                  </Alert>
                )}

                {/* Footer actions. */}
                <div className="flex flex-col-reverse gap-2 border-t pt-4 sm:flex-row sm:items-center sm:justify-between">
                  <Button type="button" variant="ghost" asChild className="min-h-10">
                    <Link href="/business">
                      <ArrowLeft aria-hidden className="size-4" />
                      {bt("common.back")}
                    </Link>
                  </Button>
                  <div className="flex flex-col-reverse gap-2 sm:flex-row">
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => void handleSkipTemplate()}
                      disabled={busyAction !== null}
                      className="min-h-10"
                    >
                      {busyAction === "skip" && (
                        <Loader2 className="size-4 animate-spin" />
                      )}
                      {bt("wizard.skipDiscovery")}
                    </Button>
                    <Button
                      type="submit"
                      size="lg"
                      disabled={providerState === "missing"}
                      className="min-h-11"
                    >
                      <Sparkles aria-hidden className="size-4" />
                      {bt("wizard.analyze")}
                    </Button>
                  </div>
                </div>
              </form>
            </Card>
          </motion.div>
        )}

        {/* --------------------------------------------------------------- */}
        {/* Step 2 — Discovery                                               */}
        {/* --------------------------------------------------------------- */}
        {step === "discovery" && (
          <motion.div {...entrance} className="space-y-4">
            <Card className="p-4 sm:p-6">
              <div className="space-y-1">
                <h2 className="font-display text-lg font-semibold tracking-tight text-foreground">
                  {bt("wizard.discoveryTitle")}
                </h2>
                <p className="text-muted-foreground text-sm leading-relaxed">
                  {bt("wizard.discoveryHint")}
                </p>
              </div>

              {/* HONEST progress: one overall spinner + real elapsed time.
                  The checklist below is static — no simulated advancement. */}
              {discoveryRunning && (
                <p className="mt-5 flex items-center gap-2.5 text-sm">
                  <Spinner aria-hidden className="size-4 text-primary" />
                  <span className="text-foreground font-medium tabular-nums">
                    {elapsed}s
                  </span>
                </p>
              )}

              <ol className="mt-6 space-y-2.5">
                {DISCOVERY_STEP_KEYS.map((key, i) => (
                  <li key={key} className="flex items-center gap-3">
                    <span
                      aria-hidden
                      className="border-border text-muted-foreground flex size-6 shrink-0 items-center justify-center rounded-full border text-[11px] font-medium"
                    >
                      {i + 1}
                    </span>
                    <span className="text-muted-foreground text-sm">
                      {bt(key)}
                    </span>
                  </li>
                ))}
              </ol>
            </Card>

            {/* Failure — retry, fall back to the template team, or go back. */}
            {discoveryError && !discoveryRunning && (
              <Alert variant="destructive">
                <AlertTriangle className="size-4" />
                <AlertDescription>
                  <p>
                    {bt("wizard.discoveryFailed", { error: discoveryError })}
                  </p>
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <Button
                      size="sm"
                      onClick={() => void runDiscovery()}
                      className="min-h-9"
                    >
                      <RefreshCw aria-hidden className="size-4" />
                      {bt("common.retry")}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void handleSkipTemplate()}
                      disabled={busyAction !== null}
                      className="min-h-9"
                    >
                      {busyAction === "skip" && (
                        <Loader2 className="size-4 animate-spin" />
                      )}
                      {bt("wizard.skipDiscovery")}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={backToForm}
                      className="min-h-9"
                    >
                      {bt("common.back")}
                    </Button>
                  </div>
                </AlertDescription>
              </Alert>
            )}

            {discoveryRunning && (
              <div>
                <Button
                  variant="ghost"
                  onClick={backToForm}
                  className="min-h-10"
                >
                  <ArrowLeft aria-hidden className="size-4" />
                  {bt("common.back")}
                </Button>
              </div>
            )}
          </motion.div>
        )}

        {/* --------------------------------------------------------------- */}
        {/* Step 3 — Blueprint review                                        */}
        {/* --------------------------------------------------------------- */}
        {step === "blueprint" && blueprint && (
          <motion.div {...entrance} className="space-y-4">
            <div className="space-y-1">
              <h2 className="font-display text-lg font-semibold tracking-tight text-foreground">
                {bt("wizard.blueprintTitle")}
              </h2>
              <p className="text-muted-foreground text-sm leading-relaxed">
                {bt("wizard.blueprintHint")}
              </p>
            </div>

            {/* Editable + regenerable text sections. */}
            {TEXT_SECTIONS.map(({ key, labelKey }) => (
              <Card key={key} className="p-4 sm:p-5">
                <div className="mb-3 flex items-center justify-between gap-2">
                  <h3 className="text-foreground text-sm font-semibold">
                    {bt(labelKey)}
                  </h3>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => void handleRegenerate(key)}
                    disabled={regenerating !== null}
                    className="min-h-9"
                  >
                    {regenerating === key ? (
                      <Loader2 aria-hidden className="size-3.5 animate-spin" />
                    ) : (
                      <RefreshCw aria-hidden className="size-3.5" />
                    )}
                    {regenerating === key
                      ? bt("wizard.regenerating")
                      : bt("wizard.regenerateSection")}
                  </Button>
                </div>
                <Textarea
                  value={blueprint[key]}
                  onChange={(e) => updateSection(key, e.target.value)}
                  aria-label={bt(labelKey)}
                  rows={5}
                  className="text-sm leading-relaxed"
                />
              </Card>
            ))}

            {/* Proposed goals — editable line list. */}
            <Card className="p-4 sm:p-5">
              <h3 className="text-foreground mb-3 text-sm font-semibold">
                {bt("wizard.section.goals")}
              </h3>
              <div className="space-y-2">
                {blueprint.proposed_goals.map((goal, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <Input
                      value={goal}
                      onChange={(e) => updateGoalAt(i, e.target.value)}
                      aria-label={`${bt("wizard.section.goals")} ${i + 1}`}
                      className="min-h-10"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => removeGoal(i)}
                      aria-label={bt("common.delete")}
                      className="text-muted-foreground hover:text-destructive size-9 shrink-0"
                    >
                      <X aria-hidden className="size-4" />
                    </Button>
                  </div>
                ))}
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={addGoal}
                className="mt-3 min-h-9"
              >
                <Plus aria-hidden className="size-3.5" />
                {bt("agent.prompt.addGoal")}
              </Button>
            </Card>

            {/* Proposed agent team — editable rows with logo picker. */}
            <Card className="p-4 sm:p-5">
              <h3 className="text-foreground mb-3 text-sm font-semibold">
                {bt("wizard.section.agents")}
              </h3>
              <div className="space-y-3">
                {blueprint.proposed_agents.map((agent, i) => (
                  <div key={i} className="space-y-2.5 rounded-lg border p-3">
                    <div className="flex items-center gap-2">
                      <LogoPicker
                        value={agent.logo}
                        agentName={agent.name}
                        onChange={(logo) => updateAgentAt(i, { logo })}
                      />
                      <Input
                        value={agent.name}
                        onChange={(e) =>
                          updateAgentAt(i, { name: e.target.value })
                        }
                        aria-label={bt("agent.name")}
                        className="min-h-10 flex-1"
                      />
                      <Input
                        value={agent.role}
                        onChange={(e) =>
                          updateAgentAt(i, { role: e.target.value })
                        }
                        aria-label={bt("agent.role")}
                        className="min-h-10 w-28 shrink-0 sm:w-40"
                      />
                    </div>
                    <Input
                      value={agent.description}
                      onChange={(e) =>
                        updateAgentAt(i, { description: e.target.value })
                      }
                      aria-label={bt("agent.description")}
                      className="min-h-10"
                    />
                  </div>
                ))}
              </div>
            </Card>

            {/* Initial task backlog — editable rows. */}
            <Card className="p-4 sm:p-5">
              <h3 className="text-foreground mb-3 text-sm font-semibold">
                {bt("wizard.section.backlog")}
              </h3>
              <div className="space-y-3">
                {blueprint.initial_task_backlog.map((task, i) => (
                  <div key={i} className="space-y-2.5 rounded-lg border p-3">
                    <div className="flex items-start gap-2">
                      <Input
                        value={task.title}
                        onChange={(e) =>
                          updateBacklogAt(i, { title: e.target.value })
                        }
                        aria-label={`${bt("agent.name")} — ${bt(
                          "wizard.section.backlog",
                        )} ${i + 1}`}
                        className="min-h-10 flex-1"
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        onClick={() => removeBacklogAt(i)}
                        aria-label={bt("common.delete")}
                        className="text-muted-foreground hover:text-destructive size-9 shrink-0"
                      >
                        <X aria-hidden className="size-4" />
                      </Button>
                    </div>
                    <Input
                      value={task.description}
                      onChange={(e) =>
                        updateBacklogAt(i, { description: e.target.value })
                      }
                      aria-label={`${bt("agent.description")} — ${bt(
                        "wizard.section.backlog",
                      )} ${i + 1}`}
                      className="min-h-10"
                    />
                    <Select
                      value={task.agent_role}
                      onValueChange={(v) => updateBacklogAt(i, { agent_role: v })}
                    >
                      <SelectTrigger
                        aria-label={bt("agent.role")}
                        className="min-h-10 w-full sm:w-56"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {backlogRoleOptions.map((role) => (
                          <SelectItem key={role} value={role}>
                            {role}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                ))}
              </div>
            </Card>

            {/* Read-only: verified vs assumed research findings. */}
            {blueprint.research_findings.length > 0 && (
              <Card className="p-4 sm:p-5">
                <h3 className="text-foreground mb-3 text-sm font-semibold">
                  {bt("wizard.section.findings")}
                </h3>
                <ul className="space-y-2.5">
                  {blueprint.research_findings.map((f, i) => {
                    const host = f.source ? sourceHostname(f.source) : null;
                    return (
                      <li key={i} className="flex items-start gap-2 text-sm">
                        <Badge
                          variant={f.verified ? "default" : "outline"}
                          className="mt-0.5 shrink-0 gap-1"
                        >
                          <span aria-hidden>{f.verified ? "✅" : "⚠️"}</span>
                          {f.verified
                            ? bt("verification.verified")
                            : bt("verification.assumption")}
                        </Badge>
                        <span className="text-foreground/85 leading-relaxed">
                          {f.finding}
                          {f.source && (
                            <>
                              {" "}
                              <a
                                href={f.source}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-primary hover:underline"
                              >
                                {host ?? bt("chat.sources")}
                              </a>
                            </>
                          )}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </Card>
            )}

            {/* Read-only: assumptions. */}
            {blueprint.assumptions.length > 0 && (
              <Card className="p-4 sm:p-5">
                <h3 className="text-foreground mb-3 text-sm font-semibold">
                  {bt("wizard.section.assumptions")}
                </h3>
                <ul className="space-y-1.5">
                  {blueprint.assumptions.map((a, i) => (
                    <li
                      key={i}
                      className="text-muted-foreground flex gap-2 text-sm leading-relaxed"
                    >
                      <span
                        aria-hidden
                        className="bg-foreground/30 mt-2 size-1 shrink-0 rounded-full"
                      />
                      {a}
                    </li>
                  ))}
                </ul>
              </Card>
            )}

            {/* Read-only: recommended skills / connectors (chips). */}
            {blueprint.recommended_skills.length > 0 ||
            blueprint.recommended_connectors.length > 0 ? (
              <Card className="space-y-3 p-4 sm:p-5">
                {blueprint.recommended_skills.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Wrench
                      aria-hidden
                      className="text-muted-foreground size-3.5 shrink-0"
                    />
                    <span className="sr-only">{bt("agent.skills")}</span>
                    {blueprint.recommended_skills.map((s) => (
                      <Badge key={s} variant="secondary">
                        {s}
                      </Badge>
                    ))}
                  </div>
                )}
                {blueprint.recommended_connectors.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Plug
                      aria-hidden
                      className="text-muted-foreground size-3.5 shrink-0"
                    />
                    {blueprint.recommended_connectors.map((c) => (
                      <Badge key={c} variant="outline">
                        {c}
                      </Badge>
                    ))}
                  </div>
                )}
              </Card>
            ) : null}

            {/* Sticky approve bar. */}
            <div className="sticky bottom-4 z-10 mt-2 flex flex-col-reverse gap-2 rounded-xl border bg-background/95 p-3 shadow-lg backdrop-blur sm:flex-row sm:items-center sm:justify-between">
              <Button
                type="button"
                variant="ghost"
                onClick={backToForm}
                className="min-h-10"
              >
                <ArrowLeft aria-hidden className="size-4" />
                {bt("common.back")}
              </Button>
              <Button
                type="button"
                size="lg"
                onClick={() => void handleApprove()}
                disabled={busyAction !== null}
                className="min-h-11"
              >
                {busyAction === "approve" && (
                  <Loader2 className="size-4 animate-spin" />
                )}
                {busyAction === "approve"
                  ? bt("wizard.creating")
                  : bt("wizard.approve")}
              </Button>
            </div>
          </motion.div>
        )}

        {/* --------------------------------------------------------------- */}
        {/* Success                                                          */}
        {/* --------------------------------------------------------------- */}
        {step === "success" && (
          <motion.div
            {...entrance}
            className="flex flex-col items-center py-16 text-center"
          >
            <span className="flex size-14 items-center justify-center rounded-full border border-brand/30 bg-brand/10 text-brand">
              <Check aria-hidden className="size-7" />
            </span>
            <h2 className="font-display mt-5 text-xl font-semibold tracking-tight text-foreground">
              {bt("wizard.created")}
            </h2>
            <Button
              size="lg"
              onClick={() => createdId && goWorkspace(createdId)}
              className="mt-6 min-h-11"
            >
              {bt("wizard.openWorkspace")}
              <ArrowRight aria-hidden className="size-4" />
            </Button>
          </motion.div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Logo picker (popover grid over the AGENT_LOGOS registry)
// ---------------------------------------------------------------------------

function LogoPicker({
  value,
  agentName,
  onChange,
}: {
  value: string;
  agentName: string;
  onChange: (logo: string) => void;
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`${bt("agent.logo")}${agentName ? ` — ${agentName}` : ""}`}
          className="focus-visible:ring-ring hover:border-primary/40 flex size-10 shrink-0 cursor-pointer items-center justify-center rounded-full transition-colors focus-visible:ring-1 focus-visible:outline-none"
        >
          <AgentLogo logo={value} className="size-8" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56 p-2">
        <div
          role="grid"
          aria-label={bt("agent.logo")}
          className="scrollbar-thin grid max-h-64 grid-cols-4 gap-1.5 overflow-y-auto p-1"
        >
          {AGENT_LOGOS.map((def) => (
            <button
              key={def.key}
              type="button"
              onClick={() => {
                onChange(def.key);
                setOpen(false);
              }}
              aria-label={def.label}
              title={def.label}
              className={cn(
                "focus-visible:ring-ring flex size-10 items-center justify-center rounded-lg border transition-colors focus-visible:ring-1 focus-visible:outline-none",
                def.key === value
                  ? "border-primary/50 bg-primary/10 text-primary"
                  : "border-border/60 text-muted-foreground hover:bg-accent hover:text-accent-foreground",
              )}
            >
              <AgentLogo logo={def.key} className="size-6" />
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

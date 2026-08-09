"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Server,
  Trash2,
  Upload,
  X,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
  Badge,
  Button,
  FormField,
  Input,
  Switch,
} from "@/components/ui";
import { SectionCard } from "@/components/settings/settings-section";
import { useAuth } from "@/hooks";
import { useAuthStore } from "@/stores";
import { aiProviderService, settingsService } from "@/lib/services";
import { cn } from "@/lib/utils";
import type { AIProviderRow } from "@/lib/db";

// ---------- Types ----------

interface AIProvider {
  id: string;
  user_id: string;
  name: string;
  base_url: string;
  models: string[];
  is_active: boolean;
  // "chat" -> POST /v1/chat/completions (universal — works with every
  // OpenAI-compatible provider including g4f.space). "responses" -> POST
  // /v1/responses (OpenAI-direct only). Defaults to "chat" so a freshly
  // added provider works out of the box without the user having to think
  // about endpoint shape.
  model_type: "chat" | "responses";
  // When false, NO tools array is sent in the request body. Some providers
  // (notably certain g4f models) reject any request with a tools array via
  // HTTP 403; toggling this off lets the user still chat in text-only mode.
  tools_enabled: boolean;
  /** When true, use the base URL as-is (no /chat/completions suffix). */
  no_prefix?: boolean;
  /** When true, sends chat_template_kwargs: {enable_thinking: true} */
  thinking_enabled?: boolean;
  has_api_key: boolean;
  created_at: string;
  updated_at: string;
}

interface TestResult {
  ok: boolean;
  status_code?: number | null;
  detail?: string | null;
  sample_response?: string | null;
}

/** Color for the model badge based on the model name. */
function badgeColorForModel(name: string): string {
  const n = name.toLowerCase();
  if (n.includes("gpt") || n.startsWith("o1") || n.startsWith("o3") || n.startsWith("o4")) return "bg-emerald-500";
  if (n.includes("claude") || n.includes("anthropic")) return "bg-orange-500";
  if (n.includes("llama") || n.includes("mistral") || n.includes("qwen") || n.includes("deepseek") || n.includes("yi") || n.includes("gemma")) return "bg-blue-500";
  if (n.includes("dall") || n.includes("stable") || n.includes("flux") || n.includes("sdxl")) return "bg-purple-500";
  if (n.includes("mimo") || n.includes("xiaomi")) return "bg-teal-500";
  if (n.includes("step") || n.includes("fun")) return "bg-rose-500";
  return "bg-muted-foreground/60";
}

interface ProviderDraft {
  name: string;
  base_url: string;
  api_key: string;
  models: string[];
  is_active: boolean;
  model_type: "chat" | "responses";
  tools_enabled: boolean;
  /** When true, use the base URL as-is (no /chat/completions suffix). */
  no_prefix?: boolean;
  /** When true, sends chat_template_kwargs: {enable_thinking: true} */
  thinking_enabled?: boolean;
}

const EMPTY_DRAFT: ProviderDraft = {
  name: "",
  base_url: "",
  api_key: "",
  models: [],
  is_active: true,
  model_type: "chat",
  tools_enabled: true,
  no_prefix: false,
  thinking_enabled: false,
};

function rowToProvider(row: AIProviderRow): AIProvider {
  return {
    id: row.id,
    user_id: row.user_id,
    name: row.name,
    base_url: row.base_url,
    models: row.models ?? [],
    is_active: row.is_active,
    model_type: row.model_type,
    tools_enabled: row.tools_enabled,
    no_prefix: row.no_prefix ?? false,
    thinking_enabled: row.thinking_enabled ?? false,
    has_api_key: !!row.api_key_encrypted,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// ---------- Page ----------

export default function ConfigSettingsPage() {
  const { user } = useAuth();
  const [providers, setProviders] = useState<AIProvider[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<ProviderDraft | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, TestResult>>({});

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const rows = await aiProviderService.list(user.id);
      setProviders(rows.map(rowToProvider));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load providers");
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    void load();
  }, [load]);

  // ---------- Handlers ----------

  const startCreate = () => {
    setEditingId(null);
    setDraft({ ...EMPTY_DRAFT });
  };

  const startEdit = (p: AIProvider) => {
    setEditingId(p.id);
    setDraft({
      name: p.name,
      base_url: p.base_url,
      api_key: "", // never pre-fill the key
      models: [...p.models],
      is_active: p.is_active,
      model_type: p.model_type ?? "chat",
      tools_enabled: p.tools_enabled ?? true,
      no_prefix: p.no_prefix ?? false,
      thinking_enabled: p.thinking_enabled ?? false,
    });
  };

  const cancel = () => {
    setDraft(null);
    setEditingId(null);
  };

  const save = async () => {
    if (!user || !draft) return;
    if (!draft.name.trim()) {
      toast.error("Name is required");
      return;
    }
    if (!draft.base_url.trim()) {
      toast.error("Base URL is required");
      return;
    }
    setSaving(true);
    try {
      const input = {
        name: draft.name.trim(),
        base_url: draft.base_url.trim(),
        // Empty string => keep existing (update) or none (create). The
        // service treats `""` as "clear" on update and "no key" on create.
        api_key: draft.api_key.trim(),
        models: draft.models.filter((m) => m.trim()).map((m) => m.trim()),
        is_active: draft.is_active,
        model_type: draft.model_type,
        tools_enabled: draft.tools_enabled,
        no_prefix: draft.no_prefix ?? false,
        thinking_enabled: draft.thinking_enabled ?? false,
      };
      if (editingId) {
        // Pass undefined for api_key when blank so the service keeps the
        // existing key (only `""` clears it).
        const patch = { ...input };
        if (!patch.api_key) delete (patch as { api_key?: string }).api_key;
        await aiProviderService.update(editingId, patch);
        toast.success("Provider updated");
      } else {
        await aiProviderService.create(user.id, input);
        toast.success("Provider added");
      }
      await load();
      cancel();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save provider");
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string) => {
    try {
      await aiProviderService.delete(id);
      toast.success("Provider deleted");
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete");
    }
  };

  const toggleActive = async (p: AIProvider, next: boolean) => {
    try {
      await aiProviderService.update(p.id, { is_active: next });
      setProviders((prev) =>
        prev.map((x) => (x.id === p.id ? { ...x, is_active: next } : x)),
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update");
    }
  };

  const test = async (p: AIProvider) => {
    setTestingId(p.id);
    setTestResults((prev) => ({ ...prev, [p.id]: { ok: false, detail: "Testing…" } }));
    try {
      const result = await aiProviderService.test(p.id);
      setTestResults((prev) => ({ ...prev, [p.id]: result }));
      if (result.ok) toast.success(`Provider ${p.name} responded OK`);
      else toast.error(`Provider ${p.name} test failed`);
    } catch (err) {
      const detail = err instanceof Error ? err.message : "Request failed";
      setTestResults((prev) => ({ ...prev, [p.id]: { ok: false, detail } }));
      toast.error(detail);
    } finally {
      setTestingId(null);
    }
  };

  // ---------- Render ----------

  return (
    <div className="space-y-6">
      {/* AI Providers section */}
      <SectionCard
        title="AI providers"
        description="Add OpenAI-compatible providers (base URL + optional API key). Then add the model IDs you want exposed in the chat model picker. API keys are encrypted at rest."
        action={
          <Button onClick={startCreate} size="sm">
            <Plus className="h-4 w-4 mr-1.5" />
            Add provider
          </Button>
        }
      >
        {loading ? (
          <div className="flex items-center justify-center py-8 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin mr-2" /> Loading…
          </div>
        ) : providers.length === 0 && !draft ? (
          <div className="rounded-xl border border-dashed border-foreground/15 p-8 text-center">
            <Server className="mx-auto h-8 w-8 text-muted-foreground mb-3" />
            <p className="font-medium">No providers configured yet</p>
            <p className="text-sm text-muted-foreground mt-1">
              Add your first AI provider to start chatting. Any OpenAI-compatible
              endpoint works — OpenAI, Groq, Together, OpenRouter, Ollama, vLLM, LM Studio, etc.
            </p>
            <Button onClick={startCreate} className="mt-4" size="sm">
              <Plus className="h-4 w-4 mr-1.5" />
              Add provider
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            {providers.map((p) => (
              <ProviderRow
                key={p.id}
                provider={p}
                onEdit={() => startEdit(p)}
                onDelete={() => void remove(p.id)}
                onToggle={(v) => void toggleActive(p, v)}
                onTest={() => void test(p)}
                testing={testingId === p.id}
                testResult={testResults[p.id]}
              />
            ))}
          </div>
        )}
      </SectionCard>

      {/* Editor dialog (inline panel, not a modal) */}
      {draft && (
        <ProviderEditor
          draft={draft}
          onChange={setDraft}
          editing={!!editingId}
          saving={saving}
          onSave={save}
          onCancel={cancel}
        />
      )}

      {/* AI Framework selector */}
      <SectionCard
        title="AI framework"
        description="Choose the AI agent framework preset. Changes the system prompt to match the framework's conventions. Applies instantly — no reset needed."
      >
        <AIFrameworkSection />
      </SectionCard>

      {/* E2B Sandbox — code runner only (not storage) */}
      <SectionCard
        title="E2B Sandbox (code runner)"
        description="Optional — used ONLY for running Python and terminal commands. Files are stored locally and auto-synced to the sandbox before code execution."
      >
        <E2BConfigSection />
      </SectionCard>

      {/* SkillsMP */}
      <SectionCard
        title="SkillsMP API Key"
        description="Optional — used for searching and installing skills from the SkillsMP marketplace. Get a key at skillsmp.com"
      >
        <SkillsMPConfigSection />
      </SectionCard>

      {/* Tool approval — toggle to skip the HITL approval dialog for tools
          flagged `requires_approval` (run_terminal, run_python). Off by
          default; turning it on is faster but less secure since the agent
          can run shell commands without confirming each one. */}
      <SectionCard
        title="Tool approval"
        description="Control whether the agent asks for confirmation before running tools that can execute shell commands or code."
      >
        <ToolApprovalSection />
      </SectionCard>

      {/* Data management — export/import all local data */}
      <SectionCard
        title="Data management"
        description="Export all your data (conversations, files, settings, skills) as a JSON file, or import previously exported data."
      >
        <DataManagementSection />
      </SectionCard>

      {/* System prompt override */}
      <SystemPromptSection />

      <OtherApiKeysSection />
    </div>
  );
}

// ---------- Other API Keys Section ----------

function OtherApiKeysSection() {
  const { user } = useAuth();
  const [tavily, setTavily] = useState("");
  const [embeddings, setEmbeddings] = useState("");
  const [langsearch, setLangsearch] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!user) return;
    void (async () => {
      try {
        const s = await settingsService.get(user.id);
        setTavily(s.tavily_api_key_present ? "•••••••••••• (saved)" : "");
        setEmbeddings(s.embeddings_api_key_present ? "•••••••••••• (saved)" : "");
        setLangsearch(s.langsearch_api_key_present ? "•••••••••••• (saved)" : "");
      } catch {
        // ignore
      } finally {
        setLoaded(true);
      }
    })();
  }, [user]);

  const save = async () => {
    if (!user) return;
    setSaving(true);
    try {
      let changed = false;
      // Only persist when the user typed something new (don't clear existing
      // keys when they leave a field blank).
      if (tavily && !tavily.startsWith("••••")) {
        await settingsService.setTavilyKey(user.id, tavily.trim());
        changed = true;
      }
      if (embeddings && !embeddings.startsWith("••••")) {
        await settingsService.setEmbeddingsKey(user.id, embeddings.trim());
        changed = true;
      }
      if (langsearch && !langsearch.startsWith("••••")) {
        await settingsService.setLangSearchKey(user.id, langsearch.trim());
        changed = true;
      }
      if (!changed) {
        toast.info("No changes to save");
        return;
      }
      toast.success("API keys saved");
      setTavily("•••••••••••• (saved)");
      setEmbeddings("•••••••••••• (saved)");
      setLangsearch("•••••••••••• (saved)");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  if (!loaded) {
    return (
      <SectionCard
        title="Other API keys"
        description="Keys for web search (Tavily, LangSearch) and embeddings. Stored encrypted on the server."
      >
        <div className="flex items-center justify-center py-8 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin mr-2" /> Loading…
        </div>
      </SectionCard>
    );
  }

  return (
    <SectionCard
      title="Other API keys"
      description="Keys for web search (Tavily, LangSearch) and embeddings. Stored encrypted locally; leave blank to keep an existing key."
    >
      <div className="space-y-4">
        <FormField label="LangSearch API key" htmlFor="langsearch-key" description="Optional — when set, web_search uses LangSearch's hybrid API (richer summaries); falls back to Miklium when blank or on error. Image & video search always use Miklium.">
          <Input
            id="langsearch-key"
            type="password"
            value={langsearch}
            onChange={(e) => setLangsearch(e.target.value)}
            placeholder="sk-…  (get one at langsearch.com/api-keys)"
          />
        </FormField>
        <FormField label="Tavily API key" htmlFor="tavily-key">
          <Input
            id="tavily-key"
            type="password"
            value={tavily}
            onChange={(e) => setTavily(e.target.value)}
            placeholder="tvly-…"
          />
        </FormField>
        <FormField label="Embeddings API key" htmlFor="embeddings-key">
          <Input
            id="embeddings-key"
            type="password"
            value={embeddings}
            onChange={(e) => setEmbeddings(e.target.value)}
            placeholder="sk-…"
          />
        </FormField>
        <Button onClick={save} disabled={saving} size="sm">
          {saving && <Loader2 className="h-4 w-4 animate-spin mr-1.5" />}
          Save keys
        </Button>
      </div>
    </SectionCard>
  );
}

// ---------- Tool Approval Section ----------

function ToolApprovalSection() {
  const { user } = useAuth();
  const [autoApprove, setAutoApprove] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!user) return;
    void (async () => {
      try {
        const v = await settingsService.getAutoApproveTools(user.id);
        setAutoApprove(v);
      } catch {
        // ignore — defaults to false
      } finally {
        setLoaded(true);
      }
    })();
  }, [user]);

  const toggle = async (next: boolean) => {
    if (!user) return;
    setAutoApprove(next);
    setSaving(true);
    try {
      await settingsService.setAutoApproveTools(user.id, next);
      toast.success(
        next
          ? "Tool auto-approval enabled"
          : "Tool auto-approval disabled — approval dialog restored",
      );
    } catch (err) {
      // Revert on error.
      setAutoApprove(!next);
      toast.error(err instanceof Error ? err.message : "Failed to update");
    } finally {
      setSaving(false);
    }
  };

  if (!loaded) {
    return (
      <div className="flex items-center justify-center py-6 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin mr-2" /> Loading…
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3 rounded-lg border border-foreground/15 p-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">Auto-approve tool calls</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            Skip the approval dialog for tools like{" "}
            <code className="font-mono">run_terminal</code>. Faster but less
            secure — the agent can run shell commands, install packages, and
            modify files without confirming each action.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {saving && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
          <Switch
            id="auto-approve-tools"
            checked={autoApprove}
            onCheckedChange={(v) => void toggle(v)}
            disabled={saving}
          />
        </div>
      </div>
      {autoApprove && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-700 dark:text-amber-300">
          <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          <span>
            Auto-approval is on. The agent will run shell commands and code
            snippets without asking. Make sure your E2B Sandbox key limits
            what these tools can do, or turn this off if you&apos;re unsure.
          </span>
        </div>
      )}
      {/* Single-round mode toggle */}
      <SingleRoundModeSection />
    </div>
  );
}

function SingleRoundModeSection() {
  const { user } = useAuth();
  const [singleRound, setSingleRound] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!user) return;
    void (async () => {
      try {
        const v = await settingsService.getSingleRoundMode(user.id);
        setSingleRound(v);
      } catch {
        // ignore
      } finally {
        setLoaded(true);
      }
    })();
  }, [user]);

  const toggle = async (next: boolean) => {
    if (!user) return;
    setSingleRound(next);
    setSaving(true);
    try {
      await settingsService.setSingleRoundMode(user.id, next);
      toast.success(
        next
          ? "Single-round mode enabled — all tools run in one round, single message bubble"
          : "Multi-round mode restored — separate bubbles for each round",
      );
    } catch (err) {
      setSingleRound(!next);
      toast.error(err instanceof Error ? err.message : "Failed to update");
    } finally {
      setSaving(false);
    }
  };

  if (!loaded) return null;

  return (
    <div className="flex items-start justify-between gap-3 rounded-lg border border-foreground/15 p-3">
      <div className="min-w-0">
        <p className="text-sm font-medium">Single-round mode</p>
        <p className="text-xs text-muted-foreground mt-0.5">
          Execute all tool calls in a single round and produce one message
          bubble. Disable for multi-round responses where each tool call
          gets its own text + response cycle.
        </p>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {saving && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
        <Switch
          id="single-round-mode"
          checked={singleRound}
          onCheckedChange={(v) => void toggle(v)}
          disabled={saving}
        />
      </div>
    </div>
  );
}

function SystemPromptSection() {
  const { user } = useAuth();
  const [prompt, setPrompt] = useState<string>("");
  const [enabled, setEnabled] = useState<boolean>(false);
  const [defaultPrompt, setDefaultPrompt] = useState<string>("");
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!user) return;
    void (async () => {
      try {
        const s = await settingsService.get(user.id);
        setPrompt(s.system_prompt ?? "");
        setEnabled(s.system_prompt_enabled ?? false);
        // Backendless mode has no server-side default prompt — keep a
        // friendly placeholder so the textarea hint is still useful.
        setDefaultPrompt(
          "You are a helpful, knowledgeable AI assistant. Use the available tools when appropriate.",
        );
      } catch {
        // ignore — section just stays at defaults
      } finally {
        setLoaded(true);
      }
    })();
  }, [user]);

  const save = async () => {
    if (!user) return;
    setSaving(true);
    try {
      await settingsService.setSystemPrompt(user.id, prompt.trim() || null, enabled);
      toast.success("System prompt saved");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const reset = async () => {
    if (!user) return;
    setSaving(true);
    try {
      await settingsService.setSystemPrompt(user.id, null, false);
      setPrompt("");
      setEnabled(false);
      toast.success("Reset to default prompt");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to reset");
    } finally {
      setSaving(false);
    }
  };

  if (!loaded) {
    return (
      <SectionCard
        title="System prompt"
        description="Override the agent's default system prompt for your chats."
      >
        <div className="flex items-center justify-center py-8 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin mr-2" /> Loading…
        </div>
      </SectionCard>
    );
  }

  return (
    <SectionCard
      title="System prompt"
      description="Override the agent's default system prompt for your chats. Leave empty to use the built-in default. The agent also automatically learns about your installed skills, MCPs, and custom tools — no need to mention them here."
    >
      <div className="space-y-4">
        <FormField label="Enable custom prompt" htmlFor="agent-prompt-enabled">
          <div className="flex items-center gap-2">
            <input
              id="agent-prompt-enabled"
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              className="h-4 w-4 rounded border-input"
            />
            <span className="text-sm text-muted-foreground">
              When checked, your custom prompt replaces the default. When
              unchecked, the prompt is saved but the default is used.
            </span>
          </div>
        </FormField>
        <FormField label="System prompt" htmlFor="agent-system-prompt">
          <textarea
            id="agent-system-prompt"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={`Leave empty to use the default prompt. Write instructions for how the agent should behave in your chats…\n\nDefault prompt:\n${defaultPrompt.slice(0, 500)}…`}
            rows={10}
            maxLength={20000}
            className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 font-mono"
          />
          <p className="text-xs text-muted-foreground mt-1">
            {prompt.length.toLocaleString()} / 20,000 chars
          </p>
        </FormField>
        <div className="flex gap-2">
          <Button onClick={save} disabled={saving} size="sm">
            {saving ? <Loader2 className="h-4 w-4 animate-spin mr-1.5" /> : <CheckCircle2 className="h-4 w-4 mr-1.5" />}
            Save prompt
          </Button>
          <Button onClick={reset} disabled={saving} size="sm" variant="outline">
            Reset to default
          </Button>
        </div>
      </div>
    </SectionCard>
  );
}

// ---------- Sub-components ----------

function ProviderRow({
  provider,
  onEdit,
  onDelete,
  onToggle,
  onTest,
  testing,
  testResult,
}: {
  provider: AIProvider;
  onEdit: () => void;
  onDelete: () => void;
  onToggle: (v: boolean) => void;
  onTest: () => void;
  testing: boolean;
  testResult?: TestResult;
}) {
  return (
    <div className="rounded-xl border border-foreground/10 p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold truncate">{provider.name}</span>
            {provider.has_api_key ? (
              <Badge variant="secondary" className="text-[10px]">key set</Badge>
            ) : (
              <Badge variant="outline" className="text-[10px]">no key</Badge>
            )}
            {!provider.is_active && (
              <Badge variant="outline" className="text-[10px]">inactive</Badge>
            )}
            {provider.model_type === "responses" ? (
              <Badge variant="outline" className="text-[10px] font-mono" title="POST /v1/responses — OpenAI direct only">
                responses
              </Badge>
            ) : (
              <Badge variant="outline" className="text-[10px] font-mono" title="POST /v1/chat/completions — universal">
                chat
              </Badge>
            )}
            {provider.tools_enabled === false && (
              <Badge variant="outline" className="text-[10px]" title="No tools array sent — text-only mode">
                no tools
              </Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-0.5 truncate">{provider.base_url}</p>
        </div>
        <div className="flex items-center gap-2">
          <Switch checked={provider.is_active} onCheckedChange={onToggle} />
          <Button size="sm" variant="ghost" onClick={onEdit}>
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button size="sm" variant="ghost">
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete provider?</AlertDialogTitle>
                <AlertDialogDescription>
                  This permanently deletes <b>{provider.name}</b> and its
                  stored API key. This action cannot be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={onDelete}>Delete</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>

      {provider.models.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {provider.models.map((m) => (
            <Badge key={m} variant="outline" className="font-mono text-[10px]">
              {m}
            </Badge>
          ))}
        </div>
      )}

      <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" onClick={onTest} disabled={testing}>
          {testing ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
          ) : (
            <CheckCircle2 className="h-3.5 w-3.5 mr-1.5" />
          )}
          Test
        </Button>
        {testResult && (
          <div
            className={`flex items-center gap-1.5 text-xs ${
              testResult.ok ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"
            }`}
          >
            {testResult.ok ? (
              <CheckCircle2 className="h-3.5 w-3.5" />
            ) : (
              <XCircle className="h-3.5 w-3.5" />
            )}
            <span className="truncate max-w-md">
              {testResult.ok
                ? `OK${testResult.status_code ? ` (${testResult.status_code})` : ""}${
                    testResult.sample_response ? `: ${testResult.sample_response.slice(0, 80)}` : ""
                  }`
                : testResult.detail || "Failed"}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

function ProviderEditor({
  draft,
  onChange,
  editing,
  saving,
  onSave,
  onCancel,
}: {
  draft: ProviderDraft;
  onChange: (next: ProviderDraft) => void;
  editing: boolean;
  saving: boolean;
  onSave: () => void;
  onCancel: () => void;
}) {
  const [newModel, setNewModel] = useState("");
  const [fetchingModels, setFetchingModels] = useState(false);

  const addModel = () => {
    const m = newModel.trim();
    if (!m) return;
    if (draft.models.includes(m)) {
      setNewModel("");
      return;
    }
    onChange({ ...draft, models: [...draft.models, m] });
    setNewModel("");
  };

  // Fetch available models from the provider's /v1/models endpoint.
  // Uses the server-side /api/fetch-models proxy to avoid CORS issues.
  const fetchModels = async () => {
    if (!draft.base_url.trim()) {
      toast.error("Enter a Base URL first");
      return;
    }
    setFetchingModels(true);
    try {
      const params = new URLSearchParams({
        baseUrl: draft.base_url.trim(),
      });
      if (draft.api_key.trim()) {
        params.set("apiKey", draft.api_key.trim());
      }
      if (draft.no_prefix) {
        params.set("noPrefix", "1");
      }
      const res = await fetch(`/api/fetch-models?${params.toString()}`);
      const data = await res.json();
      if (!res.ok) {
        toast.error(`Failed to fetch models: ${data?.error ?? res.statusText}`);
        return;
      }
      const fetched: string[] = data.models ?? [];
      if (fetched.length === 0) {
        toast.info("No models returned by this provider");
        return;
      }
      // Merge with existing models (deduplicate)
      const existing = new Set(draft.models.map((m) => m.toLowerCase()));
      const newOnes = fetched.filter((m) => !existing.has(m.toLowerCase()));
      if (newOnes.length === 0) {
        toast.info(`All ${fetched.length} models already added`);
        return;
      }
      onChange({ ...draft, models: [...draft.models, ...newOnes] });
      toast.success(`Added ${newOnes.length} new model${newOnes.length === 1 ? "" : "s"} (${fetched.length} total found)`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to fetch models");
    } finally {
      setFetchingModels(false);
    }
  };

  return (
    <div className="rounded-xl border border-foreground/15 bg-card p-5 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold">{editing ? "Edit provider" : "Add provider"}</h3>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          <X className="h-4 w-4" />
        </Button>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <FormField label="Display name" htmlFor="provider-name">
          <Input
            id="provider-name"
            placeholder="OpenAI / Groq / My Ollama"
            value={draft.name}
            onChange={(e) => onChange({ ...draft, name: e.target.value })}
          />
        </FormField>
        <FormField label="Base URL" htmlFor="provider-base-url">
          <Input
            id="provider-base-url"
            placeholder="https://api.openai.com/v1 or http://localhost:11434"
            value={draft.base_url}
            onChange={(e) => onChange({ ...draft, base_url: e.target.value })}
          />
        </FormField>
      </div>

      {/* No-prefix option — when enabled, the runtime uses the base URL
          as-is without appending /chat/completions. This is for providers
          that have non-standard endpoint paths. */}
      <div className="flex items-center gap-2">
        <Switch
          id="provider-no-prefix"
          checked={draft.no_prefix ?? false}
          onCheckedChange={(v) => onChange({ ...draft, no_prefix: v })}
        />
        <label htmlFor="provider-no-prefix" className="text-sm cursor-pointer">
          Use raw base URL (no <code className="font-mono text-xs">/chat/completions</code> suffix)
        </label>
      </div>
      <p className="text-xs text-muted-foreground -mt-2 ml-7">
        When on, the app calls <code className="font-mono text-xs">{`{base_url}`}</code> directly
        instead of <code className="font-mono text-xs">{`{base_url}/chat/completions`}</code>. Useful
        for providers with non-standard endpoints.
      </p>

      {/* Thinking toggle — for providers like Poolside that support
          chat_template_kwargs: {enable_thinking: true} */}
      <div className="flex items-center gap-2">
        <Switch
          id="provider-thinking"
          checked={draft.thinking_enabled ?? false}
          onCheckedChange={(v) => onChange({ ...draft, thinking_enabled: v })}
        />
        <label htmlFor="provider-thinking" className="text-sm cursor-pointer">
          Thinking enabled
        </label>
      </div>
      <p className="text-xs text-muted-foreground -mt-2 ml-7">
        Sends <code className="font-mono text-xs">{"chat_template_kwargs: {enable_thinking: true}"}</code> in the
        request body. For providers like Poolside that support native reasoning tokens.
      </p>

      <FormField
        label="API key (optional)"
        htmlFor="provider-api-key"
        description="Leave blank for local providers (Ollama, vLLM, LM Studio). Stored encrypted."
      >
        <Input
          id="provider-api-key"
          type="password"
          placeholder={editing ? "•••••••• (leave blank to keep existing)" : "sk-…"}
          value={draft.api_key}
          onChange={(e) => onChange({ ...draft, api_key: e.target.value })}
        />
      </FormField>

      <div>
        <div className="flex items-center justify-between">
          <label htmlFor="provider-model-input" className="text-sm font-medium">Models</label>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={fetchModels}
            disabled={fetchingModels || !draft.base_url.trim()}
            className="h-7 text-xs"
          >
            {fetchingModels ? (
              <>
                <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> Fetching…
              </>
            ) : (
              <>
                <RefreshCw className="h-3.5 w-3.5 mr-1" /> Fetch from URL
              </>
            )}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground mb-2 mt-1">
          Add the model IDs you want exposed in the chat model picker, or click
          "Fetch from URL" to auto-discover models from the provider's /v1/models endpoint.
        </p>
        <div className="flex gap-2">
          <Input
            id="provider-model-input"
            placeholder="gpt-4o / llama-3.1-70b / etc."
            value={newModel}
            onChange={(e) => setNewModel(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addModel();
              }
            }}
          />
          <Button type="button" size="sm" onClick={addModel}>
            <Plus className="h-4 w-4 mr-1" /> Add
          </Button>
        </div>
        {draft.models.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-2">
            {draft.models.map((m) => {
              const badgeColor = badgeColorForModel(m);
              return (
                <div
                  key={m}
                  className="group flex items-center gap-2.5 rounded-lg border border-border bg-card px-3 py-2 transition-colors hover:border-foreground/30"
                >
                  <span
                    className={cn(
                      "shrink-0 rounded-md px-1.5 py-0.5 font-mono text-[9px] font-bold text-white",
                      badgeColor,
                    )}
                  >
                    {m.slice(0, 3).toUpperCase()}
                  </span>
                  <span className="flex-1 min-w-0 truncate font-mono text-xs text-foreground">
                    {m}
                  </span>
                  <button
                    type="button"
                    onClick={() => onChange({ ...draft, models: draft.models.filter((x) => x !== m) })}
                    className="shrink-0 rounded-full p-1 text-muted-foreground hover:bg-muted hover:text-destructive transition-colors"
                    aria-label={`Remove ${m}`}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="flex items-center gap-2">
        <Switch
          id="provider-active"
          checked={draft.is_active}
          onCheckedChange={(v) => onChange({ ...draft, is_active: v })}
        />
        <label htmlFor="provider-active" className="text-sm">
          Active (show in chat model picker)
        </label>
      </div>

      {/* API endpoint type — controls whether the agent hits
          /v1/chat/completions (universal, works with every OpenAI-compatible
          provider including g4f.space) or /v1/responses (OpenAI-direct only).
          Defaulting to "chat" is what fixes the stuck-at-thinking bug users
          hit when they pointed the app at g4f.space — that provider doesn't
          implement /v1/responses and the SSE parser hung forever waiting for
          a chunk that never came. */}
      <div>
        <span className="text-sm font-medium block">API endpoint type</span>
        <p className="text-xs text-muted-foreground mb-2">
          Most OpenAI-compatible providers (OpenRouter, Groq, Together, Ollama,
          vLLM, LM Studio, g4f.space, …) only support{" "}
          <code className="font-mono">/v1/chat/completions</code>. Use the
          Responses API only when talking to OpenAI directly.
        </p>
        <div className="grid gap-2 sm:grid-cols-2">
          <button
            type="button"
            onClick={() => onChange({ ...draft, model_type: "chat" })}
            className={`text-left rounded-lg border p-3 transition-colors ${
              draft.model_type === "chat"
                ? "border-primary bg-primary/5 ring-1 ring-primary"
                : "border-foreground/15 hover:border-foreground/30"
            }`}
          >
            <div className="flex items-center gap-2">
              <span
                className={`h-2 w-2 rounded-full ${
                  draft.model_type === "chat" ? "bg-primary" : "bg-muted-foreground/40"
                }`}
              />
              <span className="font-medium text-sm">Chat Completions</span>
            </div>
            <p className="text-xs text-muted-foreground mt-1 ml-4">
              <code className="font-mono">/v1/chat/completions</code> — works
              with all providers
            </p>
          </button>
          <button
            type="button"
            onClick={() => onChange({ ...draft, model_type: "responses" })}
            className={`text-left rounded-lg border p-3 transition-colors ${
              draft.model_type === "responses"
                ? "border-primary bg-primary/5 ring-1 ring-primary"
                : "border-foreground/15 hover:border-foreground/30"
            }`}
          >
            <div className="flex items-center gap-2">
              <span
                className={`h-2 w-2 rounded-full ${
                  draft.model_type === "responses" ? "bg-primary" : "bg-muted-foreground/40"
                }`}
              />
              <span className="font-medium text-sm">Responses API</span>
            </div>
            <p className="text-xs text-muted-foreground mt-1 ml-4">
              <code className="font-mono">/v1/responses</code> — OpenAI direct only
            </p>
          </button>
        </div>
      </div>

      {/* Tool calling toggle — when off, NO tools array is sent in the
          request body. Some providers (notably certain g4f models) reject
          any request that includes a tools array via HTTP 403, which
          surfaces as stuck-at-thinking because the SSE stream never starts.
          With this off the user can still chat in text-only mode. */}
      <div className="rounded-lg border border-foreground/15 p-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-medium">Tool calling</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Disable if the provider returns 403 errors on tool calls (some
              g4f / free models). Text-only mode still works for chat — the
              agent just can&apos;t call create_file, run_python, etc.
            </p>
          </div>
          <Switch
            id="provider-tools-enabled"
            checked={draft.tools_enabled}
            onCheckedChange={(v) => onChange({ ...draft, tools_enabled: v })}
          />
        </div>
      </div>

      <div className="flex items-center justify-end gap-2 pt-2 border-t border-foreground/10">
        <Button variant="ghost" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button onClick={onSave} disabled={saving}>
          {saving && <Loader2 className="h-4 w-4 animate-spin mr-1.5" />}
          {editing ? "Save changes" : "Add provider"}
        </Button>
      </div>
    </div>
  );
}

// E2B Sandbox config section — persists via settingsService (encrypted locally).
// The key is stored encrypted in the user's IndexedDB vault; the localStorage
// copy is a fallback for offline / single-instance dev. The localStorage key
// name (`e2b_api_key`) is kept for back-compat with existing sessions.
function E2BConfigSection() {
  const { user } = useAuth();
  const [key, setKey] = useState("");
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  useEffect(() => {
    if (!user) return;
    void (async () => {
      try {
        const decrypted = await settingsService.getDecryptedSandboxKey(user.id);
        if (decrypted) setKey("•••••••••••• (saved)");
      } catch {
        // ignore
      }
      const stored =
        typeof window !== "undefined" ? window.localStorage.getItem("e2b_api_key") : null;
      if (stored && !key) setKey(stored);
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  const save = async () => {
    if (!user) return;
    setSaving(true);
    try {
      if (key && !key.startsWith("••••")) {
        await settingsService.setSandboxKey(user.id, key.trim());
        if (typeof window !== "undefined") {
          window.localStorage.setItem("e2b_api_key", key.trim());
        }
        setKey("•••••••••••• (saved)");
        setSaved(true);
        toast.success("E2B Sandbox key saved");
        setTimeout(() => setSaved(false), 2000);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const testKey = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      let apiKey = key;
      if (key.startsWith("••••") && user) {
        const decrypted = await settingsService.getDecryptedSandboxKey(user.id);
        apiKey = decrypted || "";
      }
      if (!apiKey) {
        setTestResult({ ok: false, message: "No API key to test. Save a key first." });
        return;
      }

      // Test by listing sandboxes via the E2B SDK directly (browser-safe).
      const { E2BClient } = await import("@/lib/e2b/client");
      const items = await E2BClient.listSandboxes(apiKey.trim());
      const runningCount = items.length;
      const oldest = items.length > 0
        ? items.sort((a: { startedAt?: string }, b: { startedAt?: string }) =>
            (a.startedAt ?? "").localeCompare(b.startedAt ?? ""),
          )[0]
        : null;
      setTestResult({
        ok: true,
        message:
          `✅ API key valid! ${runningCount} running sandbox${runningCount === 1 ? "" : "es"}` +
          (runningCount >= 10
            ? " (concurrency limit reached — oldest will be evicted on next create)"
            : runningCount > 0 && oldest?.startedAt
              ? ` (oldest started ${new Date(oldest.startedAt).toLocaleString()})`
              : ""),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Connection failed";
      // E2B SDK throws AuthenticationError for invalid keys
      const displayMsg = /auth|401|403|invalid/i.test(msg)
        ? "Invalid API key — check the key at https://e2b.dev"
        : msg;
      setTestResult({ ok: false, message: `❌ ${displayMsg}` });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <AlertTriangle className="h-3.5 w-3.5" />
        <span>
          Optional. When set, the agent routes file/terminal/code-execution
          ops through the E2B cloud sandbox instead of the local per-user
          workspace. Stored encrypted locally. Get a key at{" "}
          <a
            href="https://e2b.dev"
            target="_blank"
            rel="noopener noreferrer"
            className="text-foreground underline underline-offset-2"
          >
            e2b.dev
          </a>
          .
        </span>
      </div>
      <FormField label="E2B Sandbox API key" htmlFor="e2b-key">
        <Input
          id="e2b-key"
          type="password"
          placeholder="e2b_…"
          value={key}
          onChange={(e) => setKey(e.target.value)}
        />
      </FormField>
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={save} disabled={saving}>
          {saving ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin mr-1.5" /> Saving…
            </>
          ) : saved ? (
            "Saved ✓"
          ) : (
            "Save"
          )}
        </Button>
        <Button size="sm" variant="outline" onClick={testKey} disabled={testing}>
          {testing ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin mr-1.5" /> Testing…
            </>
          ) : (
            "Test API Key"
          )}
        </Button>
      </div>
      {testResult && (
        <div className={`rounded-md border px-3 py-2 text-xs ${
          testResult.ok
            ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-300"
            : "border-rose-500/30 bg-rose-500/5 text-rose-700 dark:text-rose-300"
        }`}>
          {testResult.message}
        </div>
      )}
    </div>
  );
}

// Sandbox management section — reset, restart, and list running sandboxes.
// Reset kills the current sandbox (files lost). Restart creates a new sandbox
// and restores files from the local OPFS backup. List shows all running
// sandboxes on the E2B account.
function SandboxManagementSection() {
  const { user } = useAuth();
  const [sandboxKey, setSandboxKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [sandboxes, setSandboxes] = useState<Array<{ sandboxID: string; startedAt: string; state?: string; templateID?: string }>>([]);
  const [result, setResult] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    void (async () => {
      try {
        const key = await settingsService.getDecryptedSandboxKey(user.id);
        setSandboxKey(key);
      } catch {
        // ignore
      } finally {
        setLoading(false);
      }
    })();
  }, [user]);

  const fetchSandboxes = async () => {
    if (!sandboxKey) return;
    setActionLoading(true);
    try {
      const { E2BClient } = await import("@/lib/e2b/client");
      const items = await E2BClient.listSandboxes(sandboxKey);
      setSandboxes(items);
      setResult(`Found ${items.length} running sandbox${items.length === 1 ? "" : "es"}`);
    } catch (err) {
      setResult(`❌ Failed to list sandboxes: ${err instanceof Error ? err.message : "Unknown"}`);
    } finally {
      setActionLoading(false);
    }
  };

  const handleReset = async () => {
    if (!sandboxKey) return;
    setActionLoading(true);
    try {
      const { getE2BClient } = await import("@/lib/e2b/client");
      const client = getE2BClient(sandboxKey, null, "shared");
      const killed = await client.reset();
      setResult(`✅ Sandbox reset${killed ? ` (killed ${killed})` : ""}. Next operation will create a fresh sandbox.`);
      // Evict all cached clients so the next call creates a new one.
      const { evictAllE2BClients } = await import("@/lib/e2b/client");
      evictAllE2BClients();
    } catch (err) {
      setResult(`❌ Reset failed: ${err instanceof Error ? err.message : "Unknown"}`);
    } finally {
      setActionLoading(false);
    }
  };

  const handleRestart = async () => {
    if (!sandboxKey) return;
    setActionLoading(true);
    try {
      const { getE2BClient } = await import("@/lib/e2b/client");
      const client = getE2BClient(sandboxKey, null, "shared");
      // First, backup files from the current sandbox to OPFS.
      let backupFiles: Array<{ path: string; content: string }> = [];
      try {
        const backup = await client.backupFiles();
        backupFiles = backup.files;
        // Save backup to OPFS for persistence.
        const { writeFile } = await import("@/lib/storage/opfs");
        const userId = useAuthStore.getState().user?.id;
        if (userId) {
          await writeFile(userId, "backups", "sandbox-backup.json", JSON.stringify(backupFiles));
        }
      } catch {
        // backup failed — restart without restore
      }
      // Evict cached clients so the restart creates a fresh one.
      const { evictAllE2BClients } = await import("@/lib/e2b/client");
      evictAllE2BClients();
      // Restart with backup restore.
      const newClient = getE2BClient(sandboxKey, null, "shared");
      const result = await newClient.restart(backupFiles);
      setResult(`✅ Sandbox restarted (new ID: ${result.sandboxId.slice(0, 12)}…, ${result.restored} files restored)`);
    } catch (err) {
      setResult(`❌ Restart failed: ${err instanceof Error ? err.message : "Unknown"}`);
    } finally {
      setActionLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading…
      </div>
    );
  }

  if (!sandboxKey) {
    return (
      <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
        <AlertTriangle className="h-3.5 w-3.5" />
        <span>No E2B sandbox key configured. Add one in the E2B Sandbox section above.</span>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" onClick={handleReset} disabled={actionLoading}>
          {actionLoading ? <Loader2 className="h-4 w-4 animate-spin mr-1.5" /> : <Trash2 className="h-4 w-4 mr-1.5" />}
          Reset sandbox
        </Button>
        <Button size="sm" variant="outline" onClick={handleRestart} disabled={actionLoading}>
          {actionLoading ? <Loader2 className="h-4 w-4 animate-spin mr-1.5" /> : <RefreshCw className="h-4 w-4 mr-1.5" />}
          Restart sandbox
        </Button>
        <Button size="sm" variant="outline" onClick={fetchSandboxes} disabled={actionLoading}>
          {actionLoading ? <Loader2 className="h-4 w-4 animate-spin mr-1.5" /> : <Server className="h-4 w-4 mr-1.5" />}
          List sandboxes
        </Button>
      </div>

      {result && (
        <div className="rounded-md border border-border bg-muted/50 px-3 py-2 text-xs">
          {result}
        </div>
      )}

      {sandboxes.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-muted-foreground">Running sandboxes:</p>
          <div className="space-y-1 max-h-48 overflow-y-auto scrollbar-thin">
            {sandboxes.map((sb) => (
              <div key={sb.sandboxID} className="flex items-center justify-between rounded-md border border-border bg-card px-2.5 py-1.5 text-xs">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="shrink-0 h-2 w-2 rounded-full bg-emerald-500" />
                  <span className="font-mono truncate">{sb.sandboxID}</span>
                </div>
                <div className="flex items-center gap-2 shrink-0 text-muted-foreground">
                  <span>{sb.state ?? "running"}</span>
                  <span>·</span>
                  <span>{new Date(sb.startedAt).toLocaleString()}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <AlertTriangle className="h-3.5 w-3.5" />
        <span>
          <strong>Reset</strong> kills the sandbox (files lost). <strong>Restart</strong> creates a new sandbox
          and restores files from local backup. <strong>List</strong> shows all running sandboxes on your E2B account.
        </span>
      </div>
    </div>
  );
}

// Data management section — export/import all local data (OPFS files +
// IndexedDB conversations/settings/skills) as a JSON file.
function DataManagementSection() {
  const { user } = useAuth();
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleExport = async () => {
    if (!user) return;
    setExporting(true);
    try {
      const { db } = await import("@/lib/db");
      const opfs = await import("@/lib/storage/opfs");

      // Collect all IndexedDB tables for this user.
      const data: Record<string, unknown> = {
        exportedAt: new Date().toISOString(),
        userId: user.id,
        conversations: [],
        messages: [],
        aiProviders: [],
        userSettings: [],
        skills: [],
        files: [],
      };

      try { data.conversations = await db.conversations.where("user_id").equals(user.id).toArray(); } catch {}
      try { data.messages = await db.messages.where("conversation_id").anyOf(
        (data.conversations as Array<{ id: string }>).map((c) => c.id)
      ).toArray(); } catch {}
      try { data.aiProviders = await db.ai_providers.where("user_id").equals(user.id).toArray(); } catch {}
      try { data.userSettings = await db.user_settings.where("user_id").equals(user.id).toArray(); } catch {}
      try { data.skills = await db.skills.where("user_id").equals(user.id).toArray(); } catch {}
      try { data.files = await db.chat_files.where("user_id").equals(user.id).toArray(); } catch {}

      // Collect all OPFS workspace files.
      const opfsFiles: Array<{ path: string; content: string }> = [];
      try {
        const dir = await opfs.ensurePath(user.id, "workspace");
        const walked = await opfs.walkFiles(dir);
        for (const f of walked) {
          try {
            const file = await f.handle.getFile();
            // No size limit — back up all files
            if (true) {
              const text = await file.text();
              opfsFiles.push({ path: f.path, content: text });
            }
          } catch {}
        }
      } catch {}
      data.opfsFiles = opfsFiles;

      // Download as JSON.
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `agent-chat-export-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.success("Data exported successfully");
    } catch (err) {
      toast.error(`Export failed: ${err instanceof Error ? err.message : "Unknown"}`);
    } finally {
      setExporting(false);
    }
  };

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !user) return;
    e.target.value = "";
    setImporting(true);
    try {
      const text = await file.text();
      const data = JSON.parse(text);

      const { db } = await import("@/lib/db");
      const { writeFileAtPath, ensurePath } = await import("@/lib/storage/opfs");

      // Import conversations.
      if (Array.isArray(data.conversations)) {
        for (const conv of data.conversations) {
          try { await db.conversations.put(conv); } catch {}
        }
      }
      // Import messages.
      if (Array.isArray(data.messages)) {
        for (const msg of data.messages) {
          try { await db.messages.put(msg); } catch {}
        }
      }
      // Import AI providers.
      if (Array.isArray(data.aiProviders)) {
        for (const p of data.aiProviders) {
          try { await db.ai_providers.put(p); } catch {}
        }
      }
      // Import user settings.
      if (Array.isArray(data.userSettings)) {
        for (const s of data.userSettings) {
          try { await db.user_settings.put(s); } catch {}
        }
      }
      // Import skills.
      if (Array.isArray(data.skills)) {
        for (const s of data.skills) {
          try { await db.skills.put(s); } catch {}
        }
      }
      // Import OPFS files.
      if (Array.isArray(data.opfsFiles)) {
        for (const f of data.opfsFiles) {
          try {
            const parts = f.path.split("/");
            const filename = parts.pop() || "file";
            const subdir = parts.join("/");
            await ensurePath(user.id, `workspace/${subdir}`);
            await writeFileAtPath(`users/${user.id}/workspace/${subdir}`, filename, f.content);
          } catch {}
        }
      }

      toast.success("Data imported successfully. Refresh the page to see imported data.");
    } catch (err) {
      toast.error(`Import failed: ${err instanceof Error ? err.message : "Invalid JSON file"}`);
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" onClick={handleExport} disabled={exporting}>
          {exporting ? <Loader2 className="h-4 w-4 animate-spin mr-1.5" /> : <Download className="h-4 w-4 mr-1.5" />}
          Export data
        </Button>
        <Button size="sm" variant="outline" onClick={() => fileInputRef.current?.click()} disabled={importing}>
          {importing ? <Loader2 className="h-4 w-4 animate-spin mr-1.5" /> : <Upload className="h-4 w-4 mr-1.5" />}
          Import data
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json,.json"
          onChange={handleImport}
          className="hidden"
        />
      </div>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <AlertTriangle className="h-3.5 w-3.5" />
        <span>
          Export downloads all your data (conversations, files, settings, skills) as a JSON file.
          Import restores from a previously exported file. All files are included in exports (no size limit).
        </span>
      </div>
    </div>
  );
}

// SkillsMP API key section — optional, used for searching + installing
// skills from the SkillsMP marketplace (https://skillsmp.com). Anonymous
// access works for basic search (50 req/day); an API key raises the limit
// to 500 req/day. Stored encrypted in `extra.skillsmp_api_key_encrypted`.
function SkillsMPConfigSection() {
  const { user } = useAuth();
  const [key, setKey] = useState("");
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!user) return;
    void (async () => {
      try {
        const decrypted = await settingsService.getDecryptedSkillsMPApiKey(user.id);
        if (decrypted) setKey("•••••••••••• (saved)");
      } catch {
        // ignore — vault may be locked or no key stored.
      }
    })();
  }, [user]);

  const save = async () => {
    if (!user) return;
    setSaving(true);
    try {
      if (key && !key.startsWith("••••")) {
        await settingsService.setSkillsMPApiKey(user.id, key.trim());
        setKey("•••••••••••• (saved)");
        setSaved(true);
        toast.success("SkillsMP API key saved");
        setTimeout(() => setSaved(false), 2000);
      } else {
        toast.info("Enter a new key to save (existing key kept).");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const clear = async () => {
    if (!user) return;
    setSaving(true);
    try {
      await settingsService.setSkillsMPApiKey(user.id, null);
      setKey("");
      toast.success("SkillsMP API key cleared");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to clear");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <AlertTriangle className="h-3.5 w-3.5" />
        <span>
          Optional — used for searching and installing skills from the
          SkillsMP marketplace. Anonymous access works for basic search
          (50 req/day); an API key raises the limit to 500 req/day. Stored
          encrypted locally. Get a key at{" "}
          <a
            href="https://skillsmp.com"
            target="_blank"
            rel="noopener noreferrer"
            className="text-foreground underline underline-offset-2"
          >
            skillsmp.com
          </a>
          .
        </span>
      </div>
      <FormField label="SkillsMP API key" htmlFor="skillsmp-key">
        <Input
          id="skillsmp-key"
          type="password"
          placeholder="sk_live_skillsmp_…"
          value={key}
          onChange={(e) => setKey(e.target.value)}
        />
      </FormField>
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={save} disabled={saving}>
          {saving ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin mr-1.5" /> Saving…
            </>
          ) : saved ? (
            "Saved ✓"
          ) : (
            "Save"
          )}
        </Button>
        {key && (
          <Button
            size="sm"
            variant="ghost"
            onClick={clear}
            disabled={saving}
            className="text-muted-foreground hover:text-destructive"
          >
            Clear
          </Button>
        )}
      </div>
    </div>
  );
}

// File system mode section — choose local (OPFS) or E2B cloud sandbox.
function FileSystemModeSection() {
  const { user } = useAuth();
  const [mode, setMode] = useState<"auto" | "local" | "hopx">("auto");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!user) return;
    void (async () => {
      try {
        const m = await settingsService.getFileSystemMode(user.id);
        setMode(m);
      } catch {
        // ignore
      } finally {
        setLoading(false);
      }
    })();
  }, [user]);

  const changeMode = async (newMode: "auto" | "local" | "hopx") => {
    if (!user || saving) return;
    setSaving(true);
    setMode(newMode);
    try {
      await settingsService.setFileSystemMode(user.id, newMode);
      toast.success(`File system mode: ${newMode === "auto" ? "Auto (E2B sandbox if available, else local)" : newMode === "local" ? "Local (browser storage)" : "E2B Sandbox (cloud)"}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save");
      setMode(mode); // revert
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="flex items-center gap-2 text-sm text-muted-foreground py-2"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>;
  }

  const options: { value: "auto" | "local" | "hopx"; label: string; description: string }[] = [
    {
      value: "auto",
      label: "Auto",
      description: "Uses the E2B sandbox when an API key is set, otherwise falls back to local browser storage.",
    },
    {
      value: "local",
      label: "Local (browser storage)",
      description: "All files, skills, and configs are stored in your browser's OPFS. No cloud sandbox. Terminal and Python execution won't work — only file read/write/list.",
    },
    {
      value: "hopx",
      label: "E2B Sandbox (cloud)",
      description: "All file ops, terminal, and Python execution run in the E2B cloud sandbox. Requires a valid E2B API key. (The mode is named \"hopx\" in storage for back-compat.)",
    },
  ];

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <AlertTriangle className="h-3.5 w-3.5" />
        <span>
          Controls where the AI's file operations (create, read, write, delete)
          are performed. Local mode works without any API key but can&apos;t run
          shell commands or Python code.
        </span>
      </div>
      <div className="space-y-2">
        {options.map((opt) => (
          <label
            key={opt.value}
            className={cn(
              "flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors",
              mode === opt.value
                ? "border-primary bg-primary/5"
                : "border-border hover:bg-muted/50",
              saving && "pointer-events-none opacity-50",
            )}
          >
            <input
              type="radio"
              name="file-system-mode"
              value={opt.value}
              checked={mode === opt.value}
              onChange={() => changeMode(opt.value)}
              className="mt-1"
            />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-foreground">{opt.label}</div>
              <div className="text-xs text-muted-foreground mt-0.5">{opt.description}</div>
            </div>
          </label>
        ))}
      </div>
    </div>
  );
}


// AI Framework selector — changes the system prompt to match the framework.
function AIFrameworkSection() {
  const { user } = useAuth();
  const [framework, setFramework] = useState("default");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!user) return;
    void (async () => {
      try {
        const f = await settingsService.getAIFramework(user.id);
        setFramework(f);
      } catch {
        // ignore
      } finally {
        setLoading(false);
      }
    })();
  }, [user]);

  const changeFramework = async (newFramework: string) => {
    if (!user || saving) return;
    setSaving(true);
    setFramework(newFramework);
    try {
      await settingsService.setAIFramework(user.id, newFramework);
      const labels: Record<string, string> = {
        default: "Default Assistant",
        pydantic_ai: "PydanticAI",
        langchain: "LangChain",
        crewai: "CrewAI",
        openai_assistants: "OpenAI Assistants",
      };
      toast.success(`Framework: ${labels[newFramework] ?? newFramework}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save");
      setFramework(framework);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="flex items-center gap-2 text-sm text-muted-foreground py-2"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>;
  }

  const frameworks = [
    { value: "default", label: "Default Assistant", description: "Generic helpful AI assistant. No framework-specific behavior." },
    { value: "pydantic_ai", label: "PydanticAI", description: "Type-safe agent with structured tool calls. Precise, validated reasoning. Matches the original backend." },
    { value: "langchain", label: "LangChain", description: "ReAct pattern: Think → Act → Observe → Answer. Chain tool calls with transparent reasoning." },
    { value: "openai_assistants", label: "OpenAI Assistants", description: "OpenAI Assistants API conventions. Function calling, clear structured responses." },
    { value: "crewai", label: "CrewAI", description: "Role-based crew agent. Focused on specific tasks (research, analyze, create, execute)." },
  ];

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <AlertTriangle className="h-3.5 w-3.5" />
        <span>
          The framework preset changes the system prompt to match the
          framework&apos;s conventions. Applies on the next chat turn — no
          reset needed. Your custom system prompt (if enabled) overrides this.
        </span>
      </div>
      <div className="space-y-2">
        {frameworks.map((fw) => (
          <label
            key={fw.value}
            className={cn(
              "flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors",
              framework === fw.value
                ? "border-primary bg-primary/5"
                : "border-border hover:bg-muted/50",
              saving && "pointer-events-none opacity-50",
            )}
          >
            <input
              type="radio"
              name="ai-framework"
              value={fw.value}
              checked={framework === fw.value}
              onChange={() => changeFramework(fw.value)}
              className="mt-1"
            />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-foreground">{fw.label}</div>
              <div className="text-xs text-muted-foreground mt-0.5">{fw.description}</div>
            </div>
          </label>
        ))}
      </div>
    </div>
  );
}

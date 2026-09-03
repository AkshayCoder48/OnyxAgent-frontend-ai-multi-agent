"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import {
  ArrowRight,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

import { Badge, Button, Input } from "@/components/ui";
import { SectionCard } from "@/components/settings/settings-section";
import { useAuth } from "@/hooks";
import { settingsService } from "@/lib/services";
import { ROUTES } from "@/lib/constants";
import { cn } from "@/lib/utils";

/**
 * Centralized API Keys settings (PRD §11).
 *
 * Every non-provider credential the app actually uses lives here:
 *   - E2B Sandbox key (required for sandbox features)
 *   - LangSearch key (optional — enhanced web search)
 *   - SkillsMP key (optional — skill marketplace rate limits)
 *
 * Model provider keys stay on /settings/config (managed per provider).
 * Keys are stored encrypted in the local vault; values are never logged.
 */

type KeyField = "e2b" | "langsearch" | "skillsmp";

interface KeyRowConfig {
  field: KeyField;
  title: string;
  /** Badge label — "Required for sandbox features" vs "Optional". */
  badge: string;
  required: boolean;
  description: ReactNode;
  placeholder: string;
  /** Whether the stored key can be cleared from this page. */
  clearable: boolean;
}

const KEY_ROWS: KeyRowConfig[] = [
  {
    field: "e2b",
    title: "E2B Sandbox API key",
    badge: "Required for sandbox features",
    required: true,
    description: (
      <>
        Routes code execution (Python, terminal) through the E2B cloud sandbox.
        Get a key at{" "}
        <a
          href="https://e2b.dev"
          target="_blank"
          rel="noopener noreferrer"
          className="text-foreground underline underline-offset-2"
        >
          e2b.dev
        </a>
        . Stored encrypted locally.
      </>
    ),
    placeholder: "e2b_…",
    clearable: true,
  },
  {
    field: "langsearch",
    title: "LangSearch API key",
    badge: "Optional",
    required: false,
    description: (
      <>
        When set, <code className="font-mono">web_search</code> uses LangSearch&apos;s
        hybrid API for richer summaries; falls back to Miklium when blank or on
        error. Get a key at{" "}
        <a
          href="https://langsearch.com"
          target="_blank"
          rel="noopener noreferrer"
          className="text-foreground underline underline-offset-2"
        >
          langsearch.com
        </a>
        .
      </>
    ),
    placeholder: "sk-…",
    clearable: false,
  },
  {
    field: "skillsmp",
    title: "SkillsMP API key",
    badge: "Optional",
    required: false,
    description: (
      <>
        Used for searching and installing skills from the SkillsMP marketplace.
        Anonymous access works for basic search (50 req/day); a key raises the
        limit to 500 req/day. Get a key at{" "}
        <a
          href="https://skillsmp.com"
          target="_blank"
          rel="noopener noreferrer"
          className="text-foreground underline underline-offset-2"
        >
          skillsmp.com
        </a>
        .
      </>
    ),
    placeholder: "sk_live_skillsmp_…",
    clearable: true,
  },
];

export default function ApiKeysSettingsPage() {
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [values, setValues] = useState<Record<KeyField, string>>({
    e2b: "",
    langsearch: "",
    skillsmp: "",
  });
  const [revealed, setRevealed] = useState<Record<KeyField, boolean>>({
    e2b: false,
    langsearch: false,
    skillsmp: false,
  });
  const [hasKey, setHasKey] = useState<Record<KeyField, boolean>>({
    e2b: false,
    langsearch: false,
    skillsmp: false,
  });
  const [savingField, setSavingField] = useState<KeyField | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const [settings, e2bKey] = await Promise.all([
        settingsService.get(user.id),
        settingsService.getDecryptedSandboxKey(user.id),
      ]);
      // localStorage copy is a legacy fallback for offline / single-instance
      // dev sessions — surface it so the user can migrate it into the vault.
      const storedLocal =
        typeof window !== "undefined" ? window.localStorage.getItem("e2b_api_key") : null;
      setValues((v) => ({ ...v, e2b: !e2bKey && storedLocal ? storedLocal : "" }));
      setHasKey({
        e2b: !!e2bKey,
        langsearch: !!settings.langsearch_api_key_present,
        skillsmp: !!settings.skillsmp_api_key_present,
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load keys");
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    void load();
  }, [load]);

  const setValue = (field: KeyField, value: string) =>
    setValues((v) => ({ ...v, [field]: value }));

  const toggleReveal = (field: KeyField) =>
    setRevealed((r) => ({ ...r, [field]: !r[field] }));

  const save = async (field: KeyField) => {
    if (!user) return;
    const raw = values[field];
    const key = raw.trim();
    if (!key) {
      toast.error("Enter a key first — leave the field untouched to keep an existing one");
      return;
    }
    setSavingField(field);
    try {
      if (field === "e2b") {
        await settingsService.setSandboxKey(user.id, key);
        // Keep the legacy localStorage copy in sync (offline fallback) and
        // drop any cached sandbox clients so the next turn uses the new key
        // immediately — no reload needed.
        if (typeof window !== "undefined") {
          window.localStorage.setItem("e2b_api_key", key);
        }
        try {
          const { evictAllE2BClients } = await import("@/lib/e2b/client");
          evictAllE2BClients();
        } catch {
          // Sandbox client module unavailable — the runtime re-reads the key
          // from the vault on every turn anyway.
        }
        toast.success("E2B Sandbox key saved");
      } else if (field === "langsearch") {
        await settingsService.setLangSearchKey(user.id, key);
        toast.success("LangSearch API key saved");
      } else {
        await settingsService.setSkillsMPApiKey(user.id, key);
        toast.success("SkillsMP API key saved");
      }
      setHasKey((h) => ({ ...h, [field]: true }));
      setValue(field, "");
      setRevealed((r) => ({ ...r, [field]: false }));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSavingField(null);
    }
  };

  const clear = async (field: KeyField) => {
    if (!user) return;
    setSavingField(field);
    try {
      if (field === "e2b") {
        await settingsService.setSandboxKey(user.id, null);
        if (typeof window !== "undefined") {
          window.localStorage.removeItem("e2b_api_key");
        }
        try {
          const { evictAllE2BClients } = await import("@/lib/e2b/client");
          evictAllE2BClients();
        } catch {
          // best-effort — the next turn re-reads the key anyway
        }
        setHasKey((h) => ({ ...h, e2b: false }));
        toast.success("E2B key cleared — sandbox features fall back to the server key when configured");
      } else if (field === "skillsmp") {
        await settingsService.setSkillsMPApiKey(user.id, null);
        setHasKey((h) => ({ ...h, skillsmp: false }));
        setValue("skillsmp", "");
        toast.success("SkillsMP API key cleared");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to clear");
    } finally {
      setSavingField(null);
    }
  };

  /** Validate the E2B key by listing running sandboxes (same call the old
   *  Config section used — browser-safe, goes through the server proxy). */
  const testE2B = async () => {
    if (!user) return;
    setTesting(true);
    setTestResult(null);
    try {
      let apiKey = values.e2b.trim();
      if (!apiKey) {
        const decrypted = await settingsService.getDecryptedSandboxKey(user.id);
        apiKey = decrypted ?? "";
      }
      if (!apiKey) {
        setTestResult({ ok: false, message: "No API key to test. Save a key first." });
        return;
      }
      const { E2BClient } = await import("@/lib/e2b/client");
      const items = await E2BClient.listSandboxes(apiKey);
      const runningCount = items.length;
      const oldest = items.length > 0
        ? [...items].sort((a, b) => (a.startedAt ?? "").localeCompare(b.startedAt ?? ""))[0]
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
      const displayMsg = /auth|401|403|invalid/i.test(msg)
        ? "Invalid API key — check the key at https://e2b.dev"
        : msg;
      setTestResult({ ok: false, message: `❌ ${displayMsg}` });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <KeyRound className="h-6 w-6" />
          API Keys
        </h1>
        <p className="text-muted-foreground mt-1">
          Credentials for the sandbox, web search, and skill marketplace —
          stored encrypted in your local vault. Blank fields keep the existing
          key.
        </p>
      </div>

      <SectionCard
        title="Application keys"
        description="Keys the app itself uses. Each is saved separately; values are masked and never logged."
      >
        {loading ? (
          <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {KEY_ROWS.map((row) => (
              <li key={row.field} className="py-4 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm font-medium">{row.title}</p>
                  {hasKey[row.field] ? (
                    <Badge variant="secondary" className="text-[10px]">saved</Badge>
                  ) : null}
                  <Badge
                    variant={row.required ? "default" : "outline"}
                    className={cn("text-[10px]", !row.required && "text-muted-foreground")}
                  >
                    {row.badge}
                  </Badge>
                </div>
                <p className="text-muted-foreground mt-0.5 text-xs leading-relaxed">
                  {row.description}
                </p>
                <div className="mt-2.5 flex flex-wrap items-center gap-2">
                  <div className="relative min-w-0 flex-1 basis-64">
                    <Input
                      id={`api-key-${row.field}`}
                      type={revealed[row.field] ? "text" : "password"}
                      value={values[row.field]}
                      onChange={(e) => setValue(row.field, e.target.value)}
                      placeholder={
                        hasKey[row.field] && !values[row.field]
                          ? "•••••••••••• (saved — enter a new key to replace)"
                          : row.placeholder
                      }
                      autoComplete="off"
                      className="pr-10 font-mono"
                    />
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="absolute right-1 top-1/2 h-7 w-7 -translate-y-1/2 p-0 text-muted-foreground"
                      onClick={() => toggleReveal(row.field)}
                      aria-label={revealed[row.field] ? "Hide key" : "Show key"}
                      title={revealed[row.field] ? "Hide" : "Show"}
                    >
                      {revealed[row.field] ? (
                        <EyeOff className="h-3.5 w-3.5" />
                      ) : (
                        <Eye className="h-3.5 w-3.5" />
                      )}
                    </Button>
                  </div>
                  <Button
                    size="sm"
                    onClick={() => void save(row.field)}
                    disabled={savingField === row.field}
                  >
                    {savingField === row.field ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin mr-1.5" /> Saving…
                      </>
                    ) : (
                      "Save"
                    )}
                  </Button>
                  {row.field === "e2b" && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void testE2B()}
                      disabled={testing}
                    >
                      {testing ? (
                        <>
                          <Loader2 className="h-4 w-4 animate-spin mr-1.5" /> Testing…
                        </>
                      ) : (
                        "Test API Key"
                      )}
                    </Button>
                  )}
                  {row.clearable && hasKey[row.field] && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void clear(row.field)}
                      disabled={savingField === row.field}
                      className="text-muted-foreground hover:text-destructive"
                    >
                      <Trash2 className="h-3.5 w-3.5 mr-1" />
                      Clear
                    </Button>
                  )}
                </div>
                {row.field === "e2b" && testResult && (
                  <div
                    className={`mt-2.5 rounded-md border px-3 py-2 text-xs ${
                      testResult.ok
                        ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-300"
                        : "border-rose-500/30 bg-rose-500/5 text-rose-700 dark:text-rose-300"
                    }`}
                  >
                    {testResult.message}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      {/* Model provider keys live per provider in Agent → Config */}
      <div className="rounded-xl border border-dashed border-foreground/15 bg-muted/30 p-4">
        <p className="text-sm font-medium">Model provider keys</p>
        <p className="text-muted-foreground mt-0.5 text-xs leading-relaxed">
          Model provider keys (OpenAI-compatible, Anthropic, etc.) are managed
          per provider in Agent → Config, where each provider stores its own
          base URL, models, and encrypted key.
        </p>
        <Button asChild size="sm" variant="outline" className="mt-3">
          <Link href={ROUTES.SETTINGS_CONFIG}>
            Manage providers in Config
            <ArrowRight className="h-3.5 w-3.5 ml-1" />
          </Link>
        </Button>
      </div>
    </div>
  );
}

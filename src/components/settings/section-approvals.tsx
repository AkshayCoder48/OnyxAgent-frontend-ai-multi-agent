"use client";

/**
 * Settings → Tools: APPROVALS (Task 2-d / PRD §8.2 + §13.5) — two panels:
 *
 *  1. Global policy editor — a searchable, grouped, per-tool TRI-STATE
 *     (Allowed / Approval required / Denied) over the registered tool
 *     surface. Defaults come from the argument-aware
 *     SENSITIVE_TOOL_DEFAULTS; explicit user entries persist via 1-a's
 *     setGlobalPolicy (user_settings.extra.approval_policies) and REPLACE
 *     the default for that tool (a project can still tighten further, never
 *     loosen — resolvePermission's strictest-wins).
 *
 *  2. Approval queue — every approval_request row (all statuses with
 *     badges, timestamps, tool, operation, a link to the source
 *     conversation, and the result summary when present) plus a
 *     "Sweep expired" button (sweepExpired transitions stale pending rows).
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Ban,
  Clock,
  ExternalLink,
  Loader2,
  Lock,
  RefreshCw,
  Search,
  ShieldCheck,
  ShieldQuestion,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SectionCard } from "@/components/settings/settings-section";
import { useAuth } from "@/hooks";
import { useConversationStore } from "@/stores";
// Side-effect: registers every built-in tool with the central registry.
import "@/lib/tools";
import { listTools, type ToolDefinition } from "@/lib/tools/registry";
import { loadDynamicTools } from "@/lib/tools/dynamic_tools";
import {
  defaultPermissionFor,
  loadGlobalPolicy,
  PERMISSION_LABELS,
  setGlobalPolicy,
  SENSITIVE_TOOL_DEFAULTS,
  type ResourcePermission,
} from "@/lib/projects/permissions";
import { listApprovals, sweepExpired } from "@/lib/projects/approvals";
import { db } from "@/lib/db";
import { cn, timeAgo } from "@/lib/utils";
import type { ApprovalRequest, ApprovalStatus } from "@/types";

// ---------------------------------------------------------------------------
// Policy editor
// ---------------------------------------------------------------------------

type ToolGroup = "built-in" | "mcp" | "composio";

function groupOfTool(name: string): ToolGroup {
  if (name.startsWith("composio_")) return "composio";
  if (name.startsWith("mcp_")) return "mcp";
  return "built-in";
}

const GROUP_LABELS: Record<ToolGroup, string> = {
  "built-in": "Built-in tools",
  mcp: "MCP tools",
  composio: "Composio connector",
};

/** The tri-state select's value space — "default" means "no explicit entry"
 * (fall back to the argument-aware default). */
type PolicySelectValue = "default" | ResourcePermission;

function permissionBadgeClass(permission: ResourcePermission): string {
  if (permission === "denied") return "border-destructive/40 text-destructive";
  if (permission === "approval_required") return "border-amber-500/40 text-amber-600 dark:text-amber-400";
  return "border-emerald-500/40 text-emerald-600 dark:text-emerald-400";
}

function PolicyEditor({ userId }: { userId: string }) {
  const [search, setSearch] = useState("");
  const [groupFilter, setGroupFilter] = useState<ToolGroup | "all">("all");
  const [policy, setPolicy] = useState<Record<string, ResourcePermission>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tools, setTools] = useState<ToolDefinition[]>([]);

  // Enumerate the registered surface (built-ins by import side effect;
  // custom tools honestly loaded from IndexedDB so the user can policy
  // their own tools too).
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        await loadDynamicTools(userId);
      } catch {
        // Non-fatal — built-ins still list.
      }
      if (alive) setTools(listTools());
    })();
    return () => {
      alive = false;
    };
  }, [userId]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const loaded = await loadGlobalPolicy(userId);
        if (alive) setPolicy(loaded);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed to load approval policies");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [userId]);

  const changePolicy = useCallback(
    async (toolName: string, value: PolicySelectValue) => {
      setSaving(toolName);
      try {
        // null REMOVES the explicit entry → the argument-aware default
        // applies again (saveGlobalPolicy's merge semantics).
        const next = await setGlobalPolicy({
          [toolName]: value === "default" ? null : value,
        });
        setPolicy(next);
        toast.success(
          value === "default"
            ? `${toolName} reset to its default policy`
            : `${toolName} set to "${PERMISSION_LABELS[value as ResourcePermission]}"`,
        );
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed to save the policy");
      } finally {
        setSaving(null);
      }
    },
    [],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return tools.filter((t) => {
      if (groupFilter !== "all" && groupOfTool(t.name) !== groupFilter) return false;
      if (!q) return true;
      return (
        t.name.toLowerCase().includes(q) ||
        (t.description ?? "").toLowerCase().includes(q)
      );
    });
  }, [tools, search, groupFilter]);

  const grouped = useMemo(() => {
    const out: Record<ToolGroup, ToolDefinition[]> = {
      "built-in": [],
      mcp: [],
      composio: [],
    };
    for (const t of filtered) out[groupOfTool(t.name)].push(t);
    return out;
  }, [filtered]);

  const explicitCount = Object.keys(policy).length;

  return (
    <SectionCard
      title="Approval policies"
      description={`Per-tool permissions applied to every conversation. Approval-required tools pause for your explicit approval before running; denied tools never run. Projects can tighten these rules further but never loosen them. ${
        explicitCount > 0 ? `${explicitCount} explicit override${explicitCount === 1 ? "" : "s"} active.` : ""
      }`}
    >
      <div className="space-y-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search tools…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9"
              aria-label="Search tools in the policy list"
            />
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {(["all", "built-in", "mcp", "composio"] as const).map((g) => (
              <button
                key={g}
                type="button"
                onClick={() => setGroupFilter(g)}
                className={cn(
                  "inline-flex h-8 items-center rounded-full border px-3 text-xs font-medium transition-colors",
                  groupFilter === g
                    ? "border-primary/50 bg-primary/10 text-primary"
                    : "border-border text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                )}
              >
                {g === "all" ? "All" : GROUP_LABELS[g]}
              </button>
            ))}
          </div>
        </div>

        {/* Sensitive-by-default note — the argument-aware defaults. */}
        <p className="rounded-lg border border-amber-500/30 bg-amber-500/[0.05] px-3 py-2 text-xs leading-relaxed text-amber-700 dark:text-amber-400">
          Default policy: <strong>Composio execution</strong> (
          {SENSITIVE_TOOL_DEFAULTS.composioExecute.tools.join(", ")}),{" "}
          <strong>environment-variable writes</strong> ({" "}
          {SENSITIVE_TOOL_DEFAULTS.envVarWrites.writeActions
            .map((a) => `manage_env_var ${a}`)
            .join(", ")}
          ) and <strong>sandbox file/folder deletion</strong> (
          {SENSITIVE_TOOL_DEFAULTS.e2bDeletes.tools.join(", ")}) require
          approval. Everything else is allowed by default.
        </p>

        {loading ? (
          <div className="flex items-center justify-center py-10">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="rounded-xl border border-dashed border-foreground/15 p-6 text-center text-sm text-muted-foreground">
            No tools match your search.
          </div>
        ) : (
          <div className="max-h-[28rem] space-y-5 overflow-y-auto scrollbar-thin pr-1">
            {(Object.keys(grouped) as ToolGroup[]).map((group) => {
              const items = grouped[group];
              if (items.length === 0) return null;
              return (
                <div key={group}>
                  <p className="mb-2 font-mono text-[10px] tracking-wider text-muted-foreground uppercase">
                    {GROUP_LABELS[group]} ({items.length})
                  </p>
                  <div className="grid gap-2">
                    {items.map((tool) => {
                      const explicit = policy[tool.name];
                      const effective: ResourcePermission =
                        explicit ?? defaultPermissionFor(tool.name, null);
                      const value: PolicySelectValue = explicit ?? "default";
                      const isSaving = saving === tool.name;
                      return (
                        <div
                          key={tool.name}
                          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/70 bg-background/50 px-3 py-2"
                        >
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-mono text-xs font-medium">
                                {tool.name}
                              </span>
                              <Badge
                                variant="outline"
                                className={cn("text-[10px]", permissionBadgeClass(effective))}
                              >
                                {effective === "approval_required" ? (
                                  <Lock className="mr-1 h-2.5 w-2.5" />
                                ) : effective === "denied" ? (
                                  <Ban className="mr-1 h-2.5 w-2.5" />
                                ) : (
                                  <ShieldCheck className="mr-1 h-2.5 w-2.5" />
                                )}
                                {explicit ? PERMISSION_LABELS[explicit] : `Default · ${PERMISSION_LABELS[effective]}`}
                              </Badge>
                            </div>
                            <p className="mt-0.5 line-clamp-1 text-[11px] text-muted-foreground">
                              {tool.description || "No description"}
                            </p>
                          </div>
                          <Select
                            value={value}
                            onValueChange={(v) => void changePolicy(tool.name, v as PolicySelectValue)}
                            disabled={isSaving}
                          >
                            <SelectTrigger
                              className="h-8 w-[13.5rem] shrink-0 text-xs"
                              aria-label={`Permission for ${tool.name}`}
                            >
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="default">
                                Default (argument-aware)
                              </SelectItem>
                              <SelectItem value="allowed">Allowed</SelectItem>
                              <SelectItem value="approval_required">
                                Approval required
                              </SelectItem>
                              <SelectItem value="denied">Denied</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </SectionCard>
  );
}

// ---------------------------------------------------------------------------
// Approval queue
// ---------------------------------------------------------------------------

const STATUS_META: Record<ApprovalStatus, { label: string; className: string }> = {
  pending: { label: "Pending", className: "border-amber-500/40 text-amber-600 dark:text-amber-400" },
  approved: { label: "Approved", className: "border-emerald-500/40 text-emerald-600 dark:text-emerald-400" },
  rejected: { label: "Rejected", className: "border-destructive/40 text-destructive" },
  cancelled: { label: "Cancelled", className: "border-foreground/25 text-muted-foreground" },
  expired: { label: "Expired", className: "border-foreground/25 text-muted-foreground" },
  completed: { label: "Completed", className: "border-emerald-500/40 text-emerald-600 dark:text-emerald-400" },
  failed: { label: "Failed", className: "border-destructive/40 text-destructive" },
};

function ApprovalQueue() {
  const [rows, setRows] = useState<ApprovalRequest[]>([]);
  const [titles, setTitles] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [sweeping, setSweeping] = useState(false);
  const router = useRouter();

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      // Sweep lazily on every render of the queue — stale pending rows
      // transition to expired before they're shown (PRD §13.5).
      await sweepExpired().catch(() => 0);
      const list = await listApprovals();
      setRows(list);
      // Source conversation titles (honest links — no fabricated names).
      const ids = [...new Set(list.map((r) => r.conversation_id))];
      const titleMap: Record<string, string> = {};
      for (const id of ids) {
        const conv = await db.conversations.get(id).catch(() => null);
        titleMap[id] = conv?.title ?? "";
      }
      setTitles(titleMap);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load the approval queue");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const openConversation = (conversationId: string) => {
    // Same navigation the project drawer uses: select the conversation in
    // the shared store, then show the chat.
    useConversationStore.getState().selectConversation(conversationId, { loading: true });
    router.push("/chat");
  };

  const handleSweep = async () => {
    setSweeping(true);
    try {
      const swept = await sweepExpired();
      if (swept > 0) {
        toast.success(`Swept ${swept} expired request${swept === 1 ? "" : "s"}`);
      } else {
        toast.info("No expired approvals to sweep");
      }
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Sweep failed");
    } finally {
      setSweeping(false);
    }
  };

  return (
    <SectionCard
      title="Approval queue"
      description="Every approval request this app has recorded — pending decisions, approved and rejected operations, expired requests — with the outcome summary when the operation ran."
      action={
        <div className="flex items-center gap-1.5">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void refresh()}
            disabled={loading || sweeping}
            title="Refresh the queue"
          >
            <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
          </Button>
          <Button variant="outline" size="sm" onClick={() => void handleSweep()} disabled={sweeping}>
            {sweeping ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Clock className="mr-2 h-4 w-4" />}
            Sweep expired
          </Button>
        </div>
      }
    >
      {loading && rows.length === 0 ? (
        <div className="flex items-center justify-center py-10">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-foreground/15 p-8 text-center">
          <ShieldQuestion className="mx-auto mb-3 h-8 w-8 text-muted-foreground" />
          <p className="font-medium">No approval requests yet</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
            When the agent calls a tool marked{" "}
            <em>approval required</em>, the request pauses here (and in its
            chat) until you approve or reject it.
          </p>
        </div>
      ) : (
        <div className="max-h-96 space-y-2 overflow-y-auto scrollbar-thin pr-1">
          {rows.map((row) => {
            const meta = STATUS_META[row.status] ?? STATUS_META.pending!;
            return (
              <div
                key={row.id}
                className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-border/70 bg-background/50 px-3 py-2.5"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline" className={cn("text-[10px]", meta.className)}>
                      {meta.label}
                    </Badge>
                    <span className="text-xs font-medium">{row.operation_type}</span>
                    <span className="font-mono text-[10px] text-muted-foreground">
                      {row.tool_name}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => openConversation(row.conversation_id)}
                    className="mt-1 inline-flex min-h-6 items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
                    title="Open the source conversation"
                  >
                    <ExternalLink className="h-3 w-3 shrink-0" aria-hidden />
                    {titles[row.conversation_id] || row.conversation_id.slice(0, 12)}
                  </button>
                  {row.result_summary && (
                    <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-muted-foreground">
                      {row.result_summary}
                    </p>
                  )}
                </div>
                <span className="shrink-0 text-[10px] text-muted-foreground" title={row.created_at}>
                  {timeAgo(row.created_at)}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </SectionCard>
  );
}

// ---------------------------------------------------------------------------
// The section (mounted by the Settings → Tools page)
// ---------------------------------------------------------------------------

export function SectionApprovals() {
  const { user } = useAuth();
  if (!user) {
    return (
      <SectionCard
        title="Approvals"
        description="Sign in to manage approval policies and the approval queue."
      >
        <p className="py-4 text-center text-sm text-muted-foreground">
          Not signed in.
        </p>
      </SectionCard>
    );
  }
  return (
    <div className="space-y-6">
      <PolicyEditor userId={user.id} />
      <ApprovalQueue />
    </div>
  );
}

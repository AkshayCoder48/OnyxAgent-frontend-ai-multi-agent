"use client";

import { useMemo } from "react";
import Link from "next/link";
import { ArrowUpRight, Building2, Users } from "lucide-react";
import type { ToolCall } from "@/types";

/**
 * manage_business tool results — the Business Mode payload beneath the
 * narration line (same slot as the memory/KB chips). ONE compact
 * presentation per result family, never one card per internal op:
 *
 *  - create / create_from_template / get / status → a business card:
 *    name + status badge + agent chips + an "Open" link to /business/{id}
 *  - list   → compact business rows (each linking to its workspace)
 *  - update → a one-line summary of the updated fields + link
 *  - manage_agents → the touched agent (name · role) + link
 *  - delete → nothing (the narration line says it; there is nothing to open)
 *
 * Parsing is tolerant: the result may be a parsed object or a JSON string
 * (memory.tsx / knowledge-base.tsx pattern). Errors and unusable payloads
 * render nothing — the raw view still shows the exact result.
 */

/** One agent chip on the business card (name + optional role). */
export interface ManageBusinessAgentChip {
  name: string;
  role?: string;
}

/** One business row in a list result. */
export interface ManageBusinessRow {
  businessId: string;
  name: string;
  status: string;
  agentCount: number;
  url: string;
}

/** The parsed manage_business result (null when there is nothing to show). */
export interface ParsedManageBusinessResult {
  kind: "business" | "list" | "agent" | "update";
  businessId?: string;
  url?: string;
  name?: string;
  status?: string;
  agents: ManageBusinessAgentChip[];
  /** manage_agents: add | update | remove. */
  agentOp?: string;
  /** update: the fields that changed. */
  updatedFields?: string[];
  /** list: the user's businesses. */
  businesses?: ManageBusinessRow[];
}

/** Coerce a tool result into a plain object (object | JSON-string | null). */
function resultObject(toolCall: ToolCall): Record<string, unknown> | null {
  const result = toolCall.result;
  if (result == null) return null;
  if (typeof result === "object") return result as Record<string, unknown>;
  if (typeof result === "string") {
    try {
      const parsed: unknown = JSON.parse(result);
      if (typeof parsed === "object" && parsed !== null) return parsed as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  return null;
}

/** Roster from a get/status agents array ([{name, role, status…}]). */
function rosterOf(v: unknown): ManageBusinessAgentChip[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((a): ManageBusinessAgentChip | null => {
      if (typeof a !== "object" || a === null) return null;
      const row = a as Record<string, unknown>;
      const name = typeof row.name === "string" ? row.name : null;
      if (!name) return null;
      const role = typeof row.role === "string" && row.role ? row.role : undefined;
      return { name, role };
    })
    .filter((c): c is ManageBusinessAgentChip => c !== null);
}

/** Parse a manage_business tool result into a renderable payload. */
export function parseManageBusinessResult(toolCall: ToolCall): ParsedManageBusinessResult | null {
  const obj = resultObject(toolCall);
  if (!obj || obj.error !== undefined || obj.ok !== true) return null;

  const args = (toolCall.args ?? {}) as Record<string, unknown>;
  const action = typeof args.action === "string" ? args.action : "";
  const url = typeof obj.url === "string" && obj.url ? obj.url : null;
  const businessId =
    typeof obj.business_id === "string" && obj.business_id
      ? obj.business_id
      : typeof obj.deleted === "string"
        ? obj.deleted
        : null;

  // list → the businesses array.
  if (Array.isArray(obj.businesses)) {
    const businesses = (obj.businesses as unknown[])
      .map((b): ManageBusinessRow | null => {
        if (typeof b !== "object" || b === null) return null;
        const row = b as Record<string, unknown>;
        const id = typeof row.business_id === "string" ? row.business_id : null;
        const name = typeof row.name === "string" ? row.name : null;
        if (!id || !name) return null;
        return {
          businessId: id,
          name,
          status: typeof row.status === "string" ? row.status : "",
          agentCount: typeof row.agents === "number" ? row.agents : 0,
          url: typeof row.url === "string" && row.url ? row.url : `/business/${id}`,
        };
      })
      .filter((b): b is ManageBusinessRow => b !== null);
    if (businesses.length === 0) return null;
    return { kind: "list", agents: [], businesses };
  }

  // manage_agents → the touched agent + link to the business.
  if (action === "manage_agents") {
    if (!businessId || !url) return null;
    // The result carries name only for "add" — update/remove fall back to
    // the agent name the model passed in the args (never fabricated).
    const argsAgent = args.agent;
    const argName =
      typeof argsAgent === "object" &&
      argsAgent !== null &&
      typeof (argsAgent as Record<string, unknown>).name === "string"
        ? ((argsAgent as Record<string, unknown>).name as string)
        : null;
    const name = typeof obj.name === "string" && obj.name ? obj.name : argName;
    return {
      kind: "agent",
      businessId,
      url,
      name: name ?? undefined,
      agents: [],
      agentOp: typeof obj.action === "string" ? obj.action : undefined,
    };
  }

  // update → the changed fields + link.
  if (action === "update" && businessId && url) {
    const fields = Array.isArray(obj.updated_fields)
      ? (obj.updated_fields as unknown[]).filter((f): f is string => typeof f === "string")
      : [];
    return { kind: "update", businessId, url, agents: [], updatedFields: fields };
  }

  // delete → nothing to open (the narration line covers it).
  if (action === "delete") return null;

  // create / create_from_template / get / status → the business card.
  if (!businessId || !url) return null;
  const name =
    typeof obj.name === "string" && obj.name
      ? obj.name
      : typeof args.name === "string" && args.name
        ? args.name
        : null;
  if (!name) return null;
  // create result: agents: ["Name", …] (strings); get/status result:
  // agents: [{name, role…}] (roster objects).
  const agents = Array.isArray(obj.agents)
    ? obj.agents.length > 0 && typeof obj.agents[0] === "string"
      ? (obj.agents as unknown[]).map((n) => ({ name: typeof n === "string" ? n : String(n) }))
      : rosterOf(obj.agents)
    : [];
  return {
    kind: "business",
    businessId,
    url,
    name,
    status: typeof obj.status === "string" ? obj.status : undefined,
    agents,
  };
}

/** Status badge tint per business status (emerald live · amber warming up ·
 *  muted archived). */
function statusClass(status: string | undefined): string {
  switch (status) {
    case "active":
      return "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400";
    case "setup":
      return "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400";
    default:
      return "border-border bg-muted/50 text-muted-foreground";
  }
}

export function ManageBusinessResult({ toolCall }: { toolCall: ToolCall }) {
  const parsed = useMemo(() => parseManageBusinessResult(toolCall), [toolCall]);
  if (!parsed) return null;

  // ---- list → compact business rows ------------------------------------
  if (parsed.kind === "list" && parsed.businesses) {
    return (
      <div className="px-1.5 py-1 sm:px-2">
        <p className="mb-1.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
          Businesses ({parsed.businesses.length})
        </p>
        <div className="scrollbar-thin max-h-64 overflow-y-auto rounded-lg border border-border bg-foreground/[0.02] p-1">
          {parsed.businesses.map((b) => (
            <Link
              key={b.businessId}
              href={b.url}
              className="group flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-accent/50"
            >
              <Building2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
              <span className="min-w-0 flex-1 truncate text-xs font-medium">{b.name}</span>
              <span className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
                <Users className="h-3 w-3" aria-hidden />
                {b.agentCount}
              </span>
              <span className={`shrink-0 rounded-full border px-1.5 py-px text-[10px] font-medium ${statusClass(b.status)}`}>
                {b.status}
              </span>
              <ArrowUpRight className="h-3 w-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" aria-hidden />
            </Link>
          ))}
        </div>
      </div>
    );
  }

  // ---- manage_agents → the touched agent --------------------------------
  if (parsed.kind === "agent") {
    return (
      <div className="flex min-w-0 items-center gap-2 px-1.5 py-1 sm:px-2">
        <Building2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {parsed.name ? (
            <>
              <span className="font-medium text-foreground">{parsed.name}</span>
              {parsed.agentOp ? ` — agent ${parsed.agentOp}d` : ""}
            </>
          ) : (
            `Agent ${parsed.agentOp ?? "updated"}`
          )}
        </p>
        <Link
          href={parsed.url ?? "/business"}
          className="inline-flex h-7 shrink-0 items-center gap-1 rounded-full border border-border bg-card px-2.5 text-[11px] font-medium shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground"
        >
          Open business
          <ArrowUpRight className="h-3 w-3" aria-hidden />
        </Link>
      </div>
    );
  }

  // ---- update → the changed fields --------------------------------------
  if (parsed.kind === "update") {
    const fields = parsed.updatedFields ?? [];
    return (
      <div className="flex min-w-0 items-center gap-2 px-1.5 py-1 sm:px-2">
        <Building2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          Updated: <span className="font-medium text-foreground">{fields.length > 0 ? fields.join(", ") : "business"}</span>
        </p>
        <Link
          href={parsed.url ?? "/business"}
          className="inline-flex h-7 shrink-0 items-center gap-1 rounded-full border border-border bg-card px-2.5 text-[11px] font-medium shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground"
        >
          Open
          <ArrowUpRight className="h-3 w-3" aria-hidden />
        </Link>
      </div>
    );
  }

  // ---- create / get / status → the business card -------------------------
  return (
    <div className="mx-1.5 my-1 rounded-xl border border-border bg-card p-3 shadow-sm sm:mx-2">
      <div className="flex min-w-0 items-start gap-2.5">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/40">
          <Building2 className="h-4 w-4 text-muted-foreground" aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <p className="min-w-0 truncate text-sm font-semibold">{parsed.name}</p>
            {parsed.status && (
              <span className={`shrink-0 rounded-full border px-1.5 py-px text-[10px] font-medium ${statusClass(parsed.status)}`}>
                {parsed.status}
              </span>
            )}
          </div>
          {parsed.agents.length > 0 ? (
            <div className="mt-1.5 flex min-w-0 flex-wrap gap-1.5">
              {parsed.agents.map((a, idx) => (
                <span
                  key={`${a.name}-${idx}`}
                  className="inline-flex max-w-[200px] items-center rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[11px]"
                  title={a.role ?? a.name}
                >
                  <span className="truncate">{a.name}</span>
                </span>
              ))}
            </div>
          ) : (
            <p className="mt-1 text-[11px] text-muted-foreground">No specialist agents yet</p>
          )}
        </div>
        <Link
          href={parsed.url ?? "/business"}
          className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-3 text-xs font-medium text-primary transition-colors hover:bg-primary/20"
        >
          Open
          <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
        </Link>
      </div>
    </div>
  );
}

"use client";

import { useMemo, useState } from "react";
import {
  Bot,
  Check,
  ChevronDown,
  Crown,
  Loader2,
  MessageSquarePlus,
  Plus,
  Sparkles,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useSubagentStore } from "@/stores/subagent-store";
import { useTeamStore, type TeamRound, type TeamRun } from "@/stores/team-store";
import { runTeamRound, runTeamSynthesis } from "@/lib/agent/team-runner";

/**
 * TeamPanel — the AGENT TEAMS / ROUNDTABLE arena (2026-11-05). Docked panel:
 * build a team from the workspace's subagents, give it a topic, and watch
 * every member answer in parallel (arena cards, live streaming through each
 * member's own session), run more rounds (members see each other's previous
 * answers), then let the lead synthesize.
 */

const STATUS_CHIP: Record<string, string> = {
  pending: "text-muted-foreground",
  streaming: "text-primary",
  completed: "text-emerald-600 dark:text-emerald-400",
  failed: "text-destructive",
};

export function TeamPanel({ onClose }: { onClose?: () => void }) {
  const teams = useTeamStore((s) => s.teams);
  const runs = useTeamStore((s) => s.runs);
  const activeRunId = useTeamStore((s) => s.activeRunId);
  const subagents = useSubagentStore((s) => s.subagents);

  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(teams[0]?.id ?? null);
  // The builder opens on demand (the empty state's CTA / the + button) —
  // not automatically, so zero-team users see the explainer first.
  const [building, setBuilding] = useState(false);
  const [topic, setTopic] = useState("");
  const [running, setRunning] = useState(false);

  const activeRun = useMemo(
    () => runs.find((r) => r.id === activeRunId) ?? null,
    [runs, activeRunId],
  );
  const selectedTeam =
    teams.find((t) => t.id === selectedTeamId) ?? teams[0] ?? null;
  const teamForRun = activeRun ? teams.find((t) => t.id === activeRun.teamId) ?? selectedTeam : selectedTeam;

  const enabledMembers = (teamForRun?.memberIds ?? [])
    .map((id) => subagents.find((s) => s.id === id))
    .filter((s): s is NonNullable<typeof s> => !!s && s.enabled);

  const anyRoundBusy = activeRun?.rounds.some((r) =>
    r.answers.some((a) => a.status === "pending" || a.status === "streaming"),
  );

  const handleRunRound = async () => {
    if (!teamForRun || !topic.trim() || running) return;
    setRunning(true);
    try {
      const store = useTeamStore.getState();
      // Continue the ACTIVE run when it belongs to this team (round 2+),
      // else start a fresh one with the topic.
      if (activeRun && activeRun.teamId === teamForRun.id) {
        await runTeamRound(activeRun.id);
      } else {
        const run = store.startRun(teamForRun.id, topic);
        await runTeamRound(run.id);
      }
    } finally {
      setRunning(false);
    }
  };

  const handleSynthesize = async () => {
    if (!activeRun || running) return;
    setRunning(true);
    try {
      await runTeamSynthesis(activeRun.id);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="flex h-full flex-col bg-card">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-3 py-3">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold">
          <Users className="h-4 w-4" />
          Teams
        </h3>
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setBuilding((v) => !v)}
            className="h-8 w-8 p-0"
            title={building ? "Close the builder" : "New team"}
            aria-label={building ? "Close the builder" : "New team"}
          >
            {building ? <X className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
          </Button>
          {onClose && (
            <Button
              size="sm"
              variant="ghost"
              onClick={onClose}
              className="h-8 w-8 p-0"
              title="Close"
              aria-label="Close teams panel"
            >
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto scrollbar-thin">
        {/* ── TEAM BUILDER ─────────────────────────────────────────── */}
        {building && (
          <TeamBuilder
            onDone={(teamId) => {
              setSelectedTeamId(teamId);
              setBuilding(false);
            }}
          />
        )}

        {/* ── NO TEAMS / NO MEMBERS empty state ────────────────────── */}
        {!building && teams.length === 0 && (
          <div className="flex flex-col items-center justify-center gap-2 px-4 py-10 text-center">
            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-muted text-muted-foreground">
              <Users className="h-4 w-4" />
            </div>
            <p className="text-xs font-medium text-foreground">No teams yet</p>
            <p className="max-w-[220px] text-[11px] leading-relaxed text-muted-foreground">
              Build a team from your subagents — every member answers the same
              topic in parallel, then discusses and synthesizes.
            </p>
            <Button size="sm" variant="outline" className="mt-1 h-7 text-xs" onClick={() => setBuilding(true)}>
              <Plus className="mr-1 h-3 w-3" /> New team
            </Button>
          </div>
        )}

        {!building && teams.length > 0 && (
          <>
            {/* ── TEAM SELECTOR ────────────────────────────────────── */}
            <div className="border-b border-border px-3 py-2">
              <label className="text-[10px] font-medium text-muted-foreground" htmlFor="team-select">
                Team
              </label>
              <div className="mt-1 flex items-center gap-1.5">
                <div className="relative flex-1">
                  <select
                    id="team-select"
                    value={selectedTeam?.id ?? ""}
                    onChange={(e) => {
                      setSelectedTeamId(e.target.value);
                      useTeamStore.getState().setActiveRun(null);
                    }}
                    className="h-8 w-full appearance-none rounded-md border border-border bg-background pl-2 pr-7 text-xs"
                  >
                    {teams.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name} ({t.memberIds.length})
                      </option>
                    ))}
                  </select>
                  <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-8 w-8 shrink-0 p-0"
                  title="Delete team"
                  aria-label="Delete team"
                  disabled={!selectedTeam}
                  onClick={() => {
                    if (!selectedTeam) return;
                    if (window.confirm(`Delete team "${selectedTeam.name}" and its run history?`)) {
                      useTeamStore.getState().deleteTeam(selectedTeam.id);
                      setSelectedTeamId(teams.find((t) => t.id !== selectedTeam.id)?.id ?? null);
                    }
                  }}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
              {/* Roster */}
              {teamForRun && (
                <ul className="mt-2 flex flex-wrap gap-1">
                  {enabledMembers.map((m) => (
                    <li
                      key={m.id}
                      className="inline-flex items-center gap-1 rounded-full border border-border bg-foreground/[0.03] px-1.5 py-0.5 text-[10px] text-muted-foreground"
                      title={m.description || m.name}
                    >
                      {teamForRun.leadId === m.id && <Crown className="h-2.5 w-2.5 text-amber-500" aria-label="lead" />}
                      {m.name}
                    </li>
                  ))}
                  {enabledMembers.length === 0 && (
                    <li className="text-[10px] text-muted-foreground">
                      No enabled members — spawn or enable subagents first.
                    </li>
                  )}
                </ul>
              )}
            </div>

            {/* ── TOPIC COMPOSER ──────────────────────────────────── */}
            <div className="border-b border-border px-3 py-2">
              <textarea
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                placeholder={
                  activeRun && activeRun.teamId === teamForRun?.id
                    ? `Round ${(activeRun.rounds.length ?? 0) + 1} — continue the discussion…`
                    : "Give the team a topic…"
                }
                rows={2}
                className="w-full resize-none rounded-md border border-border bg-background px-2 py-1.5 text-xs placeholder:text-muted-foreground/70"
                aria-label="Team topic"
              />
              <div className="mt-1.5 flex items-center gap-1.5">
                <Button
                  size="sm"
                  className="h-7 flex-1 text-xs"
                  onClick={() => void handleRunRound()}
                  disabled={!teamForRun || !topic.trim() || enabledMembers.length === 0 || running}
                >
                  {running ? (
                    <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                  ) : (
                    <MessageSquarePlus className="mr-1 h-3 w-3" />
                  )}
                  {activeRun && activeRun.teamId === teamForRun?.id
                    ? `Run round ${(activeRun.rounds.length ?? 0) + 1}`
                    : "Run roundtable"}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  onClick={() => void handleSynthesize()}
                  disabled={
                    !activeRun ||
                    activeRun.teamId !== teamForRun?.id ||
                    running ||
                    !activeRun.rounds.some((r) => r.answers.some((a) => a.status === "completed"))
                  }
                  title="The team's lead consolidates every round into one answer"
                >
                  <Sparkles className="mr-1 h-3 w-3" /> Synthesize
                </Button>
              </div>
              {activeRun && activeRun.teamId === teamForRun?.id && anyRoundBusy && (
                <p className="mt-1 text-[10px] text-primary">Round in progress — members are answering…</p>
              )}
            </div>

            {/* ── THE ARENA — the active run ──────────────────────── */}
            {activeRun && activeRun.teamId === teamForRun?.id && (
              <RunArena run={activeRun} subagents={subagents} />
            )}

            {/* ── RUN HISTORY ─────────────────────────────────────── */}
            {runs.filter((r) => r.teamId === teamForRun?.id).length > 0 && (
              <div className="border-t border-border px-3 py-2">
                <p className="mb-1 text-[10px] font-medium text-muted-foreground">Past runs</p>
                <ul className="space-y-0.5">
                  {runs
                    .filter((r) => r.teamId === teamForRun?.id)
                    .slice(0, 8)
                    .map((r) => (
                      <li key={r.id} className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => useTeamStore.getState().setActiveRun(r.id)}
                          className={cn(
                            "flex-1 truncate rounded px-1.5 py-1 text-left text-[11px] transition-colors hover:bg-foreground/5",
                            r.id === activeRunId ? "text-foreground" : "text-muted-foreground",
                          )}
                          title={r.topic}
                        >
                          {r.rounds.length} round{r.rounds.length !== 1 ? "s" : ""} · {r.topic}
                        </button>
                        <button
                          type="button"
                          onClick={() => useTeamStore.getState().deleteRun(r.id)}
                          className="px-1 text-muted-foreground hover:text-destructive"
                          title="Delete run"
                          aria-label={`Delete run: ${r.topic}`}
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </li>
                    ))}
                </ul>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/* ── The active run's arena: rounds, member cards, synthesis ───────────── */

function RunArena({ run, subagents }: { run: TeamRun; subagents: ReturnType<typeof useSubagentStore.getState>["subagents"] }) {
  const team = useTeamStore((s) => s.teams.find((t) => t.id === run.teamId));
  const leadId = team?.leadId ?? null;
  return (
    <div className="px-3 py-2">
      {/* Newest round first; every round stays inspectable. */}
      {[...run.rounds].reverse().map((round) => (
        <div key={round.index} className="mb-3">
          <p className="mb-1.5 font-mono text-[10px] tracking-wide text-muted-foreground uppercase">
            Round {round.index}
          </p>
          <div className="space-y-2">
            {round.answers.map((answer) => {
              const member = subagents.find((s) => s.id === answer.subagentId);
              return (
                <MemberCard
                  key={answer.subagentId}
                  name={member?.name ?? "Member"}
                  model={member?.model ?? null}
                  isLead={answer.subagentId === leadId}
                  status={answer.status}
                  error={answer.error ?? null}
                  sessionId={answer.sessionId ?? null}
                  fallbackText={answer.text ?? ""}
                />
              );
            })}
          </div>
          {round.synthesis && (
            <div className="mt-2 rounded-lg border border-primary/30 bg-primary/[0.04] p-2.5">
              <p className="mb-1 flex items-center gap-1 text-[10px] font-semibold text-primary">
                <Sparkles className="h-3 w-3" />
                Synthesis ·{" "}
                {subagents.find((s) => s.id === round.synthesis!.agentId)?.name ?? "Lead"}
              </p>
              <div className="max-h-72 overflow-y-auto text-xs leading-relaxed whitespace-pre-wrap text-foreground/85 scrollbar-thin">
                {round.synthesis.text}
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/** One member's arena card — live content streams from their session. */
function MemberCard({
  name,
  model,
  isLead,
  status,
  error,
  sessionId,
  fallbackText,
}: {
  name: string;
  model: string | null;
  isLead: boolean;
  status: string;
  error: string | null;
  sessionId: string | null;
  fallbackText: string;
}) {
  // LIVE: the member's last assistant message in their session (streams
  // token-by-token through the subagent store).
  const liveMessage = useSubagentStore((s) => {
    const session = s.sessions.find((x) => x.id === sessionId);
    if (!session) return null;
    for (let i = session.messages.length - 1; i >= 0; i--) {
      const m = session.messages[i]!;
      if (m.role === "assistant") return m;
    }
    return null;
  });
  const text = liveMessage?.content?.trim() || fallbackText;
  return (
    <div className="rounded-lg border border-border bg-foreground/[0.015] p-2.5">
      <div className="mb-1.5 flex items-center gap-1.5">
        <Bot className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="truncate text-xs font-semibold text-foreground/90">{name}</span>
        {isLead && (
          <span className="inline-flex items-center gap-0.5 rounded-full bg-amber-500/10 px-1.5 py-px text-[9px] font-medium text-amber-600 dark:text-amber-400">
            <Crown className="h-2.5 w-2.5" /> lead
          </span>
        )}
        {model && (
          <span className="ml-auto shrink-0 font-mono text-[9px] text-muted-foreground/70">{model}</span>
        )}
      </div>
      <p className={cn("mb-1 text-[10px] font-medium", STATUS_CHIP[status] ?? "text-muted-foreground")}>
        {status === "streaming" && <Loader2 className="mr-1 inline h-2.5 w-2.5 animate-spin" />}
        {status === "failed" ? `failed — ${error ?? "error"}` : status}
      </p>
      {text ? (
        <div className="max-h-64 overflow-y-auto text-xs leading-relaxed whitespace-pre-wrap text-foreground/80 scrollbar-thin">
          {text}
        </div>
      ) : (
        <p className="text-[11px] text-muted-foreground/70">
          {status === "pending" ? "Waiting…" : "No answer yet."}
        </p>
      )}
    </div>
  );
}

/* ── The team builder ───────────────────────────────────────────────────── */

function TeamBuilder({ onDone }: { onDone: (teamId: string) => void }) {
  const subagents = useSubagentStore((s) => s.subagents);
  const createTeam = useTeamStore((s) => s.createTeam);
  const createSubagent = useSubagentStore((s) => s.createSubagent);

  const [name, setName] = useState("");
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [leadId, setLeadId] = useState<string | null>(null);
  // Quick member creation (the roster needs members even before the AI
  // spawns any): name + role + prompt, model inherited.
  const [quickName, setQuickName] = useState("");
  const [quickRole, setQuickRole] = useState("");
  const [quickPrompt, setQuickPrompt] = useState("");

  const toggle = (id: string) => {
    setMemberIds((prev) => {
      const next = prev.includes(id) ? prev.filter((m) => m !== id) : [...prev, id];
      if (!next.includes(leadId ?? "")) setLeadId(next[0] ?? null);
      return next;
    });
  };

  const addQuickMember = () => {
    const trimmed = quickName.trim();
    if (!trimmed) return;
    const member = createSubagent({
      name: trimmed,
      description: quickRole.trim() || `Team member: ${trimmed}`,
      role: quickRole.trim() || undefined,
      systemPrompt: quickPrompt.trim() || `You are ${trimmed}, a team member in a roundtable discussion. Answer with your expertise, concretely and honestly.`,
      enabled: true,
    });
    setMemberIds((prev) => [...prev, member.id]);
    setLeadId((cur) => cur ?? member.id);
    setQuickName("");
    setQuickRole("");
    setQuickPrompt("");
  };

  const create = () => {
    if (!name.trim() || memberIds.length === 0) return;
    const team = createTeam({ name, memberIds, leadId: leadId ?? memberIds[0]! });
    onDone(team.id);
  };

  return (
    <div className="space-y-3 border-b border-border px-3 py-3">
      <p className="text-[10px] font-medium text-muted-foreground">New team</p>
      <Input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Team name (e.g. Product Council)"
        className="h-8 text-xs"
        aria-label="Team name"
      />

      {/* Roster: the workspace's subagents. */}
      <div>
        <p className="mb-1 text-[10px] text-muted-foreground">Members ({memberIds.length})</p>
        {subagents.length === 0 ? (
          <p className="text-[11px] leading-relaxed text-muted-foreground/80">
            No subagents yet — add one below, or ask Onyx to spawn specialists.
          </p>
        ) : (
          <ul className="max-h-40 space-y-0.5 overflow-y-auto scrollbar-thin">
            {subagents.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => toggle(s.id)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-xs transition-colors hover:bg-foreground/5",
                    !s.enabled && "opacity-50",
                  )}
                >
                  <span
                    className={cn(
                      "flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border",
                      memberIds.includes(s.id)
                        ? "border-primary bg-primary/15 text-primary"
                        : "border-border",
                    )}
                    aria-hidden
                  >
                    {memberIds.includes(s.id) && <Check className="h-2.5 w-2.5" />}
                  </span>
                  <span className="truncate">{s.name}</span>
                  {!s.enabled && (
                    <span className="ml-auto shrink-0 text-[9px] text-muted-foreground">disabled</span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Quick member creation. */}
      <details className="rounded-md border border-border">
        <summary className="cursor-pointer px-2 py-1.5 text-[11px] text-muted-foreground">
          + Add a member
        </summary>
        <div className="space-y-1.5 px-2 pb-2 pt-1">
          <Input
            value={quickName}
            onChange={(e) => setQuickName(e.target.value)}
            placeholder="Name (e.g. Skeptic)"
            className="h-7 text-xs"
            aria-label="New member name"
          />
          <Input
            value={quickRole}
            onChange={(e) => setQuickRole(e.target.value)}
            placeholder="Role / specialty (optional)"
            className="h-7 text-xs"
            aria-label="New member role"
          />
          <textarea
            value={quickPrompt}
            onChange={(e) => setQuickPrompt(e.target.value)}
            placeholder="System prompt (optional — a sensible default is used)"
            rows={2}
            className="w-full resize-none rounded-md border border-border bg-background px-2 py-1 text-xs placeholder:text-muted-foreground/70"
            aria-label="New member system prompt"
          />
          <Button size="sm" variant="outline" className="h-7 w-full text-xs" onClick={addQuickMember} disabled={!quickName.trim()}>
            Add to roster
          </Button>
        </div>
      </details>

      {/* Lead picker. */}
      {memberIds.length > 1 && (
        <div>
          <p className="mb-1 text-[10px] text-muted-foreground">Lead (synthesizes)</p>
          <div className="relative">
            <select
              value={leadId ?? memberIds[0] ?? ""}
              onChange={(e) => setLeadId(e.target.value)}
              aria-label="Team lead"
              className="h-7 w-full appearance-none rounded-md border border-border bg-background pl-2 pr-7 text-xs"
            >
              {memberIds.map((id) => (
                <option key={id} value={id}>
                  {subagents.find((s) => s.id === id)?.name ?? id}
                </option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
          </div>
        </div>
      )}

      <Button size="sm" className="h-8 w-full text-xs" onClick={create} disabled={!name.trim() || memberIds.length === 0}>
        Create team
      </Button>
    </div>
  );
}

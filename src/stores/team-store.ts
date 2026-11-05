"use client";

import { create } from "zustand";
import { nanoid } from "nanoid";

/**
 * Team store — AGENT TEAMS / ROUNDTABLE (2026-11-05).
 *
 * A team is a named roster of existing SUBAGENTS (spawned by the
 * orchestrator or added in the team builder) that answers ONE topic
 * together, arena-style: every member responds to the topic in parallel
 * (fan-out via startSubagentTurn), later rounds see the teammates' previous
 * answers (cross-visibility), and a designated lead synthesizes.
 *
 * Persistence: localStorage (same contract as the subagent store — teams
 * and their run history survive refresh). The heavy lifting (member turns)
 * lives in the subagent store's sessions; this store keeps the ROSTER, the
 * RUN LEDGER, and per-round answer STATUS + final text.
 */

/** A saved roster of subagents. */
export interface TeamConfig {
  id: string;
  name: string;
  description?: string;
  /** Subagent ids (roster order = card order). */
  memberIds: string[];
  /** The member that synthesizes (defaults to the first member). */
  leadId?: string | null;
  created_at: string;
}

export type TeamAnswerStatus = "pending" | "streaming" | "completed" | "failed";

/** One member's answer within one round. */
export interface TeamRoundAnswer {
  subagentId: string;
  status: TeamAnswerStatus;
  /** The member's session for THIS run (created at round 1, reused). */
  sessionId?: string | null;
  /** Final answer text (streamed live via the subagent session). */
  text?: string;
  error?: string | null;
}

/** One round of the roundtable. */
export interface TeamRound {
  /** 1-based. */
  index: number;
  startedAt: string;
  answers: TeamRoundAnswer[];
  /** The lead's synthesis of all rounds so far (set by runTeamSynthesis). */
  synthesis?: { agentId: string; text: string } | null;
}

/** One topic discussion: rounds accumulate; cross-visibility kicks in from
 *  round 2 (every member sees the previous round's answers). */
export interface TeamRun {
  id: string;
  teamId: string;
  topic: string;
  createdAt: string;
  rounds: TeamRound[];
}

interface TeamStoreState {
  teams: TeamConfig[];
  runs: TeamRun[];
  /** The run whose arena the panel shows (null = the composer). */
  activeRunId: string | null;

  createTeam: (input: { name: string; description?: string; memberIds: string[]; leadId?: string | null }) => TeamConfig;
  updateTeam: (id: string, patch: Partial<Omit<TeamConfig, "id" | "created_at">>) => void;
  deleteTeam: (id: string) => void;

  /** Start a run (or continue one): appends the next round and returns the
   *  run. Round 1 also mints the answer slots (status pending, no text). */
  appendRound: (runId: string) => TeamRound;
  startRun: (teamId: string, topic: string) => TeamRun;
  getRun: (runId: string) => TeamRun | undefined;
  patchAnswer: (
    runId: string,
    roundIndex: number,
    subagentId: string,
    patch: Partial<Omit<TeamRoundAnswer, "subagentId">>,
  ) => void;
  setRoundSynthesis: (runId: string, roundIndex: number, synthesis: { agentId: string; text: string } | null) => void;
  deleteRun: (runId: string) => void;
  setActiveRun: (runId: string | null) => void;

  loadFromStorage: () => void;
  saveToStorage: () => void;
}

const STORAGE_KEY = "onyxagent-teams-v1";

function readStorage(): { teams: TeamConfig[]; runs: TeamRun[] } {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { teams: [], runs: [] };
    const parsed = JSON.parse(raw) as { teams?: TeamConfig[]; runs?: TeamRun[] };
    return {
      teams: Array.isArray(parsed.teams) ? parsed.teams : [],
      runs: Array.isArray(parsed.runs) ? parsed.runs : [],
    };
  } catch {
    return { teams: [], runs: [] };
  }
}

export const useTeamStore = create<TeamStoreState>((set, get) => ({
  teams: [],
  runs: [],
  activeRunId: null,

  createTeam: (input) => {
    const team: TeamConfig = {
      id: `team_${nanoid(10)}`,
      name: input.name.trim() || "Team",
      description: input.description?.trim() || undefined,
      memberIds: [...new Set(input.memberIds)],
      leadId: input.leadId ?? null,
      created_at: new Date().toISOString(),
    };
    set({ teams: [...get().teams, team] });
    get().saveToStorage();
    return team;
  },

  updateTeam: (id, patch) => {
    set({
      teams: get().teams.map((t) =>
        t.id === id
          ? {
              ...t,
              ...patch,
              memberIds: patch.memberIds ? [...new Set(patch.memberIds)] : t.memberIds,
            }
          : t,
      ),
    });
    get().saveToStorage();
  },

  deleteTeam: (id) => {
    // Deleting a team deletes its runs (they reference member sessions).
    const runIds = get().runs.filter((r) => r.teamId === id).map((r) => r.id);
    set({
      teams: get().teams.filter((t) => t.id !== id),
      runs: get().runs.filter((r) => r.teamId !== id),
      activeRunId: runIds.includes(get().activeRunId ?? "") ? null : get().activeRunId,
    });
    get().saveToStorage();
  },

  appendRound: (runId) => {
    const run = get().runs.find((r) => r.id === runId);
    if (!run) throw new Error(`Team run ${runId} not found`);
    const team = get().teams.find((t) => t.id === run.teamId);
    const round: TeamRound = {
      index: run.rounds.length + 1,
      startedAt: new Date().toISOString(),
      answers: (team?.memberIds ?? []).map((subagentId) => ({
        subagentId,
        status: "pending" as const,
        // Reuse the member's session from round 1 when it exists (one
        // coherent thread per member per run).
        sessionId: run.rounds[0]?.answers.find((a) => a.subagentId === subagentId)?.sessionId ?? null,
      })),
    };
    set({
      runs: get().runs.map((r) => (r.id === runId ? { ...r, rounds: [...r.rounds, round] } : r)),
    });
    get().saveToStorage();
    return round;
  },

  startRun: (teamId, topic) => {
    const trimmed = topic.trim();
    if (!trimmed) throw new Error("A topic is required to start a team run.");
    const run: TeamRun = {
      id: `teamrun_${nanoid(10)}`,
      teamId,
      topic: trimmed,
      createdAt: new Date().toISOString(),
      rounds: [],
    };
    set({ runs: [run, ...get().runs], activeRunId: run.id });
    get().appendRound(run.id);
    get().saveToStorage();
    return get().runs.find((r) => r.id === run.id)!;
  },

  getRun: (runId) => get().runs.find((r) => r.id === runId),

  patchAnswer: (runId, roundIndex, subagentId, patch) => {
    set({
      runs: get().runs.map((r) =>
        r.id !== runId
          ? r
          : {
              ...r,
              rounds: r.rounds.map((round) =>
                round.index !== roundIndex
                  ? round
                  : {
                      ...round,
                      answers: round.answers.map((a) =>
                        a.subagentId !== subagentId ? a : { ...a, ...patch },
                      ),
                    },
              ),
            },
      ),
    });
    get().saveToStorage();
  },

  setRoundSynthesis: (runId, roundIndex, synthesis) => {
    set({
      runs: get().runs.map((r) =>
        r.id !== runId
          ? r
          : {
              ...r,
              rounds: r.rounds.map((round) =>
                round.index !== roundIndex ? round : { ...round, synthesis },
              ),
            },
      ),
    });
    get().saveToStorage();
  },

  deleteRun: (runId) => {
    set({
      runs: get().runs.filter((r) => r.id !== runId),
      activeRunId: get().activeRunId === runId ? null : get().activeRunId,
    });
    get().saveToStorage();
  },

  setActiveRun: (runId) => set({ activeRunId: runId }),

  loadFromStorage: () => {
    const { teams, runs } = readStorage();
    set({ teams, runs });
  },

  saveToStorage: () => {
    try {
      const { teams, runs } = get();
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ teams, runs }));
    } catch {
      /* quota / private mode — teams stay in memory for this session */
    }
  },
}));

// AUTO-HYDRATE on module import (same contract as the subagent store).
if (typeof window !== "undefined") {
  try {
    useTeamStore.getState().loadFromStorage();
  } catch {
    /* storage unavailable — the store starts empty */
  }
}

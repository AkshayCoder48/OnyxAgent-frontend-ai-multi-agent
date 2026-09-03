"use client";

/**
 * Background agent client — launches and tracks agent turns that run INSIDE
 * the E2B sandbox as background commands (the E2B-documented way to keep
 * work going after the browser disconnects: sandboxes are server-side VMs,
 * a background command "keeps running inside the sandbox even after the SDK
 * disconnects").
 *
 * Flow:
 *   1. `launchBackgroundTurn` — POST /api/sandbox {action:"bg_start"} with
 *      the provider config + conversation; the server writes the runner
 *      script + state into the sandbox and starts
 *      `node bg-agent.mjs` as a background command. Returns immediately.
 *   2. `pollBackgroundTurn` — bg_status reconnects (Sandbox.connect) and
 *      reads the events the runner has written so far.
 *   3. On reload, `getActiveJob` finds the persisted job for the
 *      conversation and polling resumes — whatever the runner did while the
 *      browser was closed replays into the chat.
 */

export interface BgEvent {
  t: "round_start" | "text" | "reasoning" | "tool_call" | "tool_result" | "done" | "error";
  round?: number;
  /** text / reasoning content */
  content?: string;
  /** tool_call / tool_result id */
  id?: string;
  name?: string;
  args?: Record<string, unknown>;
  result?: string;
  message?: string;
}

export interface BgJob {
  sandboxId: string;
  pid?: number;
  conversationId: string | null;
  assistantMessageId: string;
  startedAt: number;
}

export interface BgTurnOptions {
  /** The user's E2B API key (decrypted). */
  e2bApiKey: string;
  provider: {
    baseUrl: string;
    apiKey: string | null;
    model: string;
    temperature?: number;
    toolsEnabled?: boolean;
    noPrefix?: boolean;
  };
  systemPrompt: string;
  history: Array<{ role: "user" | "assistant" | "system"; content: string }>;
  assistantMessageId: string;
  conversationId: string | null;
}

const JOBS_KEY = "onyx-bg-jobs";

function readJobs(): Record<string, BgJob> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(JOBS_KEY);
    return raw ? (JSON.parse(raw) as Record<string, BgJob>) : {};
  } catch {
    return {};
  }
}

function writeJobs(jobs: Record<string, BgJob>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(JOBS_KEY, JSON.stringify(jobs));
  } catch {
    // ignore quota errors
  }
}

function saveJob(job: BgJob): void {
  const jobs = readJobs();
  // One job per conversation — drop any stale job for THIS conversation,
  // keep jobs from others.
  const cleaned: Record<string, BgJob> = {};
  for (const [id, j] of Object.entries(jobs)) {
    if (j.conversationId !== job.conversationId) cleaned[id] = j;
  }
  cleaned[job.assistantMessageId] = job;
  writeJobs(cleaned);
}

export function clearJob(assistantMessageId: string): void {
  const jobs = readJobs();
  delete jobs[assistantMessageId];
  writeJobs(jobs);
}

/** The persisted job for a conversation (resumable after a reload). */
export function getActiveJob(conversationId: string | null): BgJob | null {
  const jobs = readJobs();
  for (const job of Object.values(jobs)) {
    if (job.conversationId === (conversationId ?? null)) return job;
  }
  return null;
}

async function sandboxCall<T>(
  e2bApiKey: string,
  action: string,
  args: Record<string, unknown>,
): Promise<T> {
  const res = await fetch("/api/sandbox", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiKey: e2bApiKey, action, args }),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok || (data && typeof data === "object" && "error" in data && data.error && action !== "bg_status")) {
    throw new Error((data as { error?: string }).error ?? `Sandbox ${action} failed (${res.status})`);
  }
  return data as T;
}

/** Launch the background agent turn. Resolves as soon as the command STARTS
 *  (the loop itself runs inside the sandbox, independent of this browser). */
export async function launchBackgroundTurn(opts: BgTurnOptions): Promise<BgJob> {
  const state = {
    provider: {
      baseUrl: opts.provider.baseUrl,
      apiKey: opts.provider.apiKey,
      model: opts.provider.model,
      temperature: opts.provider.temperature,
      toolsEnabled: opts.provider.toolsEnabled,
      noPrefix: opts.provider.noPrefix,
    },
    toolsEnabled: opts.provider.toolsEnabled,
    messages: [
      ...(opts.systemPrompt ? [{ role: "system", content: opts.systemPrompt }] : []),
      ...opts.history,
    ],
  };
  const res = await sandboxCall<{ sandboxId: string; pid: number; error?: string }>(
    opts.e2bApiKey,
    "bg_start",
    { state, conversationId: opts.conversationId },
  );
  if (!res.sandboxId) {
    throw new Error(res.error ?? "Failed to start the background run");
  }
  const job: BgJob = {
    sandboxId: res.sandboxId,
    pid: res.pid,
    conversationId: opts.conversationId,
    assistantMessageId: opts.assistantMessageId,
    startedAt: Date.now(),
  };
  saveJob(job);
  return job;
}

export interface BgStatus {
  sandboxId: string;
  status: "starting" | "running" | "done" | "error" | "unreachable" | string;
  events: BgEvent[];
  content: string;
  error: string | null;
  startedAt: string | null;
}

/** Reconnect to the background sandbox and read its progress. */
export async function pollBackgroundTurn(
  e2bApiKey: string,
  sandboxId: string,
): Promise<BgStatus> {
  return sandboxCall<BgStatus>(e2bApiKey, "bg_status", { sandboxId });
}

/** Stop the background runner (kills its processes; files stay). */
export async function stopBackgroundTurn(
  e2bApiKey: string,
  sandboxId: string,
): Promise<void> {
  await sandboxCall(e2bApiKey, "bg_stop", { sandboxId });
}

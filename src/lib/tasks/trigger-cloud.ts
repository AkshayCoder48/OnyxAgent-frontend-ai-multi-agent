// ============================================================================
// Background Task Execution Framework — Trigger.dev CLOUD orchestrator.
//
// The third execution mode (orchestration-mode.ts): the operator connects a
// trigger.dev Cloud key (Settings → Cloud Tasks) and the app drives the SAME
// deployed worker protocol through the public cloud REST API —
// https://api.trigger.dev — with NO self-hosting:
//
//   · verifyCloudKey     GET  /api/v3/projects           (connect + re-test)
//   · triggerCloudTaskRun POST /api/v1/runs               (kick agent-run)
//   · fetchCloudRunState GET  /api/v3/runs/:id            (self-heal)
//   · cancelCloudRunById POST /api/v3/runs/:id/cancel     (cancel)
//
// CREDENTIAL DISCIPLINE (mirrors keyring.ts):
//   · the API key + minted WORKER_TOKEN are sealed with AES-256-GCM into
//     TaskCloudConfig (SQLite); plaintext lives ONLY in process memory
//     (short-lived config cache below),
//   · NEVER logged — log run ids + statuses only,
//   · the master key comes from TASKS_CLOUD_MASTER_KEY (env) or the machine
//     key file db/cloud-config.key (generated once, 32 random bytes hex).
//
// DISPATCH (kickCloudRun): the app atomically claims the queued TaskRun
// (lockHolder "triggerdev:cloud-kick:<id>"), builds the same
// WorkerClaimedRun the worker route would return, and triggers the deployed
// `agent-run` task directly on the cloud — zero queue latency. On API
// failure the claim is RELEASED back to queued so the deployed worker's
// poll-claims cron (every minute) remains the backstop dispatcher.
//
// SELF-HEAL (healStaleCloudRuns): a cloud run that exhausted its retries
// before reporting would otherwise sit "running" forever — when a row goes
// stale (>2 min untouched) its cloud state is fetched and terminal outcomes
// are settled locally; a queued row that was NEVER claimed (>10 min) fails
// with an actionable "deploy the worker" error.
// ============================================================================

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TaskRun } from "@prisma/client";
import { prisma } from "./prisma";
import { keyring } from "./keyring";
import { clampTimeoutMs } from "./local-driver";
import { parseConfig, parsePayload } from "./run-store";
import type {
  BackgroundTaskType,
  WorkerClaimedRun,
} from "./protocol";

// ---------------------------------------------------------------------------
// AES-256-GCM sealing — master key from env or the machine key file.
// ---------------------------------------------------------------------------

const MASTER_KEY_ENV = "TASKS_CLOUD_MASTER_KEY";
const MACHINE_KEY_FILE = join(process.cwd(), "db", "cloud-config.key");

/** Machine-key cache (globalThis-guarded for dev HMR reloads). */
const gKey = globalThis as unknown as { __onyxCloudMasterKey?: Buffer };

function getMasterKey(): Buffer {
  if (gKey.__onyxCloudMasterKey && gKey.__onyxCloudMasterKey.length === 32) {
    return gKey.__onyxCloudMasterKey;
  }
  let key: Buffer | null = null;

  const envKey = process.env[MASTER_KEY_ENV]?.trim();
  if (envKey) {
    if (/^[0-9a-fA-F]{64}$/.test(envKey)) key = Buffer.from(envKey, "hex");
    else if (/^[A-Za-z0-9+/]+={0,2}$/.test(envKey)) {
      const b = Buffer.from(envKey, "base64");
      if (b.length === 32) key = b;
    }
    if (!key) key = createHash("sha256").update(envKey, "utf8").digest();
  } else if (existsSync(MACHINE_KEY_FILE)) {
    const hex = readFileSync(MACHINE_KEY_FILE, "utf8").trim();
    if (/^[0-9a-fA-F]{64}$/.test(hex)) key = Buffer.from(hex, "hex");
  }
  if (!key) {
    // First use — generate + persist the machine key (0600-ish on Linux).
    key = randomBytes(32);
    try {
      mkdirSync(join(process.cwd(), "db"), { recursive: true });
      writeFileSync(MACHINE_KEY_FILE, `${key.toString("hex")}\n`, { mode: 0o600 });
    } catch (err) {
      // Read-only fs → fall back to an ephemeral process key (a restart
      // invalidates the sealed config; the operator re-connects the key).
      console.warn(
        `[tasks] could not persist the cloud master key file: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  gKey.__onyxCloudMasterKey = key;
  return key;
}

/** Seal a secret: `v1:<iv>:<tag>:<ciphertext>` (base64 parts). */
export function sealSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getMasterKey(), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return `v1:${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${ct.toString("base64")}`;
}

/** Open a sealed secret. Null on any corruption / master-key mismatch. */
export function openSecret(sealed: string): string | null {
  try {
    const parts = sealed.split(":");
    if (parts.length !== 4 || parts[0] !== "v1") return null;
    const iv = Buffer.from(parts[1]!, "base64");
    const tag = Buffer.from(parts[2]!, "base64");
    const ct = Buffer.from(parts[3]!, "base64");
    const decipher = createDecipheriv("aes-256-gcm", getMasterKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/** UI-safe key mask — "tr_••••••••4f2a". Never the key itself. */
export function maskSecret(key: string): string {
  if (key.length <= 8) return "••••••••";
  return `${key.slice(0, 3)}••••••••${key.slice(-4)}`;
}

// ---------------------------------------------------------------------------
// Config store — TaskCloudConfig singleton + in-memory cache.
// ---------------------------------------------------------------------------

/** Environment of a trigger.dev project (from GET /api/v3/projects). */
export interface CloudEnvironmentInfo {
  id: string;
  name: string;
  slug: string;
}

/** Project entry of the verification snapshot. */
export interface CloudProjectInfo {
  id: string;
  name: string;
  externalRef: string;
  orgSlug: string | null;
  orgName: string | null;
  environments: CloudEnvironmentInfo[];
}

/** Verification snapshot. `partial` = environment key (can trigger runs but
 * cannot list projects through the management API). */
export interface CloudAccountSnapshot {
  partial: boolean;
  note?: string;
  projects: CloudProjectInfo[];
}

/** The resolved, DECRYPTED config (in-memory only — never logged/persisted). */
export interface CloudConfig {
  keySource: "settings" | "env";
  apiKey: string;
  maskedKey: string;
  taskSlug: string;
  account: CloudAccountSnapshot | null;
  /** Effective WORKER_TOKEN (env wins over the minted stored one). */
  workerToken: string;
  workerTokenSource: "env" | "generated" | "none";
  verifiedAt: string | null;
}

const CONFIG_TTL_MS = 30_000;
const CONFIG_ROW_ID = "primary";
const DEFAULT_TASK_SLUG = "agent-run";

const gCfg = globalThis as unknown as {
  __onyxCloudConfigCache?: { data: CloudConfig | null; at: number } | null;
  // ALSO clears the orchestration-mode cache (globalThis convention — the
  // mode module imports this file, so it cannot import back; both caches
  // live on globalThis and are invalidated together).
  __onyxOrchestrationMode?: { mode: string; at: number } | null;
};

function parseAccountJson(json: string): CloudAccountSnapshot | null {
  try {
    const parsed = JSON.parse(json) as Partial<CloudAccountSnapshot>;
    if (parsed && typeof parsed === "object" && Array.isArray(parsed.projects)) {
      return {
        partial: parsed.partial === true,
        ...(typeof parsed.note === "string" ? { note: parsed.note } : {}),
        projects: parsed.projects,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * The active cloud config, or null when neither a stored key nor
 * TRIGGER_CLOUD_KEY (env) exists. Cached ~30s per process; secrets live in
 * memory only for the cache lifetime.
 */
export async function getCloudConfig(): Promise<CloudConfig | null> {
  const cached = gCfg.__onyxCloudConfigCache;
  if (cached && Date.now() - cached.at < CONFIG_TTL_MS) return cached.data;

  let config: CloudConfig | null = null;
  try {
    const row = await prisma.taskCloudConfig.findUnique({ where: { id: CONFIG_ROW_ID } });
    if (row) {
      const apiKey = openSecret(row.encryptedKey);
      const storedWorkerToken = openSecret(row.encryptedWorkerToken) || "";
      const envWorkerToken = process.env.WORKER_TOKEN?.trim() || "";
      if (apiKey) {
        const workerToken = envWorkerToken || storedWorkerToken;
        config = {
          keySource: "settings",
          apiKey,
          maskedKey: row.maskedKey,
          taskSlug: row.taskSlug || DEFAULT_TASK_SLUG,
          account: parseAccountJson(row.accountJson),
          workerToken,
          workerTokenSource: envWorkerToken
            ? "env"
            : storedWorkerToken
              ? "generated"
              : "none",
          verifiedAt: row.verifiedAt.toISOString(),
        };
      }
    }
  } catch (err) {
    // DB hiccup (e.g. schema not pushed yet) — degrade to env-only resolution.
    console.warn(
      `[tasks] cloud config read failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!config) {
    const envKey = process.env.TRIGGER_CLOUD_KEY?.trim();
    if (envKey) {
      const envWorkerToken = process.env.WORKER_TOKEN?.trim() || "";
      config = {
        keySource: "env",
        apiKey: envKey,
        maskedKey: maskSecret(envKey),
        taskSlug: process.env.TRIGGER_CLOUD_TASK_SLUG?.trim() || DEFAULT_TASK_SLUG,
        account: null,
        workerToken: envWorkerToken,
        workerTokenSource: envWorkerToken ? "env" : "none",
        verifiedAt: null,
      };
    }
  }

  gCfg.__onyxCloudConfigCache = { data: config, at: Date.now() };
  return config;
}

/** Drop the config + orchestration-mode caches (after connect/disconnect). */
export function invalidateCloudConfigCache(): void {
  gCfg.__onyxCloudConfigCache = null;
  gCfg.__onyxOrchestrationMode = null; // mode flips with the config
}

export interface SaveCloudConfigInput {
  apiKey: string;
  taskSlug: string;
  account: CloudAccountSnapshot;
}

/**
 * Persist a VERIFIED key (the caller verifies first — verifyCloudKey). Mints
 * a WORKER_TOKEN when neither the env var nor a previous token exists, so
 * the operator can wire the deployed cloud worker without touching .env.
 * Returns the resolved config; never logs the key or token.
 */
export async function saveCloudConfig(
  input: SaveCloudConfigInput,
): Promise<CloudConfig> {
  const existing = await prisma.taskCloudConfig.findUnique({
    where: { id: CONFIG_ROW_ID },
  });

  let mintedToken: string | null = null;
  if (!process.env.WORKER_TOKEN?.trim()) {
    mintedToken =
      (existing ? openSecret(existing.encryptedWorkerToken) : null) ||
      randomBytes(24).toString("hex");
  }

  const sealedKey = sealSecret(input.apiKey);
  const sealedToken = sealSecret(mintedToken ?? "");
  const common = {
    maskedKey: maskSecret(input.apiKey),
    taskSlug: input.taskSlug,
    accountJson: JSON.stringify(input.account),
    verifiedAt: new Date(),
  };

  await prisma.taskCloudConfig.upsert({
    where: { id: CONFIG_ROW_ID },
    create: { id: CONFIG_ROW_ID, encryptedKey: sealedKey, encryptedWorkerToken: sealedToken, ...common },
    update: {
      encryptedKey: sealedKey,
      ...(mintedToken ? { encryptedWorkerToken: sealedToken } : {}),
      ...common,
    },
  });

  invalidateCloudConfigCache();
  const config = await getCloudConfig();
  if (!config) throw new Error("cloud config save succeeded but the read-back failed");
  return config;
}

/** Update only the task slug (PATCH). */
export async function updateCloudTaskSlug(taskSlug: string): Promise<void> {
  await prisma.taskCloudConfig.update({
    where: { id: CONFIG_ROW_ID },
    data: { taskSlug },
  });
  invalidateCloudConfigCache();
}

/** Refresh the verification snapshot + verifiedAt (POST action:"retest"). */
export async function refreshCloudAccount(account: CloudAccountSnapshot): Promise<void> {
  await prisma.taskCloudConfig.update({
    where: { id: CONFIG_ROW_ID },
    data: { accountJson: JSON.stringify(account), verifiedAt: new Date() },
  });
  invalidateCloudConfigCache();
}

/** Disconnect — delete the stored config (back to local mode). */
export async function clearCloudConfig(): Promise<void> {
  await prisma.taskCloudConfig.deleteMany({ where: { id: CONFIG_ROW_ID } });
  invalidateCloudConfigCache();
}

/** Effective WORKER_TOKEN (env > minted) — for the worker route + the
 * Settings setup checklist. Null when neither exists. */
export async function getEffectiveWorkerToken(): Promise<{
  token: string | null;
  source: "env" | "generated" | "none";
}> {
  const envToken = process.env.WORKER_TOKEN?.trim();
  if (envToken) return { token: envToken, source: "env" };
  const config = await getCloudConfig();
  if (config?.workerToken) return { token: config.workerToken, source: config.workerTokenSource };
  return { token: null, source: "none" };
}

/** Dashboard base for run links (best-effort — falls back to the app root
 * when the snapshot lacks org/project/env slugs). */
export function cloudDashboardBase(account: CloudAccountSnapshot | null): string {
  const p = account?.projects?.[0];
  const env = p?.environments?.[0];
  if (p?.orgSlug && p.externalRef && env?.slug) {
    return `https://cloud.trigger.dev/orgs/${p.orgSlug}/projects/${p.externalRef}/environments/${env.slug}`;
  }
  return "https://cloud.trigger.dev";
}

// ---------------------------------------------------------------------------
// Cloud REST client — https://api.trigger.dev (no SDK dependency).
// ---------------------------------------------------------------------------

const REQUEST_TIMEOUT_MS = 12_000;

/** api.trigger.dev base (overridable for enterprise clouds). */
export function cloudApiBase(): string {
  return (
    process.env.TRIGGER_CLOUD_API_URL?.trim().replace(/\/+$/, "") ||
    "https://api.trigger.dev"
  );
}

class CloudApiError extends Error {
  readonly status: number;
  constructor(status: number, detail: string) {
    super(detail || `api.trigger.dev returned HTTP ${status}`);
    this.name = "CloudApiError";
    this.status = status;
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return typeof err === "string" ? err : JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function field(value: unknown, fallback = ""): string {
  return typeof value === "string" && value ? value : fallback;
}

/** Authenticated JSON request against api.trigger.dev. Throws CloudApiError
 * on non-2xx; the bearer key is never included in any thrown message. */
async function cloudRequest(
  apiKey: string,
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${cloudApiBase()}${path}`, {
      method: init?.method ?? "GET",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (err) {
    if (err instanceof CloudApiError) throw err;
    throw new CloudApiError(0, `network error reaching ${cloudApiBase()} (${errorMessage(err).slice(0, 160)})`);
  }

  const text = await res.text().catch(() => "");
  if (!res.ok) {
    let detail = "";
    try {
      const parsed = JSON.parse(text) as {
        error?: { message?: string } | string;
        message?: string;
        detail?: string;
      };
      if (typeof parsed.error === "string") detail = parsed.error;
      else if (parsed.error?.message) detail = parsed.error.message;
      else if (parsed.message) detail = parsed.message;
      else if (parsed.detail) detail = parsed.detail;
    } catch {
      /* HTML error page (their gateway's 404/5xx fallback) — never leak it */
    }
    throw new CloudApiError(
      res.status,
      detail || `api.trigger.dev returned HTTP ${res.status}`,
    );
  }
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new CloudApiError(0, "api.trigger.dev returned a non-JSON body");
  }
}

export type VerifyCloudKeyResult =
  | { ok: true; account: CloudAccountSnapshot }
  | { ok: false; status: number; error: string };

/**
 * Verify a key against api.trigger.dev (GET /api/v1/projects — the platform
 * listing used by the v3 management SDK; clean JSON auth errors).
 *
 * Cascade: environment keys (tr_trigger_…) are PAT-only-rejected on the
 * projects listing while still being able to trigger runs — so for those the
 * key is validated against GET /api/v3/runs/:id instead (auth runs before
 * the run lookup, so anything other than 401/403 proves the key is live) and
 * accepted with a `partial` snapshot.
 */
export async function verifyCloudKey(apiKey: string): Promise<VerifyCloudKeyResult> {
  try {
    const data = await cloudRequest(apiKey, "/api/v1/projects");
    const list = Array.isArray(data)
      ? data
      : Array.isArray((data as { data?: unknown[] }).data)
        ? ((data as { data: unknown[] }).data)
        : [];
    const projects: CloudProjectInfo[] = [];
    for (const raw of list) {
      if (!raw || typeof raw !== "object") continue;
      const p = raw as Record<string, unknown>;
      const org = (p.organization && typeof p.organization === "object"
        ? p.organization
        : {}) as Record<string, unknown>;
      const envs = Array.isArray(p.environments) ? p.environments : [];
      projects.push({
        id: field(p.id),
        name: field(p.name, "project"),
        externalRef: field(p.externalRef),
        orgSlug: typeof org.slug === "string" ? org.slug : null,
        orgName: typeof org.name === "string" ? org.name : null,
        environments: envs
          .filter((e): e is Record<string, unknown> => !!e && typeof e === "object")
          .map((e) => ({ id: field(e.id), name: field(e.name), slug: field(e.slug) }))
          .filter((e) => e.id),
      });
    }
    return { ok: true, account: { partial: false, projects } };
  } catch (err) {
    if (err instanceof CloudApiError && (err.status === 401 || err.status === 403)) {
      if (apiKey.startsWith("tr_trigger_")) {
        // Environment keys cannot list projects — validate the KEY itself
        // against a run read (auth precedes the lookup: a 401/403 means the
        // key is bad; a 404 means it authenticated fine).
        try {
          await cloudRequest(apiKey, "/api/v3/runs/000000000000000000000000");
        } catch (probeErr) {
          if (
            probeErr instanceof CloudApiError &&
            (probeErr.status === 401 || probeErr.status === 403)
          ) {
            return {
              ok: false,
              status: probeErr.status,
              error:
                "api.trigger.dev rejected the key — check that it is valid, not expired, and belongs to your project's environment.",
            };
          }
          // 404 / anything else — the key authenticated; accept as partial.
        }
        return {
          ok: true,
          account: {
            partial: true,
            note: "Environment key — it can trigger runs, but project details are not visible through the management API.",
            projects: [],
          },
        };
      }
      return {
        ok: false,
        status: err.status,
        error:
          "api.trigger.dev rejected the key — check that it is valid, not expired, and has access to your projects.",
      };
    }
    if (err instanceof CloudApiError && err.status === 429) {
      return { ok: false, status: 429, error: "Rate limited by api.trigger.dev — try again in a moment." };
    }
    return { ok: false, status: 0, error: errorMessage(err) };
  }
}

/** Trigger a task run on the cloud (POST /api/v1/runs — the same endpoint
 * the v3 SDK's tasks.trigger uses) → the cloud run id. */
export async function triggerCloudTaskRun(
  config: Pick<CloudConfig, "apiKey" | "taskSlug">,
  payload: unknown,
): Promise<string> {
  let run: unknown;
  try {
    run = await cloudRequest(config.apiKey, "/api/v1/runs", {
      method: "POST",
      body: { task: config.taskSlug, payload },
    });
  } catch (err) {
    // Their gateway answers invalid keys on this endpoint with an opaque
    // 405 "Unexpected Server Error" — translate to something actionable.
    if (err instanceof CloudApiError && err.status === 405) {
      throw new CloudApiError(
        err.status,
        "api.trigger.dev rejected the trigger request — check that the key is valid and the worker task is deployed",
      );
    }
    throw err;
  }
  const id = field((run as { id?: unknown })?.id);
  if (!id) throw new CloudApiError(0, "api.trigger.dev returned no run id");
  return id;
}

export type CloudRunState =
  | { status: "completed" }
  | { status: "cancelled" }
  | { status: "failed"; error?: string }
  | { status: "live" };

/** Fetch a cloud run's state (GET /api/v3/runs/:id), normalized. Returns
 * null when the state can't be determined (network/parse error, 404). */
export async function fetchCloudRunState(
  config: Pick<CloudConfig, "apiKey">,
  cloudRunId: string,
): Promise<CloudRunState | null> {
  let run: unknown;
  try {
    run = await cloudRequest(config.apiKey, `/api/v3/runs/${encodeURIComponent(cloudRunId)}`);
  } catch {
    return null;
  }
  if (!run || typeof run !== "object") return null;
  const raw = String(
    (run as { status?: unknown }).status ?? "",
  ).toLowerCase();
  if (raw === "completed" || raw === "complete") return { status: "completed" };
  if (raw === "canceled" || raw === "cancelled") return { status: "cancelled" };
  if (raw === "failed") return { status: "failed" };
  if (raw === "timed_out" || raw === "timeout") {
    return { status: "failed", error: "the run timed out on Trigger.dev Cloud" };
  }
  return { status: "live" };
}

/** Cancel a cloud run (POST /api/v3/runs/:id/cancel). 404/409 are fine —
 * the run already reached a terminal state. Best-effort by contract. */
export async function cancelCloudRunById(
  config: Pick<CloudConfig, "apiKey">,
  cloudRunId: string,
): Promise<void> {
  try {
    await cloudRequest(config.apiKey, `/api/v3/runs/${encodeURIComponent(cloudRunId)}/cancel`, {
      method: "POST",
    });
  } catch (err) {
    if (err instanceof CloudApiError && (err.status === 404 || err.status === 409)) return;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Dispatch — kick a queued TaskRun to the cloud agent-run task.
// ---------------------------------------------------------------------------

const CLOUD_KICK_PREFIX = "triggerdev:cloud-kick";

export type CloudKickResult =
  | { ok: true; cloudRunId: string }
  | { ok: false; error: string };

/**
 * Zero-latency cloud dispatch: atomically claim the queued run (the same CAS
 * the worker route uses), rebuild the WorkerClaimedRun in-process, and
 * trigger the deployed `agent-run` task on api.trigger.dev. The resulting
 * cloud run id is persisted to TaskRun.externalRunId.
 *
 * On failure the claim is RELEASED (running → queued) so the deployed
 * worker's poll-claims cron stays the backstop dispatcher — the run is
 * never stranded in a half-claimed state.
 */
export async function kickCloudRun(
  runId: string,
  fallbackAppUrl: string,
): Promise<CloudKickResult> {
  const config = await getCloudConfig();
  if (!config) return { ok: false, error: "cloud mode is not configured" };

  const lockHolder = `${CLOUD_KICK_PREFIX}:${randomUUID().slice(0, 8)}`;
  const claim = await prisma.taskRun.updateMany({
    where: { id: runId, status: "queued" },
    data: {
      status: "running",
      lockHolder,
      lockedAt: new Date(),
      attempts: { increment: 1 },
    },
  });
  if (claim.count === 0) {
    return { ok: false, error: "run was already claimed by another orchestrator" };
  }

  const row = await prisma.taskRun.findUnique({ where: { id: runId } });
  if (!row) return { ok: false, error: "run row disappeared before dispatch" };

  const appUrl = (process.env.APP_URL?.trim() || fallbackAppUrl).replace(/\/+$/, "");
  const runConfig = parseConfig(row.config);
  const claimed: WorkerClaimedRun = {
    runId: row.id,
    type: row.type as BackgroundTaskType,
    prompt: row.prompt,
    config: runConfig,
    payload: parsePayload(row.payload),
    appUrl,
    startedAt: row.startedAt.toISOString(),
    timeoutMs: clampTimeoutMs(runConfig.timeoutMs),
  };

  try {
    const cloudRunId = await triggerCloudTaskRun(config, { run: claimed });
    await prisma.taskRun
      .update({ where: { id: runId }, data: { externalRunId: cloudRunId } })
      .catch(() => {
        // best-effort persistence — the cloud run is already executing and
        // reports back over the worker protocol regardless.
      });
    console.log(
      `[tasks] run ${runId} kicked to Trigger.dev Cloud via task "${config.taskSlug}"`,
    );
    return { ok: true, cloudRunId };
  } catch (err) {
    const message = errorMessage(err).slice(0, 300);
    await prisma.taskRun
      .updateMany({
        where: { id: runId, status: "running", lockHolder },
        data: { status: "queued", lockHolder: null, lockedAt: null },
      })
      .catch(() => {
        // release failure — the 60s lock-staleness fence lets poll-claims
        // re-claim it anyway (same fence poll-claims relies on).
      });
    console.warn(`[tasks] cloud kick failed for run ${runId}: ${message}`);
    return { ok: false, error: message };
  }
}

// ---------------------------------------------------------------------------
// Self-heal — settle cloud rows the worker never reported terminal for.
// ---------------------------------------------------------------------------

/** Row must be untouched this long before its cloud state is checked. */
const HEAL_STALE_MS = 120_000;
/** Per-run cloud-state check backoff. */
const HEAL_CHECK_INTERVAL_MS = 30_000;
/** A queued row this old was never claimed — fail with guidance. */
const HEAL_QUEUED_GIVEUP_MS = 10 * 60_000;
/** Stale rows healed per batch sweep. */
const HEAL_BATCH = 3;

const gHeal = globalThis as unknown as {
  __onyxCloudHealChecked?: Map<string, number>;
  __onyxCloudHealSweepAt?: number;
};

function healChecked(): Map<string, number> {
  if (!gHeal.__onyxCloudHealChecked) gHeal.__onyxCloudHealChecked = new Map();
  if (gHeal.__onyxCloudHealChecked.size > 256) gHeal.__onyxCloudHealChecked.clear();
  return gHeal.__onyxCloudHealChecked;
}

async function healRow(config: CloudConfig, row: TaskRun, now: number): Promise<boolean> {
  // Queued + never claimed for 10 min → the worker isn't deployed / can't
  // authenticate. Fail with an actionable message (purely local — no API call).
  if (row.status === "queued") {
    if (now - row.startedAt.getTime() < HEAL_QUEUED_GIVEUP_MS) return false;
    const settled = await prisma.taskRun.updateMany({
      where: { id: row.id, status: "queued" },
      data: {
        status: "failed",
        phase: "finalize",
        error:
          "Never claimed by the Trigger.dev Cloud worker — deploy trigger-worker/ (Settings → Cloud Tasks has the checklist) and verify APP_URL + WORKER_TOKEN on the cloud project.",
        finishedAt: new Date(),
        lockHolder: null,
      },
    });
    keyring.drop(row.id);
    return settled.count > 0;
  }

  // Running + a known cloud run id → ask the cloud for the truth.
  if (row.status !== "running" || !row.externalRunId) return false;
  const last = healChecked().get(row.id) ?? 0;
  if (now - last < HEAL_CHECK_INTERVAL_MS) return false;
  healChecked().set(row.id, now);

  const state = await fetchCloudRunState(config, row.externalRunId).catch(() => null);
  if (!state || state.status === "live") return false;

  const data =
    state.status === "completed"
      ? { status: "completed", error: null }
      : state.status === "cancelled"
        ? { status: "cancelled", error: null }
        : {
            status: "failed",
            error: state.error ?? "the run ended on Trigger.dev Cloud without reporting back",
          };
  const settled = await prisma.taskRun.updateMany({
    where: { id: row.id, status: "running" },
    data: { ...data, phase: "done", finishedAt: new Date(), lockHolder: null },
  });
  keyring.drop(row.id);
  if (settled.count > 0) {
    console.log(`[tasks] run ${row.id} self-healed from cloud state: ${data.status}`);
  }
  return settled.count > 0;
}

/**
 * Sweep-on-read healer. With `scopeRunId` it checks exactly that run (used
 * by the single-run status view — no global throttle so a user watching a
 * stuck run gets it settled on the next poll); without it, a throttled batch
 * over stale cloud rows (list view). Returns true when anything settled.
 */
export async function healStaleCloudRuns(scopeRunId?: string): Promise<boolean> {
  const config = await getCloudConfig();
  if (!config) return false;
  const now = Date.now();

  if (scopeRunId) {
    const row = await prisma.taskRun.findUnique({ where: { id: scopeRunId } });
    if (!row || row.orchestrator !== "cloud") return false;
    if (
      (row.status === "queued" || row.status === "running") &&
      now - row.updatedAt.getTime() > HEAL_STALE_MS
    ) {
      try {
        return await healRow(config, row, now);
      } catch {
        return false;
      }
    }
    return false;
  }

  if (now - (gHeal.__onyxCloudHealSweepAt ?? 0) < HEAL_CHECK_INTERVAL_MS) return false;
  gHeal.__onyxCloudHealSweepAt = now;

  try {
    const staleBefore = new Date(now - HEAL_STALE_MS);
    const rows = await prisma.taskRun.findMany({
      where: {
        orchestrator: "cloud",
        status: { in: ["queued", "running"] },
        updatedAt: { lt: staleBefore },
      },
      orderBy: { updatedAt: "asc" },
      take: HEAL_BATCH,
    });
    let settled = false;
    for (const row of rows) {
      try {
        settled = (await healRow(config, row, now)) || settled;
      } catch {
        // one bad row must not abort the batch
      }
    }
    return settled;
  } catch {
    return false;
  }
}

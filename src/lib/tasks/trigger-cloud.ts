// ============================================================================
// Background Task Execution Framework — Trigger.dev CLOUD orchestrator
// (DIRECT execution).
//
// The ONLY execution mode: the operator connects a trigger.dev Cloud key
// (Settings → Cloud) and every background task (chat agent runs, sub-agent
// chains, scheduled business tasks, terminal commands) executes durably on
// their own trigger.dev Cloud project — no self-hosting, no local mode, no
// worker callbacks.
//
// Bootstrapping is AUTOMATIC: on connect the app verifies the key
// (GET /api/v1/whoami), and the bundled worker (trigger-worker/) is deployed
// to the operator's cloud project with the key itself
// (`trigger.dev deploy --authorization` accepts environment secret keys —
// TRIGGER_ACCESS_TOKEN). Deployments persist server-side on the cloud, so
// the app only ever needs the key at runtime.
//
// Per-run protocol (NO callbacks — the app pulls everything):
//   · dispatch → POST /api/v1/tasks/agent-run/trigger (full run + credentials)
//   · progress → GET /api/v3/runs/:id → run.metadata.onyx (phase/progress/
//     chunk ring) — synced into the TaskRun row by syncCloudRunIntoRow
//   · result   → the finished run's OUTPUT (status/error/artifacts)
//   · cancel   → POST /api/v2/runs/:id/cancel
//
// CREDENTIAL DISCIPLINE: the API key is sealed with AES-256-GCM into
// TaskCloudConfig (SQLite); plaintext lives ONLY in process memory
// (short-lived config cache). NEVER logged — run ids and statuses only.
// Per-run credentials (E2B key, LLM key pool, task token) ride in the
// trigger payload — scoped to the operator's own cloud project — and die
// with the run.
// ============================================================================

import { spawn } from "node:child_process";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TaskPayloadFile, TaskRunProgress } from "./protocol";
import type { BackgroundTaskType, CloudAgentRunPayload, CloudRunMetadata, CloudRunOutput } from "./protocol";
import { TASK_CLOUD_PAYLOAD_MAX_BYTES } from "./protocol";
import { prisma } from "./prisma";
import { keyring } from "./keyring";
import {
  appendChunksToRun,
  mergeProgressIntoRun,
  parseConfig,
  parsePayload,
  type PendingChunk,
} from "./run-store";

const clampTimeoutMsLocal = (ms: unknown): number => {
  const raw = typeof ms === "number" && Number.isFinite(ms) ? ms : 30 * 60 * 1000;
  return Math.min(Math.max(Math.round(raw), 60_000), 30 * 60 * 1000);
};

// ---------------------------------------------------------------------------
// Secret sealing (AES-256-GCM) — master key from env or the machine key file.
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
      writeFileSync(MACHINE_KEY_FILE, `${key.toString("hex")}\n`, { mode: 0o600 });
    } catch {
      // Read-only fs → ephemeral process key (a restart invalidates the
      // sealed config; the operator re-connects the key).
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

/** Project entry of the verification snapshot (whoami-derived). */
export interface CloudProjectInfo {
  id: string;
  name: string;
  externalRef: string;
  orgSlug: string | null;
  orgName: string | null;
  environments: Array<{ id: string; name: string; slug: string }>;
}

/** Verification snapshot. `partial` = the key could not reveal project
 *  details (PAT-shaped keys) — run links then default to the dashboard. */
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
  verifiedAt: string | null;
  /** True when the server filesystem is read-only (serverless — Netlify etc.)
   *  and the config could NOT be sealed to SQLite. The config lives in
   *  process memory for this instance only; the BROWSER holds the durable
   *  mirror (vault-sealed in Dexie) and re-submits it on the next cold start. */
  ephemeral?: boolean;
}

const CONFIG_TTL_MS = 30_000;
const CONFIG_ROW_ID = "primary";
const DEFAULT_TASK_SLUG = "agent-run";

const gCfg = globalThis as unknown as {
  __onyxCloudConfigCache?: { data: CloudConfig | null; at: number } | null;
  /** Serverless fallback: the config that could NOT be sealed to the
   *  read-only SQLite file. Lives in process memory for this lambda's
   *  lifetime; the browser mirror (cloud-config-store.ts) re-supplies it
   *  after a cold start. */
  __onyxCloudMemoryConfig?: CloudConfig | null;
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

  // 1) Process-memory config (set when a seal FAILED — read-only serverless
  //    filesystem). It always represents the operator's LATEST verified
  //    intent in this process, so it shadows any stale SQLite row.
  let config: CloudConfig | null = gCfg.__onyxCloudMemoryConfig ?? null;

  // 2) Durable SQLite seal.
  if (!config) {
    try {
      const row = await prisma.taskCloudConfig.findUnique({ where: { id: CONFIG_ROW_ID } });
      if (row) {
        const apiKey = openSecret(row.encryptedKey);
        if (apiKey) {
          config = {
            keySource: "settings",
            apiKey,
            maskedKey: row.maskedKey,
            taskSlug: row.taskSlug || DEFAULT_TASK_SLUG,
            account: parseAccountJson(row.accountJson),
            verifiedAt: row.verifiedAt.toISOString(),
          };
        }
      }
    } catch (err) {
      // DB hiccup (schema not pushed yet, read-only filesystem on serverless
      // deployments where even the OPEN can fail) — degrade to env below.
      console.warn(
        `[tasks] cloud config read failed: ${
          err instanceof Error
            ? err.message || JSON.stringify(err).slice(0, 200)
            : String(err)
        }`,
      );
    }
  }

  // 3) Env fallback.
  if (!config) {
    const envKey = process.env.TRIGGER_CLOUD_KEY?.trim();
    if (envKey) {
      config = {
        keySource: "env",
        apiKey: envKey,
        maskedKey: maskSecret(envKey),
        taskSlug: process.env.TRIGGER_CLOUD_TASK_SLUG?.trim() || DEFAULT_TASK_SLUG,
        account: null,
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
  taskSlug?: string;
  account?: CloudAccountSnapshot | null;
}

export interface SaveCloudConfigResult {
  config: CloudConfig;
  /** False when the SQLite seal failed (read-only serverless filesystem) and
   *  the config is held in process memory only (browser mirror re-supplies
   *  it after cold starts). */
  persisted: boolean;
}

/**
 * Persist a VERIFIED key (the caller verifies first — verifyCloudKey). On a
 * read-only filesystem (serverless) the config degrades to process memory
 * (`persisted: false`) instead of failing the connect — the browser keeps
 * the durable, vault-sealed mirror. Returns the resolved config; never logs
 * the key.
 */
export async function saveCloudConfig(
  input: SaveCloudConfigInput,
): Promise<SaveCloudConfigResult> {
  const common = {
    maskedKey: maskSecret(input.apiKey),
    taskSlug: input.taskSlug ?? DEFAULT_TASK_SLUG,
    account: input.account ?? null,
    verifiedAt: new Date().toISOString(),
  };

  try {
    const sealedKey = sealSecret(input.apiKey);
    const rowCommon = {
      maskedKey: common.maskedKey,
      taskSlug: common.taskSlug,
      accountJson: common.account ? JSON.stringify(common.account) : "{}",
      verifiedAt: new Date(),
    };

    await prisma.taskCloudConfig.upsert({
      where: { id: CONFIG_ROW_ID },
      create: {
        id: CONFIG_ROW_ID,
        encryptedKey: sealedKey,
        encryptedWorkerToken: sealSecret(""), // legacy column — unused
        ...rowCommon,
      },
      update: {
        encryptedKey: sealedKey,
        ...rowCommon,
      },
    });

    invalidateCloudConfigCache();
    const config = await getCloudConfig();
    if (!config) throw new Error("cloud config save succeeded but the read-back failed");
    return { config, persisted: !config.ephemeral };
  } catch (err) {
    // READ-ONLY FILESYSTEM (serverless — Netlify/Vercel functions): the
    // SQLite seal is impossible. Hold the verified config in process memory
    // so THIS instance can dispatch runs; the browser mirror re-applies it
    // on the next cold start. The connect UX still succeeds.
    console.warn(
      `[tasks] cloud config seal failed (memory fallback): ${err instanceof Error ? err.message : String(err)}`,
    );
    const config: CloudConfig = {
      keySource: "settings",
      apiKey: input.apiKey,
      maskedKey: common.maskedKey,
      taskSlug: common.taskSlug,
      account: common.account,
      verifiedAt: common.verifiedAt,
      ephemeral: true,
    };
    gCfg.__onyxCloudMemoryConfig = config;
    invalidateCloudConfigCache();
    return { config, persisted: false };
  }
}

/** Update only the task slug (PATCH). */
export async function updateCloudTaskSlug(taskSlug: string): Promise<void> {
  try {
    await prisma.taskCloudConfig.update({
      where: { id: CONFIG_ROW_ID },
      data: { taskSlug },
    });
  } catch {
    // Serverless: the durable seal is unavailable — patch the memory config.
    if (!gCfg.__onyxCloudMemoryConfig) throw new Error("no cloud config to update");
    gCfg.__onyxCloudMemoryConfig = {
      ...gCfg.__onyxCloudMemoryConfig,
      taskSlug,
    };
  }
  invalidateCloudConfigCache();
}

/** Refresh the verification snapshot + verifiedAt (POST action:"retest"). */
export async function refreshCloudAccount(account: CloudAccountSnapshot): Promise<void> {
  try {
    await prisma.taskCloudConfig.update({
      where: { id: CONFIG_ROW_ID },
      data: { accountJson: JSON.stringify(account), verifiedAt: new Date() },
    });
  } catch {
    // Serverless: refresh the memory config instead.
    if (!gCfg.__onyxCloudMemoryConfig) throw new Error("no cloud config to refresh");
    gCfg.__onyxCloudMemoryConfig = {
      ...gCfg.__onyxCloudMemoryConfig,
      account,
      verifiedAt: new Date().toISOString(),
    };
  }
  invalidateCloudConfigCache();
}

/** Disconnect — delete the stored config. Always succeeds client-side: on a
 *  read-only filesystem there is nothing to delete and the memory config is
 *  simply dropped. */
export async function clearCloudConfig(): Promise<void> {
  try {
    await prisma.taskCloudConfig.deleteMany({ where: { id: CONFIG_ROW_ID } });
  } catch {
    // read-only filesystem — nothing persisted server-side anyway
  }
  gCfg.__onyxCloudMemoryConfig = null;
  invalidateCloudConfigCache();
}

/** Dashboard base for run links (from the whoami snapshot). */
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
  init?: { method?: string; body?: unknown; timeoutMs?: number },
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
      signal: AbortSignal.timeout(init?.timeoutMs ?? REQUEST_TIMEOUT_MS),
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
 * Verify a key against api.trigger.dev via GET /api/v1/whoami — the
 * environment-keyed identity endpoint. For environment secret keys
 * (tr_prod_sk_ / tr_dev_sk_ / tr_trigger_ / …) it returns the full
 * environment + project + organization snapshot (including the project
 * externalRef used for the automatic worker deploy + dashboard links).
 * PAT-shaped keys (tr_pat_) answer a different shape and degrade to a
 * `partial` snapshot (project details are only enumerable via the
 * PAT-only /api/v1/projects listing — not needed to orchestrate runs).
 */
export async function verifyCloudKey(apiKey: string): Promise<VerifyCloudKeyResult> {
  let data: unknown;
  try {
    data = await cloudRequest(apiKey, "/api/v1/whoami");
  } catch (err) {
    if (err instanceof CloudApiError && err.status === 401) {
      return {
        ok: false,
        status: 401,
        error:
          "api.trigger.dev rejected the key — check that it is valid, not expired, and copied in full from cloud.trigger.dev (API keys page).",
      };
    }
    if (err instanceof CloudApiError && err.status === 403) {
      return {
        ok: false,
        status: 403,
        error:
          "The key authenticated but lacks the access this app needs — use an environment secret key (tr_prod_sk_… / tr_dev_sk_…) with the Operator or No-restrictions preset (cloud.trigger.dev → API keys).",
      };
    }
    if (err instanceof CloudApiError && err.status === 429) {
      return { ok: false, status: 429, error: "Rate limited by api.trigger.dev — try again in a moment." };
    }
    return { ok: false, status: 0, error: errorMessage(err) };
  }

  if (!data || typeof data !== "object") {
    return { ok: false, status: 0, error: "api.trigger.dev returned an unexpected whoami response" };
  }
  const w = data as Record<string, unknown>;
  const project = (w.project && typeof w.project === "object" ? w.project : {}) as Record<string, unknown>;
  const org =
    (w.organization && typeof w.organization === "object" ? w.organization : {}) as Record<string, unknown>;

  if (field(project.externalRef)) {
    // Environment secret key — full snapshot.
    return {
      ok: true,
      account: {
        partial: false,
        projects: [
          {
            id: field(project.id),
            name: field(project.name, "project"),
            externalRef: field(project.externalRef),
            orgSlug: field(org.slug) || null,
            orgName: field(org.title) || null,
            environments: [
              {
                id: field(w.id),
                name: field(w.type, "environment"),
                slug: field(w.slug, "prod"),
              },
            ],
          },
        ],
      },
    };
  }

  // PAT-shaped key — accept with a partial snapshot (orchestration works;
  // project detail links default to the dashboard root).
  return {
    ok: true,
    account: {
      partial: true,
      note: "Key verified. Project details are only visible to environment secret keys — run links default to the dashboard root.",
      projects: [],
    },
  };
}

// ---------------------------------------------------------------------------
// Run dispatch + state (direct cloud execution).
// ---------------------------------------------------------------------------

/** Trigger the deployed agent-run task (POST /api/v1/tasks/:id/trigger)
 * with the FULL direct-execution payload → the cloud run id. */
export async function triggerCloudTaskRun(
  config: Pick<CloudConfig, "apiKey" | "taskSlug">,
  payload: unknown,
  options?: { tags?: string[] },
): Promise<string> {
  const run = (await cloudRequest(
    config.apiKey,
    `/api/v1/tasks/${encodeURIComponent(config.taskSlug)}/trigger`,
    {
      method: "POST",
      body: { payload, ...(options?.tags ? { options: { tags: options.tags } } : {}) },
      timeoutMs: 20_000,
    },
  )) as { id?: unknown };
  const id = field(run?.id);
  if (!id) throw new CloudApiError(0, "api.trigger.dev returned no run id");
  return id;
}

export type CloudRunState =
  | { status: "completed" }
  | { status: "cancelled" }
  | { status: "failed"; error?: string }
  | { status: "live" };

/** A raw /api/v3/runs/:id object — status + metadata + output + error. */
export interface CloudRunView {
  state: CloudRunState;
  /** The task's `onyx` metadata blob (progress + chunk ring), when present. */
  metadata: CloudRunMetadata | null;
  /** The task's return value (terminal runs only). */
  output: CloudRunOutput | null;
  /** Cloud error message for failed runs. */
  error: string | null;
  version: string | null;
}

/** Fetch a cloud run (GET /api/v3/runs/:id) and normalize it into the view
 * the sync path consumes. Null when the run can't be read. */
export async function fetchCloudRunView(
  config: Pick<CloudConfig, "apiKey">,
  cloudRunId: string,
): Promise<CloudRunView | null> {
  let run: unknown;
  try {
    run = await cloudRequest(config.apiKey, `/api/v3/runs/${encodeURIComponent(cloudRunId)}`);
  } catch {
    return null;
  }
  if (!run || typeof run !== "object") return null;
  const r = run as {
    status?: unknown;
    isFailed?: unknown;
    isCancelled?: unknown;
    isSuccess?: unknown;
    error?: { message?: unknown } | null;
    metadata?: Record<string, unknown> | null;
    output?: Record<string, unknown> | null;
    version?: unknown;
  };

  // isCancelled outranks isFailed — the cloud marks CANCELED runs with BOTH
  // flags true (verified live), and "cancelled" is the honest user-facing
  // outcome for a deliberate cancel.
  const raw = String(r.status ?? "").toLowerCase();
  let state: CloudRunState;
  if (r.isCancelled === true || raw === "canceled" || raw === "cancelled") {
    state = { status: "cancelled" };
  } else if (r.isSuccess === true || raw === "completed" || raw === "complete" || raw === "success") {
    state = { status: "completed" };
  } else if (r.isFailed === true || raw === "failed") {
    state = {
      status: "failed",
      error: field(r.error?.message) || undefined,
    };
  } else if (raw === "timed_out" || raw === "timeout" || raw === "expired") {
    state = { status: "failed", error: "the run timed out on Trigger.dev Cloud" };
  } else {
    // QUEUED / EXECUTING / WAITING / DELAYED / PENDING_VERSION /
    // WAITING_FOR_DEPLOY / CANCELLING … — still in flight.
    state = { status: "live" };
  }

  const metaRaw = r.metadata?.["onyx"];
  let metadata: CloudRunMetadata | null = null;
  if (metaRaw && typeof metaRaw === "object") {
    const m = metaRaw as Partial<CloudRunMetadata>;
    if (m && typeof m === "object" && m.progress && typeof m.progress === "object") {
      metadata = {
        phase: m.phase ?? "init",
        progress: m.progress as TaskRunProgress,
        chunkSeq: typeof m.chunkSeq === "number" ? m.chunkSeq : 0,
        chunks: Array.isArray(m.chunks) ? m.chunks : [],
        updatedAt: typeof m.updatedAt === "number" ? m.updatedAt : Date.now(),
      };
    }
  }

  let output: CloudRunOutput | null = null;
  if (r.output && typeof r.output === "object" && Array.isArray((r.output as { artifacts?: unknown }).artifacts)) {
    output = r.output as unknown as CloudRunOutput;
  }

  return {
    state,
    metadata,
    output,
    error: field(r.error?.message) || null,
    version: field(r.version) || null,
  };
}

/** Back-compat shim: just the terminal/live state of a cloud run. */
export async function fetchCloudRunState(
  config: Pick<CloudConfig, "apiKey">,
  cloudRunId: string,
): Promise<CloudRunState | null> {
  const view = await fetchCloudRunView(config, cloudRunId);
  return view?.state ?? null;
}

/** Cancel a cloud run (POST /api/v2/runs/:id/cancel — the documented cancel
 * endpoint; 200 → { id }). 404/409 are fine — the run already reached a
 * terminal state. Best-effort by contract. */
export async function cancelCloudRunById(
  config: Pick<CloudConfig, "apiKey">,
  cloudRunId: string,
): Promise<void> {
  try {
    await cloudRequest(config.apiKey, `/api/v2/runs/${encodeURIComponent(cloudRunId)}/cancel`, {
      method: "POST",
    });
  } catch (err) {
    if (err instanceof CloudApiError && (err.status === 404 || err.status === 409)) return;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Dispatch — send a queued TaskRun directly to the cloud agent-run task.
// ---------------------------------------------------------------------------

export type CloudDispatchResult =
  | { ok: true; cloudRunId: string }
  | { ok: false; error: string };

/** Clamp the serialized cloud trigger payload under the REST ceiling by
 * dropping payload FILES largest-first (names stay honest — the run simply
 * starts with the newest/smallest subset). Conversation text is tiny and
 * always kept. */
function clampCloudPayload(payload: CloudAgentRunPayload): CloudAgentRunPayload {
  let files: TaskPayloadFile[] = [...payload.run.payload.files];
  while (true) {
    const candidate: CloudAgentRunPayload = {
      ...payload,
      run: { ...payload.run, payload: { ...payload.run.payload, files } },
    };
    if (JSON.stringify(candidate).length <= TASK_CLOUD_PAYLOAD_MAX_BYTES || files.length === 0) {
      return candidate;
    }
    // Drop the largest file (decoded size, then content length as tiebreak).
    let largestIdx = 0;
    for (let i = 1; i < files.length; i++) {
      const a = files[i]!;
      const b = files[largestIdx]!;
      if (a.size > b.size || (a.size === b.size && a.content.length > b.content.length)) {
        largestIdx = i;
      }
    }
    files = files.filter((_, i) => i !== largestIdx);
  }
}

/**
 * Direct cloud dispatch: atomically claim the queued run (CAS on status
 * "queued" — the double-dispatch fence), build the full direct-execution
 * payload from the row + keyring entry, and POST it to the deployed
 * agent-run task. The resulting cloud run id is persisted to
 * TaskRun.externalRunId.
 *
 * On failure the run FAILS with the cloud error — there is no backstop
 * dispatcher anymore (the deployed worker IS the executor); the message is
 * surfaced to the client.
 */
export async function dispatchCloudRun(
  runId: string,
  fallbackAppUrl: string,
): Promise<CloudDispatchResult> {
  const config = await getCloudConfig();
  if (!config) {
    return { ok: false, error: "Trigger.dev Cloud is not connected — add your API key in Settings → Cloud." };
  }

  const lockHolder = `cloud-dispatch:${randomUUID().slice(0, 8)}`;
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
    return { ok: false, error: "run was already claimed by another dispatcher" };
  }

  const row = await prisma.taskRun.findUnique({ where: { id: runId } });
  if (!row) return { ok: false, error: "run row disappeared before dispatch" };

  const entry = keyring.get(runId);
  const runConfig = parseConfig(row.config);

  // Resolve the app origin the sandbox runner can reach for the keyless LLM
  // bridge fallback (APP_URL wins — behind proxies the request origin can
  // be an internal address).
  const appUrl = (process.env.APP_URL?.trim() || fallbackAppUrl).replace(/\/+$/, "");

  // LLM endpoint resolution (mirrors runner-config.ts):
  //   · pinned provider gateway (config.chatUrl) — bearer = first pool key,
  //   · otherwise the app's keyless bridge (/api/tasks/llm) — bearer = the
  //     task token (pool keys are NOT rotated against the bridge).
  const usingBridge = !runConfig.chatUrl?.trim();
  const chatUrl = usingBridge ? `${appUrl}/api/tasks/llm` : runConfig.chatUrl!.trim();
  const pool = entry?.keyPool ?? [];
  const chatToken = usingBridge ? (entry?.taskToken ?? "") : (pool[0] ?? entry?.taskToken ?? "");

  // E2B key: explicit per-run key, else the server env.
  const explicitE2b = entry?.e2bApiKey?.trim() && entry.e2bApiKey !== "USE_SERVER_ENV"
    ? entry.e2bApiKey
    : "";
  const e2bApiKey = explicitE2b || process.env.E2B_API_KEY?.trim() || "";

  const fullPayload: CloudAgentRunPayload = {
    run: {
      runId: row.id,
      type: row.type as BackgroundTaskType,
      prompt: row.prompt,
      config: runConfig,
      payload: parsePayload(row.payload),
      startedAt: row.startedAt.toISOString(),
      timeoutMs: clampTimeoutMsLocal(runConfig.timeoutMs),
    },
    credentials: {
      e2bApiKey,
      chatUrl,
      chatToken,
      keyPool: usingBridge ? [] : pool,
    },
  };
  const cloudPayload = clampCloudPayload(fullPayload);

  try {
    const cloudRunId = await triggerCloudTaskRun(config, cloudPayload, {
      tags: [`run:${row.id}`],
    });
    await prisma.taskRun
      .update({ where: { id: runId }, data: { externalRunId: cloudRunId } })
      .catch(() => {
        // best-effort persistence — the status sync reconciles from the
        // cloud run state regardless.
      });
    console.log(
      `[tasks] run ${runId} dispatched to Trigger.dev Cloud via task "${config.taskSlug}" (${cloudRunId})`,
    );
    return { ok: true, cloudRunId };
  } catch (err) {
    const message = errorMessage(err).slice(0, 400);
    await prisma.taskRun
      .updateMany({
        where: { id: runId, status: "running", lockHolder },
        data: {
          status: "failed",
          phase: "finalize",
          error: `Trigger.dev Cloud dispatch failed: ${message}`,
          finishedAt: new Date(),
          lockHolder: null,
          lockedAt: null,
        },
      })
      .catch(() => {
        // settle failure — the status sync still reconciles from the cloud.
      });
    keyring.drop(runId);
    console.warn(`[tasks] cloud dispatch failed for run ${runId}: ${message}`);
    return { ok: false, error: message };
  }
}

// ---------------------------------------------------------------------------
// Status sync — pull run metadata (progress + chunks) and terminal output
// into the TaskRun row. Called by the status routes on every poll.
// ---------------------------------------------------------------------------

/** Progress column marker for the last synced WORKER chunk seq (worker seq
 * space — distinct from the row's local chunkSeq assignment space). */
const CLOUD_CHUNK_SEQ_KEY = "cloudChunkSeq";

/** Map a TaskPhase from the cloud metadata phase (worker phases ⊂ TaskPhase). */
function metadataPhaseToTaskPhase(phase: CloudRunMetadata["phase"]): string {
  return phase; // same vocabulary as the local driver phases
}

/**
 * Sync one cloud-orchestrated run from its cloud state:
 *   · live runs — merge metadata progress + append new chunks (worker ring
 *     seq > last synced marker),
 *   · terminal runs — settle the row (status/phase/finishedAt/error) and
 *     persist the output artifacts as TaskArtifact rows (idempotent on
 *     re-sync via the terminal-status CAS).
 * Returns true when the row changed.
 */
export async function syncCloudRunIntoRow(runId: string): Promise<boolean> {
  const config = await getCloudConfig();
  if (!config) return false;
  const row = await prisma.taskRun.findUnique({ where: { id: runId } });
  if (!row || row.orchestrator !== "cloud") return false;
  if (["completed", "failed", "cancelled"].includes(row.status)) return false;
  if (!row.externalRunId) return false;

  const view = await fetchCloudRunView(config, row.externalRunId).catch(() => null);
  if (!view) return false;

  let changed = false;

  // ── Live progress (metadata) ────────────────────────────────────────────
  if (view.metadata) {
    const meta = view.metadata;
    const prevProgress = (() => {
      try {
        return JSON.parse(row.progress || "{}") as Record<string, unknown>;
      } catch {
        return {} as Record<string, unknown>;
      }
    })();
    const lastSyncedWorkerSeq = typeof prevProgress[CLOUD_CHUNK_SEQ_KEY] === "number"
      ? (prevProgress[CLOUD_CHUNK_SEQ_KEY] as number)
      : 0;

    const newChunks: PendingChunk[] = meta.chunks
      .filter((c) => typeof c?.seq === "number" && c.seq > lastSyncedWorkerSeq)
      .map((c) => ({
        kind: c.kind,
        ...(typeof c.round === "number" ? { round: c.round } : {}),
        ...(c.name ? { name: c.name } : {}),
        content: String(c.content ?? ""),
        ts: typeof c.ts === "number" ? c.ts : Date.now(),
      }));
    if (newChunks.length > 0) {
      await appendChunksToRun(runId, newChunks);
      changed = true;
    }

    const { [CLOUD_CHUNK_SEQ_KEY]: _dropped, ...progressPatch } = meta.progress as unknown as Record<string, unknown>;
    const patch: Partial<TaskRunProgress> & Record<string, unknown> = {
      ...progressPatch,
      ...(meta.chunkSeq > lastSyncedWorkerSeq
        ? { [CLOUD_CHUNK_SEQ_KEY]: meta.chunkSeq }
        : {}),
    };
    await mergeProgressIntoRun(runId, patch as Partial<TaskRunProgress>);
    if (meta.chunkSeq > lastSyncedWorkerSeq || newChunks.length > 0) changed = true;

    const phase = metadataPhaseToTaskPhase(meta.phase);
    const sandboxId = row.sandboxId ?? (view.output?.sandboxId ?? null);
    await prisma.taskRun
      .updateMany({
        where: { id: runId, status: { in: ["queued", "running"] } },
        data: { ...(phase !== row.phase ? { phase } : {}), ...(sandboxId ? { sandboxId } : {}) },
      })
      .catch(() => undefined);
    if (phase !== row.phase) changed = true;
  }

  // ── Terminal settle (output artifacts) ──────────────────────────────────
  if (view.state.status !== "live") {
    const output = view.output;
    const error =
      view.state.status === "failed"
        ? (view.state.error ?? output?.error ?? view.error ?? "the run failed on Trigger.dev Cloud")
        : null;

    const settled = await prisma.taskRun.updateMany({
      where: { id: runId, status: { in: ["queued", "running"] } },
      data: {
        status: view.state.status,
        phase: "done",
        error,
        finishedAt: new Date(),
        lockHolder: null,
        lockedAt: null,
        ...(output?.sandboxId ? { sandboxId: output.sandboxId } : {}),
      },
    });

    if (settled.count > 0) {
      changed = true;
      keyring.drop(runId);
      // Persist output artifacts exactly once (guarded by the terminal CAS
      // above — only the settler writes them).
      const artifacts = output?.artifacts ?? [];
      if (artifacts.length > 0) {
        await prisma.taskArtifact
          .createMany({
            data: artifacts.map((a) => ({
              runId,
              kind: a.kind,
              name: a.name.slice(0, 200),
              path: a.path ?? null,
              mimeType: a.mimeType ?? "text/plain",
              content: a.content,
              encoding: a.encoding ?? "utf8",
              size: a.content.length,
              truncated: a.truncated === true,
            })),
          })
          .catch((err) => {
            console.warn(
              `[tasks] artifact persist failed for ${runId}: ${err instanceof Error ? err.message : String(err)}`,
            );
          });
      }
      console.log(`[tasks] run ${runId} settled from cloud state: ${view.state.status}`);
    }
    return changed;
  }

  return changed;
}

/** Row must be untouched this long before the unscoped batch sweep touches
 * it (the scoped single-run sync has no throttle — a watching user gets
 * freshness on every poll). */
const SYNC_BATCH_INTERVAL_MS = 30_000;
/** Stale rows synced per batch sweep. */
const SYNC_BATCH = 3;

const gSync = globalThis as unknown as { __onyxCloudSyncSweepAt?: number };

/**
 * Sweep-on-read sync (list view): throttled batch over non-terminal cloud
 * rows. With `scopeRunId` it syncs exactly that run with no throttle.
 * Returns true when anything changed.
 */
export async function healStaleCloudRuns(scopeRunId?: string): Promise<boolean> {
  const config = await getCloudConfig();
  if (!config) return false;

  if (scopeRunId) {
    try {
      return await syncCloudRunIntoRow(scopeRunId);
    } catch {
      return false;
    }
  }

  const now = Date.now();
  if (now - (gSync.__onyxCloudSyncSweepAt ?? 0) < SYNC_BATCH_INTERVAL_MS) return false;
  gSync.__onyxCloudSyncSweepAt = now;

  try {
    const rows = await prisma.taskRun.findMany({
      where: {
        orchestrator: "cloud",
        status: { in: ["queued", "running"] },
        externalRunId: { not: null },
      },
      orderBy: { updatedAt: "asc" },
      take: SYNC_BATCH,
    });
    let changed = false;
    for (const row of rows) {
      try {
        changed = (await syncCloudRunIntoRow(row.id)) || changed;
      } catch {
        // one bad row must not abort the batch
      }
    }
    return changed;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Worker bootstrap — liveness probe + automatic deploy on connect.
// ---------------------------------------------------------------------------

export type WorkerLiveness = "live" | "deploying" | "undeployed" | "unknown";

export interface WorkerBootstrapState {
  liveness: WorkerLiveness;
  /** ISO timestamp of the last liveness probe. */
  probedAt: string | null;
  /** Deploy subprocess state (when an auto-deploy was started). */
  deploy: {
    state: "running" | "succeeded" | "failed" | "unavailable";
    startedAt: string | null;
    finishedAt: string | null;
    /** Last log lines (deploy only — never contains the key). */
    tail: string[];
  } | null;
}

const WORKER_DIR = join(process.cwd(), "trigger-worker");
const DEPLOY_STATE_FILE = join(process.cwd(), "db", "cloud-worker-deploy.json");

const gBoot = globalThis as unknown as {
  __onyxWorkerLiveness?: { value: WorkerLiveness; at: number } | null;
  __onyxWorkerDeploy?: NonNullable<WorkerBootstrapState["deploy"]> | null;
};

/** Probe the deployed worker's liveness: trigger the `health` task and wait
 * briefly for it to execute. COMPLETED → live; PENDING_VERSION /
 * WAITING_FOR_DEPLOY → undeployed (no live deployment with the task);
 * anything else → unknown. Cached ~60s per process. */
export async function probeWorkerLiveness(
  config?: Pick<CloudConfig, "apiKey">,
  opts?: { skipCache?: boolean },
): Promise<WorkerLiveness> {
  const cached = gBoot.__onyxWorkerLiveness;
  if (!opts?.skipCache && cached && Date.now() - cached.at < 60_000) {
    return cached.value;
  }
  const cfg = config ?? (await getCloudConfig());
  if (!cfg) return "unknown";

  const setCache = (value: WorkerLiveness) => {
    gBoot.__onyxWorkerLiveness = { value, at: Date.now() };
    return value;
  };

  try {
    const runId = await triggerCloudTaskRun({ ...cfg, taskSlug: "health" }, {});
    // Poll briefly — the health task completes in ~1-3s.
    for (let i = 0; i < 10; i++) {
      await new Promise((resolve) => setTimeout(resolve, 600));
      const view = await fetchCloudRunView(cfg, runId).catch(() => null);
      if (!view) continue;
      if (view.state.status === "completed") return setCache("live");
      if (view.state.status === "failed") return setCache("live"); // deployed but the probe failed — still deployed
      if (view.state.status === "live") {
        const raw = await cloudRequest(cfg.apiKey, `/api/v3/runs/${encodeURIComponent(runId)}`)
          .then((r) => (r as { status?: string }).status ?? "")
          .catch(() => "");
        if (raw === "PENDING_VERSION" || raw === "WAITING_FOR_DEPLOY") {
          return setCache("undeployed");
        }
      }
    }
    // Still executing after the window — a deployment exists (undeployed
    // runs resolve to PENDING_VERSION immediately, which we check above).
    return setCache("unknown");
  } catch {
    return setCache("unknown");
  }
}

/** Load (or initialize) the deploy-subprocess state. */
function loadDeployState(): NonNullable<WorkerBootstrapState["deploy"]> {
  if (gBoot.__onyxWorkerDeploy) return gBoot.__onyxWorkerDeploy;
  try {
    const raw = readFileSync(DEPLOY_STATE_FILE, "utf8");
    const parsed = JSON.parse(raw) as NonNullable<WorkerBootstrapState["deploy"]>;
    if (parsed && typeof parsed === "object" && parsed.state) return parsed;
  } catch {
    /* no state file yet */
  }
  return { state: "unavailable", startedAt: null, finishedAt: null, tail: [] };
}

function saveDeployState(state: NonNullable<WorkerBootstrapState["deploy"]>): void {
  gBoot.__onyxWorkerDeploy = state;
  try {
    writeFileSync(DEPLOY_STATE_FILE, JSON.stringify(state, null, 2));
  } catch {
    // read-only fs — process memory only
  }
}

/**
 * Automatically deploy the bundled worker (trigger-worker/) to the
 * operator's cloud project using their own key. Requires a writable
 * filesystem + node/npx (the sandbox / local dev / any long-lived server);
 * serverless deployments are read-only by design and skip this — the cloud
 * deployment persists server-side and only needs re-deploying when the
 * worker code changes, which happens from a checkout anyway.
 */
export async function autoDeployWorker(config: CloudConfig): Promise<WorkerBootstrapState["deploy"]> {
  const state = loadDeployState();
  if (state.state === "running") return state; // already in flight

  // Writability gate (serverless skip).
  try {
    const { accessSync, constants } = await import("node:fs");
    accessSync(WORKER_DIR, constants.W_OK);
  } catch {
    const unavailable: NonNullable<WorkerBootstrapState["deploy"]> = {
      state: "unavailable",
      startedAt: null,
      finishedAt: null,
      tail: ["Auto-deploy skipped — this server has a read-only filesystem. Deployments persist on trigger.dev Cloud; re-deploy from a local checkout when the worker changes."],
    };
    saveDeployState(unavailable);
    return unavailable;
  }

  const account = config.account?.projects?.[0];
  const projectRef = account?.externalRef || process.env.TRIGGER_PROJECT_REF?.trim();
  if (!projectRef) {
    const failed: NonNullable<WorkerBootstrapState["deploy"]> = {
      state: "failed",
      startedAt: null,
      finishedAt: new Date().toISOString(),
      tail: ["Cannot resolve the cloud project ref — re-connect the key (whoami did not return project details)."],
    };
    saveDeployState(failed);
    return failed;
  }

  const started: NonNullable<WorkerBootstrapState["deploy"]> = {
    state: "running",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    tail: [`deploying worker to project ${projectRef}…`],
  };
  saveDeployState(started);
  gBoot.__onyxWorkerLiveness = null;

  const logLines: string[] = [];
  const pushLog = (line: string) => {
    logLines.push(line.replace(/tr_[A-Za-z0-9_]+/g, "tr_•••••")); // never log keys
    if (logLines.length > 40) logLines.shift();
  };

  try {
    const child = spawn(
      "npx",
      ["--yes", "trigger.dev@latest", "deploy", "--env", "prod", "--plain", "--skip-update-check"],
      {
        cwd: WORKER_DIR,
        env: {
          ...process.env,
          TRIGGER_ACCESS_TOKEN: config.apiKey,
          TRIGGER_PROJECT_REF: projectRef,
          npm_config_yes: "true",
        },
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    child.stdout?.on("data", (d) => {
      for (const line of d.toString().split("\n")) {
        const trimmed = line.replace(/\u001b\[[0-9;]*[a-zA-Z]/g, "").trim();
        if (trimmed) pushLog(trimmed);
      }
    });
    child.stderr?.on("data", (d) => {
      for (const line of d.toString().split("\n")) {
        const trimmed = line.replace(/\u001b\[[0-9;]*[a-zA-Z]/g, "").trim();
        if (trimmed && !trimmed.startsWith("npm warn")) pushLog(trimmed);
      }
    });
    child.on("error", (err) => {
      saveDeployState({
        state: "failed",
        startedAt: started.startedAt,
        finishedAt: new Date().toISOString(),
        tail: [...logLines, `spawn failed: ${err.message}`].slice(-40),
      });
    });
    child.on("close", (code) => {
      const ok = code === 0;
      saveDeployState({
        state: ok ? "succeeded" : "failed",
        startedAt: started.startedAt,
        finishedAt: new Date().toISOString(),
        tail: [...logLines, ok ? "deployment completed" : `deploy exited with code ${code}`].slice(-40),
      });
      gBoot.__onyxWorkerLiveness = null;
    });
    return started;
  } catch (err) {
    const failed: NonNullable<WorkerBootstrapState["deploy"]> = {
      state: "failed",
      startedAt: started.startedAt,
      finishedAt: new Date().toISOString(),
      tail: [...logLines, errorMessage(err)].slice(-40),
    };
    saveDeployState(failed);
    return failed;
  }
}

/** Current bootstrap state (liveness + deploy subprocess) for the UI. */
export async function getWorkerBootstrapState(
  opts?: { skipCache?: boolean },
): Promise<WorkerBootstrapState> {
  const config = await getCloudConfig();
  if (!config) {
    return { liveness: "unknown", probedAt: null, deploy: null };
  }
  const liveness = await probeWorkerLiveness(config, opts);
  return {
    liveness,
    probedAt: new Date().toISOString(),
    deploy: loadDeployState(),
  };
}

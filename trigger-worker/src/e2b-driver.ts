// ============================================================================
// OnyxAgent cloud worker — E2B sandbox driver (direct cloud execution).
//
// The sandbox execution core shared by the agent-run task: creates the task
// sandbox (PRD §4.2 — hard 30-minute window) with the run's OWN E2B key
// (payload.credentials.e2bApiKey — no server env), mounts the serialized
// client workspace (FR-4.1 .onyxagent_files.json manifest + verification),
// launches the headless runner or a terminal command, polls their
// file-based status protocol, and collects artifacts (FR-2.3) for the run
// output. Mirrors the app's local driver semantics.
// ============================================================================

import { Sandbox } from "@e2b/code-interpreter";
import type {
  AgentRunPayload,
  CloudArtifact,
  OnyxAgentFilesManifest,
  TaskPayload,
  TaskPayloadFile,
} from "./protocol.js";
import {
  MANIFEST_PATH,
  TASK_ARTIFACT_EXCLUDES,
  TASK_MAX_DURATION_MS,
  TASK_PAYLOAD_BUDGET,
} from "./protocol.js";
import { HEADLESS_RUNNER_PY } from "./runner-source.js";
import { clampMaxRounds } from "./util.js";

/** Sandbox workspace root (matches the app's chat sandbox layout). */
const HOME = "/home/user";

export interface MountReport {
  filesListed: number;
  filesMounted: number;
  filesVerified: number;
  missing: string[];
}

// ---------------------------------------------------------------------------
// Sandbox lifecycle
// ---------------------------------------------------------------------------

/** Create a dedicated task sandbox. The E2B key ALWAYS comes from the run
 *  payload (the app resolved it from the triggering client's vault or its
 *  server env). The sandbox window follows the run's execution window
 *  (PRD §4 timeout freedom — up to TASK_MAX_DURATION_MS = 2h); when the
 *  account's tier rejects the larger window the create is retried once at
 *  the legacy 30-minute cap so long-horizon runs still execute, just with a
 *  shorter live window. */
export async function createTaskSandbox(
  run: AgentRunPayload["run"],
  e2bApiKey: string,
): Promise<Sandbox> {
  const apiKey = e2bApiKey.trim();
  if (!apiKey) {
    throw new Error(
      "No E2B sandbox key available for this run — add one in Settings → Sandboxes (or set E2B_API_KEY on the app server) and retry.",
    );
  }
  const requestedMs = Math.min(
    Number.isFinite(run.timeoutMs) ? run.timeoutMs : 30 * 60 * 1000,
    TASK_MAX_DURATION_MS,
  );
  const create = (timeoutMs: number) =>
    Sandbox.create({
      apiKey,
      timeoutMs,
      metadata: {
        "onyx-app": "onyx",
        "onyx-scope": "background-task-worker",
        "onyx-task": run.runId,
      },
    });
  try {
    return await create(requestedMs);
  } catch (err) {
    if (requestedMs <= 30 * 60 * 1000) throw err;
    // Tier caps the window — fall back to the 30-minute legacy cap.
    return await create(30 * 60 * 1000);
  }
}

/** Best-effort kill — never throws (finalize must not fail on cleanup). */
export async function killQuiet(sandbox: Sandbox | null): Promise<void> {
  if (!sandbox) return;
  try {
    await sandbox.kill();
  } catch {
    // Already dead / network blip — nothing to do.
  }
}

// ---------------------------------------------------------------------------
// Mount + verify (FR-4.1)
// ---------------------------------------------------------------------------

/** Recursively walk the sandbox filesystem from `dir` (bounded). */
async function walkFiles(
  sandbox: Sandbox,
  dir = HOME,
  depth = 0,
  out: Array<{ path: string; size: number }> = [],
): Promise<Array<{ path: string; size: number }>> {
  if (depth > 8 || out.length > 500) return out;
  const entries = await sandbox.files.list(dir).catch(() => []);
  for (const entry of entries) {
    const entryPath = entry.path ?? `${dir}/${entry.name}`;
    if (entry.type === "dir") {
      await walkFiles(sandbox, entryPath, depth + 1, out);
    } else {
      out.push({ path: entryPath, size: entry.size ?? 0 });
    }
  }
  return out;
}

function sandboxPath(rel: string): string {
  const clean = rel.replace(/^\/+/, "");
  return `${HOME}/${clean}`;
}

/** Write the manifest of mounted files (FR-4.1). */
async function writeManifest(
  sandbox: Sandbox,
  runId: string,
  files: TaskPayloadFile[],
): Promise<OnyxAgentFilesManifest> {
  const manifest: OnyxAgentFilesManifest = {
    version: 1,
    runId,
    createdAt: new Date().toISOString(),
    files: files.map((f) => ({
      path: f.path,
      size: f.size,
      sha256: f.sha256,
      source: f.source,
    })),
  };
  await sandbox.files.write(sandboxPath(MANIFEST_PATH), JSON.stringify(manifest));
  return manifest;
}

/** Mount the payload workspace + write the manifest. Returns the manifest. */
export async function mountPayload(
  sandbox: Sandbox,
  run: AgentRunPayload["run"],
): Promise<OnyxAgentFilesManifest> {
  const files = ((run.payload as TaskPayload)?.files ?? []) as TaskPayloadFile[];
  for (const file of files) {
    const target = sandboxPath(file.path);
    if (file.encoding === "base64") {
      const bytes = Buffer.from(file.content, "base64");
      const arrayBuffer = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer;
      await sandbox.files.write(target, arrayBuffer);
    } else {
      await sandbox.files.write(target, file.content);
    }
  }
  return writeManifest(sandbox, run.runId, files);
}

/** Verify every manifest entry landed with a matching size (FR-4.1). */
export async function verifyMount(
  sandbox: Sandbox,
  manifest: OnyxAgentFilesManifest,
): Promise<MountReport> {
  const present = new Map<string, number>();
  for (const entry of await walkFiles(sandbox)) present.set(entry.path, entry.size);

  let verified = 0;
  const missing: string[] = [];
  for (const file of manifest.files) {
    const target = sandboxPath(file.path);
    const size = present.get(target);
    if (size === undefined) {
      missing.push(file.path);
    } else if (size === file.size) {
      verified += 1;
    } else {
      missing.push(file.path);
    }
  }
  return {
    filesListed: manifest.files.length,
    filesMounted: manifest.files.length - missing.length,
    filesVerified: verified,
    missing,
  };
}

// ---------------------------------------------------------------------------
// Start (agent runner or terminal command)
// ---------------------------------------------------------------------------

interface AgentStatus {
  status?: string;
  stage?: string;
  round?: number;
  total_rounds?: number;
  current_tool?: string | null;
  last_update?: number;
  error?: string | null;
}

interface HistoryEntry {
  role?: string;
  content?: string;
  tool_calls?: Array<{
    id?: string;
    name?: string;
    args?: unknown;
    result?: unknown;
  }>;
}

/** Launch the headless agent runner (mirrors the app's agent_start). The
 *  LLM endpoint + credentials ride in the run payload — resolved by the app
 *  (user provider gateway + rotational key pool, or the app's own bridge). */
export async function startAgentRunner(
  sandbox: Sandbox,
  run: AgentRunPayload["run"],
  credentials: AgentRunPayload["credentials"],
): Promise<void> {
  // 1. Runner source (stdlib-only Python, runner v2 — key-pool rotation).
  await sandbox.files.write(`${HOME}/headless_runner.py`, HEADLESS_RUNNER_PY);

  // 2. Run config — credentials live ONLY here (chmod 600) and die with
  //    the sandbox (PRD §4.2 credential sandboxing).
  const runConfig = {
    run_id: run.runId,
    conversation_id: run.payload.conversation.id,
    prompt: run.prompt,
    chat_url: credentials.chatUrl,
    api_key: credentials.chatToken,
    api_key_pool: credentials.keyPool,
    model: run.config.model ?? "",
    system_prompt: run.config.systemPrompt ?? "",
    seed_messages: run.payload.conversation.messages,
    temperature:
      typeof run.config.temperature === "number" ? run.config.temperature : null,
    max_rounds: clampMaxRounds(run.config.maxRounds),
  };
  await sandbox.files.write(
    `${HOME}/.onyx/agent/run.json`,
    JSON.stringify(runConfig),
  );
  await sandbox.commands.run(`chmod 600 ${HOME}/.onyx/agent/run.json`, {
    timeoutMs: 10_000,
  });

  // 3. Durable starting status BEFORE launch (mirrors the app's early-write).
  const now = Date.now();
  await sandbox.files.write(
    `${HOME}/agent_status.json`,
    JSON.stringify({
      status: "starting",
      run_id: run.runId,
      stage: "boot",
      round: 0,
      total_rounds: 0,
      current_tool: null,
      last_update: now,
      started_at: now,
    }),
  );

  // 4. Detached launch — the runner owns the loop from here.
  await sandbox.commands.run(
    `cd ${HOME} && nohup python3 headless_runner.py > ${HOME}/background.log 2>&1 &`,
    { timeoutMs: 10_000 },
  );
}

/** Launch a terminal command with output/exit-code capture (FR-3.3). */
export async function startTerminalCommand(
  sandbox: Sandbox,
  run: AgentRunPayload["run"],
): Promise<void> {
  const command = run.config.command?.trim();
  if (!command) throw new Error("terminal_command run is missing config.command");
  const cwd = run.config.cwd?.trim() || HOME;
  const script = ["#!/bin/bash", `cd ${cwd}`, command].join("\n");
  await sandbox.files.write(`${HOME}/.onyx/task/cmd.sh`, script);
  await sandbox.commands.run(
    `nohup bash -c 'bash ${HOME}/.onyx/task/cmd.sh > ${HOME}/.onyx/task/output.log 2> ${HOME}/.onyx/task/error.log; echo $? > ${HOME}/.onyx/task/exit_code' > /dev/null 2>&1 &`,
    { timeoutMs: 10_000 },
  );
}

// ---------------------------------------------------------------------------
// Status polling (file protocol — same files the app's detached-run sync reads)
// ---------------------------------------------------------------------------

async function readJson<T>(sandbox: Sandbox, path: string): Promise<T | null> {
  try {
    const text = await sandbox.files.read(path, { format: "text" });
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export async function readAgentStatus(sandbox: Sandbox): Promise<AgentStatus | null> {
  return readJson<AgentStatus>(sandbox, `${HOME}/agent_status.json`);
}

export async function readAgentHistory(sandbox: Sandbox): Promise<HistoryEntry[] | null> {
  const parsed = await readJson<{ messages?: HistoryEntry[] } | HistoryEntry[]>(
    sandbox,
    `${HOME}/chat_history.json`,
  );
  if (!parsed) return null;
  return Array.isArray(parsed) ? parsed : (parsed.messages ?? []);
}

export interface TerminalStatus {
  exited: boolean;
  exitCode: number | null;
  output: string;
  error: string;
}

export async function readTerminalStatus(sandbox: Sandbox): Promise<TerminalStatus> {
  const exitCode = await readJson<number>(sandbox, `${HOME}/.onyx/task/exit_code`).catch(
    () => null,
  );
  const output = await sandbox.files
    .read(`${HOME}/.onyx/task/output.log`, { format: "text" })
    .catch(() => "");
  const error = await sandbox.files
    .read(`${HOME}/.onyx/task/error.log`, { format: "text" })
    .catch(() => "");
  return {
    exited: exitCode !== null && exitCode !== undefined,
    exitCode: typeof exitCode === "number" ? exitCode : null,
    output,
    error,
  };
}

export async function readLogTail(sandbox: Sandbox, bytes = 4096): Promise<string> {
  try {
    const log = await sandbox.files.read(`${HOME}/background.log`, { format: "text" });
    return log.slice(-bytes);
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Artifacts (FR-2.3 / FR-4.2 — changed + new files, budget-capped)
// ---------------------------------------------------------------------------

function isExcluded(path: string): boolean {
  const rel = path.startsWith(`${HOME}/`) ? path.slice(HOME.length + 1) : path;
  return TASK_ARTIFACT_EXCLUDES.some((excl) => rel === excl || rel.startsWith(`${excl}/`));
}

function guessMime(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    txt: "text/plain", md: "text/markdown", json: "application/json",
    csv: "text/csv", html: "text/html", css: "text/css", js: "text/javascript",
    ts: "text/typescript", tsx: "text/typescript", py: "text/x-python",
    sh: "text/x-shellscript", yml: "text/yaml", yaml: "text/yaml",
    svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg",
    jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
    pdf: "application/pdf", zip: "application/zip",
  };
  return map[ext] ?? "application/octet-stream";
}

/**
 * Collect artifacts: the final agent message (when the history has one past
 * the seed), every new/changed sandbox file (FR-4.2 broad workspace updates),
 * and terminal reports. Manifest-identical inputs are skipped.
 */
export async function collectArtifacts(
  sandbox: Sandbox,
  run: AgentRunPayload["run"],
  manifest: OnyxAgentFilesManifest,
): Promise<CloudArtifact[]> {
  const artifacts: CloudArtifact[] = [];
  let totalBytes = 0;
  const pushCapped = (input: CloudArtifact, size: number) => {
    if (artifacts.length >= TASK_PAYLOAD_BUDGET.maxArtifacts) return;
    if (totalBytes + size > TASK_PAYLOAD_BUDGET.maxTotalArtifactBytes) return;
    artifacts.push(input);
    totalBytes += size;
  };

  // Final assistant message (agent runs).
  if (run.type !== "terminal_command") {
    const history = await readAgentHistory(sandbox);
    const seedCount = run.payload.conversation.messages.length;
    const after = history ? history.slice(seedCount) : [];
    const finalText = [...after]
      .reverse()
      .find((e) => e.role === "assistant" && typeof e.content === "string" && e.content.trim());
    if (finalText?.content) {
      pushCapped(
        {
          kind: "message",
          name: "result.md",
          mimeType: "text/markdown",
          content: finalText.content.slice(0, TASK_PAYLOAD_BUDGET.maxArtifactBytes),
          encoding: "utf8",
          truncated: finalText.content.length > TASK_PAYLOAD_BUDGET.maxArtifactBytes,
        },
        finalText.content.length,
      );
    }
  }

  // Changed/new files vs the mount manifest.
  const manifestByPath = new Map(
    manifest.files.map((f) => [sandboxPath(f.path), f.size] as const),
  );
  for (const entry of await walkFiles(sandbox)) {
    if (isExcluded(entry.path)) continue;
    const mountedSize = manifestByPath.get(entry.path);
    if (mountedSize !== undefined && mountedSize === entry.size) continue; // unchanged input
    if (entry.size > TASK_PAYLOAD_BUDGET.maxArtifactBytes) {
      pushCapped(
        {
          kind: "file",
          name: entry.path.split("/").pop() ?? entry.path,
          path: entry.path,
          mimeType: guessMime(entry.path),
          content: "",
          encoding: "base64",
          truncated: true,
        },
        0,
      );
      continue;
    }
    try {
      const bytes = await sandbox.files.read(entry.path, { format: "bytes" });
      pushCapped(
        {
          kind: "file",
          name: entry.path.split("/").pop() ?? entry.path,
          path: entry.path,
          mimeType: guessMime(entry.path),
          content: Buffer.from(bytes).toString("base64"),
          encoding: "base64",
        },
        entry.size,
      );
    } catch {
      // Unreadable file — skip silently.
    }
  }

  // Terminal reports.
  if (run.type === "terminal_command") {
    const terminal = await readTerminalStatus(sandbox);
    if (terminal.output) {
      pushCapped(
        {
          kind: "report",
          name: "output.log",
          mimeType: "text/plain",
          content: terminal.output.slice(0, 200_000),
          encoding: "utf8",
          truncated: terminal.output.length > 200_000,
        },
        terminal.output.length,
      );
    }
    if (terminal.error) {
      pushCapped(
        {
          kind: "report",
          name: "error.log",
          mimeType: "text/plain",
          content: terminal.error.slice(0, 100_000),
          encoding: "utf8",
          truncated: terminal.error.length > 100_000,
        },
        terminal.error.length,
      );
    }
  }

  return artifacts;
}

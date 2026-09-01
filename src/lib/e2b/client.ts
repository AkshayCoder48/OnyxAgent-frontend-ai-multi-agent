"use client";

/**
 * E2B Sandbox client — calls the server-side /api/sandbox API route.
 *
 * The E2B SDK (`e2b` / `@e2b/code-interpreter`) depends on `undici` which
 * requires Node.js built-ins (`node:fs`, `node:http2`) that can't be bundled
 * for the browser. So we delegate all SDK operations to the server-side
 * API route at `/api/sandbox`, which runs the SDK in Node.js.
 *
 * Sandbox modes:
 *   - "shared" (default): a single Sandbox instance per apiKey, reused
 *     across all conversations. Lower latency, fewer sandboxes.
 *   - "separate": a new Sandbox per (apiKey, conversationId). Isolation
 *     between conversations, but more sandboxes created.
 *
 * Backward-compat: the class is still named `E2BClient` and the factory
 * `getE2BClient()` still exists so existing call sites don't break.
 */

const API_ENDPOINT = "/api/sandbox";

export interface E2BFile {
  path: string;
  type: "file" | "directory";
  size?: number;
  /** Optional file name (some sandbox list responses include it; otherwise
   *  callers can derive it from `path.split("/").pop()`). */
  name?: string;
}

export interface E2BExecResult {
  stdout: string;
  stderr: string;
  exit_code: number;
  duration_ms: number;
}

export interface StreamMessage {
  type: "stdout" | "stderr" | "result" | "prompt";
  data?: string;
  exit_code?: number;
  prompt?: string;
}

export class E2BError extends Error {
  status: number;
  detail: unknown;
  constructor(message: string, status: number, detail?: unknown) {
    super(message);
    this.name = "E2BError";
    this.status = status;
    this.detail = detail;
  }
}

// Cache of E2BClient instances by (apiKey, conversationId, mode).
const clientCache = new Map<string, E2BClient>();

export function getE2BClient(
  apiKey: string,
  conversationId?: string | null,
  mode: "shared" | "separate" = "shared",
): E2BClient {
  const cacheKey = `${apiKey}:${conversationId ?? ""}:${mode}`;
  let client = clientCache.get(cacheKey);
  if (!client) {
    client = new E2BClient(apiKey, conversationId ?? null, mode);
    clientCache.set(cacheKey, client);
  }
  return client;
}

export function evictAllE2BClients(): void {
  clientCache.clear();
}

export class E2BClient {
  private apiKey: string;
  private conversationId: string | null;
  private mode: "shared" | "separate";
  /** The sandbox ID from the last successful operation. Stored in localStorage
   *  so it survives page refreshes and is passed to the server on each request
   *  — this lets the server reconnect to the existing sandbox instead of
   *  creating a new one (critical for Vercel serverless). */
  private sandboxId: string | null = null;

  constructor(
    apiKey: string,
    conversationId: string | null = null,
    mode: "shared" | "separate" = "shared",
  ) {
    this.apiKey = apiKey;
    this.conversationId = conversationId;
    this.mode = mode;
    // Load the sandbox ID from localStorage
    if (typeof window !== "undefined") {
      const stored = window.localStorage.getItem(`e2b-sandbox-id:${apiKey}`);
      if (stored) this.sandboxId = stored;
    }
  }

  /** Make a call to the server-side sandbox API. Auto-recovers from dead
   *  sandboxes by restarting (with OPFS backup restore) on "probably not
   *  running" errors. Rate-limited (HTTP 429 / 529) calls back off —
   *  honoring the server's retry-after hint when present — and retry a
   *  bounded number of times. */
  private async call<T>(
    action: string,
    args: Record<string, unknown> = {},
  ): Promise<T> {
    // ── Request coalescing ──────────────────────────────────────────
    // Identical in-flight requests (same action + args + sandbox) share a
    // single promise so concurrent tools don't stampede the rate-limited
    // sandbox API with duplicates.
    const coalesceKey = `${this.apiKey}:${this.mode}:${action}:${JSON.stringify(args)}`;
    const inFlight = E2BClient.inFlightCalls.get(coalesceKey);
    if (inFlight) {
      try {
        return (await inFlight) as T;
      } catch {
        // The shared attempt failed — fall through and try again below.
      }
    }

    const attempt = this.callUncached<T>(action, args).finally(() => {
      E2BClient.inFlightCalls.delete(coalesceKey);
    });
    E2BClient.inFlightCalls.set(coalesceKey, attempt);
    return attempt;
  }

  /** In-flight request coalescing map (shared across client instances). */
  private static inFlightCalls = new Map<string, Promise<unknown>>();

  /** The actual (non-coalesced) sandbox API call with bounded rate-limit
   *  backoff (429 / 529). */
  private async callUncached<T>(
    action: string,
    args: Record<string, unknown> = {},
  ): Promise<T> {
    const doCall = async (sandboxId: string | null): Promise<Response> => {
      return fetch(API_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          apiKey: this.apiKey,
          action,
          args,
          conversationId: this.conversationId,
          sandboxMode: this.mode,
          // Pass the sandbox ID so the server can reconnect to an existing
          // sandbox instead of creating a new one on each serverless cold start.
          sandboxId: sandboxId,
        }),
      });
    };

    // ── Bounded rate-limit backoff (PRD §30) ──────────────────────
    // E2B (and the serverless route in front of it) throttle with 429/529 —
    // sandbox API quota or Vercel rate limits. Retry a bounded number of
    // times instead of throwing: the operation is recoverable and a
    // transient throttle shouldn't surface as a hard failure. Server hints
    // are honored when present: a `retry_after_ms` body field, or a
    // `Retry-After` header in seconds or HTTP-date form; otherwise
    // exponential backoff (1s, 2s, 4s) capped at 8s. Never loops forever.
    const MAX_RATE_LIMIT_RETRIES = 3;
    const BASE_DELAY_MS = 1_000;
    const MAX_DELAY_MS = 8_000;
    let res = await doCall(this.sandboxId);
    let data = await res.json().catch(() => ({}));
    let rateLimitAttempt = 0;
    while ((res.status === 429 || res.status === 529) && rateLimitAttempt < MAX_RATE_LIMIT_RETRIES) {
      rateLimitAttempt++;
      const retryAfterHeader = res.headers.get("retry-after");
      const retryAfterBody = (data as { retry_after_ms?: number })?.retry_after_ms;
      let delayMs: number;
      if (typeof retryAfterBody === "number" && retryAfterBody > 0) {
        delayMs = Math.min(retryAfterBody, MAX_DELAY_MS);
      } else if (retryAfterHeader) {
        // Retry-After can be seconds or a date — handle both.
        const asNum = Number(retryAfterHeader);
        if (!Number.isNaN(asNum)) {
          delayMs = Math.min(asNum * 1000, MAX_DELAY_MS);
        } else {
          const asDate = Date.parse(retryAfterHeader);
          delayMs = Number.isNaN(asDate)
            ? Math.min(BASE_DELAY_MS * Math.pow(2, rateLimitAttempt - 1), MAX_DELAY_MS)
            : Math.min(asDate - Date.now(), MAX_DELAY_MS);
        }
      } else {
        delayMs = Math.min(BASE_DELAY_MS * Math.pow(2, rateLimitAttempt - 1), MAX_DELAY_MS);
      }
      // Guard against negative / zero delays.
      delayMs = Math.max(delayMs, 100);
      console.warn(
        `[e2b] rate-limited (${res.status}) on action="${action}" — retry ${rateLimitAttempt}/${MAX_RATE_LIMIT_RETRIES} after ${delayMs}ms`,
      );
      await new Promise((r) => setTimeout(r, delayMs));
      res = await doCall(this.sandboxId);
      data = await res.json().catch(() => ({}));
    }

    // Save the sandbox ID from SUCCESSFUL responses only. The server may
    // return HTTP 200 with an `error` field when the sandbox died mid-command
    // — in that case, `data.sandboxId` may be null or a dead ID, so we MUST
    // NOT cache it. Only cache when there's no error AND a sandboxId is present.
    if (res.ok && !(data as { error?: string })?.error) {
      const sid = (data as { sandboxId?: string })?.sandboxId;
      if (sid && sid !== this.sandboxId) {
        this.sandboxId = sid;
        if (typeof window !== "undefined") {
          window.localStorage.setItem(`e2b-sandbox-id:${this.apiKey}`, sid);
        }
      }
    }

    // Auto-recover from dead sandbox: check BOTH HTTP errors AND response body
    // errors (the server returns 200 with an error field when the sandbox
    // dies mid-command).
    //
    // Note: the server now also does its own dead-sandbox recovery (evict +
    // fresh create + retry). This client-side retry is a second line of
    // defense for the case where the server's recovery also failed (e.g.
    // Sandbox.create itself failed due to a transient E2B API issue).
    const errMsg = (data as { error?: string })?.error ?? "";
    const isDeadSandbox = /not running|probably not|no such|not found|sandbox.*not|unavailable/i.test(errMsg);
    if (isDeadSandbox && action !== "restart" && action !== "reset") {
      console.warn(`[e2b] sandbox dead (${errMsg}), clearing cache and retrying...`);
      // Clear the stored sandbox ID so the retry creates a new one.
      this.sandboxId = null;
      if (typeof window !== "undefined") {
        window.localStorage.removeItem(`e2b-sandbox-id:${this.apiKey}`);
      }
      // Retry the original action with sandboxId=null. The server will see
      // no clientSandboxId, skip the cache lookup (which we just evicted by
      // failing), and create a fresh sandbox.
      res = await doCall(null);
      data = await res.json().catch(() => ({}));
      // Cache the new sandbox ID if the retry succeeded.
      if (res.ok && !(data as { error?: string })?.error) {
        const sid = (data as { sandboxId?: string })?.sandboxId;
        if (sid) {
          this.sandboxId = sid;
          if (typeof window !== "undefined") {
            window.localStorage.setItem(`e2b-sandbox-id:${this.apiKey}`, sid);
          }
        }
      }
    }

    if (!res.ok) {
      const msg =
        (data as { error?: string })?.error ?? `HTTP ${res.status}`;
      if (res.status === 401) {
        throw new E2BError(
          "E2B API key is invalid. Get one at https://e2b.dev/dashboard?tab=keys",
          res.status,
          data,
        );
      }
      throw new E2BError(msg, res.status, data);
    }

    return data as T;
  }

  async createSandbox(): Promise<{ id: string }> {
    const r = await this.call<{ sandboxId: string }>("create");
    return { id: r.sandboxId };
  }

  async getSandboxId(): Promise<string> {
    const r = await this.call<{ sandboxId: string }>("create");
    return r.sandboxId;
  }

  async deleteSandbox(): Promise<void> {
    try {
      await this.call("kill");
    } catch {
      // ignore
    }
  }

  // ---------------------------------------------------------------
  // File operations
  // ---------------------------------------------------------------

  async listFiles(path = "/home/user"): Promise<E2BFile[]> {
    const r = await this.call<{ items: E2BFile[] }>("list_files", { path });
    return r.items ?? [];
  }

  async readFile(path: string): Promise<string> {
    const r = await this.call<{ content: string; isBase64?: boolean }>("read_file", { path });
    // The server now returns base64-encoded content to avoid UTF-8 corruption.
    // Decode it back to a string for text files. For binary files, use
    // readFileBytes instead.
    if (r.isBase64 && typeof atob !== "undefined") {
      try {
        const binary = atob(r.content);
        // Try to decode as UTF-8 — if it's text, this works. If it's binary,
        // the caller should use readFileBytes instead.
        return binary;
      } catch {
        return r.content ?? "";
      }
    }
    return r.content ?? "";
  }

  /** Read a file as raw bytes (Blob). Use this for binary files (images,
   *  PDFs, archives, etc.) to avoid UTF-8 corruption. */
  async readFileBytes(path: string): Promise<Blob | null> {
    const r = await this.call<{ content: string; isBase64?: boolean }>("read_file", { path });
    if (r.isBase64 && typeof atob !== "undefined") {
      try {
        const binary = atob(r.content);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
          bytes[i] = binary.charCodeAt(i);
        }
        return new Blob([bytes]);
      } catch {
        return null;
      }
    }
    // Fallback: treat as text.
    return new Blob([r.content ?? ""]);
  }

  async writeFile(path: string, content: string): Promise<void> {
    await this.call("write_file", { path, content });
  }

  /** Write N files in ONE HTTP call. Critical for syncOpfsToSandbox —
   *  previously each file was a separate fetch() (20 files = 20 sequential
   *  HTTP round-trips = 1-2 min blocking). Now: 1 HTTP call. */
  async batchWrite(files: Array<{ path: string; content: string }>): Promise<{ written: number; errors: Array<{ path: string; error: string }> }> {
    const r = await this.call<{ written: number; errors: Array<{ path: string; error: string }> }>("batch_write", { files });
    return { written: r.written ?? 0, errors: r.errors ?? [] };
  }

  async uploadFile(path: string, file: Blob): Promise<void> {
    const text = await file.text();
    await this.writeFile(path, text);
  }

  async deleteFile(path: string, _recursive = false): Promise<void> {
    await this.call("delete_file", { path });
  }

  async createFolder(path: string): Promise<void> {
    await this.call("create_folder", { path });
  }

  // ---------------------------------------------------------------
  // Process / command execution
  // ---------------------------------------------------------------

  async exec(
    command: string,
    opts?: { cwd?: string; timeout?: number },
  ): Promise<E2BExecResult> {
    const start = Date.now();
    try {
      const r = await this.call<{
        stdout: string;
        stderr: string;
        exit_code: number;
      }>("exec", {
        command,
        cwd: opts?.cwd ?? "/home/user",
        timeout: opts?.timeout ?? 120,
      });
      return {
        stdout: r.stdout ?? "",
        stderr: r.stderr ?? "",
        exit_code: r.exit_code ?? 0,
        duration_ms: Date.now() - start,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        stdout: "",
        stderr: msg,
        exit_code: -1,
        duration_ms: Date.now() - start,
      };
    }
  }

  async runPython(
    code: string,
    opts?: { timeout?: number },
  ): Promise<E2BExecResult> {
    const start = Date.now();
    try {
      const r = await this.call<{
        stdout: string;
        stderr: string;
        exit_code: number;
      }>("run_python", {
        code,
        timeout: opts?.timeout ?? 60,
      });
      return {
        stdout: r.stdout ?? "",
        stderr: r.stderr ?? "",
        exit_code: r.exit_code ?? 0,
        duration_ms: Date.now() - start,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        stdout: "",
        stderr: msg,
        exit_code: -1,
        duration_ms: Date.now() - start,
      };
    }
  }

  async *runPythonStream(
    code: string,
    opts?: { timeout?: number; envs?: Record<string, string> },
  ): AsyncIterable<StreamMessage> {
    // REAL STREAMING via SSE — pipes stdout/stderr chunks to the caller
    // as they arrive from the E2B sandbox, instead of waiting for the
    // entire Python execution to finish. This is what makes `run_python`
    // output appear LIVE (e.g. `print()` lines show up immediately).
    // `envs` (PRD §14): the user's env-var VALUES, injected into the
    // execution so `os.environ[...]` resolves to real values.
    yield* this.consumeSSEStream("run_python_stream", {
      code,
      timeout: opts?.timeout ?? 60,
      ...(opts?.envs ? { envs: opts.envs } : {}),
    });
  }

  async *runCommandStream(
    command: string,
    opts?: { cwd?: string; timeout?: number; envs?: Record<string, string> },
  ): AsyncIterable<StreamMessage> {
    // REAL STREAMING via SSE — pipes stdout/stderr chunks to the caller
    // as they arrive from the E2B sandbox, instead of waiting for the
    // entire command to finish. This is what makes `run_terminal` output
    // appear LIVE (e.g. `ls -la` output streams line-by-line).
    // `envs` (PRD §14): the user's env-var VALUES, injected into the
    // command so `$VAR` references resolve to real values.
    yield* this.consumeSSEStream("exec_stream", {
      command,
      cwd: opts?.cwd ?? "/home/user",
      timeout: opts?.timeout ?? 120,
      ...(opts?.envs ? { envs: opts.envs } : {}),
    });
  }

  /**
   * Consume a Server-Sent Events (SSE) stream from the sandbox API.
   * Parses `data: {...}\n\n` lines and yields them as StreamMessage objects.
   * Handles the sandbox ID caching + dead-sandbox recovery (on error, retries
   * once with a fresh sandbox via the server-side logic).
   */
  private async *consumeSSEStream(
    action: string,
    args: Record<string, unknown>,
  ): AsyncIterable<StreamMessage> {
    const res = await fetch(API_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify({
        apiKey: this.apiKey,
        action,
        args,
        conversationId: this.conversationId,
        sandboxMode: this.mode,
        sandboxId: this.sandboxId,
      }),
    });

    if (!res.ok || !res.body) {
      const data = await res.json().catch(() => ({}));
      const errMsg = (data as { error?: string })?.error ?? `HTTP ${res.status}`;
      yield { type: "stderr", data: errMsg };
      yield { type: "result", exit_code: -1 };
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // SSE events are separated by `\n\n`. Parse complete events.
        let idx: number;
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const rawEvent = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          // Each event may have multiple `data:` lines — join them.
          const lines = rawEvent.split("\n");
          const dataLines = lines
            .filter((l) => l.startsWith("data:"))
            .map((l) => l.slice(5).trimStart());
          if (dataLines.length === 0) continue;
          const jsonStr = dataLines.join("\n");
          try {
            const msg = JSON.parse(jsonStr) as {
              type: "stdout" | "stderr" | "result" | "error" | "prompt";
              data?: unknown;
              exit_code?: number;
              sandboxId?: string;
              error?: string;
              prompt?: string;
            };
            // Cache the sandbox ID from any message that includes it.
            if (msg.sandboxId && msg.sandboxId !== this.sandboxId) {
              this.sandboxId = msg.sandboxId;
              if (typeof window !== "undefined") {
                window.localStorage.setItem(`e2b-sandbox-id:${this.apiKey}`, msg.sandboxId);
              }
            }
            if (msg.type === "stdout" && msg.data) {
              // Ensure data is always a string. Handle both string and
              // OutputMessage object ({ line, timestamp, error }) cases.
              const outStr = typeof msg.data === "string"
                ? msg.data
                : (typeof msg.data === "object" && msg.data && "line" in msg.data
                    ? String((msg.data as { line: unknown }).line ?? "")
                    : String(msg.data));
              if (outStr) {
                yield { type: "stdout", data: outStr };
              }
            } else if (msg.type === "stderr" && msg.data) {
              const errStr = typeof msg.data === "string"
                ? msg.data
                : (typeof msg.data === "object" && msg.data && "line" in msg.data
                    ? String((msg.data as { line: unknown }).line ?? "")
                    : String(msg.data));
              if (errStr) {
                yield { type: "stderr", data: errStr };
              }
            } else if (msg.type === "result") {
              yield { type: "result", exit_code: msg.exit_code ?? 0 };
              return;
            } else if (msg.type === "error") {
              yield { type: "stderr", data: msg.error ?? "Unknown error" };
              yield { type: "result", exit_code: -1 };
              return;
            } else if (msg.type === "prompt" && msg.prompt) {
              // Interactive prompt detected (e.g. "Ok to proceed? (y)")
              // The UI shows an input field so the user can respond.
              yield { type: "prompt", prompt: msg.prompt };
            }
          } catch {
            // ignore malformed JSON
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
    // If we exit the loop without a result event, emit one.
    yield { type: "result", exit_code: 0 };
  }

  async searchFiles(query: string, path = "/home/user"): Promise<string> {
    const r = await this.call<{ stdout: string }>("search_files", {
      query,
      path,
    });
    return r.stdout ?? "(no matches)";
  }

  // ---------------------------------------------------------------
  // Sandbox management: keepalive, backup, restore, reset, restart
  // ---------------------------------------------------------------

  /** Keepalive ping — resets the sandbox inactivity timer. Called every
   *  5 minutes by the client-side keepalive system. */
  async keepalive(): Promise<boolean> {
    try {
      await this.call<{ ok: boolean }>("keepalive");
      return true;
    } catch {
      return false;
    }
  }

  /** Download ALL files from the sandbox as a backup payload.
   *  Returns { files: [{ path, content }], count }.
   *  Used by the auto-backup system to save sandbox files to OPFS. */
  async backupFiles(): Promise<{ files: Array<{ path: string; content: string }>; count: number }> {
    return await this.call<{ files: Array<{ path: string; content: string }>; count: number }>("backup_files");
  }

  /** Restore a backup to the sandbox. Writes each file to its path.
   *  Used after creating a new sandbox to restore files from OPFS backup. */
  async restoreFiles(files: Array<{ path: string; content: string }>): Promise<number> {
    const r = await this.call<{ ok: boolean; restored: number }>("restore_files", { files });
    return r.restored ?? 0;
  }

  /** Reset the sandbox — kills the current sandbox. The next operation
   *  creates a fresh sandbox with empty files. */
  async reset(): Promise<string | null> {
    const r = await this.call<{ ok: boolean; killed: string | null }>("reset");
    return r.killed;
  }

  /** Restart the sandbox — kills the current sandbox and creates a new one.
   *  If backupFiles is provided, restores them to the new sandbox. */
  async restart(backupFiles?: Array<{ path: string; content: string }>): Promise<{ sandboxId: string; restored: number }> {
    return await this.call<{ ok: boolean; sandboxId: string; restored: number }>("restart", { backupFiles });
  }

  // ---------------------------------------------------------------
  // Static: test API key (used by the settings page test button)
  // ---------------------------------------------------------------

  /** Static: list running sandboxes for an API key. Used by the settings
   *  page test button to verify the key works. */
  static async listSandboxes(
    apiKey: string,
  ): Promise<Array<{ sandboxID: string; startedAt: string; status?: string }>> {
    const res = await fetch(API_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey, action: "list" }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg =
        (data as { error?: string })?.error ?? `HTTP ${res.status}`;
      throw new E2BError(msg, res.status, data);
    }
    return (data as { items: Array<{ sandboxID: string; startedAt: string; status?: string }> }).items ?? [];
  }

  /** Static: kill ALL cached sandboxes for an API key (both shared + separate).
   *  Used when the user switches sandbox allocation mode — the old sandboxes'
   *  file systems are lost and fresh ones are created in the new mode. Also
   *  evicts the local client cache so the next getE2BClient() call creates
   *  a fresh E2BClient that doesn't hold a stale sandbox reference. */
  static async killAllSandboxes(apiKey: string): Promise<string[]> {
    const res = await fetch(API_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey, action: "kill_all" }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg =
        (data as { error?: string })?.error ?? `HTTP ${res.status}`;
      throw new E2BError(msg, res.status, data);
    }
    // Evict all cached E2BClient instances for this apiKey so the next
    // getE2BClient() call creates a fresh client (which will create a new
    // sandbox on its first operation in the new mode).
    for (const [key] of clientCache.entries()) {
      if (key.startsWith(apiKey)) {
        clientCache.delete(key);
      }
    }
    return (data as { killed: string[] }).killed ?? [];
  }
}

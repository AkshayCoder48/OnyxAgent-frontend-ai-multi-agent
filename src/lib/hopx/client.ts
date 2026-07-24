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
 * Backward-compat: the class is still named `HopxClient` and the factory
 * `getHopxClient()` still exists so existing call sites don't break.
 */

const API_ENDPOINT = "/api/sandbox";

export interface HopxFile {
  path: string;
  type: "file" | "directory";
  size?: number;
}

export interface HopxExecResult {
  stdout: string;
  stderr: string;
  exit_code: number;
  duration_ms: number;
}

export interface StreamMessage {
  type: "stdout" | "stderr" | "result";
  data?: string;
  exit_code?: number;
}

export class HopxError extends Error {
  status: number;
  detail: unknown;
  constructor(message: string, status: number, detail?: unknown) {
    super(message);
    this.name = "HopxError";
    this.status = status;
    this.detail = detail;
  }
}

// Cache of HopxClient instances by (apiKey, conversationId, mode).
const clientCache = new Map<string, HopxClient>();

export function getHopxClient(
  apiKey: string,
  conversationId?: string | null,
  mode: "shared" | "separate" = "shared",
): HopxClient {
  const cacheKey = `${apiKey}:${conversationId ?? ""}:${mode}`;
  let client = clientCache.get(cacheKey);
  if (!client) {
    client = new HopxClient(apiKey, conversationId ?? null, mode);
    clientCache.set(cacheKey, client);
  }
  return client;
}

export function evictAllHopxClients(): void {
  clientCache.clear();
}

export class HopxClient {
  private apiKey: string;
  private conversationId: string | null;
  private mode: "shared" | "separate";

  constructor(
    apiKey: string,
    conversationId: string | null = null,
    mode: "shared" | "separate" = "shared",
  ) {
    this.apiKey = apiKey;
    this.conversationId = conversationId;
    this.mode = mode;
  }

  /** Make a call to the server-side sandbox API. */
  private async call<T>(
    action: string,
    args: Record<string, unknown> = {},
  ): Promise<T> {
    const res = await fetch(API_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        apiKey: this.apiKey,
        action,
        args,
        conversationId: this.conversationId,
        sandboxMode: this.mode,
      }),
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      const msg =
        (data as { error?: string })?.error ?? `HTTP ${res.status}`;
      if (res.status === 401) {
        throw new HopxError(
          "E2B API key is invalid. Get one at https://e2b.dev/dashboard?tab=keys",
          res.status,
          data,
        );
      }
      throw new HopxError(msg, res.status, data);
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

  async listFiles(path = "/home/user"): Promise<HopxFile[]> {
    const r = await this.call<{ items: HopxFile[] }>("list_files", { path });
    return r.items ?? [];
  }

  async readFile(path: string): Promise<string> {
    const r = await this.call<{ content: string }>("read_file", { path });
    return r.content ?? "";
  }

  async writeFile(path: string, content: string): Promise<void> {
    await this.call("write_file", { path, content });
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
  ): Promise<HopxExecResult> {
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
  ): Promise<HopxExecResult> {
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
    opts?: { timeout?: number },
  ): AsyncIterable<StreamMessage> {
    const result = await this.runPython(code, opts);
    if (result.stdout) yield { type: "stdout", data: result.stdout };
    if (result.stderr) yield { type: "stderr", data: result.stderr };
    yield { type: "result", exit_code: result.exit_code };
  }

  async *runCommandStream(
    command: string,
    opts?: { cwd?: string; timeout?: number },
  ): AsyncIterable<StreamMessage> {
    const result = await this.exec(command, opts);
    if (result.stdout) yield { type: "stdout", data: result.stdout };
    if (result.stderr) yield { type: "stderr", data: result.stderr };
    yield { type: "result", exit_code: result.exit_code };
  }

  async searchFiles(query: string, path = "/home/user"): Promise<string> {
    const r = await this.call<{ stdout: string }>("search_files", {
      query,
      path,
    });
    return r.stdout ?? "(no matches)";
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
      throw new HopxError(msg, res.status, data);
    }
    return (data as { items: Array<{ sandboxID: string; startedAt: string; status?: string }> }).items ?? [];
  }

  /** Static: kill ALL cached sandboxes for an API key (both shared + separate).
   *  Used when the user switches sandbox allocation mode — the old sandboxes'
   *  file systems are lost and fresh ones are created in the new mode. Also
   *  evicts the local client cache so the next getHopxClient() call creates
   *  a fresh HopxClient that doesn't hold a stale sandbox reference. */
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
      throw new HopxError(msg, res.status, data);
    }
    // Evict all cached HopxClient instances for this apiKey so the next
    // getHopxClient() call creates a fresh client (which will create a new
    // sandbox on its first operation in the new mode).
    for (const [key] of clientCache.entries()) {
      if (key.startsWith(apiKey)) {
        clientCache.delete(key);
      }
    }
    return (data as { killed: string[] }).killed ?? [];
  }
}

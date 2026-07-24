"use client";

/**
 * Browser-based MCP (Model Context Protocol) client.
 *
 * Connects to remote MCP servers over `sse` or `streamable_http` transports
 * and exposes a tiny surface:
 *
 *   - `connect()`           — initialize + list tools
 *   - `listTools()`         — refresh the tool catalog
 *   - `callTool(name, args)` — invoke a tool and return its result
 *   - `disconnect()`        — tear down the connection
 *
 * The client implements the JSON-RPC 2.0 envelope that MCP uses on top of
 * both transports:
 *
 *   - **SSE**: open a long-lived `EventSource` to `<url>/sse` for
 *     server→client messages, POST JSON-RPC requests to the endpoint
 *     advertised in the first `endpoint` event. (Legacy MCP shape used by
 *     the original LangChain-style servers.)
 *   - **streamable_http**: POST each JSON-RPC request to `<url>` with
 *     `Accept: application/json, text/event-stream`. The response is
 *     either a single JSON object or an SSE stream of JSON objects — we
 *     parse both and resolve with the `result` field of the matching
 *     response. (The modern MCP "Streamable HTTP" transport from spec
 *     version 2025-03-26.)
 *
 * Both transports are purely browser-side — no Node `child_process`, no
 * `stdio`. This is the only way to reach an MCP server from backendless
 * mode.
 *
 * The client is per-server: one instance per configured `MCPServerRow`.
 * The agent runtime constructs (and disconnects) one client per turn so
 * long-lived SSE connections don't leak between turns.
 */

export type MCPTransport = "sse" | "streamable_http";

export interface MCPTool {
  /** Tool name as exposed by the server (unique within a server). */
  name: string;
  description: string;
  /** JSON Schema for the tool's parameters. */
  inputSchema: Record<string, unknown>;
}

export interface MCPCallResult {
  /** List of content blocks returned by the tool (text, image, etc.). */
  content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
    | { type: "resource"; resource: unknown }
    | { type: string; [key: string]: unknown }
  >;
  /** Optional structured error from the server. */
  isError?: boolean;
  /** Free-form metadata. */
  [key: string]: unknown;
}

interface MCPClientOptions {
  url: string;
  transport: MCPTransport;
  /** Extra headers (e.g. Authorization) applied to every request. */
  headers?: Record<string, string>;
  /** Caller's abort signal — propagated to fetch / EventSource. */
  signal?: AbortSignal;
  /** Optional request timeout (ms). Defaults to 30s. */
  timeoutMs?: number;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const PROTOCOL_VERSION = "2025-03-26";
const CLIENT_NAME = "OnyxAgent";
const CLIENT_VERSION = "1.0.0";

export class MCPClient {
  private url: string;
  private transport: MCPTransport;
  private headers: Record<string, string>;
  private signal?: AbortSignal;
  private timeoutMs: number;

  /** Monotonic JSON-RPC request id. */
  private nextId = 1;
  /** Cached tool list — populated by `connect()` / `listTools()`. */
  private tools: MCPTool[] = [];
  /** SSE: the endpoint the server tells us to POST to. */
  private postEndpoint: string | null = null;
  /** SSE: the live EventSource. */
  private eventSource: EventSource | null = null;
  /** SSE: pending JSON-RPC requests awaiting a response. */
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  /** Whether `initialize` has completed. */
  private initialized = false;

  constructor(opts: MCPClientOptions) {
    this.url = opts.url.trim();
    this.transport = opts.transport;
    this.headers = opts.headers ?? {};
    this.signal = opts.signal;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  // -------------------------------------------------------------------------
  // Public API.
  // -------------------------------------------------------------------------

  /**
   * Initialize the session and populate the tool list. Idempotent — calling
   * twice is a no-op (returns the cached tool list).
   */
  async connect(): Promise<MCPTool[]> {
    if (this.initialized) return this.tools;
    if (this.transport === "sse") {
      await this.connectSSE();
    } else {
      await this.initializeHTTP();
    }
    this.initialized = true;
    await this.listTools();
    return this.tools;
  }

  /** Get the cached tool list (call `connect()` first). */
  getTools(): MCPTool[] {
    return this.tools;
  }

  /** Refresh the tool list from the server. */
  async listTools(): Promise<MCPTool[]> {
    const result = await this.sendRequest("tools/list", {});
    const tools = (result as { tools?: MCPTool[] })?.tools ?? [];
    this.tools = tools;
    return tools;
  }

  /**
   * Call a tool by name. Returns the raw `result` object from the server
   * (which contains `content`, `isError`, etc.).
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<MCPCallResult> {
    const result = await this.sendRequest("tools/call", { name, arguments: args });
    return result as MCPCallResult;
  }

  /** Tear down the connection (close EventSource, reject pending). */
  disconnect(): void {
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
    for (const [, pending] of this.pending) {
      pending.reject(new Error("MCP client disconnected"));
    }
    this.pending.clear();
    this.initialized = false;
  }

  // -------------------------------------------------------------------------
  // SSE transport.
  // -------------------------------------------------------------------------

  private async connectSSE(): Promise<void> {
    // The legacy SSE transport: open EventSource to `<url>` (server streams
    // an `endpoint` event telling us where to POST), then `initialize`.
    const es = new EventSource(this.url, { withCredentials: false });
    this.eventSource = es;

    // Wait for the server to send the `endpoint` event before continuing.
    const endpointPromise = new Promise<void>((resolve, reject) => {
      const onEndpoint = (event: MessageEvent) => {
        this.postEndpoint = typeof event.data === "string" ? event.data.trim() : "";
        es.removeEventListener("endpoint", onEndpoint as EventListener);
        es.removeEventListener("error", onError as EventListener);
        resolve();
      };
      const onError = () => {
        es.removeEventListener("endpoint", onEndpoint as EventListener);
        es.removeEventListener("error", onError as EventListener);
        reject(new Error(`Failed to open SSE connection to ${this.url}`));
      };
      es.addEventListener("endpoint", onEndpoint as EventListener);
      es.addEventListener("error", onError as EventListener);
    });

    // General message handler — dispatch JSON-RPC responses to pending
    // requests by id.
    es.addEventListener("message", (event: MessageEvent) => {
      this.handleSSEMessage(event.data);
    });

    // If the caller aborts, close the EventSource.
    this.signal?.addEventListener("abort", () => {
      es.close();
    });

    await endpointPromise;
    await this.initializeHTTP();
  }

  private handleSSEMessage(raw: string): void {
    let msg: JsonRpcResponse;
    try {
      msg = JSON.parse(raw) as JsonRpcResponse;
    } catch {
      return; // ignore non-JSON keepalives
    }
    if (typeof msg.id !== "number") return;
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    this.pending.delete(msg.id);
    if (msg.error) {
      pending.reject(new Error(`${msg.error.message} (code ${msg.error.code})`));
    } else {
      pending.resolve(msg.result);
    }
  }

  // -------------------------------------------------------------------------
  // Streamable HTTP transport (also used as the POST channel for SSE).
  // -------------------------------------------------------------------------

  private resolvePostUrl(): string {
    if (this.transport === "sse" && this.postEndpoint) {
      // postEndpoint may be relative — resolve against the server URL.
      try {
        return new URL(this.postEndpoint, this.url).toString();
      } catch {
        return this.postEndpoint;
      }
    }
    return this.url;
  }

  private async initializeHTTP(): Promise<void> {
    await this.sendRequest("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: CLIENT_NAME, version: CLIENT_VERSION },
    });
    // Send the `notifications/initialized` notification (no response expected).
    await this.sendNotification("notifications/initialized", {});
  }

  /**
   * POST a JSON-RPC request and await the matching response. For the
   * streamable_http transport, parses both single-JSON and SSE-encoded
   * responses. For SSE transport, POSTs to the negotiated endpoint and
   * resolves when the EventSource delivers the response.
   */
  private sendRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    const req: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    const body = JSON.stringify(req);

    if (this.transport === "sse" && this.eventSource) {
      // Response will arrive via the EventSource message handler.
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`MCP request timed out: ${method}`));
        }, this.timeoutMs);
        this.pending.set(id, {
          resolve: (v) => {
            clearTimeout(timer);
            resolve(v);
          },
          reject: (e) => {
            clearTimeout(timer);
            reject(e);
          },
        });
        void this.postJSON(this.resolvePostUrl(), body).catch((err) => {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(err);
        });
      });
    }

    // streamable_http — POST and parse the response inline.
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`MCP request timed out: ${method}`));
      }, this.timeoutMs);
      this.postJSON(this.resolvePostUrl(), body, true)
        .then((raw) => {
          clearTimeout(timer);
          const parsed = this.parseHTTPResponse(raw);
          const match = parsed.find((m) => m.id === id);
          if (!match) {
            reject(new Error(`MCP server returned no response for ${method} (id=${id})`));
            return;
          }
          if (match.error) {
            reject(new Error(`${match.error.message} (code ${match.error.code})`));
            return;
          }
          resolve(match.result);
        })
        .catch((err) => {
          clearTimeout(timer);
          reject(err);
        });
    });
  }

  /** Fire-and-forget JSON-RPC notification (no id, no response). */
  private async sendNotification(method: string, params: Record<string, unknown>): Promise<void> {
    const body = JSON.stringify({ jsonrpc: "2.0", method, params });
    try {
      await this.postJSON(this.resolvePostUrl(), body);
    } catch {
      // best-effort
    }
  }

  /**
   * POST `body` to `url` with the configured headers + the JSON-RPC content
   * type. When `acceptSSE` is true (streamable_http), also advertise
   * `text/event-stream` so the server can stream responses back. Returns
   * the raw response body text.
   */
  private async postJSON(url: string, body: string, acceptSSE = false): Promise<string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Accept": acceptSSE ? "application/json, text/event-stream" : "application/json",
      "MCP-Protocol-Version": PROTOCOL_VERSION,
      ...this.headers,
    };
    const res = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: this.signal,
      // Browsers refuse to set `Authorization` etc. on EventSource, but
      // `fetch` allows them — so SSE server-side auth still works for the
      // POST channel.
      credentials: "include",
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`MCP HTTP ${res.status}: ${text || res.statusText}`);
    }
    return res.text();
  }

  /**
   * Parse a streamable_http response body. The server may return either:
   *   - a single JSON-RPC object, or
   *   - an SSE stream of JSON-RPC objects (separated by `\n\n`, each
   *     prefixed with `data: `).
   * Returns the list of JSON-RPC objects found.
   */
  private parseHTTPResponse(raw: string): JsonRpcResponse[] {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    // SSE shape — multiple `data:` lines separated by blank lines.
    if (trimmed.startsWith("data:") || trimmed.includes("\ndata:")) {
      const out: JsonRpcResponse[] = [];
      for (const chunk of trimmed.split(/\n\n+/)) {
        for (const line of chunk.split(/\n/)) {
          const m = line.match(/^data:\s*(.*)$/);
          if (!m || m[1] === undefined) continue;
          try {
            out.push(JSON.parse(m[1]) as JsonRpcResponse);
          } catch {
            // ignore non-JSON data lines (e.g. `[DONE]`)
          }
        }
      }
      return out;
    }
    // Single JSON object.
    try {
      return [JSON.parse(trimmed) as JsonRpcResponse];
    } catch {
      return [];
    }
  }
}

// ---------------------------------------------------------------------------
// Convenience: connect + list tools in one call. Used by the runtime at
// turn start to populate the registry.
// ---------------------------------------------------------------------------

export interface MCPServerConfig {
  id: string;
  name: string;
  transport: MCPTransport;
  url: string;
  headers: Record<string, string>;
}

export interface MCPDiscoveryResult {
  server: MCPServerConfig;
  tools: MCPTool[];
  /** Error message if connect/list failed — `tools` will be empty. */
  error?: string;
}

/**
 * Connect to a list of MCP servers and return their tool catalogs.
 * Failures are per-server — one bad server doesn't block the others.
 */
export async function discoverMCPTools(
  servers: MCPServerConfig[],
  signal?: AbortSignal,
): Promise<MCPDiscoveryResult[]> {
  const results = await Promise.all(
    servers.map(async (server) => {
      const client = new MCPClient({
        url: server.url,
        transport: server.transport,
        headers: server.headers,
        signal,
      });
      try {
        const tools = await client.connect();
        // Disconnect after discovery — the runtime keeps the client
        // around only for the duration of a single agent turn (it
        // re-creates a client per tool call to keep the lifecycle simple).
        // Discovery here is just to enumerate what's available.
        client.disconnect();
        return { server, tools };
      } catch (err) {
        client.disconnect();
        return {
          server,
          tools: [],
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );
  return results;
}

/**
 * Connect to a single MCP server and call one of its tools. The client is
 * created on-demand and disconnected after the call — keeps the lifecycle
 * simple and avoids leaking SSE connections.
 */
export async function callMCPTool(
  server: MCPServerConfig,
  toolName: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<MCPCallResult> {
  const client = new MCPClient({
    url: server.url,
    transport: server.transport,
    headers: server.headers,
    signal,
  });
  try {
    await client.connect();
    return await client.callTool(toolName, args);
  } finally {
    client.disconnect();
  }
}

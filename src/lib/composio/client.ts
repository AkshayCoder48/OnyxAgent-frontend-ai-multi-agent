// ============================================================================
// Composio REST client — minimal, typed, fetch-based (NO SDK dependency).
//
// Verified against the Composio v3 API reference (docs.composio.dev):
//   Base URL : https://backend.composio.dev  (env override: COMPOSIO_BASE_URL)
//   Auth     : `x-api-key: <project API key>` request header
//   Errors   : { error: { message, code, slug, status, request_id, suggested_fix } }
//
// Endpoint map (all under /api/v3):
//   POST   /tool_router/session                          create session {user_id}
//   GET    /tool_router/session/{sid}                    restore/verify session
//   POST   /tool_router/session/{sid}/search             NL tool discovery
//   POST   /tool_router/session/{sid}/execute            execute tool/meta tool
//   POST   /tool_router/session/{sid}/link               OAuth link for a toolkit
//   GET    /toolkits?search=&category=&limit=&cursor=    toolkit catalog (paged)
//   GET    /toolkits/categories                          category chips
//   GET    /connected_accounts?user_ids=&toolkit_slugs=  connected accounts
//   GET    /connected_accounts/{id}                      verify one connection
//   DELETE /connected_accounts/{id}                      remove a connection
//
// SECURITY: the API key is only ever sent in the `x-api-key` header. It is
// never logged, never embedded in error messages, and never returned in any
// response payload (see `sanitizeError`). Use this module server-side; the
// browser talks to /api/composio/* routes which use it transiently.
// ============================================================================

/** Default Composio backend (verified live; the legacy api.composio.com host
 *  no longer resolves). Overridable for self-hosted/future moves. */
export const COMPOSIO_DEFAULT_BASE_URL =
  (process.env.COMPOSIO_BASE_URL ?? "https://backend.composio.dev").replace(/\/+$/, "");

const REQUEST_TIMEOUT_MS = 20_000;
const CONNECTED_ACCOUNTS_PAGE_LIMIT = 100;

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

/** Error surfaced by the Composio API. `message` is sanitized — it can never
 *  contain the API key (the key only ever lives in the request header, which
 *  is never echoed back by Composio nor included in our own error paths). */
export class ComposioError extends Error {
  readonly status: number;
  /** Composio error slug, e.g. "Auth_Unauthorized", "Session_NotFound". */
  readonly slug?: string;
  /** Composio internal error code (e.g. 902). */
  readonly code?: number;
  /** Composio request id — quote it when reporting issues. */
  readonly requestId?: string;
  /** Human-readable fix suggestion from the API, when present. */
  readonly suggestedFix?: string;

  constructor(init: {
    message: string;
    status: number;
    slug?: string;
    code?: number;
    requestId?: string;
    suggestedFix?: string;
  }) {
    super(init.message);
    this.name = "ComposioError";
    this.status = init.status;
    this.slug = init.slug;
    this.code = init.code;
    this.requestId = init.requestId;
    this.suggestedFix = init.suggestedFix;
  }

  /** True when the API rejected the key itself (bad/expired key). */
  get isAuthError(): boolean {
    return this.status === 401 || this.slug === "Auth_Unauthorized";
  }

  /** True when the referenced tool-router session no longer exists. */
  get isSessionMissing(): boolean {
    return this.status === 404 && /session/i.test(this.slug ?? "");
  }
}

// ---------------------------------------------------------------------------
// Wire types (only the fields we consume; unknown extras are ignored)
// ---------------------------------------------------------------------------

export interface ComposioToolkit {
  slug: string;
  name: string;
  type?: string;
  /** Auth schemes the toolkit supports, e.g. ["oauth2", "api_key"]. */
  auth_schemes?: string[];
  /** Auth schemes Composio can manage for you (no custom credentials). */
  composio_managed_auth_schemes?: string[];
  /** Toolkits that need no auth at all (open APIs). */
  no_auth?: boolean;
  auth_guide_url?: string;
  deprecated?: unknown;
  meta?: {
    description?: string;
    logo?: string;
    app_url?: string;
    categories?: Array<{ id: string; name: string }>;
    tools_count?: number;
    triggers_count?: number;
    version?: string;
    created_at?: string;
    updated_at?: string;
  };
}

export interface ComposioToolkitPage {
  items: ComposioToolkit[];
  next_cursor: string | null;
  total_items: number;
  current_page: number;
  total_pages: number;
}

export interface ComposioCategory {
  id: string;
  name: string;
}

/** SAFE connected-account projection — everything sensitive is stripped. */
export interface ComposioConnectedAccountSafe {
  id: string;
  toolkitSlug: string;
  authScheme?: string;
  alias?: string;
  userId?: string;
  status: string;
  createdAt?: string;
  updatedAt?: string;
  isDisabled?: boolean;
}

export interface ComposioSessionInfo {
  session_id: string;
  mcp?: { type?: string; url?: string };
  tool_router_tools?: string[];
}

export interface SessionSearchToolSchema {
  toolkit?: string;
  tool_slug?: string;
  description?: string;
  input_schema?: Record<string, unknown>;
  [k: string]: unknown;
}

export interface SessionSearchResult {
  index?: number;
  use_case?: string;
  execution_guidance?: string;
  difficulty?: string;
  primary_tool_slugs?: string[];
  related_tool_slugs?: string[];
  toolkits?: string[];
  error?: string;
  [k: string]: unknown;
}

export interface SessionToolkitConnectionStatus {
  toolkit: string;
  description?: string;
  has_active_connection: boolean;
  status_message?: string;
  [k: string]: unknown;
}

export interface SessionSearchResponse {
  success?: boolean;
  error?: string;
  results?: SessionSearchResult[];
  toolkit_connection_statuses?: SessionToolkitConnectionStatus[];
  tool_schemas?: Record<string, SessionSearchToolSchema>;
  next_steps_guidance?: string[];
  [k: string]: unknown;
}

export interface SessionExecuteResponse {
  premium_charge?: { amount?: string; currency?: string; charged_by?: string };
  data?: unknown;
  error?: string;
  log_id?: string;
  [k: string]: unknown;
}

export interface ComposioLinkResponse {
  link_token?: string;
  redirect_url?: string;
  connected_account_id?: string;
  expires_at?: string;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class ComposioClient {
  private readonly apiKey: string;
  private readonly base: string;

  constructor(apiKey: string, baseUrl?: string) {
    const key = apiKey.trim();
    if (!key) throw new ComposioError({ message: "Composio API key is empty", status: 401 });
    this.apiKey = key;
    this.base = (baseUrl ?? COMPOSIO_DEFAULT_BASE_URL).replace(/\/+$/, "");
  }

  /** Core request helper. NEVER logs the key; NEVER puts it in a URL/query. */
  private async request<T>(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    pathname: string,
    opts: { query?: Record<string, string | number | boolean | undefined>; body?: unknown } = {},
  ): Promise<T> {
    const url = new URL(`${this.base}${pathname}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          "x-api-key": this.apiKey,
          ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        cache: "no-store",
      });
    } catch (e) {
      throw new ComposioError({
        message:
          e instanceof Error && e.name === "TimeoutError"
            ? "Composio request timed out"
            : "Could not reach Composio (network error)",
        status: 0,
      });
    }

    const text = await res.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }

    if (!res.ok) {
      const err = (parsed as { error?: Record<string, unknown> } | null)?.error;
      const g = (field: string): string | undefined => {
        const v = err?.[field];
        return typeof v === "string" ? v : undefined;
      };
      throw new ComposioError({
        message: g("message") ?? `Composio request failed (HTTP ${res.status})`,
        status: res.status,
        slug: g("slug"),
        code: typeof err?.code === "number" ? err.code : undefined,
        requestId: g("request_id"),
        suggestedFix: g("suggested_fix"),
      });
    }

    return (parsed ?? {}) as T;
  }

  // ── Lightweight key validation ────────────────────────────────────────
  /** Cheap authenticated call used to validate an API key. Returns the
   *  project-visible toolkit count (throws on invalid keys). */
  async validateKey(): Promise<{ ok: true; totalItems: number }> {
    const page = await this.request<ComposioToolkitPage>("GET", "/api/v3/toolkits", {
      query: { limit: 1 },
    });
    return { ok: true, totalItems: Number(page.total_items ?? 0) };
  }

  // ── Toolkit catalog ───────────────────────────────────────────────────
  async listToolkits(opts: {
    search?: string;
    category?: string;
    cursor?: string;
    limit?: number;
    sortBy?: "usage" | "alphabetically";
  } = {}): Promise<ComposioToolkitPage> {
    const limit = Math.min(Math.max(Math.floor(opts.limit ?? 100), 1), 1000);
    const raw = await this.request<unknown>("GET", "/api/v3/toolkits", {
      query: {
        search: opts.search,
        category: opts.category,
        cursor: opts.cursor,
        limit,
        sort_by: opts.sortBy,
      },
    });
    // DEFENSIVE PAGE NORMALIZATION (count-vs-dropdown mismatch fix): if the
    // upstream shape shifts (items nested one level, array at the top, or a
    // `data` wrapper), normalize instead of silently rendering an empty
    // catalog while the status count still shows the total.
    return normalizeToolkitPage(raw);
  }

  async listToolkitCategories(): Promise<{ items: ComposioCategory[] }> {
    return this.request<{ items: ComposioCategory[] }>("GET", "/api/v3/toolkits/categories");
  }

  // ── Tool-router sessions ──────────────────────────────────────────────
  /** Create a session scoped to the app user. Connected accounts are keyed
   *  by `user_id`, so the SAME stable id must be reused for every session —
   *  pass the OnyxAgent user id. */
  async createSession(userId: string): Promise<ComposioSessionInfo> {
    return this.request<ComposioSessionInfo>("POST", "/api/v3/tool_router/session", {
      body: { user_id: userId },
    });
  }

  /** Fetch an existing session (verify/restore). 404 → ComposioError with
   *  `isSessionMissing === true`. */
  async getSession(sessionId: string): Promise<ComposioSessionInfo> {
    return this.request<ComposioSessionInfo>(
      "GET",
      `/api/v3/tool_router/session/${encodeURIComponent(sessionId)}`,
    );
  }

  /** Natural-language tool discovery scoped to the session. */
  async searchSessionTools(sessionId: string, useCase: string): Promise<SessionSearchResponse> {
    return this.request<SessionSearchResponse>(
      "POST",
      `/api/v3/tool_router/session/${encodeURIComponent(sessionId)}/search`,
      { body: { queries: [{ use_case: useCase }] } },
    );
  }

  /** Execute a tool (app tool or COMPOSIO_* meta tool) within the session. */
  async executeSessionTool(
    sessionId: string,
    input: { toolSlug: string; arguments?: Record<string, unknown> },
  ): Promise<SessionExecuteResponse> {
    return this.request<SessionExecuteResponse>(
      "POST",
      `/api/v3/tool_router/session/${encodeURIComponent(sessionId)}/execute`,
      { body: { tool_slug: input.toolSlug, arguments: input.arguments ?? {} } },
    );
  }

  /** Initiate the OAuth flow for a toolkit within the session. Returns the
   *  redirect URL the USER must open to authorize. */
  async initiateSessionLink(
    sessionId: string,
    input: { toolkit: string; callbackUrl?: string; alias?: string },
  ): Promise<ComposioLinkResponse> {
    return this.request<ComposioLinkResponse>(
      "POST",
      `/api/v3/tool_router/session/${encodeURIComponent(sessionId)}/link`,
      {
        body: {
          toolkit: input.toolkit,
          ...(input.callbackUrl ? { callback_url: input.callbackUrl } : {}),
          ...(input.alias ? { alias: input.alias } : {}),
        },
      },
    );
  }

  // ── Connected accounts ────────────────────────────────────────────────
  /** List connected accounts (sanitized — oauth tokens/state NEVER leave
   *  this server module). */
  async listConnectedAccounts(opts: {
    userId?: string;
    toolkitSlugs?: string[];
    cursor?: string;
  } = {}): Promise<{ items: ComposioConnectedAccountSafe[]; next_cursor: string | null; total_items: number }> {
    // user_ids/toolkit_slugs are repeated query params.
    const query: Record<string, string | number> = { limit: CONNECTED_ACCOUNTS_PAGE_LIMIT };
    const url = new URL(`${this.base}/api/v3/connected_accounts`);
    if (opts.userId) url.searchParams.append("user_ids", opts.userId);
    for (const slug of opts.toolkitSlugs ?? []) url.searchParams.append("toolkit_slugs", slug);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));

    const res = await fetch(url, {
      headers: { "x-api-key": this.apiKey },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      cache: "no-store",
    });
    const text = await res.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }
    if (!res.ok) {
      const err = (parsed as { error?: Record<string, unknown> } | null)?.error;
      const g = (f: string): string | undefined =>
        typeof err?.[f] === "string" ? (err[f] as string) : undefined;
      throw new ComposioError({
        message: g("message") ?? `Composio request failed (HTTP ${res.status})`,
        status: res.status,
        slug: g("slug"),
        code: typeof err?.code === "number" ? err.code : undefined,
        requestId: g("request_id"),
        suggestedFix: g("suggested_fix"),
      });
    }
    const page = (parsed ?? {}) as {
      items?: Array<Record<string, unknown>>;
      next_cursor?: string | null;
      total_items?: number;
    };
    return {
      items: (page.items ?? []).map(sanitizeConnectedAccount).filter((a): a is ComposioConnectedAccountSafe => !!a),
      next_cursor: page.next_cursor ?? null,
      total_items: Number(page.total_items ?? 0),
    };
  }

  /** Verify a single connected account's status by id. */
  async getConnectedAccount(id: string): Promise<ComposioConnectedAccountSafe | null> {
    const raw = await this.request<Record<string, unknown>>(
      "GET",
      `/api/v3/connected_accounts/${encodeURIComponent(id)}`,
    );
    return sanitizeConnectedAccount(raw);
  }

  /** Remove a connected account (user-initiated disconnect). */
  async deleteConnectedAccount(id: string): Promise<void> {
    await this.request<unknown>("DELETE", `/api/v3/connected_accounts/${encodeURIComponent(id)}`);
  }
}

// ---------------------------------------------------------------------------
// Sanitizers
// ---------------------------------------------------------------------------

/**
 * Normalize a raw toolkits-endpoint payload into ComposioToolkitPage.
 *
 * Handles the documented shape ({items: [...], next_cursor, total_items}) and
 * defensively unwraps shape drift observed across API revisions: a nested
 * `items.items`, a top-level array, or a `data`/`result` wrapper. An
 * unrecognized shape yields an EMPTY page (the UI shows its honest error /
 * empty state instead of crashing) — never a fabricated dataset.
 */
export function normalizeToolkitPage(raw: unknown): ComposioToolkitPage {
  const empty: ComposioToolkitPage = { items: [], next_cursor: null, total_items: 0, current_page: 1, total_pages: 1 };
  if (Array.isArray(raw)) {
    // Bare array — no pagination info available.
    return { items: raw as ComposioToolkit[], next_cursor: null, total_items: raw.length, current_page: 1, total_pages: 1 };
  }
  if (!raw || typeof raw !== "object") return empty;
  const o = raw as Record<string, unknown>;
  // Unwrap one level of common wrappers.
  const source = (o.items ?? o.data ?? o.result ?? o) as Record<string, unknown> | ComposioToolkit[];
  let items: unknown = source;
  if (source && typeof source === "object" && !Array.isArray(source)) {
    const inner = (source as Record<string, unknown>).items;
    if (Array.isArray(inner)) items = inner;
  }
  if (!Array.isArray(items)) items = [];
  const meta = (Array.isArray(source) ? o : source) as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
  return {
    items: items as ComposioToolkit[],
    next_cursor: str(o.next_cursor ?? meta.next_cursor),
    total_items: num(o.total_items ?? meta.total_items) || (items as unknown[]).length,
    current_page: num(o.current_page ?? meta.current_page) || 1,
    total_pages: num(o.total_pages ?? meta.total_pages) || 1,
  };
}

/**
 * Reduce a raw connected-account record to the SAFE projection.
 * The raw record's `state` and `data` fields carry OAuth tokens/secrets —
 * they must NEVER cross the server boundary toward the browser or the LLM.
 */
export function sanitizeConnectedAccount(raw: Record<string, unknown>): ComposioConnectedAccountSafe | null {
  const id = typeof raw.id === "string" ? raw.id : null;
  if (!id) return null;
  const toolkit = raw.toolkit as { slug?: unknown } | undefined;
  const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
  return {
    id,
    toolkitSlug:
      (toolkit && typeof toolkit.slug === "string" && toolkit.slug) ||
      str(raw.toolkit_slug) ||
      "unknown",
    authScheme: str(raw.authScheme),
    alias: str(raw.alias),
    userId: str(raw.user_id),
    status: str(raw.status) ?? "UNKNOWN",
    createdAt: str(raw.created_at),
    updatedAt: str(raw.updated_at),
    isDisabled: raw.is_disabled === true,
  };
}

/** Map a raw connected-account status string to the UI connection state. */
export function connectionStateOf(status: string): "active" | "initializing" | "expired" | "error" {
  const s = status.toUpperCase();
  if (s === "ACTIVE" || s === "COMPLETED" || s === "SUCCESS") return "active";
  if (s === "INITIALIZING" || s === "PENDING" || s === "WAITING") return "initializing";
  if (s === "EXPIRED") return "expired";
  return "error";
}

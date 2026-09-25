// @vitest-environment node
/**
 * Unit tests for the Composio REST client (src/lib/composio/client.ts).
 *
 * Pins the VERIFIED v3 wire contract (docs.composio.dev):
 *  - auth via the `x-api-key` header (never query/URL);
 *  - Composio error envelope → ComposioError (message/slug/status/request_id);
 *  - connected-account records are SANITIZED — OAuth `state`/`data` never
 *    survive into the safe projection;
 *  - toolkit catalog pagination pass-through (cursor/limit/search/category);
 *  - session create/search/execute/link bodies match the API shapes;
 *  - connection-state mapping for the UI badges.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ComposioClient,
  ComposioError,
  connectionStateOf,
  sanitizeConnectedAccount,
} from "./client";

const KEY = "test_composio_key_12345";

function mockFetchOnce(status: number, body: unknown): ReturnType<typeof vi.fn> {
  const fn = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ComposioClient", () => {
  it("authenticates with the x-api-key header and never leaks the key into URLs", async () => {
    const fetchMock = mockFetchOnce(200, { items: [], total_items: 250, next_cursor: null });
    const client = new ComposioClient(KEY);
    await client.validateKey();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).not.toContain(KEY); // key NEVER in the URL
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe(KEY); // only the header
    expect(String(url)).toContain("/api/v3/toolkits");
  });

  it("maps the Composio error envelope to ComposioError (auth errors)", async () => {
    mockFetchOnce(401, {
      error: {
        message: "Invalid API key format. Please provide a valid API key.",
        code: 902,
        slug: "Auth_Unauthorized",
        status: 401,
        request_id: "req_123",
        suggested_fix: "API keys are at least 10 characters long.",
      },
    });
    const client = new ComposioClient("short");
    await expect(client.validateKey()).rejects.toMatchObject({
      name: "ComposioError",
      status: 401,
      slug: "Auth_Unauthorized",
      code: 902,
      requestId: "req_123",
      isAuthError: true,
    });
  });

  it("flags missing tool-router sessions (404 + Session slug) for auto-heal", async () => {
    mockFetchOnce(404, {
      error: { message: "session not found", slug: "Session_NotFound", status: 404 },
    });
    const client = new ComposioClient(KEY);
    const err = await client.getSession("trs_missing").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ComposioError);
    expect((err as ComposioError).isSessionMissing).toBe(true);
  });

  it("creates a session with the user id in the body (POST /api/v3/tool_router/session)", async () => {
    const fetchMock = mockFetchOnce(200, {
      session_id: "trs_1a2b3c",
      mcp: { type: "http", url: "https://app.composio.dev/tool_router/v3/trs_1a2b3c/mcp" },
    });
    const client = new ComposioClient(KEY);
    const session = await client.createSession("user_123");
    expect(session.session_id).toBe("trs_1a2b3c");

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(String(url)).toContain("/api/v3/tool_router/session");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ user_id: "user_123" });
  });

  it("sends the search use-case shape and passes tool slugs through", async () => {
    const fetchMock = mockFetchOnce(200, {
      success: true,
      results: [{ primary_tool_slugs: ["SLACK_SEND_MESSAGE"] }],
      toolkit_connection_statuses: [{ toolkit: "slack", has_active_connection: false }],
      tool_schemas: {
        SLACK_SEND_MESSAGE: { toolkit: "slack", tool_slug: "SLACK_SEND_MESSAGE", description: "Send" },
      },
    });
    const client = new ComposioClient(KEY);
    const r = await client.searchSessionTools("trs_1", "send a slack message");
    expect(r.results?.[0]?.primary_tool_slugs).toEqual(["SLACK_SEND_MESSAGE"]);

    const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      queries: [{ use_case: "send a slack message" }],
    });
  });

  it("executes tools with {tool_slug, arguments} in the body", async () => {
    const fetchMock = mockFetchOnce(200, { data: { status: "success" }, log_id: "log_1" });
    const client = new ComposioClient(KEY);
    const r = await client.executeSessionTool("trs_1", {
      toolSlug: "SLACK_SEND_MESSAGE",
      arguments: { channel: "#general", message: "hi" },
    });
    expect(r.data).toEqual({ status: "success" });

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(String(url)).toContain("/api/v3/tool_router/session/trs_1/execute");
    expect(JSON.parse(init.body as string)).toEqual({
      tool_slug: "SLACK_SEND_MESSAGE",
      arguments: { channel: "#general", message: "hi" },
    });
  });

  it("initiates links with the toolkit body shape", async () => {
    const fetchMock = mockFetchOnce(201, {
      link_token: "lt_1",
      redirect_url: "https://app.composio.dev/link/lt_1",
      connected_account_id: "ca_1",
    });
    const client = new ComposioClient(KEY);
    const r = await client.initiateSessionLink("trs_1", { toolkit: "slack" });
    expect(r.redirect_url).toContain("/link/lt_1");

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(String(url)).toContain("/api/v3/tool_router/session/trs_1/link");
    expect(JSON.parse(init.body as string)).toEqual({ toolkit: "slack" });
  });

  it("forwards catalog search/category/cursor/limit as query params", async () => {
    const fetchMock = mockFetchOnce(200, { items: [], next_cursor: "cur_2", total_items: 10 });
    const client = new ComposioClient(KEY);
    await client.listToolkits({ search: "slack", category: "communication", cursor: "cur_1", limit: 50 });

    const [url] = fetchMock.mock.calls[0] as [URL, RequestInit];
    const qs = new URL(url).searchParams;
    expect(qs.get("search")).toBe("slack");
    expect(qs.get("category")).toBe("communication");
    expect(qs.get("cursor")).toBe("cur_1");
    expect(qs.get("limit")).toBe("50");
  });

  it("sanitizes connected accounts — OAuth state/data NEVER survives", async () => {
    mockFetchOnce(200, {
      items: [
        {
          id: "ca_1",
          toolkit: { slug: "slack" },
          alias: "work",
          user_id: "user_123",
          status: "ACTIVE",
          created_at: "2025-01-01T00:00:00Z",
          state: {
            authScheme: "OAUTH2",
            val: { oauth_token: "xoxb-SECRET", oauth_token_secret: "SECRET" },
          },
          data: { access_token: "SECRET" },
        },
      ],
      next_cursor: null,
      total_items: 1,
    });
    const client = new ComposioClient(KEY);
    const r = await client.listConnectedAccounts({ userId: "user_123" });
    expect(r.items).toHaveLength(1);
    const acc = r.items[0]!;
    expect(acc).toEqual({
      id: "ca_1",
      toolkitSlug: "slack",
      authScheme: undefined,
      alias: "work",
      userId: "user_123",
      status: "ACTIVE",
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: undefined,
      isDisabled: false,
    });
    // The sanitized JSON never contains token material.
    const serialized = JSON.stringify(acc);
    expect(serialized).not.toContain("SECRET");
    expect(serialized).not.toContain("oauth_token");
  });

  it("drops connected-account records without an id", () => {
    expect(sanitizeConnectedAccount({ status: "ACTIVE" })).toBeNull();
  });

  it("maps connection states for the UI", () => {
    expect(connectionStateOf("ACTIVE")).toBe("active");
    expect(connectionStateOf("INITIALIZING")).toBe("initializing");
    expect(connectionStateOf("EXPIRED")).toBe("expired");
    expect(connectionStateOf("ERROR")).toBe("error");
    expect(connectionStateOf("something_else")).toBe("error");
  });

  it("rejects empty API keys client-side", () => {
    expect(() => new ComposioClient("   ")).toThrow(ComposioError);
  });
});

// Composio tools — external-app integrations via the Composio platform
// (Slack, GitHub, Gmail, Notion, Linear, …250+ apps).
//
// SESSION META-TOOL APPROACH (no schema dumping): the prompt carries only
// these three generic tools. The agent discovers concrete platform tools at
// RUNTIME with `composio_search_tools`, hands the user an OAuth link with
// `composio_connect_platform` when a platform isn't connected yet, and runs
// the discovered tool with `composio_execute_tool`.
//
// Flow baked into the descriptions: search first → (connect + WAIT if
// needed) → execute.
//
// All three are browser-registry tools: the handler runs in the browser,
// resolves the vault-encrypted Composio key transiently (see
// src/lib/composio/browser.ts) and proxies through /api/composio/* so the
// key never enters the model context, tool arguments, or logs.

import { registerTool } from "./registry";
import {
  resolveComposioHeaders,
  persistComposioSessionId,
} from "@/lib/composio/browser";
import { recordToolToolkits } from "@/lib/composio/branding";
import type { ToolResult } from "@/types";

/** Direct fetch that keeps the route's stable `error` code (jsonFetch would
 *  collapse it into a plain message). */
async function composioFetch(
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; code?: string; message?: string; data?: unknown; [k: string]: unknown }> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, code: "NETWORK", message: "Could not reach the Composio proxy route." };
  }
  const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok || !data || data.ok === false) {
    return {
      ok: false,
      code: typeof data?.error === "string" ? data.error : `HTTP_${res.status}`,
      message: typeof data?.message === "string" ? data.message : `Request failed (HTTP ${res.status})`,
    };
  }
  return { ok: true, ...data };
}

// ---------------------------------------------------------------------------
// composio_search_tools — natural-language discovery (session-scoped)
// ---------------------------------------------------------------------------

registerTool(
  "composio_search_tools",
  "Discover tools across 250+ external apps (Slack, GitHub, Gmail, Notion, Linear, Spotify, …) connected through Composio. FIRST STEP of every external-app task: describe WHAT you want to do in plain language (e.g. 'send a slack message to the #general channel' or 'create a github issue in repo x'). Returns matching tool slugs with their input schemas plus which platforms already have an active connection. Always search BEFORE executing. If a needed platform is NOT connected, call composio_connect_platform next, share the link with the user, and WAIT for them to authorize.",
  {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Natural-language use case, e.g. 'send a slack message to a channel'",
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
  async (args, ctx): Promise<ToolResult> => {
    const query = String((args as { query?: unknown }).query ?? "").trim();
    if (!query) {
      return { success: false, output: null, error: "A natural-language query is required." };
    }
    if (!ctx.userId) {
      return { success: false, output: null, error: "No active user — cannot resolve the Composio connection." };
    }
    let headers: Awaited<ReturnType<typeof resolveComposioHeaders>>;
    try {
      const h = await resolveComposioHeaders(ctx.userId);
      if (!h) throw new Error("NOT_CONNECTED");
      headers = h;
    } catch {
      return notConnectedResult();
    }
    try {
      const r = await composioFetch("/api/composio/tools/search", headers, { query });
      if (!r.ok) {
        return {
          success: false,
          output: null,
          error: r.message ?? "Composio tool search failed.",
          ...(r.code ? { code: r.code } : {}),
        };
      }
      // Persist any (re)created session so we reuse it on later calls.
      if (typeof r.sessionId === "string") {
        await persistComposioSessionId(ctx.userId, r.sessionId);
      }
      const tools = Array.isArray(r.tools) ? r.tools : [];
      // Harvest the authoritative toolName→toolkit mapping (each result
      // carries Composio's own tool_schemas.toolkit) so later execute calls
      // can brand themselves with the REAL platform logo (PRD §18–§23).
      // Pure client-side cache record — the result shape is untouched.
      recordToolToolkits(tools as ReadonlyArray<{ slug?: unknown; toolkit?: unknown }>);
      if (!tools.length) {
        return {
          success: true,
          output: {
            query,
            tools: [],
            connections: r.connections ?? [],
            message: "No matching tools found. Try a more specific query naming the app and the action.",
          },
        };
      }
      return {
        success: true,
        output: {
          query,
          tools,
          connections: r.connections ?? [],
          ...(Array.isArray(r.guidance) && r.guidance.length ? { guidance: r.guidance } : {}),
          nextStep:
            "Pick the right tool slug, build arguments from its inputSchema, and call composio_execute_tool. If a needed platform shows connected: false, call composio_connect_platform first and WAIT for the user.",
        },
      };
    } catch (e) {
      return { success: false, output: null, error: e instanceof Error ? e.message : String(e) };
    }
  },
  false,
  "integrations",
);

// ---------------------------------------------------------------------------
// composio_connect_platform — OAuth link for a platform
// ---------------------------------------------------------------------------

registerTool(
  "composio_connect_platform",
  "Get the OAuth authorization link for an external app platform (by Composio toolkit slug, e.g. 'slack', 'github', 'gmail', 'notion'). Returns a redirect URL that ONLY the user can open and authorize — you cannot complete the authorization yourself. Share the link with the user as a markdown link, tell them which platform it connects, then WAIT for their confirmation before checking the connection (composio_search_tools shows connected: true once authorized).",
  {
    type: "object",
    properties: {
      toolkit: {
        type: "string",
        description: "Composio toolkit slug, e.g. 'slack', 'github', 'gmail', 'notion'",
      },
    },
    required: ["toolkit"],
    additionalProperties: false,
  },
  async (args, ctx): Promise<ToolResult> => {
    const toolkit = String((args as { toolkit?: unknown }).toolkit ?? "").trim().toLowerCase();
    if (!toolkit) {
      return { success: false, output: null, error: "A toolkit slug is required (e.g. 'slack')." };
    }
    if (!ctx.userId) {
      return { success: false, output: null, error: "No active user — cannot resolve the Composio connection." };
    }
    let headers: Awaited<ReturnType<typeof resolveComposioHeaders>>;
    try {
      const h = await resolveComposioHeaders(ctx.userId);
      if (!h) throw new Error("NOT_CONNECTED");
      headers = h;
    } catch {
      return notConnectedResult();
    }
    try {
      const r = await composioFetch("/api/composio/connect-platform", headers, { toolkitSlug: toolkit });
      if (!r.ok) {
        return {
          success: false,
          output: null,
          error: r.message ?? "Could not initiate the connection.",
          ...(r.code ? { code: r.code } : {}),
        };
      }
      if (typeof r.sessionId === "string") {
        await persistComposioSessionId(ctx.userId, r.sessionId);
      }
      const redirectUrl = typeof r.redirectUrl === "string" ? r.redirectUrl : null;
      if (!redirectUrl) {
        return { success: false, output: null, error: "Composio did not return an authorization URL." };
      }
      return {
        success: true,
        output: {
          toolkit,
          redirectUrl,
          instructions:
            `Give this link to the user and WAIT: [Connect ${toolkit}](${redirectUrl}) — after they authorize, the platform will show connected: true in composio_search_tools results.`,
        },
      };
    } catch (e) {
      return { success: false, output: null, error: e instanceof Error ? e.message : String(e) };
    }
  },
  false,
  "integrations",
);

// ---------------------------------------------------------------------------
// composio_execute_tool — execute a discovered tool (session-scoped)
// ---------------------------------------------------------------------------

/**
 * Coerce the model's `args` payload into a plain object (user report
 * 2026-11-24: "args must be an object matching the tool's inputSchema" on
 * EVERY composio call). OpenAI-compatible gateways deliver tool arguments
 * in degenerate shapes that the old hard guard rejected outright:
 *
 *   1. DOUBLE-STRINGIFIED — "args": "{\"channel\":\"C123\"}" (the nested
 *      object arrived as a JSON string; some providers re-encode every
 *      object-valued parameter).
 *   2. ALIAS KEY — arguments/parameters/params/input instead of `args`
 *      (the model renamed the field after the Composio API's own wording).
 *   3. FLATTENED — the tool's fields ride the TOP level of our own tool
 *      call: {"toolName": "SLACK_SEND_MESSAGE", "channel": "C123", …} —
 *      the provider dropped one level of nesting.
 *   4. MISSING + extras — zero-field tools (`{}` inputSchema) are called
 *      with no args at all; also accepts `args: null`.
 *
 * Shared by the execute tool (full logic: alias + string + flatten) and the
 * route (parse-only, so the wire stays an object — see route.ts).
 */
export function coerceComposioArgs(
  raw: unknown,
  extra: Record<string, unknown> = {},
): Record<string, unknown> | null {
  // Alias keys: accept whichever object-valued alias the model chose.
  let candidate: unknown = raw;
  if (candidate == null) {
    // (4) missing/null → start from extras (flattened fields, if any)
    candidate = Object.keys(extra).length ? { ...extra } : {};
  }

  // (1) double-stringified JSON — parse once; on failure it's garbage.
  if (typeof candidate === "string") {
    const t = candidate.trim();
    if (!t) candidate = {};
    else {
      try {
        candidate = JSON.parse(t);
      } catch {
        return null; // unparseable string — genuinely bad payload
      }
    }
  }

  // Parsed from string OR native object — extras (the flattened tool fields
  // that rode the TOP level of our own call) always survive underneath: a
  // string args + flattened call keeps BOTH ({args:'{"text":"hi"}',
  // channel:"C8"} → {text, channel}).
  const mergeWithExtras = (obj: Record<string, unknown>): Record<string, unknown> => {
    const merged: Record<string, unknown> = { ...extra };
    for (const [k, v] of Object.entries(obj)) {
      if (v !== undefined) merged[k] = v;
    }
    return merged;
  };

  if (Array.isArray(candidate)) return null; // arrays are never the inputSchema
  if (candidate !== null && typeof candidate === "object" && !(candidate instanceof Date)) {
    const obj = candidate as Record<string, unknown>;
    // Alias unwrap ONE level: {args: {...}} / {arguments: {...}} wrapped
    // AGAIN by the model (string args inside an object, etc.).
    const inner = obj.args ?? obj.arguments ?? obj.parameters ?? obj.params ?? obj.input;
    if (inner != null && typeof inner === "string") {
      try {
        const parsed = JSON.parse(inner.trim());
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return mergeWithExtras(parsed as Record<string, unknown>);
        }
      } catch {
        return null;
      }
    }
    // (2) alias key at OUR level: {arguments: {...}} → use the inner object
    if (inner != null && typeof inner === "object" && !Array.isArray(inner)) {
      return mergeWithExtras(inner as Record<string, unknown>);
    }
    // Plain object — merge extras so flattened fields survive.
    return mergeWithExtras(obj);
  }
  return null;
}

registerTool(
  "composio_execute_tool",
  "Execute a Composio tool that was discovered with composio_search_tools, passing a JSON arguments object built from the tool's inputSchema. Server-side, session-scoped, runs with the user's connected account. If the platform isn't connected you get a CONNECTION_REQUIRED error — do NOT retry blindly: call composio_connect_platform, share the OAuth link with the user, and wait for them to authorize. Never fabricate a result: report exactly what the tool returned (its data, error, or logId).",
  {
    type: "object",
    properties: {
      toolName: {
        type: "string",
        description: "The Composio tool slug from composio_search_tools, e.g. 'SLACK_SEND_MESSAGE'",
      },
      args: {
        type: "object",
        description: "Arguments matching the tool's inputSchema (from composio_search_tools)",
      },
    },
    required: ["toolName", "args"],
    additionalProperties: false,
  },
  async (args, ctx): Promise<ToolResult> => {
    const input = args as { toolName?: unknown; args?: unknown };
    let toolName = String(input.toolName ?? "").trim();
    if (!toolName) {
      return { success: false, output: null, error: "toolName is required (a slug from composio_search_tools)." };
    }

    // DEGENERATE-SHAPE COERCION (user report 2026-11-24): the model may
    // deliver args double-stringified, under an alias key, flattened into
    // our own call's top level, or missing for zero-field tools. Normalize
    // ALL of those into the plain object Composio expects before executing
    // — the old hard guard rejected them with "args must be an object…"
    // on EVERY call.
    const {
      args: flattened,
      toolName: flattenedTool,
      // Alias keys are WRAPPERS, not flattened fields — excluded from extras
      // so they never leak into the merged tool args.
      arguments: _a,
      parameters: _p,
      params: _pa,
      input: _i,
      ...flatExtras
    } = input as Record<string, unknown>;
    const coerced = coerceComposioArgs(
      flattened ?? (input as { arguments?: unknown }).arguments ?? null,
      flatExtras,
    );
    if (!coerced) {
      return {
        success: false,
        output: null,
        error:
          "args must be a JSON object matching the tool's inputSchema (a JSON string, an object, or the tool's fields directly are all accepted).",
      };
    }
    // A flattened call can name the tool via arguments-as-string too — pick
    // up the toolName if it only appeared in the extras.
    if (!toolName && typeof flattenedTool === "string") toolName = flattenedTool.trim();
    const toolArgs = coerced;
    if (!ctx.userId) {
      return { success: false, output: null, error: "No active user — cannot resolve the Composio connection." };
    }
    let headers: Awaited<ReturnType<typeof resolveComposioHeaders>>;
    try {
      const h = await resolveComposioHeaders(ctx.userId);
      if (!h) throw new Error("NOT_CONNECTED");
      headers = h;
    } catch {
      return notConnectedResult();
    }
    try {
      const r = await composioFetch("/api/composio/tools/execute", headers, {
        toolName,
        args: toolArgs,
      });
      if (!r.ok) {
        const connectionRequired = r.code === "CONNECTION_REQUIRED";
        return {
          success: false,
          output: null,
          error: r.message ?? "Tool execution failed.",
          ...(r.code ? { code: r.code } : {}),
          ...(connectionRequired
            ? {
                action:
                  "Call composio_connect_platform with the platform's toolkit slug (you saw it in the composio_search_tools results), share the OAuth link with the user, then wait for them to authorize.",
              }
            : {}),
        };
      }
      if (typeof r.sessionId === "string") {
        await persistComposioSessionId(ctx.userId, r.sessionId);
      }
      return {
        success: true,
        output: {
          tool: toolName,
          data: r.data ?? null,
          ...(typeof r.toolError === "string" && r.toolError ? { toolError: r.toolError } : {}),
          ...(typeof r.logId === "string" && r.logId ? { logId: r.logId } : {}),
        },
      };
    } catch (e) {
      return { success: false, output: null, error: e instanceof Error ? e.message : String(e) };
    }
  },
  false,
  "integrations",
);

/** The shared "Composio isn't set up" answer — surfaces a connect action,
 *  never a fake success. */
function notConnectedResult(): ToolResult {
  return {
    success: false,
    output: null,
    error:
      "COMPOSIO_NOT_CONNECTED: Composio isn't configured yet. Ask the user to add their Composio API key in Settings → Integrations (https://composio.dev → Settings → Project Settings → API Keys), then retry.",
  };
}

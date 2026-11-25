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

/** A tool-args object (at any depth) that looks like Composio's file
 *  descriptor { name, mimetype, s3key } — with an s3key that was invented
 *  (empty / placeholder / obviously not a storage key). Returns the
 *  parameter's path + the offending s3key so the guard can name it. */
function findFabricatedFileParam(
  node: unknown,
  path = "",
): { param: string; s3key: string } | null {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      const hit = findFabricatedFileParam(node[i], path ? `${path}[${i}]` : `[${i}]`);
      if (hit) return hit;
    }
    return null;
  }
  if (!node || typeof node !== "object") return null;
  const obj = node as Record<string, unknown>;
  const looksLikeDescriptor =
    typeof obj.name === "string" &&
    typeof obj.mimetype === "string" &&
    "s3key" in obj; // the marker Composio's file params carry
  if (looksLikeDescriptor) {
    const s3key = typeof obj.s3key === "string" ? obj.s3key.trim() : "";
    // Only flag CERTAIN fabrications: empty or explicit placeholders. A
    // real key's shape isn't guaranteed to carry slashes — don't risk a
    // false positive rejecting a legitimately staged descriptor.
    if (!s3key || /^(test|dummy|fake|placeholder|xxx|your_s3key|<|\{)/i.test(s3key)) {
      return { param: path || "file_to_upload", s3key: s3key || "" };
    }
  }
  for (const [k, v] of Object.entries(obj)) {
    const hit = findFabricatedFileParam(v, path ? `${path}.${k}` : k);
    if (hit) return hit;
  }
  return null;
}

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

// Arg coercion lives in the SERVER-SAFE module src/lib/composio/coerce.ts —
// re-exported here for the browser tool + tests, while server routes import
// it directly from there (importing THIS file from a route drags the "use
// client" registry in and breaks `next build`; see worklog Task 45).
// NOTE: `export … from` does NOT bind the name locally — import it too so
// the handler below can call it.
import { coerceComposioArgs } from "@/lib/composio/coerce";
export { coerceComposioArgs };

registerTool(
  "composio_execute_tool",
  "Execute a Composio tool that was discovered with composio_search_tools, passing a JSON arguments object built from the tool's inputSchema. Pass `args` as a real JSON OBJECT — never a JSON-encoded string ('{\"q\": …}' is wrong; {\"q\": …} is right). Server-side, session-scoped, runs with the user's connected account. If the platform isn't connected you get a CONNECTION_REQUIRED error — do NOT retry blindly: call composio_connect_platform, share the OAuth link with the user, and wait for them to authorize. Never fabricate a result: report exactly what the tool returned (its data, error, or logId).",
  {
    type: "object",
    properties: {
      toolName: {
        type: "string",
        description: "The Composio tool slug from composio_search_tools, e.g. 'SLACK_SEND_MESSAGE'",
      },
      args: {
        type: "object",
        description:
          "Arguments matching the tool's inputSchema (from composio_search_tools), passed as a JSON OBJECT (not a stringified one)",
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

    // FABRICATED-S3KEY GUARD (user report 2026-11-25): Composio file
    // parameters carry { name, mimetype, s3key } — the s3key is minted by
    // Composio's Files API and can NEVER be invented. An empty/placeholder
    // one reaches their Apollo files API and dies with HTTP 400 AFTER the
    // call was already accepted, wasting the turn. Catch it here and route
    // the model to composio_upload_file, which stages the file and returns
    // the REAL descriptor.
    const fileParamGuard = findFabricatedFileParam(toolArgs);
    if (fileParamGuard) {
      return {
        success: false,
        output: null,
        error:
          `The '${fileParamGuard.param}' parameter needs a REAL s3key from Composio's file storage — '${fileParamGuard.s3key}' is not one (an invented/empty s3key fails inside Composio with HTTP 400).`,
        action:
          `Call composio_upload_file first with { toolName: "${toolName}", filePath: <workspace file> } (or content for inline text) — it returns the exact { name, mimetype, s3key } descriptor. Then retry composio_execute_tool with that descriptor as the '${fileParamGuard.param}' value, unchanged.`,
      };
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

// ---------------------------------------------------------------------------
// composio_upload_file — stage a file into Composio's storage, get the
// real s3key its file-consuming tools demand (GOOGLEDRIVE_CREATE_FILE's
// `file_to_upload` etc.).
//
// Motivation (user report 2026-11-25): the model fabricated
// `file_to_upload: { name, mimetype, s3key: "" }` from thin air because NO
// upload flow existed — Composio's Apollo files API then failed the whole
// tool call with HTTP 400. The s3key is minted by Composio's two-step
// Files API (upload-request → presigned PUT) and can NEVER be invented.
//
// The model passes EITHER inline `content` OR a workspace `filePath` —
// the AI's own generated scripts/outputs (E2B sandbox files) are read
// from the sandbox as bytes and staged WITHOUT the model re-typing their
// contents into the tool call (which would corrupt binaries and blow the
// context window).
// ---------------------------------------------------------------------------

/** Guess a mimetype from a filename — only used to pre-fill the Files-API
 *  request; the tool call's own explicit mimetype always wins. */
function guessMime(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  const table: Record<string, string> = {
    txt: "text/plain", md: "text/markdown", csv: "text/csv", json: "application/json",
    js: "text/javascript", ts: "text/plain", py: "text/x-python", sh: "text/x-shellscript",
    html: "text/html", css: "text/css", pdf: "application/pdf", png: "image/png",
    jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", svg: "image/svg+xml",
    webp: "image/webp", zip: "application/zip", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    mp4: "video/mp4", wav: "audio/wav", mp3: "audio/mpeg",
  };
  return table[ext] ?? "application/octet-stream";
}

registerTool(
  "composio_upload_file",
  "Stage a file into Composio's storage and get the REAL `s3key` its file-consuming tools require. Use BEFORE composio_execute_tool whenever the tool's schema has a file parameter (e.g. GOOGLEDRIVE_CREATE_FILE's `file_to_upload`: { name, mimetype, s3key }). NEVER fabricate an s3key — an empty one fails the call with an Apollo files-API 400. Sources: pass `filePath` for a file in the user's workspace (a script you wrote, an output/automated artifact — read as raw bytes, binaries safe) OR `content` for text you have in-context. Then call composio_execute_tool with the returned fileDescriptor EXACTLY as the file parameter's value.",
  {
    type: "object",
    properties: {
      toolName: {
        type: "string",
        description: "The Composio tool that will consume this file (e.g. 'GOOGLEDRIVE_CREATE_FILE') — from composio_search_tools.",
      },
      filePath: {
        type: "string",
        description: "Workspace-relative path of an existing file (e.g. 'output/clips.md', 'scripts/analyze.py'). Preferred for anything you created or ran in the sandbox.",
      },
      content: {
        type: "string",
        description: "Inline text content (used only when filePath is absent). For workspace files always prefer filePath.",
      },
      filename: {
        type: "string",
        description: "Name for the staged file. Defaults to the filePath's basename (or 'file.txt' for inline content).",
      },
      mimetype: {
        type: "string",
        description: "Mime type; inferred from the filename extension when omitted.",
      },
    },
    required: ["toolName"],
    additionalProperties: false,
  },
  async (args, ctx): Promise<ToolResult> => {
    const input = args as {
      toolName?: unknown; filePath?: unknown; content?: unknown;
      filename?: unknown; mimetype?: unknown;
    };
    const toolName = String(input.toolName ?? "").trim();
    if (!toolName) {
      return { success: false, output: null, error: "toolName is required — the Composio tool that will consume this file." };
    }
    const filePath = typeof input.filePath === "string" ? input.filePath.trim() : "";
    const inlineContent = typeof input.content === "string" ? input.content : "";
    if (!filePath && !inlineContent) {
      return { success: false, output: null, error: "Provide either filePath (a workspace file) or content (inline text)." };
    }
    if (!ctx.userId) {
      return { success: false, output: null, error: "No active user — cannot resolve the Composio connection." };
    }

    // Resolve the toolkit for the Files-API request. We only know slugs we
    // harvested from composio_search_tools results; never guess from the
    // tool-name prefix (PRD §23) — fall back to a generic 'unknown' the
    // route can reject cleanly... but the harvested map usually has it.
    const { getToolkitSlugForTool } = await import("@/lib/composio/branding");
    const toolkitSlug = getToolkitSlugForTool(toolName);
    if (!toolkitSlug) {
      return {
        success: false,
        output: null,
        error:
          `No toolkit mapping for ${toolName}. Run composio_search_tools for the task first — its results teach this app which toolkit owns the tool (needed for file staging).`,
      };
    }

    // Read the bytes: sandbox file (preferred) or inline text.
    let bytes: Uint8Array;
    let filename: string;
    if (filePath) {
      const { chatSandboxForCtx } = await import("@/lib/e2b/sandbox-rotation");
      const sbx = await chatSandboxForCtx(ctx);
      if (!sbx) {
        return { success: false, output: null, error: "No sandbox configured — the workspace file can't be read. Use inline `content` instead." };
      }
      try {
        const blob = await sbx.client.readFileBytes(filePath);
        if (!blob) throw new Error("empty file");
        bytes = new Uint8Array(await blob.arrayBuffer());
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { success: false, output: null, error: `Failed to read workspace file '${filePath}': ${msg}` };
      }
      filename = String(input.filename ?? "").trim() || filePath.split("/").pop() || "file.txt";
    } else {
      // Inline text — encode as UTF-8 bytes.
      bytes = new TextEncoder().encode(inlineContent);
      filename = String(input.filename ?? "").trim() || "file.txt";
    }
    if (bytes.length === 0) {
      return { success: false, output: null, error: "File is empty — nothing to stage." };
    }
    if (bytes.length > 20 * 1024 * 1024) {
      return { success: false, output: null, error: `File too large: ${bytes.length} bytes (max 20 MB).` };
    }

    const mimetype = String(input.mimetype ?? "").trim() || guessMime(filename);

    // Base64 the bytes for the proxy route (the route re-hashes + PUTs).
    let binary = "";
    const CHUNK = 0x8000; // 32 KB per String.fromCharCode — stack-safe.
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    const b64 = btoa(binary);

    let headers: Awaited<ReturnType<typeof resolveComposioHeaders>>;
    try {
      const h = await resolveComposioHeaders(ctx.userId);
      if (!h) throw new Error("NOT_CONNECTED");
      headers = h;
    } catch {
      return notConnectedResult();
    }

    const r = await composioFetch("/api/composio/files/upload", headers, {
      toolkitSlug,
      toolSlug: toolName,
      filename,
      mimetype,
      contentB64: b64,
    });
    if (!r.ok) {
      return { success: false, output: null, error: r.message ?? "File staging failed.", ...(r.code ? { code: r.code } : {}) };
    }
    const descriptor = (r.fileDescriptor ?? null) as { name?: unknown; mimetype?: unknown; s3key?: unknown } | null;
    const s3key = typeof r.s3key === "string" ? r.s3key : typeof descriptor?.s3key === "string" ? descriptor.s3key : "";
    if (!s3key) {
      return { success: false, output: null, error: "Composio returned no s3key — staging incomplete. Retry once, then report the failure." };
    }
    return {
      success: true,
      output: {
        message: `Staged ${filename} (${bytes.length} bytes) for ${toolName}.`,
        fileDescriptor: { name: filename, mimetype, s3key },
        next:
          "Call composio_execute_tool and set the tool's file parameter (e.g. file_to_upload) to this fileDescriptor object EXACTLY — do not edit the s3key.",
      },
    };
  },
  false,
  "integrations",
);

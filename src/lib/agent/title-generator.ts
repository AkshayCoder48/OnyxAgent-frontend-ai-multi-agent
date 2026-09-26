"use client";

/**
 * Chat-title naming call (PRD §12 — first call = chat naming call).
 *
 * When the user sends the FIRST message of a new chat, a small DEDICATED
 * chat-completion call generates ONLY the conversation title BEFORE the main
 * agent call begins. This keeps the naming model output completely separate
 * from the chat messages (it never touches the emit pipeline / turn stores).
 *
 * Flow (interactive new chats only — scheduled-task chats get their title
 * from the task name in the scheduler engine):
 *
 *   Prompt submitted (new chat)
 *     → conversation created with an EMPTY title (UI shows the skeleton)
 *     → Call 1: THIS naming call (non-streaming, same provider+model the
 *       user selected — resolved by use-chat's buildTurnOptions)
 *     → title applied → fades/slides into the empty title space
 *     → Call 2: the main agent call (streaming) begins
 *
 * Robustness contract: `generateChatTitle` NEVER throws and NEVER takes
 * longer than its timeout (~12s, AbortController). On ANY failure (network,
 * non-OK, unparseable body, timeout) it resolves `null` and the caller falls
 * back to the first 60 chars of the prompt (the pre-naming behavior) — the
 * main agent call is never blocked longer than the caller's wait cap.
 */

import { applyParamPolicy } from "@/lib/agent/param-policy";
import { buildWireMessages, getWireCompat } from "@/lib/agent/wire-compat";

const CHAT_PROXY_URL = "/api/chat-proxy";

/** Hard abort for the naming call. The caller additionally caps its own wait
 *  at a shorter duration (see use-chat doSend) so the main call never stalls. */
export const TITLE_TIMEOUT_MS = 12_000;

/**
 * The caller's wait cap (PRD §12 ordering tradeoff): the naming call normally
 * resolves in well under two seconds, and the main agent call waits for it
 * (naming call → title animation → main call). But if the provider is slow
 * or broken, blocking the chat for the full TITLE_TIMEOUT_MS would be terrible
 * UX — so after this cap the main call starts anyway and the title lands
 * whenever the naming call finishes (the reveal animation plays late, which
 * still looks correct because the title space stays a skeleton until then).
 */
export const TITLE_WAIT_CAP_MS = 6_000;

/** The naming prompt — short, language-agnostic, no formatting. */
export const TITLE_SYSTEM_PROMPT =
  "You generate short chat titles. Reply with ONLY the title, 2-5 words, no quotes, no punctuation at the end, in the user's language.";

/** The first message is truncated to this length before being sent — the
 *  title only needs the topic, and this keeps the call tiny + fast. */
export const TITLE_INPUT_LIMIT = 500;

/** Hard cap on the SANITIZED title (a misbehaving model that answers with a
 *  paragraph gets clipped instead of blowing up the sidebar/subheader).
 *  No `max_tokens` is sent in the request on purpose: reasoning models would
 *  spend the whole budget thinking and return an empty `content`. */
export const TITLE_MAX_LENGTH = 80;

/** Provider shape needed for the naming call — exactly what buildTurnOptions
 *  already resolved for the main turn (same provider the user selected). */
export interface TitleProviderConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** When true, use the base URL as-is (no /chat/completions suffix). */
  noPrefix?: boolean;
  /** Request parameters this provider rejects (Settings → Edit Provider). */
  disabledParams?: string[];
}

/** Truncate the first message for the naming prompt (pure). */
export function truncateTitleInput(firstMessage: string): string {
  return firstMessage.slice(0, TITLE_INPUT_LIMIT);
}

/** Build the naming call's message array (pure) — exported for tests. */
export function buildTitleMessages(
  firstMessage: string,
): Array<{ role: "system" | "user"; content: string }> {
  return [
    { role: "system", content: TITLE_SYSTEM_PROMPT },
    { role: "user", content: truncateTitleInput(firstMessage) },
  ];
}

/** Quote characters models wrap titles in (straight/curly/guillemets/backticks). */
const WRAPPER_CHARS = "\"'«»„“”‘’`";
const ONLY_WRAPPERS_RE = /^["'«»„“”‘’`]+$/;

/**
 * Sanitize a raw model reply into a display title (pure).
 * Strips: wrapping quote PAIRS (one layer at a time so ""Title"" collapses
 * fully, while a lone apostrophe — "users' guide" — is preserved), "Title:"
 * labels, markdown emphasis, surrounding whitespace, and trailing
 * punctuation. Collapses inner newlines/tabs to single spaces and caps the
 * length. Returns "" when nothing usable remains (caller falls back).
 */
export function sanitizeChatTitle(raw: string): string {
  let title = raw.trim();

  // Strip a leading label ("Title:", "Chat title:", "Titel —" …).
  title = title.replace(/^(?:chat\s*)?title\s*[:\-–—]\s*/i, "");

  // Unwrap matched quote pairs FIRST (before markdown stripping — the
  // `code` rule below would otherwise eat wrapping backticks). One layer
  // per pass; only BOTH-ends matches strip, so "``Title''" / "«Title»" /
  // "\"Title\"" all collapse while a possessive trailing apostrophe
  // ("users' guide") survives.
  while (
    title.length >= 2 &&
    WRAPPER_CHARS.includes(title[0]!) &&
    WRAPPER_CHARS.includes(title[title.length - 1]!)
  ) {
    title = title.slice(1, -1).trim();
  }
  // Nothing left but quote characters → unusable.
  if (title.length > 0 && ONLY_WRAPPERS_RE.test(title)) return "";

  // Strip markdown emphasis + headings the model may add.
  title = title
    .replace(/^#{1,6}\s*/, "")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/\*(.*?)\*/g, "$1")
    .replace(/__(.*?)__/g, "$1")
    .replace(/_(.*?)_/g, "$1")
    .replace(/`([^`]*)`/g, "$1");

  // Collapse internal whitespace (multi-line prompts → one line).
  title = title.replace(/\s+/g, " ").trim();

  // No punctuation at the end (per the prompt — enforce it anyway).
  title = title.replace(/[\s.,!?;:…、。，！？；：\-–—]+$/, "");

  if (!title) return "";
  return title.length > TITLE_MAX_LENGTH ? title.slice(0, TITLE_MAX_LENGTH) : title;
}

/**
 * Fallback title when the naming call fails: the first 60 chars of the
 * prompt (the pre-naming behavior). Whitespace is collapsed so a multi-line
 * first message doesn't become a broken 3-line sidebar entry.
 */
export function fallbackChatTitle(firstMessage: string): string {
  const collapsed = firstMessage.replace(/\s+/g, " ").trim();
  return collapsed.length > 60 ? `${collapsed.slice(0, 60)}…` : collapsed;
}

/**
 * Extract the assistant text from a chat-completions response body (pure).
 * Handles the two shapes the proxy can return:
 *  1. A plain JSON body (`stream:false` honored) → choices[0].message.content
 *     (string, or an OpenAI-style content-parts array).
 *  2. An SSE stream (some providers force streaming regardless of
 *     `stream:false` — the proxy always requests text/event-stream) → the
 *     concatenated `choices[0].delta.content` fragments.
 * Returns null when no text can be extracted.
 */
export function parseChatTitleBody(bodyText: string): string | null {
  if (!bodyText) return null;

  // 1. Plain JSON body.
  try {
    const obj = JSON.parse(bodyText) as {
      choices?: Array<{
        message?: { content?: unknown };
        delta?: { content?: unknown };
      }>;
    };
    const choice = obj.choices?.[0];
    const content = choice?.message?.content ?? choice?.delta?.content;
    const text = contentPartsToString(content);
    if (text) return text;
  } catch {
    // Not plain JSON — fall through to the SSE scan.
  }

  // 2. SSE scan — accumulate delta fragments from every `data:` line.
  let sse = "";
  for (const line of bodyText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const obj = JSON.parse(payload) as {
        choices?: Array<{ delta?: { content?: unknown }; message?: { content?: unknown } }>;
      };
      const choice = obj.choices?.[0];
      const fragment = contentPartsToString(choice?.delta?.content ?? choice?.message?.content);
      if (fragment) sse += fragment;
    } catch {
      // Skip unparseable keep-alive/comment frames.
    }
  }
  return sse || null;
}

/** Chat-completions `content` can be a string or an array of
 *  `{ type: "text", text }` parts — flatten to a string. */
function contentPartsToString(content: unknown): string | null {
  if (typeof content === "string") return content || null;
  if (Array.isArray(content)) {
    const joined = content
      .map((part) =>
        typeof part === "string"
          ? part
          : typeof part === "object" && part !== null && "text" in part
            ? String((part as { text?: unknown }).text ?? "")
            : "",
      )
      .join("")
      .trim();
    return joined || null;
  }
  return null;
}

/**
 * The naming call — a minimal NON-STREAMING chat completion through the
 * existing /api/chat-proxy (x-target-url header, same request shape as the
 * runtime's streamRound). Resolves with the sanitized title, or null on ANY
 * failure (the caller applies the fallback). Never rejects.
 *
 * No rate-limit retry loop on purpose: the naming call sits on the critical
 * path before the main turn — if the provider is rate-limited the MAIN call
 * will hit the same limit and run its own backoff there; failing fast here
 * (→ fallback title) keeps the chat responsive.
 */
export async function generateChatTitle(opts: {
  provider: TitleProviderConfig;
  firstMessage: string;
  /** Hard timeout (defaults to TITLE_TIMEOUT_MS). */
  timeoutMs?: number;
  /** Optional external abort (e.g. the execution's stop signal). */
  signal?: AbortSignal;
}): Promise<string | null> {
  const { provider, firstMessage, timeoutMs = TITLE_TIMEOUT_MS, signal } = opts;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const abortWithExternal = () => controller.abort();
  signal?.addEventListener("abort", abortWithExternal, { once: true });
  try {
    // Target URL — identical resolution to the runtime's streamRound.
    const base = provider.baseUrl.replace(/\/$/, "");
    const targetUrl = provider.noPrefix ? base : `${base}/chat/completions`;

    const body: Record<string, unknown> = {
      model: provider.model,
      // STRICT-GATEWAY WIRE COMPAT (LLM HTTP 400 fix): apply any modes the
      // session already learned for this provider+model (e.g. the system
      // prompt is content-filtered → compact/dropped). No probing ladder
      // here on purpose — the naming call must fail fast to its fallback.
      messages: buildWireMessages(
        buildTitleMessages(firstMessage),
        getWireCompat(provider.baseUrl, provider.model),
      ),
      stream: false, // one tiny JSON reply — no SSE needed
    };
    // Strip params the user disabled / the session auto-learned to ban.
    applyParamPolicy(body, {
      baseUrl: provider.baseUrl,
      model: provider.model,
      disabledParams: provider.disabledParams,
    });

    const response = await fetch(
      `${CHAT_PROXY_URL}?url=${encodeURIComponent(targetUrl)}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-target-url": targetUrl,
          Authorization: `Bearer ${provider.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
        cache: "no-store",
      },
    );
    if (!response.ok) {
      // STRICT-GATEWAY one-shot retry (LLM HTTP 400 fix): providers that
      // content-filter system prompts (e.g. gen.pollinations.ai community
      // routes reject this very naming prompt — verified live) get ONE
      // immediate retry with the system message dropped. The model can
      // still name the chat from the user message alone; any other failure
      // resolves null and the caller applies the fallback title. No
      // probing ladder — the naming call must fail fast.
      if (response.status === 400 && Array.isArray(body.messages)) {
        const withoutSystem = (body.messages as Array<{ role: string }>).filter(
          (m) => m.role !== "system",
        );
        if (withoutSystem.length !== (body.messages as unknown[]).length) {
          const retry = await fetch(
            `${CHAT_PROXY_URL}?url=${encodeURIComponent(targetUrl)}`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "x-target-url": targetUrl,
                Authorization: `Bearer ${provider.apiKey}`,
              },
              body: JSON.stringify({ ...body, messages: withoutSystem }),
              signal: controller.signal,
              cache: "no-store",
            },
          );
          if (retry.ok) {
            const rawRetry = parseChatTitleBody(await retry.text());
            if (rawRetry !== null) {
              const titleRetry = sanitizeChatTitle(rawRetry);
              if (titleRetry) return titleRetry;
            }
            return null;
          }
        }
      }
      return null;
    }

    const raw = parseChatTitleBody(await response.text());
    if (raw === null) return null;
    const title = sanitizeChatTitle(raw);
    return title || null;
  } catch {
    // Abort (timeout/stop), network error, body read failure — any failure
    // means "use the fallback title". Never throw to the caller.
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abortWithExternal);
  }
}

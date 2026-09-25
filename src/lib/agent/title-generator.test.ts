// @vitest-environment node
/**
 * Unit tests for the chat-title naming call (src/lib/agent/title-generator.ts,
 * PRD §12 — first call = chat naming call).
 *
 * Pins:
 *  - the naming PROMPT (system text + 500-char input truncation);
 *  - the SANITIZER (quotes / labels / markdown / trailing punctuation / cap);
 *  - the FALLBACK title (first 60 chars, whitespace collapsed);
 *  - the RESPONSE PARSER (plain JSON, OpenAI content-parts, forced SSE);
 *  - the CALL ITSELF: proxy URL + x-target-url, user's provider+model,
 *    stream:false, never-rejects contract (non-OK → null, timeout → null,
 *    external abort → null).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TITLE_INPUT_LIMIT,
  TITLE_SYSTEM_PROMPT,
  buildTitleMessages,
  fallbackChatTitle,
  generateChatTitle,
  parseChatTitleBody,
  sanitizeChatTitle,
  truncateTitleInput,
  type TitleProviderConfig,
} from "./title-generator";

afterEach(() => {
  vi.unstubAllGlobals();
});

const PROVIDER: TitleProviderConfig = {
  baseUrl: "https://api.example.com/v1",
  apiKey: "sk-test",
  model: "test-model",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("title prompt construction", () => {
  it("uses the exact naming system prompt and the raw first message", () => {
    const messages = buildTitleMessages("Fix the login bug");
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({ role: "system", content: TITLE_SYSTEM_PROMPT });
    expect(messages[1]).toEqual({ role: "user", content: "Fix the login bug" });
  });

  it("truncates the first message to the input limit", () => {
    expect(TITLE_INPUT_LIMIT).toBe(500);
    const long = "x".repeat(1200);
    expect(truncateTitleInput(long)).toHaveLength(500);
    expect(buildTitleMessages(long)[1]!.content).toHaveLength(500);
  });
});

describe("sanitizeChatTitle", () => {
  it("keeps a clean title untouched", () => {
    expect(sanitizeChatTitle("Fix login bug")).toBe("Fix login bug");
  });

  it("strips wrapping quotes and backticks (nested too)", () => {
    expect(sanitizeChatTitle('"Fix login bug"')).toBe("Fix login bug");
    expect(sanitizeChatTitle("“Fix login bug”")).toBe("Fix login bug");
    expect(sanitizeChatTitle("``Fix login bug''")).toBe("Fix login bug");
    expect(sanitizeChatTitle('""Fix login bug""')).toBe("Fix login bug");
    expect(sanitizeChatTitle("«Fix login bug»")).toBe("Fix login bug");
  });

  it("keeps a possessive apostrophe (single-end quotes are content)", () => {
    expect(sanitizeChatTitle("Users' guide")).toBe("Users' guide");
  });

  it("strips Title: labels, markdown emphasis and headings", () => {
    expect(sanitizeChatTitle("Title: Fix login bug")).toBe("Fix login bug");
    expect(sanitizeChatTitle("Chat title - Fix login bug")).toBe("Fix login bug");
    expect(sanitizeChatTitle("**Fix login bug**")).toBe("Fix login bug");
    expect(sanitizeChatTitle("# Fix login bug")).toBe("Fix login bug");
    expect(sanitizeChatTitle("`Fix login bug`")).toBe("Fix login bug");
  });

  it("strips trailing punctuation and collapses inner whitespace", () => {
    expect(sanitizeChatTitle("Fix login bug.")).toBe("Fix login bug");
    expect(sanitizeChatTitle("Fix login bug!?…")).toBe("Fix login bug");
    expect(sanitizeChatTitle("Fix   login\n\tbug — prod.")).toBe("Fix login bug — prod");
  });

  it("caps the length at the model-side limit", () => {
    const long = "word ".repeat(40).trim(); // 200 chars
    expect(sanitizeChatTitle(long).length).toBeLessThanOrEqual(80);
  });

  it("returns an empty string for unusable input", () => {
    expect(sanitizeChatTitle("")).toBe("");
    expect(sanitizeChatTitle("   ")).toBe("");
    expect(sanitizeChatTitle('"..."')).toBe("");
  });
});

describe("fallbackChatTitle", () => {
  it("returns short prompts verbatim (whitespace collapsed)", () => {
    expect(fallbackChatTitle("hello world")).toBe("hello world");
    expect(fallbackChatTitle("line one\nline two")).toBe("line one line two");
  });

  it("truncates at 60 chars with an ellipsis (pre-naming behavior)", () => {
    const input = "y".repeat(100);
    const title = fallbackChatTitle(input);
    expect(title.length).toBe(61);
    expect(title.endsWith("…")).toBe(true);
    expect(title.slice(0, 60)).toBe("y".repeat(60));
  });
});

describe("parseChatTitleBody", () => {
  it("reads choices[0].message.content from a plain JSON body", () => {
    const body = JSON.stringify({
      choices: [{ message: { role: "assistant", content: "Fix login bug" } }],
    });
    expect(parseChatTitleBody(body)).toBe("Fix login bug");
  });

  it("flattens OpenAI-style content-parts arrays", () => {
    const body = JSON.stringify({
      choices: [
        { message: { role: "assistant", content: [{ type: "text", text: "Fix " }, { type: "text", text: "login bug" }] } },
      ],
    });
    expect(parseChatTitleBody(body)).toBe("Fix login bug");
  });

  it("accumulates delta fragments when the provider force-streams SSE", () => {
    const body = [
      'data: {"choices":[{"delta":{"content":"Fix "}}]}',
      "",
      "data: {\"choices\":[{\"delta\":{\"content\":\"login\"}}]}",
      "data: {\"choices\":[{\"delta\":{\"content\":\" bug\"}}]}",
      "data: [DONE]",
    ].join("\n");
    expect(parseChatTitleBody(body)).toBe("Fix login bug");
  });

  it("returns null for unparseable bodies", () => {
    expect(parseChatTitleBody("")).toBeNull();
    expect(parseChatTitleBody("<html>oops</html>")).toBeNull();
    expect(parseChatTitleBody(JSON.stringify({ error: "no key" }))).toBeNull();
  });
});

describe("generateChatTitle (the naming call)", () => {
  it("calls the proxy with the user's provider+model, stream:false, and sanitizes the reply", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ choices: [{ message: { content: '"Fix login bug."' } }] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const title = await generateChatTitle({
      provider: PROVIDER,
      firstMessage: "Please fix the login bug on the settings page",
    });

    expect(title).toBe("Fix login bug");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url.startsWith("/api/chat-proxy?url=")).toBe(true);
    expect(url).toContain(encodeURIComponent("https://api.example.com/v1/chat/completions"));
    expect(init.headers).toMatchObject({
      "x-target-url": "https://api.example.com/v1/chat/completions",
      Authorization: "Bearer sk-test",
    });
    const body = JSON.parse(String(init.body)) as {
      model: string;
      stream: boolean;
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.model).toBe("test-model"); // the user's ACTIVE model, never hardcoded
    expect(body.stream).toBe(false);
    expect(body.messages).toEqual(buildTitleMessages("Please fix the login bug on the settings page"));
  });

  it("honors no_prefix providers (base URL used as-is)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ choices: [{ message: { content: "Fix login bug" } }] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await generateChatTitle({
      provider: { ...PROVIDER, baseUrl: "https://gw.example.com/api", noPrefix: true },
      firstMessage: "hi",
    });

    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toContain(encodeURIComponent("https://gw.example.com/api"));
    expect(init.headers).toMatchObject({ "x-target-url": "https://gw.example.com/api" });
  });

  it("resolves null on a non-OK response (never rejects)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ error: "rate limited" }, 429)));
    await expect(
      generateChatTitle({ provider: PROVIDER, firstMessage: "hi" }),
    ).resolves.toBeNull();
  });

  it("resolves null when the body carries no usable content", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ choices: [] })));
    await expect(
      generateChatTitle({ provider: PROVIDER, firstMessage: "hi" }),
    ).resolves.toBeNull();
  });

  it("resolves null on timeout (AbortController)", async () => {
    // A fetch that hangs until aborted (like a real network call).
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              const err = new Error("aborted");
              err.name = "AbortError";
              reject(err);
            });
          }),
      ),
    );
    await expect(
      generateChatTitle({ provider: PROVIDER, firstMessage: "hi", timeoutMs: 15 }),
    ).resolves.toBeNull();
  });

  it("resolves null when the external signal aborts", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              const err = new Error("aborted");
              err.name = "AbortError";
              reject(err);
            });
          }),
      ),
    );
    const controller = new AbortController();
    const pending = generateChatTitle({
      provider: PROVIDER,
      firstMessage: "hi",
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).resolves.toBeNull();
  });
});

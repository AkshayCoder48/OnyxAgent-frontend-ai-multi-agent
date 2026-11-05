// @vitest-environment node
/**
 * remember-page — the shared "remember this page" pipeline (KB deepening,
 * 2026-11-05). Pure-shape tests run against the real module with the
 * OnyxBase layer mocked (resolveKBClients / kbSave) — the same in-memory
 * fake-KV pattern as skills-sync.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const kbState = vi.hoisted(() => ({
  clients: null as null | { kv: unknown },
  saveCalls: [] as Array<{ userId: string; input: Record<string, unknown> }>,
  saveImpl: null as null | ((input: Record<string, unknown>) => Record<string, unknown>),
}));

vi.mock("@/lib/onyxbase/kb-store", () => ({
  MAX_KB_CONTENT_CHARS: 400_000,
  kbSave: vi.fn(async (_kv: unknown, userId: string, input: Record<string, unknown>) => {
    kbState.saveCalls.push({ userId, input });
    if (kbState.saveImpl) return kbState.saveImpl(input);
    return {
      id: "kb_test123",
      title: input.title,
      content: input.content,
      size: String(input.content).length,
    };
  }),
  resolveKBClients: vi.fn(async () => kbState.clients),
}));

import {
  buildRememberedPageContent,
  hostnameOf,
  rememberPageTags,
  rememberPageToKB,
  REMEMBERED_PAGE_TEXT_BUDGET,
} from "./remember-page";

beforeEach(() => {
  kbState.clients = { kv: {} };
  kbState.saveCalls.length = 0;
  kbState.saveImpl = null;
});

describe("buildRememberedPageContent — the saved document's shape", () => {
  const base = { url: "https://a.example.com/guide", title: "The Guide", text: "Body text." };

  it("carries url + capture date + the page text", () => {
    const c = buildRememberedPageContent(base);
    expect(c).toContain("- **URL:** https://a.example.com/guide");
    expect(c).toContain("- **Captured:**");
    expect(c).toContain("## Page content");
    expect(c).toContain("Body text.");
    // no note → no note line
    expect(c).not.toContain("**Note:**");
    // no history by default when navLog is absent
    expect(c).not.toContain("## Pages visited this session");
  });

  it("flattens the curated note into a blockquote", () => {
    const c = buildRememberedPageContent({ ...base, note: "Why this page matters.\nSecond line." });
    expect(c).toContain("> **Note:** Why this page matters. Second line.");
    // the note comes FIRST — the why precedes the capture
    expect(c.indexOf("**Note:**")).toBeLessThan(c.indexOf("## Page content"));
  });

  it("appends the browse history (default) and honors include_history:false", () => {
    const navLog = [
      { url: "https://a.example.com/", title: "Home", ts: 1730000000000 },
      { url: "https://a.example.com/guide", title: "The Guide", ts: 1730000060000 },
    ];
    const withHistory = buildRememberedPageContent({ ...base, navLog });
    expect(withHistory).toContain("## Pages visited this session");
    expect(withHistory).toContain("1. [Home](https://a.example.com/)");
    expect(withHistory).toContain("2. [The Guide](https://a.example.com/guide)");

    const optedOut = buildRememberedPageContent({ ...base, navLog, includeHistory: false });
    expect(optedOut).not.toContain("## Pages visited this session");
  });

  it("caps the history list at the 30 most recent entries", () => {
    const navLog = Array.from({ length: 45 }, (_, i) => ({ url: `https://x.example/${i}` }));
    const c = buildRememberedPageContent({ ...base, navLog });
    expect(c).not.toContain("/0]");
    expect(c).not.toContain("/14]");
    // 45 - 30 = 15 is the oldest kept (no title → the URL is the label)
    expect(c).toContain("1. [https://x.example/15]");
    expect(c).toContain("30. [https://x.example/44]");
  });

  it("caps the page text at the budget and flags the truncation", () => {
    const long = "x".repeat(REMEMBERED_PAGE_TEXT_BUDGET + 500);
    const c = buildRememberedPageContent({ ...base, text: long });
    expect(c).toContain(`- **Truncated:** page text capped at ${REMEMBERED_PAGE_TEXT_BUDGET.toLocaleString()} chars.`);
    expect(c).not.toContain("x".repeat(REMEMBERED_PAGE_TEXT_BUDGET + 1));
  });

  it("an empty capture renders an honest placeholder, never a blank section", () => {
    const c = buildRememberedPageContent({ url: "https://a.example.com", title: "T", text: "   " });
    expect(c).toContain("(no visible text)");
  });
});

describe("hostname + tags", () => {
  it("strips www. and tolerates junk URLs (the URL parser lowercases)", () => {
    expect(hostnameOf("https://www.Example.COM/x")).toBe("example.com");
    expect(hostnameOf("data:image/png;base64,xx")).toBe("");
    expect(hostnameOf("not a url")).toBe("");
  });

  it("tags = browser + saved-page + clean hostname", () => {
    expect(rememberPageTags("https://www.a.example.com/guide")).toEqual([
      "browser",
      "saved-page",
      "a.example.com",
    ]);
    // a hostile hostname cannot smuggle tag junk
    expect(rememberPageTags("https://a.example.com/")).toEqual(["browser", "saved-page", "a.example.com"]);
  });
});

describe("rememberPageToKB — the save pipeline (never throws)", () => {
  const base = { url: "https://a.example.com/guide", title: "The Guide", text: "Body text." };

  it("saves a document-typed item with web category + provenance tags (ai source)", async () => {
    const res = await rememberPageToKB("user-1", { ...base, source: "ai" });
    expect(res.ok).toBe(true);
    expect(kbState.saveCalls).toHaveLength(1);
    const { userId, input } = kbState.saveCalls[0]!;
    expect(userId).toBe("user-1");
    expect(input.type).toBe("document");
    expect(input.category).toBe("web");
    expect(input.source).toBe("ai");
    expect(input.tags).toEqual(["browser", "saved-page", "a.example.com"]);
    expect(input.title).toBe("The Guide");
  });

  it("a user-triggered save is badged source user", async () => {
    await rememberPageToKB("user-1", { ...base, source: "user" });
    expect(kbState.saveCalls[0]!.input.source).toBe("user");
  });

  it("falls back to the hostname when the page has no title", async () => {
    await rememberPageToKB("user-1", { ...base, title: "" });
    expect(kbState.saveCalls[0]!.input.title).toBe("a.example.com");
  });

  it("NOT_CONFIGURED when OnyxBase is not set up (no save attempted)", async () => {
    kbState.clients = null;
    const res = await rememberPageToKB("user-1", base);
    expect(res).toMatchObject({ ok: false, code: "NOT_CONFIGURED" });
    if (!res.ok) expect(res.message).toContain("Settings");
    expect(kbState.saveCalls).toHaveLength(0);
  });

  it("EMPTY_CAPTURE when neither title nor text exists", async () => {
    const res = await rememberPageToKB("user-1", { url: "https://a.example.com", title: "", text: "" });
    expect(res).toMatchObject({ ok: false, code: "EMPTY_CAPTURE" });
    expect(kbState.saveCalls).toHaveLength(0);
  });

  it("SAVE_FAILED when kbSave throws — the message rides along", async () => {
    kbState.saveImpl = () => {
      throw new Error("KV quota exceeded");
    };
    const res = await rememberPageToKB("user-1", base);
    expect(res).toMatchObject({ ok: false, code: "SAVE_FAILED" });
    if (!res.ok) expect(res.message).toContain("KV quota exceeded");
  });
});

/**
 * Regression tests — reliability fixes round (chat-history boot hydration,
 * Composio catalog consistency).
 */
import { describe, expect, it } from "vitest";
import { qk } from "@/lib/query-keys";
import { normalizeToolkitPage } from "@/lib/composio/client";

// ---------------------------------------------------------------------------
// 1. USER-SCOPED QUERY KEYS (chat history empty on app open)
// ---------------------------------------------------------------------------

describe("conversations list query key is user-scoped", () => {
  it("produces DIFFERENT keys for different user ids", () => {
    // The auth store boots with the transient local-user and swaps to the
    // real Dexie user id asynchronously — a static key cached the transient
    // user's empty list forever (the "history empty until Settings visit"
    // bug). Different ids MUST be different cache entries so the swap
    // triggers a fresh fetch.
    expect(qk.conversations.list("local-user")).not.toEqual(qk.conversations.list("u_real_123"));
  });

  it("falls back to a stable anon key when no user yet", () => {
    expect(qk.conversations.list()).toEqual(qk.conversations.list(undefined));
    expect(qk.conversations.list().join(".")).toContain("anon");
  });

  it("stays under the conversations prefix so broad invalidation still matches", () => {
    const key = qk.conversations.list("u1");
    expect(key.slice(0, 1)).toEqual(["conversations"]);
    // React Query prefix matching: every scoped key starts with the all() key.
    const prefix = qk.conversations.all();
    expect(key.slice(0, prefix.length)).toEqual(prefix);
  });

  it("slash-commands list key is user-scoped the same way", () => {
    expect(qk.slashCommands.list("a")).not.toEqual(qk.slashCommands.list("b"));
    expect(qk.slashCommands.list(undefined)).toEqual(qk.slashCommands.list());
  });
});

// ---------------------------------------------------------------------------
// 2. COMPOSIO PAGE NORMALIZATION (count vs dropdown mismatch)
// ---------------------------------------------------------------------------

describe("normalizeToolkitPage", () => {
  it("passes the documented shape through", () => {
    const page = normalizeToolkitPage({
      items: [{ slug: "github", name: "GitHub" }],
      next_cursor: "cur_1",
      total_items: 1463,
      current_page: 1,
      total_pages: 15,
    });
    expect(page.items).toHaveLength(1);
    expect(page.next_cursor).toBe("cur_1");
    expect(page.total_items).toBe(1463);
  });

  it("unwraps a nested items.items shape", () => {
    const page = normalizeToolkitPage({
      items: { items: [{ slug: "slack" }], total_items: 42 },
    });
    expect(page.items).toEqual([{ slug: "slack" }]);
    expect(page.total_items).toBe(42);
  });

  it("handles a bare top-level array", () => {
    const page = normalizeToolkitPage([{ slug: "gmail" }, { slug: "notion" }]);
    expect(page.items).toHaveLength(2);
    expect(page.total_items).toBe(2);
    expect(page.next_cursor).toBeNull();
  });

  it("unwraps a data wrapper", () => {
    const page = normalizeToolkitPage({ data: { items: [{ slug: " linear " }], next_cursor: null } });
    expect(page.items[0]?.slug).toBe(" linear ");
  });

  it("returns an EMPTY page (never throws) for garbage", () => {
    for (const garbage of [null, undefined, 42, "nope", {}, { items: 7 }]) {
      const page = normalizeToolkitPage(garbage);
      expect(page.items).toEqual([]);
      expect(page.next_cursor).toBeNull();
    }
  });
});

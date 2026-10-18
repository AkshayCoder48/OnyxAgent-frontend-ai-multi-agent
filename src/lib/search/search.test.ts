/**
 * Hybrid search tests (Task 2-b) — pure helpers (stripMarkdown, buildExcerpt,
 * RRF fusion, scope filtering, cosine, date bounds) + the Dexie-backed
 * indexer/search end-to-end on fake-indexeddb (index → search finds message
 * CONTENT; delete cascade; orphan purge; backfill idempotence; title cache).
 */
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import type { MessageSearchRow, Project } from "@/types";
import {
  AUTO_BACKFILL_MESSAGE_CAP,
  backfillAllIndexes,
  buildSearchRow,
  countTokens,
  ensureIndexPopulated,
  INDEX_TEXT_CAP,
  indexConversationMessages,
  indexMessage,
  removeConversationFromIndex,
  stripMarkdown,
  updateConversationTitleCache,
} from "./indexer";
import {
  buildExcerpt,
  cosineSimilarity,
  dateBounds,
  filterRowsForScope,
  reciprocalRankFusion,
  searchChats,
  wordCount,
  type RrfEntry,
} from "./search";
import { tokenize } from "./score";

const USER = "user-1";
const NOW = "2026-02-15T10:00:00.000Z";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeSearchRow(overrides: Partial<MessageSearchRow> = {}): MessageSearchRow {
  return {
    message_id: "m1",
    conversation_id: "c1",
    project_id: null,
    role: "user",
    text: "sample text",
    title_cache: "Chat",
    token_count: 2,
    embedding: null,
    embed_model: null,
    embed_state: "none",
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

async function seedThread(opts: {
  conversationId: string;
  projectId?: string | null;
  title: string;
  messages: Array<{ id: string; role: "user" | "assistant"; content: string; created_at?: string }>;
}) {
  await db.conversations.put({
    id: opts.conversationId,
    user_id: USER,
    title: opts.title,
    created_at: NOW,
    updated_at: NOW,
    is_archived: false,
    is_demo: false,
    last_message_preview: null,
    last_message_at: null,
    ...(opts.projectId ? { project_id: opts.projectId } : {}),
  });
  for (const m of opts.messages) {
    await db.messages.put({
      id: m.id,
      conversation_id: opts.conversationId,
      role: m.role,
      content: m.content,
      created_at: m.created_at ?? NOW,
      tool_calls: [],
      files: [],
    });
  }
}

// ---------------------------------------------------------------------------
// stripMarkdown
// ---------------------------------------------------------------------------

describe("stripMarkdown", () => {
  it("strips emphasis but keeps the text", () => {
    expect(stripMarkdown("**bold** and *italic* and _also_ and ~~gone~~")).toBe(
      "bold and italic and also and gone",
    );
  });

  it("keeps code text inside fences but drops the fence markers", () => {
    const md = "Intro\n```ts\nconst xylophone = 1;\nconsole.log(xylophone);\n```\nOutro";
    const out = stripMarkdown(md);
    expect(out).toContain("const xylophone = 1;");
    expect(out).toContain("console.log(xylophone);");
    expect(out).not.toContain("```");
    expect(out).toContain("ts");
  });

  it("strips inline code backticks, keeps the code", () => {
    expect(stripMarkdown("run `bun test` now")).toBe("run bun test now");
  });

  it("keeps link labels, drops urls; keeps image alt text", () => {
    expect(stripMarkdown("see [the docs](https://example.com) here")).toBe("see the docs here");
    expect(stripMarkdown("![a cat](https://x/cat.png)")).toBe("a cat");
  });

  it("strips heading markers, blockquotes, list bullets and task markers", () => {
    expect(stripMarkdown("## Title")).toBe("Title");
    expect(stripMarkdown("> quoted line")).toBe("quoted line");
    expect(stripMarkdown("- item one\n* item two\n3. item three")).toBe(
      "item one\nitem two\nitem three",
    );
    expect(stripMarkdown("- [x] done thing")).toBe("done thing");
  });

  it("keeps table cell text, drops pipes and separator rows", () => {
    const out = stripMarkdown("| a | b |\n| --- | --- |\n| 1 | 2 |");
    expect(out).toContain("a");
    expect(out).toContain("b");
    expect(out).toContain("1");
    expect(out).toContain("2");
    expect(out).not.toContain("|");
    expect(out).not.toContain("---");
  });

  it("strips bare html tags but keeps their content", () => {
    expect(stripMarkdown("<b>bold</b> and <br/>break")).toBe("bold and break");
  });

  it("caps the output at 4000 chars", () => {
    const long = "word ".repeat(2000);
    expect(stripMarkdown(long).length).toBeLessThanOrEqual(INDEX_TEXT_CAP);
  });

  it("is pure and handles empty input", () => {
    expect(stripMarkdown("")).toBe("");
    expect(stripMarkdown("   \n\n  ")).toBe("");
    expect(stripMarkdown("plain")).toBe("plain");
  });
});

describe("buildSearchRow", () => {
  it("builds the row with stripped text, token count and none embed state", () => {
    const row = buildSearchRow(
      { id: "m1", conversation_id: "c1", role: "user", content: "**hello** world", created_at: NOW },
      { projectId: "p1", title: "T" },
    );
    expect(row.text).toBe("hello world");
    expect(row.message_id).toBe("m1");
    expect(row.project_id).toBe("p1");
    expect(row.title_cache).toBe("T");
    expect(row.embed_state).toBe("none");
    expect(row.token_count).toBe(countTokens("hello world"));
  });
});

// ---------------------------------------------------------------------------
// buildExcerpt
// ---------------------------------------------------------------------------

describe("buildExcerpt", () => {
  it("returns the whole (escaped) text when it fits, with terms marked", () => {
    const out = buildExcerpt("the prisma schema is ready", "prisma");
    expect(out).toBe("the <mark>prisma</mark> schema is ready");
  });

  it("html-escapes the text but still marks terms", () => {
    const out = buildExcerpt("use <script>alert(1)</script> with prisma", "prisma");
    expect(out).toContain("&lt;script&gt;");
    expect(out).not.toContain("<script>");
    expect(out).toContain("<mark>prisma</mark>");
  });

  it("selects the densest term window and ellipsizes the cut ends", () => {
    const filler = "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod ".repeat(8);
    const text = `${filler}alpha prisma beta prisma gamma prisma delta ${filler}`;
    const out = buildExcerpt(text, "prisma", 120);
    expect(out.startsWith("…")).toBe(true);
    expect(out.endsWith("…")).toBe(true);
    const marks = out.match(/<mark>prisma<\/mark>/g) ?? [];
    // The window should cover the cluster, not the head of the text.
    expect(marks.length).toBeGreaterThanOrEqual(2);
    expect(out).not.toMatch(/^…lorem/);
  });

  it("falls back to the head of the text when no term matches (semantic-only hit)", () => {
    const text = "a discussion about database migrations and client generation".repeat(4);
    const out = buildExcerpt(text, "xylophone", 80);
    expect(out.startsWith("a discussion")).toBe(true);
    expect(out.endsWith("…")).toBe(true);
    expect(out).not.toContain("<mark>");
  });

  it("ignores one-letter and stopword terms for matching", () => {
    const out = buildExcerpt("what did the agent say about a prisma", "what did the a");
    expect(out).toBe("what did the agent say about a prisma");
  });

  it("marks case-insensitively on word boundaries only", () => {
    const out = buildExcerpt("Prisma prismatic prisma", "prisma");
    expect(out).toBe("<mark>Prisma</mark> prismatic <mark>prisma</mark>");
  });
});

// ---------------------------------------------------------------------------
// RRF fusion
// ---------------------------------------------------------------------------

describe("reciprocalRankFusion", () => {
  const lex: RrfEntry[] = [
    { id: "a", rank: 0 },
    { id: "b", rank: 1 },
    { id: "c", rank: 2 },
  ];
  const sem: RrfEntry[] = [
    { id: "b", rank: 0 },
    { id: "d", rank: 1 },
    { id: "a", rank: 2 },
  ];

  it("marks rows present in both lists as 'both' with summed scores", () => {
    const fused = reciprocalRankFusion(lex, sem, 60);
    const both = fused.find((f) => f.id === "b")!;
    expect(both.matchedBy).toBe("both");
    // b is rank 1 in lex (1/(60+1+1) = 1/62) and rank 0 in sem (1/61).
    expect(both.score).toBeCloseTo(1 / 62 + 1 / 61, 10);
    const a = fused.find((f) => f.id === "a")!;
    expect(a.matchedBy).toBe("both");
  });

  it("rows in one list only keep their side", () => {
    const fused = reciprocalRankFusion(lex, sem, 60);
    expect(fused.find((f) => f.id === "c")!.matchedBy).toBe("lexical");
    expect(fused.find((f) => f.id === "d")!.matchedBy).toBe("semantic");
  });

  it("a row ranked high in BOTH lists outranks a row ranked first in one", () => {
    const fused = reciprocalRankFusion(lex, sem, 60);
    const order = fused.map((f) => f.id);
    // b: 1/61 + 1/61 ≈ 0.0328 — beats a: 1/61 + 1/63 ≈ 0.0318 and the
    // single-list tops (0.0164).
    expect(order[0]).toBe("b");
    expect(order).toContain("a");
    expect(order).toContain("c");
    expect(order).toContain("d");
  });

  it("an empty semantic list leaves lexical order untouched", () => {
    const fused = reciprocalRankFusion(lex, [], 60);
    expect(fused.map((f) => f.id)).toEqual(["a", "b", "c"]);
    expect(fused.every((f) => f.matchedBy === "lexical")).toBe(true);
  });

  it("ties break deterministically", () => {
    const l1: RrfEntry[] = [
      { id: "x", rank: 0 },
      { id: "y", rank: 1 },
    ];
    const s1: RrfEntry[] = [
      { id: "y", rank: 0 },
      { id: "x", rank: 1 },
    ];
    const out1 = reciprocalRankFusion(l1, s1, 60).map((f) => f.id);
    const out2 = reciprocalRankFusion(l1, s1, 60).map((f) => f.id);
    expect(out1).toEqual(out2);
  });
});

// ---------------------------------------------------------------------------
// Scope filtering + date bounds + cosine + word count
// ---------------------------------------------------------------------------

describe("filterRowsForScope", () => {
  const rows = [
    makeSearchRow({ message_id: "g1", conversation_id: "c1", project_id: null }),
    makeSearchRow({ message_id: "g2", conversation_id: "c2", project_id: null }),
    makeSearchRow({ message_id: "p1", conversation_id: "c3", project_id: "proj-1" }),
    makeSearchRow({ message_id: "p2", conversation_id: "c4", project_id: "proj-2" }),
  ];

  it("all keeps everything", () => {
    expect(filterRowsForScope(rows, "all")).toHaveLength(4);
  });

  it("general keeps only rows with no project", () => {
    const out = filterRowsForScope(rows, "general");
    expect(out.map((r) => r.message_id)).toEqual(["g1", "g2"]);
  });

  it("project scope keeps only that project's rows", () => {
    const out = filterRowsForScope(rows, { projectId: "proj-1" });
    expect(out.map((r) => r.message_id)).toEqual(["p1"]);
  });
});

describe("dateBounds", () => {
  it("expands date-only values to inclusive day bounds", () => {
    const { fromMs, toMs } = dateBounds({ from: "2026-02-10", to: "2026-02-12" });
    expect(new Date(fromMs!).toISOString()).toBe("2026-02-10T00:00:00.000Z");
    expect(new Date(toMs!).toISOString()).toBe("2026-02-12T23:59:59.999Z");
  });

  it("accepts a single side", () => {
    expect(dateBounds({ from: "2026-02-10" }).toMs).toBeNull();
    expect(dateBounds({ to: "2026-02-12" }).fromMs).toBeNull();
    expect(dateBounds(undefined).fromMs).toBeNull();
  });

  it("invalid values yield null bounds", () => {
    expect(dateBounds({ from: "not-a-date" }).fromMs).toBeNull();
  });
});

describe("cosineSimilarity", () => {
  it("identical vectors score 1", () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 10);
  });

  it("orthogonal vectors score 0", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
  });

  it("length mismatch or zero vectors score 0", () => {
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
    expect(cosineSimilarity([], [])).toBe(0);
  });

  it("opposite vectors score -1", () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 10);
  });
});

describe("wordCount", () => {
  it("counts raw whitespace-separated words", () => {
    expect(wordCount("what did the agent say")).toBe(5);
    expect(wordCount("  prisma  ")).toBe(1);
    expect(wordCount("")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Dexie-backed: indexer + searchChats end-to-end
// ---------------------------------------------------------------------------

const GENERAL_CHAT = {
  conversationId: "conv-general",
  projectId: null as string | null,
  title: "Deployment Troubleshooting",
  messages: [
    {
      id: "msg-g1",
      role: "user" as const,
      content: "How do I run prisma client generation during the production build?",
    },
    {
      id: "msg-g2",
      role: "assistant" as const,
      content: "Run `bun run prisma generate` before the **build** step.",
    },
  ],
};

const PROJECT_CHAT = {
  conversationId: "conv-project",
  projectId: "proj-1",
  title: "Database Architecture",
  messages: [
    {
      id: "msg-p1",
      role: "user" as const,
      content: "Let's store the xylophone-project-note in the schema plan.",
    },
    {
      id: "msg-p2",
      role: "assistant" as const,
      content: "The schema plan covers **prisma** migrations and markdown `fences`.",
    },
  ],
};

async function seedProject() {
  const project: Project = {
    id: "proj-1",
    user_id: USER,
    name: "OnyxAgent Development",
    description: null,
    goal: "Build the app",
    instructions: "",
    icon: null,
    accent_color: "#0e9488",
    status: "active",
    pinned: false,
    memory_settings: {
      enabled: true,
      cross_chat_retrieval: true,
      automatic_updates: true,
      context_budget_chars: 4000,
    },
    model_preferences: { preferred_model: null },
    resources: [],
    instructions_history: [],
    created_at: NOW,
    updated_at: NOW,
    last_activity_at: null,
  };
  await db.projects.put(project);
}

beforeEach(async () => {
  await Promise.all([
    db.conversations.clear(),
    db.messages.clear(),
    db.message_search_index.clear(),
    db.projects.clear(),
  ]);
});

describe("indexer (fake-indexeddb)", () => {
  it("indexMessage writes a searchable row with project_id + stripped text", async () => {
    await seedProject();
    await seedThread(GENERAL_CHAT);
    await seedThread(PROJECT_CHAT);
    await indexMessage({
      id: "msg-p2",
      conversation_id: PROJECT_CHAT.conversationId,
      role: "assistant",
      content: PROJECT_CHAT.messages[1]!.content,
      created_at: NOW,
    });
    const row = await db.message_search_index.get("msg-p2");
    expect(row).toBeDefined();
    expect(row!.project_id).toBe("proj-1");
    expect(row!.title_cache).toBe("Database Architecture");
    expect(row!.text).toBe("The schema plan covers prisma migrations and markdown fences.");
    expect(row!.embed_state).toBe("none");
    expect(row!.token_count).toBe(
      tokenize("The schema plan covers prisma migrations and markdown fences.").length,
    );
  });

  it("skips system + empty messages", async () => {
    await seedThread(GENERAL_CHAT);
    await indexMessage({
      id: "msg-sys",
      conversation_id: GENERAL_CHAT.conversationId,
      role: "system",
      content: "system prompt",
      created_at: NOW,
    });
    await indexMessage({
      id: "msg-empty",
      conversation_id: GENERAL_CHAT.conversationId,
      role: "user",
      content: "   ",
      created_at: NOW,
    });
    expect(await db.message_search_index.count()).toBe(0);
  });

  it("preserves an embedding when the text is unchanged, resets it when changed", async () => {
    await seedThread(GENERAL_CHAT);
    const content = GENERAL_CHAT.messages[0]!.content;
    await indexMessage({
      id: "msg-g1",
      conversation_id: GENERAL_CHAT.conversationId,
      role: "user",
      content,
      created_at: NOW,
    });
    // Simulate a previously successful embed.
    await db.message_search_index.put({
      ...(await db.message_search_index.get("msg-g1"))!,
      embedding: [0.1, 0.2],
      embed_model: "test-embed",
      embed_state: "ready",
    });
    // Re-index the SAME content → embedding kept.
    await indexMessage({
      id: "msg-g1",
      conversation_id: GENERAL_CHAT.conversationId,
      role: "user",
      content,
      created_at: NOW,
    });
    const kept = await db.message_search_index.get("msg-g1");
    expect(kept!.embed_state).toBe("ready");
    expect(kept!.embedding).toEqual([0.1, 0.2]);
    // Changed content → embedding reset for re-embed.
    await indexMessage({
      id: "msg-g1",
      conversation_id: GENERAL_CHAT.conversationId,
      role: "user",
      content: `${content} (edited)`,
      created_at: NOW,
    });
    const reset = await db.message_search_index.get("msg-g1");
    expect(reset!.embed_state).toBe("none");
    expect(reset!.embedding).toBeNull();
  });

  it("indexConversationMessages removes rows for deleted messages (delete cascade)", async () => {
    await seedThread(GENERAL_CHAT);
    await indexConversationMessages(GENERAL_CHAT.conversationId);
    expect(await db.message_search_index.count()).toBe(2);
    await db.messages.delete("msg-g1");
    await indexConversationMessages(GENERAL_CHAT.conversationId);
    const ids = (await db.message_search_index.toArray()).map((r) => r.message_id);
    expect(ids).toEqual(["msg-g2"]);
  });

  it("removeConversationFromIndex removes every row of the conversation", async () => {
    await seedThread(GENERAL_CHAT);
    await indexConversationMessages(GENERAL_CHAT.conversationId);
    await removeConversationFromIndex(GENERAL_CHAT.conversationId);
    expect(await db.message_search_index.count()).toBe(0);
  });

  it("updateConversationTitleCache bulk-updates titles without touching text", async () => {
    await seedThread(GENERAL_CHAT);
    await indexConversationMessages(GENERAL_CHAT.conversationId);
    await updateConversationTitleCache(GENERAL_CHAT.conversationId, "Renamed Chat");
    const rows = await db.message_search_index.toArray();
    expect(rows.every((r) => r.title_cache === "Renamed Chat")).toBe(true);
    expect(rows.every((r) => r.text.length > 0)).toBe(true);
  });

  it("backfillAllIndexes is idempotent (second run indexes nothing) and caps writes", async () => {
    await seedProject();
    await seedThread(GENERAL_CHAT);
    await seedThread(PROJECT_CHAT);
    const first = await backfillAllIndexes(USER);
    expect(first.messagesIndexed).toBe(4);
    expect(first.capped).toBe(false);
    const second = await backfillAllIndexes(USER);
    expect(second.messagesIndexed).toBe(0);
    // Cap: 1 message max → exactly one write, capped flag set.
    await db.message_search_index.clear();
    const capped = await backfillAllIndexes(USER, { messageCap: 1 });
    expect(capped.messagesIndexed).toBe(1);
    expect(capped.capped).toBe(true);
  });

  it("ensureIndexPopulated backfills bounded gaps and no-ops when fresh", async () => {
    await seedProject();
    await seedThread(GENERAL_CHAT);
    await seedThread(PROJECT_CHAT);
    const res = await ensureIndexPopulated(USER);
    expect(res.messagesIndexed).toBe(4);
    expect(res.messagesIndexed).toBeLessThanOrEqual(AUTO_BACKFILL_MESSAGE_CAP);
    const again = await ensureIndexPopulated(USER);
    expect(again.messagesIndexed).toBe(0);
  });
});

describe("searchChats (fake-indexeddb, keyword mode)", () => {
  beforeEach(async () => {
    await seedProject();
    await seedThread(GENERAL_CHAT);
    await seedThread(PROJECT_CHAT);
    await indexConversationMessages(GENERAL_CHAT.conversationId);
    await indexConversationMessages(PROJECT_CHAT.conversationId);
  });

  it("finds message CONTENT (not titles) with a highlighted excerpt", async () => {
    const res = await searchChats("xylophone-project-note", { scope: "all", userId: USER });
    expect(res.hits).toHaveLength(1);
    const hit = res.hits[0]!;
    expect(hit.messageId).toBe("msg-p1");
    expect(hit.conversationTitle).toBe("Database Architecture");
    expect(hit.projectName).toBe("OnyxAgent Development");
    expect(hit.projectAccent).toBe("#0e9488");
    expect(hit.excerpt).toContain("<mark>xylophone-project-note</mark>");
    expect(hit.matchedBy).toBe("lexical");
    // Honest mode: no Pollinations account in tests → keyword only.
    expect(res.semanticAvailable).toBe(false);
  });

  it("strips markdown syntax from indexed text (searchable code kept)", async () => {
    const res = await searchChats("fences", { scope: "all", userId: USER });
    expect(res.hits[0]?.messageId).toBe("msg-p2");
  });

  it("general scope excludes project rows; project scope excludes general rows", async () => {
    const general = await searchChats("prisma", { scope: "general", userId: USER });
    expect(general.hits.map((h) => h.messageId).sort()).toEqual(["msg-g1", "msg-g2"]);
    const project = await searchChats("prisma", { scope: { projectId: "proj-1" }, userId: USER });
    expect(project.hits.map((h) => h.messageId)).toEqual(["msg-p2"]);
  });

  it("date filters bound the scan", async () => {
    // Everything seeded at NOW (2026-02-15) — a later window matches nothing.
    const later = await searchChats("prisma", {
      scope: "all",
      userId: USER,
      dateFilter: { from: "2026-03-01" },
    });
    expect(later.hits).toHaveLength(0);
    // A window that contains NOW matches.
    const containing = await searchChats("prisma", {
      scope: "all",
      userId: USER,
      dateFilter: { from: "2026-02-01", to: "2026-02-28" },
    });
    expect(containing.hits.length).toBeGreaterThan(0);
  });

  it("lazily purges orphaned rows (conversation deleted without the hook)", async () => {
    await db.conversations.delete(GENERAL_CHAT.conversationId);
    const res = await searchChats("prisma", { scope: "all", userId: USER });
    // The purge removed the orphaned conversation's rows inside the search.
    expect(res.hits.every((h) => h.conversationId !== GENERAL_CHAT.conversationId)).toBe(true);
    const remainingRows = await db.message_search_index
      .where("conversation_id")
      .equals(GENERAL_CHAT.conversationId)
      .count();
    expect(remainingRows).toBe(0);
  });

  it("prefers the LIVE conversation title over the index-time cache after a rename", async () => {
    await db.conversations.update(GENERAL_CHAT.conversationId, { title: "Renamed Live Title" });
    const res = await searchChats("production build", { scope: "all", userId: USER });
    expect(res.hits[0]?.conversationTitle).toBe("Renamed Live Title");
  });

  it("returns an honest empty result for nonsense terms", async () => {
    const res = await searchChats("zzzqqqxxx", { scope: "all", userId: USER });
    expect(res.hits).toHaveLength(0);
    expect(res.semanticAvailable).toBe(false);
    expect(res.scannedMessages).toBeGreaterThan(0);
  });

  it("empty/whitespace queries short-circuit", async () => {
    expect((await searchChats("", { scope: "all", userId: USER })).hits).toHaveLength(0);
    expect((await searchChats("   ", { scope: "all", userId: USER })).hits).toHaveLength(0);
    // Stopword-only queries tokenize to nothing → no hits, no error.
    expect((await searchChats("the of and", { scope: "all", userId: USER })).hits).toHaveLength(0);
  });

  it("multi-word queries with no embeddings degrade to lexical-only order", async () => {
    const res = await searchChats("prisma generate production build", { scope: "all", userId: USER });
    expect(res.semanticAvailable).toBe(false);
    expect(res.hits.length).toBeGreaterThan(0);
    expect(res.hits.every((h) => h.matchedBy === "lexical")).toBe(true);
    // msg-g1 mentions prisma + generate + production + build — top hit.
    expect(res.hits[0]!.messageId).toBe("msg-g1");
  });

  it("respects the result limit", async () => {
    const res = await searchChats("prisma", { scope: "all", userId: USER, limit: 1 });
    expect(res.hits).toHaveLength(1);
  });
});

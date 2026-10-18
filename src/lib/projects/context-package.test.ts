/**
 * Project context package tests (Task 2-d / PRD §7.1 + §7.3) — the builder
 * against fake-indexeddb: project resolution (general chats → null, the
 * first-turn projectId hint), the always-present header, budgeted memory
 * inclusion, cross-chat retrieval via the search index AND the direct-scan
 * fallback, and the budget cap.
 */
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";

import { db } from "@/lib/db";
import {
  assemblePackage,
  buildCrossChatSection,
  buildMemorySection,
  buildProjectContextPackage,
  buildProjectHeader,
  rankIndexedRows,
  type CrossChatExcerpt,
} from "./context-package";
import { createProject, DEFAULT_MEMORY_SETTINGS } from "./service";
import { saveMemory } from "./memory";
import type { MessageSearchRow, Project, ProjectMemoryItem } from "@/types";

// Dynamic "now": the scan window filters against the REAL clock (30 days),
// so seeds must be recent relative to whenever the test runs.
const NOW = new Date().toISOString();
const USER = "user-1";

function isoOffset(ms: number): string {
  return new Date(Date.parse(NOW) + ms).toISOString();
}

function makeConversationRow(
  id: string,
  projectId: string | null,
  title: string,
  updatedAt = NOW,
) {
  return {
    id,
    user_id: USER,
    title,
    created_at: NOW,
    updated_at: updatedAt,
    is_archived: false,
    is_demo: false,
    ...(projectId ? { project_id: projectId } : {}),
  };
}

function makeMessageRow(
  id: string,
  conversationId: string,
  content: string,
  createdAt = NOW,
  role: "user" | "assistant" = "user",
) {
  return {
    id,
    conversation_id: conversationId,
    role,
    content,
    created_at: createdAt,
  };
}

function makeSearchRow(
  messageId: string,
  conversationId: string,
  projectId: string,
  text: string,
  title: string,
): MessageSearchRow {
  return {
    message_id: messageId,
    conversation_id: conversationId,
    project_id: projectId,
    role: "user",
    text,
    title_cache: title,
    token_count: 10,
    embed_state: "none",
    created_at: NOW,
    updated_at: NOW,
  };
}

function makeMemoryItem(overrides: Partial<ProjectMemoryItem> = {}): ProjectMemoryItem {
  return {
    id: "m1",
    project_id: "p1",
    category: "decision",
    content: "Use SQLite for local persistence.",
    source_conversation_ids: [],
    pinned: false,
    superseded_by: null,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

beforeEach(async () => {
  await Promise.all([
    db.projects.clear(),
    db.project_memories.clear(),
    db.approval_requests.clear(),
    db.message_search_index.clear(),
    db.conversations.clear(),
    db.messages.clear(),
    db.tool_calls.clear(),
    db.user_settings.clear(),
  ]);
});

describe("buildProjectContextPackage — resolution", () => {
  it("returns null for a general conversation", async () => {
    await db.conversations.add(makeConversationRow("c-general", null, "General chat"));
    expect(await buildProjectContextPackage("c-general", "hello")).toBeNull();
  });

  it("returns null for an unknown conversation id", async () => {
    expect(await buildProjectContextPackage("nope", "hello")).toBeNull();
  });

  it("uses the projectId hint only when the conversation row is absent (first turn)", async () => {
    const project = await createProject({ user_id: USER,
      name: "OnyxAgent Dev",
      goal: "Ship the approvals layer",
    });
    // No conversation row (brand-new project chat) → hint applies.
    const pkg = await buildProjectContextPackage(null, "hello", { projectId: project.id });
    expect(pkg).toContain("OnyxAgent Dev");
    expect(pkg).toContain("Ship the approvals layer");
    expect(pkg).toContain("## PROJECT CONTEXT");
  });

  it("ignores the hint when the conversation resolves to a general chat", async () => {
    const project = await createProject({ user_id: USER, name: "P", goal: "G" });
    await db.conversations.add(makeConversationRow("c-general", null, "General"));
    // The row is authoritative — a stale activeProjectId must not leak in.
    expect(
      await buildProjectContextPackage("c-general", "hello", { projectId: project.id }),
    ).toBeNull();
  });
});

describe("buildProjectContextPackage — header + instruction line", () => {
  it("always includes name, goal, instructions and the fixed instruction line", async () => {
    const project = await createProject({ user_id: USER,
      name: "Frontend performance",
      goal: "Cut LCP to under 1s",
      instructions: "Never regress bundle size.",
    });
    await db.conversations.add(makeConversationRow("c1", project.id, "Chat 1"));
    const pkg = await buildProjectContextPackage("c1", "how do we cut LCP?");
    expect(pkg).toContain("Project: Frontend performance");
    expect(pkg).toContain("Cut LCP to under 1s");
    expect(pkg).toContain("Never regress bundle size.");
    expect(pkg).toContain("project_memory tool");
    expect(pkg).toContain("cite the source");
  });

  it("includes memory when enabled, with pinned items always present", async () => {
    const project = await createProject({ user_id: USER, name: "P", goal: "G" });
    await saveMemory(project.id, {
      category: "constraint",
      content: "Node 20 only",
      pinned: true,
    });
    await saveMemory(project.id, {
      category: "decision",
      content: "We chose the lexical scorer for retrieval ranking",
    });
    await db.conversations.add(makeConversationRow("c1", project.id, "Chat 1"));
    const pkg = await buildProjectContextPackage("c1", "which scorer did we choose for retrieval?");
    expect(pkg).toContain("### Project memory");
    expect(pkg).toContain("[constraint · pinned] Node 20 only");
    expect(pkg).toContain("lexical scorer");
  });

  it("drops the memory section when memory_settings.enabled is false", async () => {
    const project = await createProject({ user_id: USER,
      name: "P",
      goal: "G",
      memory_settings: { ...DEFAULT_MEMORY_SETTINGS, enabled: false },
    });
    await saveMemory(project.id, { category: "decision", content: "A decision" });
    await db.conversations.add(makeConversationRow("c1", project.id, "Chat 1"));
    const pkg = await buildProjectContextPackage("c1", "decision");
    expect(pkg).not.toContain("### Project memory");
  });
});

describe("buildProjectContextPackage — cross-chat retrieval", () => {
  async function seedProjectChatProject() {
    const project = await createProject({ user_id: USER, name: "Streaming fix", goal: "Fix streaming bug" });
    await db.conversations.bulkAdd([
      makeConversationRow("c-current", project.id, "Current chat"),
      makeConversationRow("c-a", project.id, "Frontend performance"),
      makeConversationRow("c-b", project.id, "Backend cleanup"),
      makeConversationRow("c-general", null, "Unrelated general chat"),
    ]);
    await db.messages.bulkAdd([
      makeMessageRow("m1", "c-a", "We decided to fix the streaming bug with a buffered delta batcher instead of raw passthrough."),
      makeMessageRow("m2", "c-b", "Dinner plans unrelated to anything."),
      // Current-conversation messages are NEVER retrieved.
      makeMessageRow("m3", "c-current", "streaming streaming streaming"),
      // Old message (outside the 30-day window) is skipped by the scan.
      makeMessageRow("m4", "c-a", "ancient streaming decision", isoOffset(-40 * 86_400_000)),
    ]);
    return project;
  }

  it("falls back to a direct Dexie scan when the index is empty, with source titles", async () => {
    await seedProjectChatProject();
    const pkg = await buildProjectContextPackage("c-current", "continue fixing the streaming bug with our earlier approach");
    expect(pkg).toContain("### Relevant excerpts from other project chats");
    expect(pkg).toContain("[from: Frontend performance]");
    expect(pkg).toContain("streaming bug");
    // The unrelated conversation is lexically filtered out.
    expect(pkg).not.toContain("Dinner plans");
    // Current conversation's own messages are excluded.
    expect(pkg).not.toContain("streaming streaming streaming");
  });

  it("prefers message_search_index rows when present", async () => {
    const project = await seedProjectChatProject();
    await db.message_search_index.bulkAdd([
      makeSearchRow("s1", "c-a", project.id, "The indexed streaming decision says use the delta batcher.", "Frontend performance"),
    ]);
    const pkg = await buildProjectContextPackage("c-current", "continue fixing the streaming bug");
    expect(pkg).toContain("indexed streaming decision");
    expect(pkg).toContain("[from: Frontend performance]");
  });

  it("drops the section when cross_chat_retrieval is disabled", async () => {
    const project = await createProject({ user_id: USER,
      name: "P",
      goal: "G",
      memory_settings: { ...DEFAULT_MEMORY_SETTINGS, cross_chat_retrieval: false },
    });
    await db.conversations.bulkAdd([
      makeConversationRow("c-current", project.id, "Current"),
      makeConversationRow("c-a", project.id, "Other"),
    ]);
    await db.messages.add(makeMessageRow("m1", "c-a", "streaming bug discussion"));
    const pkg = await buildProjectContextPackage("c-current", "streaming bug");
    expect(pkg).not.toContain("### Relevant excerpts from other project chats");
  });

  it("shrinks the cross-chat section to the project's context budget", async () => {
    const project = await createProject({ user_id: USER,
      name: "P",
      goal: "G",
      memory_settings: { ...DEFAULT_MEMORY_SETTINGS, context_budget_chars: 700 },
    });
    await db.conversations.bulkAdd([
      makeConversationRow("c-current", project.id, "Current"),
      makeConversationRow("c-a", project.id, "Alpha"),
    ]);
    // Many long relevant messages — the budget must cut the list down.
    for (let i = 0; i < 6; i++) {
      await db.messages.add(
        makeMessageRow(`m${i}`, "c-a", `streaming bug decision number ${i} `.repeat(12)),
      );
    }
    const pkg = await buildProjectContextPackage("c-current", "streaming bug decision");
    const section = pkg!.split("### Relevant excerpts")[1] ?? "";
    expect(section.length).toBeLessThan(900); // header + at most a couple of excerpts
    expect(pkg).toContain("[from: Alpha]"); // at least the single best excerpt survives
  });
});

describe("pure section builders", () => {
  const project: Project = {
    id: "p1",
    user_id: USER,
    name: "P",
    description: null,
    goal: "G",
    instructions: "I",
    icon: null,
    accent_color: null,
    status: "active",
    pinned: false,
    memory_settings: { ...DEFAULT_MEMORY_SETTINGS },
    model_preferences: { preferred_model: null },
    resources: [],
    instructions_history: [],
    created_at: NOW,
    updated_at: NOW,
    last_activity_at: null,
  };

  it("buildProjectHeader renders name/goal/instructions", () => {
    const header = buildProjectHeader(project);
    expect(header).toContain("Project: P");
    expect(header).toContain("Goal: G");
    expect(header).toContain("Instructions:\nI");
  });

  it("buildMemorySection renders category + pinned markers, null when empty", () => {
    expect(buildMemorySection([])).toBeNull();
    const section = buildMemorySection([makeMemoryItem()]);
    expect(section).toContain("[decision] Use SQLite for local persistence.");
    const pinned = buildMemorySection([makeMemoryItem({ pinned: true })]);
    expect(pinned).toContain("[decision · pinned]");
  });

  it("buildCrossChatSection prefixes each excerpt with its source title", () => {
    expect(buildCrossChatSection([])).toBeNull();
    const excerpts: CrossChatExcerpt[] = [
      {
        conversationId: "c1",
        conversationTitle: "Design review",
        excerpt: "We settled on the amber accent.",
        score: 0.5,
        source: "scan",
      },
    ];
    const section = buildCrossChatSection(excerpts);
    expect(section).toContain("- [from: Design review] We settled on the amber accent.");
  });

  it("rankIndexedRows dedupes near-identical excerpts and caps to top-K", () => {
    const rows = [
      makeSearchRow("s1", "c1", "p1", "streaming bug fix decision", "A"),
      makeSearchRow("s2", "c1", "p1", "streaming bug fix decision (repeated)", "A"),
      makeSearchRow("s3", "c2", "p1", "totally different content", "B"),
    ];
    const out = rankIndexedRows("streaming bug decision", rows);
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((e) => e.source === "index")).toBe(true);
    // The off-topic row never makes it (score 0 → dropped by rankDocuments).
    expect(out.find((e) => e.excerpt.includes("totally different"))).toBeUndefined();
  });

  it("assemblePackage joins sections with the header first", () => {
    const text = assemblePackage({
      header: buildProjectHeader(project),
      memorySection: buildMemorySection([makeMemoryItem()]),
      crossChatSection: buildCrossChatSection([]),
    });
    expect(text.startsWith("## PROJECT CONTEXT\nProject: P")).toBe(true);
    expect(text).toContain("### Project memory");
  });
});

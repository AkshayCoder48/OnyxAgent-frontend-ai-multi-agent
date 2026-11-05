// @vitest-environment node
/**
 * CHAT BRANCHES integration source pins (2026-11-05) — the latency-fixes
 * idiom: assert the WIRING of the fork flows at the source level, where
 * full-pipeline tests would need the entire chat graph.
 *
 * Pinned invariants:
 *   1. editUserMessage / regenerate are NON-DESTRUCTIVE (no row deletes);
 *   2. the runtime persists fork parents + the active leaf, and resolves
 *      wire history through the branch walk;
 *   3. the paint path resolves the active branch + builds picker metadata;
 *   4. every saveAgentCheckpoint carries the turn's user-message parent.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (rel: string) =>
  readFileSync(join(process.cwd(), "src", rel), "utf8");

const USE_CHAT = read("hooks/use-chat.ts");
const RUNTIME = read("lib/agent/runtime.ts");
const CONTAINER = read("components/chat/chat-container.tsx");
const MAPPER = read("lib/conversation-to-chat.ts");
const SERVICES = read("lib/services/index.ts");
const LIST = read("components/chat/message-list.tsx");
const ITEM = read("components/chat/message-item.tsx");

function section(src: string, startMarker: string, endMarker: string): string {
  const s = src.indexOf(startMarker);
  expect(s, `${startMarker} not found`).toBeGreaterThan(-1);
  const e = src.indexOf(endMarker, s);
  expect(e, `${endMarker} not found after ${startMarker}`).toBeGreaterThan(s);
  return src.slice(s, e);
}

describe("the fork flows are non-destructive", () => {
  it("editUserMessage never deletes rows — it forks + backfills the parent", () => {
    const fn = section(USE_CHAT, "const editUserMessage = useCallback(", "  const sendAskUserResponses");
    expect(fn).not.toContain("deleteMessage");
    expect(fn).toContain("setMessageParent(userMsg.id, forkParentId)");
    expect(fn).toContain("parentMessageId: forkParentId");
    // the legacy rows are retired from the LIVE VIEW only
    expect(fn).toContain("Retire the old branch from the LIVE VIEW ONLY");
  });

  it("regenerate never deletes rows — it reuses the user message", () => {
    const fn = section(USE_CHAT, "const regenerate = useCallback(", "  /**\n   * EDIT USER MESSAGE");
    expect(fn).not.toContain("deleteMessage");
    expect(fn).toContain("reuseUserMessageId: userMsg.id");
  });

  it("doSend threads the fork options into the runtime options", () => {
    expect(USE_CHAT).toContain("opts.reuseUserMessageId = turnOpts.reuseUserMessageId");
    expect(USE_CHAT).toContain("opts.parentMessageId = turnOpts.parentMessageId");
  });
});

describe("the runtime persists the tree", () => {
  it("the user message forks from the conversation's active leaf (or the explicit parent)", () => {
    const sec = section(RUNTIME, "1. Persist the user's message", "2. Load history from Dexie");
    expect(sec).toContain("getActiveLeaf(conversationId)");
    expect(sec).toContain("setActiveLeaf(conversationId, userMessageRowId)");
    expect(sec).toContain("reuseUserMessageId");
  });

  it("wire history resolves through the branch walk — sibling branches never leak into context", () => {
    const sec = section(RUNTIME, "2. Load history from Dexie", "2.5 HOT-LOAD DYNAMIC TOOLS");
    expect(sec).toContain("resolveActiveBranch(history, userMessageRowId)");
  });

  it("EVERY checkpoint save carries the turn's user-message parent", () => {
    const count = (RUNTIME.match(/parentId: userMessageRowId,/g) ?? []).length;
    expect(count).toBeGreaterThanOrEqual(8); // 8 saveAgentCheckpoint call sites
  });

  it("the settled assistant message becomes the active-branch leaf", () => {
    expect(RUNTIME).toContain("setActiveLeaf(conversationId, savedMessage.id)");
  });

  it("a checkpoint put without parentId PRESERVES the earlier link (never orphans)", () => {
    expect(SERVICES).toContain("parent_id: input.parentId ?? existing?.parent_id ?? null");
  });

  it("addMessage persists the fork parent", () => {
    expect(SERVICES).toContain("{ parent_id: input.parentId }");
    expect(SERVICES).toContain("async setMessageParent(messageId: string, parentId: string | null)");
    expect(SERVICES).toContain("async getActiveLeaf(conversationId: string)");
  });
});

describe("the paint path resolves the branch", () => {
  it("the container resolves the active branch + builds picker metadata before painting", () => {
    const sec = section(CONTAINER, "CHAT BRANCHES: resolve the ACTIVE branch", "replaceAllMessages(painted);");
    expect(sec).toContain("resolveActiveBranch(currentMessages, activeLeafId)");
    expect(sec).toContain("buildBranchInfo(currentMessages, resolvedRows)");
  });

  it("a leaf-only change repaints (branch switch, same messages array)", () => {
    expect(CONTAINER).toContain("paintedLeafRef.current === activeLeafId");
    expect(CONTAINER).toMatch(/useConversationStore\(\(s\) => s\.activeLeafId\)/);
  });

  it("the switch handler lands on the sibling branch's deepest message + persists", () => {
    const fn = section(CONTAINER, "CHAT BRANCHES: the ‹ i/n › switch", "  // Slash command handlers");
    expect(fn).toContain("siblingGroup(all, target)");
    expect(fn).toContain("deepestLeafOf(all, next.id)");
    expect(fn).toContain("setActiveLeafFor(convId, newLeafId)");
    expect(fn).toContain("setActiveLeaf(convId, newLeafId)");
  });

  it("switching is disabled while a turn is live", () => {
    expect(CONTAINER).toContain("branchesDisabled={isProcessing}");
  });
});

describe("the picker wiring reaches the messages", () => {
  it("the mapper carries parent_id into the live view", () => {
    expect(MAPPER).toContain("parent_id:");
  });

  it("MessageList + MessageItem carry the branch props through", () => {
    expect(LIST).toContain("branchInfo?: Map<string, BranchPosition>");
    expect(LIST).toContain("branch={branchInfo?.get(message.id)}");
    expect(ITEM).toContain("branch?: { index: number; count: number }");
    expect(ITEM).toContain("<BranchPicker");
    // the memo comparator sees branch changes (the picker flips on switch)
    expect(ITEM).toContain("prev.branch?.index === next.branch?.index");
  });
});

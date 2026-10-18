/**
 * Projects data layer tests (Task 1-a) — service CRUD + cascade accounting,
 * permission resolution matrix, memory dedupe + budgeted retrieval,
 * approval lifecycle, params-hash stability, and the Dexie v3→v4 upgrade
 * path proof.
 *
 * Dexie-backed tests run against `fake-indexeddb` (dev dependency) — the
 * real `AppDatabase` class and the real service modules are exercised, only
 * the IndexedDB engine is faked.
 */
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import Dexie from "dexie";
import { AppDatabase, db } from "@/lib/db";
import {
  capInstructionsHistory,
  createProject,
  deleteProject,
  duplicateProject,
  getProject,
  INSTRUCTIONS_HISTORY_CAP,
  listProjects,
  ProjectServiceError,
  reorderProjects,
  touchProjectActivity,
  updateProject,
  DEFAULT_MEMORY_SETTINGS,
} from "./service";
import {
  APPROVAL_POLICIES_KEY,
  canonicalParamsHash,
  canonicalizeParams,
  defaultPermissionFor,
  findApplicableRule,
  loadGlobalPolicy,
  resolvePermission,
  sanitizePolicyRecord,
  saveGlobalPolicy,
  sha256Sync,
  strictestPermission,
} from "./permissions";
import {
  contentSimilarity,
  listMemories,
  MEMORY_SIMILARITY_THRESHOLD,
  retrieveMemories,
  saveMemory,
  selectMemoriesWithinBudget,
} from "./memory";
import {
  APPROVAL_TTL_MS,
  completeApproval,
  createApprovalRequest,
  getApproval,
  listApprovals,
  resolveApproval,
  sweepExpired,
} from "./approvals";
import type { Project, ProjectMemoryItem } from "@/types";

const USER = "user-1";
const OTHER_USER = "user-2";
const NOW = "2026-01-01T00:00:00.000Z";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeProject(id: string, overrides: Partial<Project> = {}): Project {
  return {
    id,
    user_id: USER,
    name: `Project ${id}`,
    description: null,
    goal: "Test goal",
    instructions: "",
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
    ...overrides,
  };
}

interface ConversationFixture {
  id: string;
  user_id: string;
  title?: string;
  created_at: string;
  updated_at: string;
  is_archived: boolean;
  is_demo: boolean;
  project_id?: string | null;
}

function makeConversation(id: string, projectId: string | null = null, userId = USER): ConversationFixture {
  return {
    id,
    user_id: userId,
    title: `Chat ${id}`,
    created_at: NOW,
    updated_at: NOW,
    is_archived: false,
    is_demo: false,
    ...(projectId ? { project_id: projectId } : {}),
  };
}

function makeMessage(id: string, conversationId: string) {
  return {
    id,
    conversation_id: conversationId,
    role: "user" as const,
    content: `message ${id}`,
    created_at: NOW,
  };
}

function makeToolCall(id: string, messageId: string) {
  return {
    id,
    message_id: messageId,
    tool_call_id: `tc_${id}`,
    tool_name: "web_search",
    args: {},
    result: "",
    status: "completed" as const,
    started_at: NOW,
    completed_at: NOW,
  };
}

function makeRating(id: string, messageId: string) {
  return {
    id,
    message_id: messageId,
    user_id: USER,
    rating: 1,
    comment: null,
    created_at: NOW,
    updated_at: NOW,
  };
}

function makeChartSpec(id: string, messageId: string, conversationId: string) {
  return {
    id,
    user_id: USER,
    conversation_id: conversationId,
    message_id: messageId,
    tool_call_id: `tc_${id}`,
    spec: {
      kind: "chart" as const,
      chart_type: "line" as const,
      title: "t",
      data: [],
      x_key: "x",
      series: [],
      style: {},
    },
    created_at: NOW,
  };
}

function makeSearchRow(messageId: string, conversationId: string, projectId: string | null) {
  return {
    message_id: messageId,
    conversation_id: conversationId,
    project_id: projectId,
    role: "user" as const,
    text: `indexed ${messageId}`,
    title_cache: "title",
    token_count: 2,
    embed_state: "none" as const,
    created_at: NOW,
    updated_at: NOW,
  };
}

function makeMemory(id: string, projectId: string, content: string, overrides: Partial<ProjectMemoryItem> = {}): ProjectMemoryItem {
  return {
    id,
    project_id: projectId,
    category: "decision",
    content,
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
    db.message_ratings.clear(),
    db.chart_specs.clear(),
    db.conversation_shares.clear(),
    db.todo_lists.clear(),
    db.user_settings.clear(),
  ]);
});

// ---------------------------------------------------------------------------
// Dexie upgrade path — v3 database opens and upgrades to v4
// ---------------------------------------------------------------------------

describe("Dexie v3 → v4 upgrade", () => {
  it("upgrades a legacy v3 database without data loss and exposes the v4 tables + project_id index", async () => {
    const NAME = "agent-chat-app-upgrade-test";

    // Legacy database with the EXACT v1/v3 store definitions the app shipped
    // before version 4 (v2 was identical to v1 for these stores).
    const v1Stores = {
      users: "&id, email, is_active, created_at",
      conversations: "&id, user_id, is_archived, is_demo, created_at, updated_at, last_message_at",
      messages: "&id, conversation_id, role, created_at",
      tool_calls: "&id, message_id, tool_call_id, status, started_at",
      chat_files: "&id, user_id, message_id, conversation_id, created_at",
      message_ratings: "&id, message_id, user_id, [message_id+user_id], created_at",
      conversation_shares: "&id, conversation_id, shared_by, shared_with, share_token, created_at",
      user_slash_commands: "&id, user_id, name, [user_id+name], is_enabled",
      ai_providers: "&id, user_id, is_active, created_at",
      user_settings: "&id, user_id",
      mcp_servers: "&id, user_id, is_active, created_at",
      custom_tools: "&id, user_id, is_active, name, created_at",
      skills: "&id, user_id, name, [user_id+name], is_active, created_at",
      chart_specs: "&id, user_id, conversation_id, message_id, tool_call_id",
    };
    const legacy = new Dexie(NAME);
    legacy.version(1).stores(v1Stores);
    legacy.version(3).stores({ todo_lists: "&conversation_id, updated_at" });
    await legacy.open();
    await legacy.table("conversations").add(makeConversation("c-legacy"));
    await legacy.table("todo_lists").add({ conversation_id: "c-legacy", todos: [], updated_at: NOW });
    await legacy.close();

    // Open with the REAL class — the v3 → v4 upgrade runs here.
    const app = new AppDatabase(NAME);
    await app.open();
    expect(app.verno).toBe(4);

    // Existing data survived the upgrade.
    expect((await app.conversations.get("c-legacy"))?.title).toBe("Chat c-legacy");
    expect(await app.todo_lists.get("c-legacy")).toBeDefined();

    // New v4 tables are present and writable.
    await app.projects.add(makeProject("p-upgrade"));
    await app.project_memories.add(makeMemory("m-upgrade", "p-upgrade", "note"));
    await app.approval_requests.add({
      id: "apr_upgrade",
      project_id: "p-upgrade",
      conversation_id: "c-legacy",
      operation_type: "op",
      tool_name: "delete_file",
      operation_parameters: {},
      params_hash: "x",
      status: "pending",
      created_at: NOW,
    });
    await app.message_search_index.add(makeSearchRow("msg-upgrade", "c-legacy", "p-upgrade"));

    // The conversations.project_id index works.
    await app.conversations.add(makeConversation("c-proj", "p-upgrade"));
    const projectChats = await app.conversations.where("project_id").equals("p-upgrade").toArray();
    expect(projectChats.map((c) => c.id)).toEqual(["c-proj"]);

    expect(await app.projects.count()).toBe(1);
    expect(await app.project_memories.count()).toBe(1);
    expect(await app.approval_requests.count()).toBe(1);
    expect(await app.message_search_index.count()).toBe(1);
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// service: createProject validation
// ---------------------------------------------------------------------------

describe("createProject validation", () => {
  it("rejects an empty name with a typed error", async () => {
    await expect(
      createProject({ user_id: USER, name: "   ", goal: "g" }),
    ).rejects.toMatchObject({ code: "invalid_name" });
    await expect(
      createProject({ user_id: USER, name: "", goal: "g" }),
    ).rejects.toBeInstanceOf(ProjectServiceError);
  });

  it("rejects an empty goal with a typed error", async () => {
    await expect(
      createProject({ user_id: USER, name: "n", goal: "  " }),
    ).rejects.toMatchObject({ code: "invalid_goal" });
  });

  it("rejects a missing user id", async () => {
    await expect(
      createProject({ user_id: "", name: "n", goal: "g" }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("persists a valid project with defaults and a trimmed name", async () => {
    const project = await createProject({
      user_id: USER,
      name: "  Website Redesign  ",
      goal: " Ship the redesign ",
      instructions: "Keep it fast.",
    });
    expect(project.name).toBe("Website Redesign");
    expect(project.goal).toBe("Ship the redesign");
    expect(project.status).toBe("active");
    expect(project.pinned).toBe(false);
    expect(project.memory_settings).toEqual(DEFAULT_MEMORY_SETTINGS);
    expect(project.resources).toEqual([]);
    // Initial instructions seed the version history at v1.
    expect(project.instructions_history).toHaveLength(1);
    expect(project.instructions_history[0].content).toBe("Keep it fast.");

    const stored = await getProject(project.id);
    expect(stored?.name).toBe("Website Redesign");
  });

  it("assigns increasing manual sort_order per user", async () => {
    const a = await createProject({ user_id: USER, name: "a", goal: "g" });
    const b = await createProject({ user_id: USER, name: "b", goal: "g" });
    expect(b.sort_order!).toBeGreaterThan(a.sort_order!);
  });
});

// ---------------------------------------------------------------------------
// service: updateProject + instructions history
// ---------------------------------------------------------------------------

describe("updateProject + instructions history", () => {
  it("appends a version snapshot when instructions change, not on identical re-save", async () => {
    const project = await createProject({ user_id: USER, name: "p", goal: "g", instructions: "v1" });
    const v2 = await updateProject(project.id, { instructions: "v2" });
    expect(v2.instructions_history.map((h) => h.content)).toEqual(["v1", "v2"]);
    const again = await updateProject(project.id, { instructions: "v2" });
    expect(again.instructions_history).toHaveLength(2);
  });

  it("stamps updated_at on every write and validates patches", async () => {
    const project = await createProject({ user_id: USER, name: "p", goal: "g" });
    const before = project.updated_at;
    await new Promise((r) => setTimeout(r, 5));
    const updated = await updateProject(project.id, { name: "renamed" });
    expect(updated.updated_at).not.toBe(before);
    await expect(updateProject(project.id, { name: " " })).rejects.toMatchObject({
      code: "invalid_name",
    });
    await expect(updateProject("missing", { name: "x" })).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("caps the history at 20 entries keeping the most recent (pure fn)", () => {
    let history = [{ content: "v0", saved_at: NOW }];
    for (let i = 1; i <= 30; i++) {
      history = capInstructionsHistory(history, { content: `v${i}`, saved_at: NOW });
    }
    expect(history).toHaveLength(INSTRUCTIONS_HISTORY_CAP);
    expect(history[0].content).toBe("v11"); // dropped v0..v10
    expect(history[history.length - 1].content).toBe("v30");
  });

  it("merges partial memory_settings over the existing block", async () => {
    const project = await createProject({ user_id: USER, name: "p", goal: "g" });
    const updated = await updateProject(project.id, {
      memory_settings: { context_budget_chars: 1000 },
    });
    expect(updated.memory_settings).toEqual({
      ...DEFAULT_MEMORY_SETTINGS,
      context_budget_chars: 1000,
    });
  });
});

// ---------------------------------------------------------------------------
// service: cascade delete accounting
// ---------------------------------------------------------------------------

describe("deleteProject cascade accounting", () => {
  it("removes every owned row, returns honest counts, and leaves general chats alone", async () => {
    const project = await createProject({ user_id: USER, name: "p", goal: "g" });
    const pid = project.id;

    // Two project conversations + one general conversation.
    await db.conversations.bulkAdd([
      makeConversation("c1", pid),
      makeConversation("c2", pid),
      makeConversation("c-general"),
    ]);
    // Messages: 2 in c1, 1 in c2, 1 in the general chat.
    await db.messages.bulkAdd([
      makeMessage("m1", "c1"),
      makeMessage("m2", "c1"),
      makeMessage("m3", "c2"),
      makeMessage("m-general", "c-general"),
    ]);
    // Per-message children for the project messages.
    await db.tool_calls.bulkAdd([makeToolCall("t1", "m1"), makeToolCall("t2", "m3")]);
    await db.message_ratings.bulkAdd([makeRating("r1", "m1")]);
    await db.chart_specs.bulkAdd([makeChartSpec("ch1", "m2", "c1")]);
    // Conversation-scoped rows.
    await db.conversation_shares.add({
      id: "s1",
      conversation_id: "c1",
      shared_by: USER,
      permission: "view",
      created_at: NOW,
    });
    await db.todo_lists.add({ conversation_id: "c1", todos: [], updated_at: NOW });
    // Memories: 3 (one already superseded — still a row that gets deleted).
    await db.project_memories.bulkAdd([
      makeMemory("mem1", pid, "decision A"),
      makeMemory("mem2", pid, "decision B"),
      makeMemory("mem3", pid, "old", { superseded_by: "mem2" }),
    ]);
    // Approvals: one keyed by project_id, one keyed only by conversation.
    await db.approval_requests.bulkAdd([
      {
        id: "apr_p",
        project_id: pid,
        conversation_id: "c1",
        operation_type: "op",
        tool_name: "delete_file",
        operation_parameters: {},
        params_hash: "h",
        status: "pending",
        created_at: NOW,
      },
      {
        id: "apr_conv",
        project_id: null,
        conversation_id: "c2",
        operation_type: "op",
        tool_name: "delete_file",
        operation_parameters: {},
        params_hash: "h",
        status: "pending",
        created_at: NOW,
      },
    ]);
    // Search index: 2 project rows + 1 general row.
    await db.message_search_index.bulkAdd([
      makeSearchRow("m1", "c1", pid),
      makeSearchRow("m3", "c2", pid),
      makeSearchRow("m-general", "c-general", null),
    ]);

    const summary = await deleteProject(pid);
    expect(summary).toEqual({
      projects: 1,
      conversations: 2,
      messages: 3,
      tool_calls: 2,
      message_ratings: 1,
      chart_specs: 1,
      conversation_shares: 1,
      todo_lists: 1,
      project_memories: 3,
      approval_requests: 2,
      message_search_index: 2,
    });

    // General conversation + its message + its search row survive.
    expect(await db.conversations.get("c-general")).toBeDefined();
    expect(await db.messages.get("m-general")).toBeDefined();
    expect(await db.message_search_index.get("m-general")).toBeDefined();
    // Nothing project-owned remains.
    expect(await db.projects.count()).toBe(0);
    expect(await db.conversations.where("project_id").equals(pid).count()).toBe(0);
    expect(await db.project_memories.where("project_id").equals(pid).count()).toBe(0);
    expect(await db.approval_requests.count()).toBe(0);
    await expect(deleteProject(pid)).rejects.toMatchObject({ code: "not_found" });
  });
});

// ---------------------------------------------------------------------------
// service: archive / restore / reorder / duplicate / touch
// ---------------------------------------------------------------------------

describe("archive / restore / reorder / duplicate / touch", () => {
  it("flips status and stamps updated_at on archive/restore", async () => {
    const project = await createProject({ user_id: USER, name: "p", goal: "g" });
    const archived = await updateProject(project.id, { status: "archived" });
    expect(archived.status).toBe("archived");
    const restored = await updateProject(project.id, { status: "active" });
    expect(restored.status).toBe("active");
    expect(restored.updated_at >= project.updated_at).toBe(true);
  });

  it("persists manual ordering via reorderProjects", async () => {
    const a = await createProject({ user_id: USER, name: "a", goal: "g" });
    const b = await createProject({ user_id: USER, name: "b", goal: "g" });
    await reorderProjects([b.id, a.id]);
    const list = await listProjects(USER);
    expect(list.map((p) => p.id)).toEqual([b.id, a.id]);
    expect(list[0].sort_order).toBe(1);
    expect(list[1].sort_order).toBe(2);
  });

  it("duplicates config only: fresh id, \"(copy)\" name, no memories/chats, not pinned", async () => {
    const source = await createProject({
      user_id: USER,
      name: "Website Redesign",
      goal: "g",
      instructions: "rules",
      icon: "rocket",
      accent_color: "#ff0000",
      pinned: true,
      resources: [
        { resource_type: "tool", resource_id: "web_search", permission: "denied", updated_at: NOW },
      ],
    });
    await db.project_memories.add(makeMemory("mem-dup", source.id, "decision"));
    await db.conversations.add(makeConversation("c-dup", source.id));

    const copy = await duplicateProject(source.id);
    expect(copy.id).not.toBe(source.id);
    expect(copy.name).toBe("Website Redesign (copy)");
    expect(copy.goal).toBe("g");
    expect(copy.instructions).toBe("rules");
    expect(copy.resources).toEqual(source.resources);
    expect(copy.pinned).toBe(false); // duplicates never inherit the pin
    expect(copy.status).toBe("active");
    // Config-only: no memories, no conversations copied.
    expect(await db.project_memories.where("project_id").equals(copy.id).count()).toBe(0);
    expect(await db.conversations.where("project_id").equals(copy.id).count()).toBe(1 - 1);
    // Source untouched.
    expect(await db.project_memories.where("project_id").equals(source.id).count()).toBe(1);

    const stripped = await duplicateProject(source.id, {
      includeInstructions: false,
      includeAppearance: false,
      includeResources: false,
      includeMemorySettings: false,
      nameOverride: "Blank slate",
    });
    expect(stripped.name).toBe("Blank slate");
    expect(stripped.instructions).toBe("");
    expect(stripped.icon).toBeNull();
    expect(stripped.resources).toEqual([]);
    expect(stripped.memory_settings).toEqual(DEFAULT_MEMORY_SETTINGS);
  });

  it("touchProjectActivity stamps last_activity_at and is a no-op for unknown ids", async () => {
    const project = await createProject({ user_id: USER, name: "p", goal: "g" });
    expect(project.last_activity_at).toBeNull();
    await touchProjectActivity(project.id);
    const touched = await getProject(project.id);
    expect(touched?.last_activity_at).not.toBeNull();
    await expect(touchProjectActivity("missing-id")).resolves.toBeUndefined();
  });

  it("listProjects is user-scoped and deterministic", async () => {
    await createProject({ user_id: USER, name: "mine", goal: "g" });
    await createProject({ user_id: OTHER_USER, name: "theirs", goal: "g" });
    const mine = await listProjects(USER);
    expect(mine).toHaveLength(1);
    expect(mine[0].name).toBe("mine");
  });
});

// ---------------------------------------------------------------------------
// permissions: argument-aware default sensitivity
// ---------------------------------------------------------------------------

describe("defaultPermissionFor (arg-aware sensitivity)", () => {
  it("treats ordinary tools as allowed", () => {
    expect(defaultPermissionFor("web_search", { query: "x" })).toBe("allowed");
    expect(defaultPermissionFor("read_file", { path: "a.txt" })).toBe("allowed");
    expect(defaultPermissionFor("create_file", { path: "a.txt", content: "x" })).toBe("allowed");
    expect(defaultPermissionFor("write_file", { path: "a.txt", content: "x" })).toBe("allowed");
    expect(defaultPermissionFor("edit_file", { path: "a.txt" })).toBe("allowed");
    expect(defaultPermissionFor("move_file", { source: "a", destination: "b" })).toBe("allowed");
    expect(defaultPermissionFor("create_folder", { path: "d" })).toBe("allowed");
    expect(defaultPermissionFor("composio_search_tools", { query: "slack" })).toBe("allowed");
    expect(defaultPermissionFor("composio_connect_platform", { toolkit: "slack" })).toBe("allowed");
  });

  it("requires approval for env-var writes but not reads (manage_env_var actions)", () => {
    expect(defaultPermissionFor("manage_env_var", { action: "list" })).toBe("allowed");
    expect(defaultPermissionFor("manage_env_var", { action: "get", name: "X" })).toBe("allowed");
    expect(defaultPermissionFor("manage_env_var", { action: "add", name: "X", value: "v" })).toBe("approval_required");
    expect(defaultPermissionFor("manage_env_var", { action: "set", name: "X", value: "v" })).toBe("approval_required");
    expect(defaultPermissionFor("manage_env_var", { action: "edit", name: "X", value: "v" })).toBe("approval_required");
    expect(defaultPermissionFor("manage_env_var", { action: "delete", name: "X" })).toBe("approval_required");
  });

  it("recognizes the legacy pre-merge env-var tool names", () => {
    expect(defaultPermissionFor("add_env_var", { name: "X" })).toBe("approval_required");
    expect(defaultPermissionFor("delete_env_var", { name: "X" })).toBe("approval_required");
    expect(defaultPermissionFor("list_env_vars", {})).toBe("allowed");
    expect(defaultPermissionFor("get_env_var", { name: "X" })).toBe("allowed");
  });

  it("requires approval for composio execution and e2b deletes", () => {
    expect(defaultPermissionFor("composio_execute_tool", { toolName: "SLACK_SEND_MESSAGE", args: {} })).toBe("approval_required");
    expect(defaultPermissionFor("delete_file", { path: "a.txt" })).toBe("approval_required");
    expect(defaultPermissionFor("delete_folder", { path: "d" })).toBe("approval_required");
  });
});

// ---------------------------------------------------------------------------
// permissions: resolution matrix (global vs project — strictest wins)
// ---------------------------------------------------------------------------

describe("resolvePermission matrix", () => {
  const toolRule = (id: string, permission: "allowed" | "approval_required" | "denied") => ({
    resource_type: "tool" as const,
    resource_id: id,
    permission,
    updated_at: NOW,
  });

  it("with no project and no policy → defaults apply", () => {
    expect(resolvePermission("web_search", {}, { globalPolicy: null, project: null })).toBe("allowed");
    expect(
      resolvePermission("manage_env_var", { action: "delete" }, { globalPolicy: {}, project: null }),
    ).toBe("approval_required");
  });

  it("an explicit global entry replaces the default for that tool", () => {
    // Tighten an otherwise-allowed tool.
    expect(
      resolvePermission("web_search", {}, { globalPolicy: { web_search: "denied" }, project: null }),
    ).toBe("denied");
    // Loosen a default-approval tool (explicit user choice).
    expect(
      resolvePermission(
        "manage_env_var",
        { action: "delete" },
        { globalPolicy: { manage_env_var: "allowed" }, project: null },
      ),
    ).toBe("allowed");
  });

  it("a project rule can tighten but NEVER loosen a stricter global rule", () => {
    // global allowed + project approval_required → approval_required.
    expect(
      resolvePermission("web_search", {}, {
        globalPolicy: { web_search: "allowed" },
        project: { id: "p", resources: [toolRule("web_search", "approval_required")] },
      }),
    ).toBe("approval_required");
    // global approval_required + project allowed → still approval_required.
    expect(
      resolvePermission("manage_env_var", { action: "delete" }, {
        globalPolicy: {},
        project: { id: "p", resources: [toolRule("manage_env_var", "allowed")] },
      }),
    ).toBe("approval_required");
    // explicit global allowed (user override) + project allowed → allowed.
    expect(
      resolvePermission("manage_env_var", { action: "delete" }, {
        globalPolicy: { manage_env_var: "allowed" },
        project: { id: "p", resources: [toolRule("manage_env_var", "allowed")] },
      }),
    ).toBe("allowed");
    // project denied always wins.
    expect(
      resolvePermission("web_search", {}, {
        globalPolicy: {},
        project: { id: "p", resources: [toolRule("web_search", "denied")] },
      }),
    ).toBe("denied");
    // global denied + project allowed → denied.
    expect(
      resolvePermission("web_search", {}, {
        globalPolicy: { web_search: "denied" },
        project: { id: "p", resources: [toolRule("web_search", "allowed")] },
      }),
    ).toBe("denied");
  });

  it("unrelated project rules do not leak onto other tools", () => {
    expect(
      resolvePermission("web_search", {}, {
        globalPolicy: {},
        project: { id: "p", resources: [toolRule("run_terminal", "denied")] },
      }),
    ).toBe("allowed");
  });

  it("findApplicableRule matches exact ids and mcp \"server:tool\" suffixes", () => {
    const rules = [
      toolRule("web_search", "denied"),
      {
        resource_type: "mcp_tool" as const,
        resource_id: "slack:send_message",
        permission: "approval_required" as const,
        updated_at: NOW,
      },
    ];
    expect(findApplicableRule("web_search", rules)?.permission).toBe("denied");
    expect(findApplicableRule("send_message", rules)?.permission).toBe("approval_required");
    expect(findApplicableRule("send_message", [])).toBeUndefined();
  });

  it("strictestPermission orders the three states", () => {
    expect(strictestPermission("allowed", "approval_required")).toBe("approval_required");
    expect(strictestPermission("denied", "approval_required")).toBe("denied");
    expect(strictestPermission("allowed", "allowed")).toBe("allowed");
    expect(strictestPermission("denied", "allowed")).toBe("denied");
  });
});

// ---------------------------------------------------------------------------
// permissions: global policy persistence (user_settings.extra)
// ---------------------------------------------------------------------------

describe("global policy persistence", () => {
  it("saves, merges, loads and deletes entries via user_settings.extra", async () => {
    expect(await loadGlobalPolicy(USER)).toEqual({});
    await saveGlobalPolicy(USER, { web_search: "denied", manage_env_var: "allowed" });
    expect(await loadGlobalPolicy(USER)).toEqual({ web_search: "denied", manage_env_var: "allowed" });
    // Merge: one tool at a time; null removes (falls back to default).
    await saveGlobalPolicy(USER, { run_terminal: "approval_required" });
    await saveGlobalPolicy(USER, { web_search: null });
    const merged = await loadGlobalPolicy(USER);
    expect(merged).toEqual({ manage_env_var: "allowed", run_terminal: "approval_required" });

    // Raw storage shape: nested under extra.approval_policies.
    const row = await db.user_settings.where("user_id").equals(USER).first();
    expect(row?.extra?.[APPROVAL_POLICIES_KEY]).toEqual(merged);
  });

  it("sanitizePolicyRecord drops junk values", () => {
    expect(
      sanitizePolicyRecord({ a: "allowed", b: "yes", c: 3, d: "denied", e: null }),
    ).toEqual({ a: "allowed", d: "denied" });
  });
});

// ---------------------------------------------------------------------------
// permissions: canonical params hashing
// ---------------------------------------------------------------------------

describe("canonical params hash", () => {
  it("sha256Sync matches the FIPS 180-4 test vectors", () => {
    expect(sha256Sync("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(sha256Sync("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(sha256Sync("The quick brown fox jumps over the lazy dog")).toBe(
      "d7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592",
    );
  });

  it("canonicalizeParams is key-order independent at every nesting level", () => {
    const a = { path: "x.txt", opts: { mode: "w", flags: { b: 1, a: 2 } }, z: [1, 2] };
    const b = { z: [1, 2], opts: { flags: { a: 2, b: 1 }, mode: "w" }, path: "x.txt" };
    expect(canonicalizeParams(a)).toBe(canonicalizeParams(b));
    // Different content → different canonical form.
    expect(canonicalizeParams(a)).not.toBe(canonicalizeParams({ ...b, path: "y.txt" }));
  });

  it("canonicalParamsHash is stable across key order and matches sha256Sync", async () => {
    const a = { action: "delete", name: "API_KEY" };
    const b = { name: "API_KEY", action: "delete" };
    const hashA = await canonicalParamsHash(a);
    const hashB = await canonicalParamsHash(b);
    expect(hashA).toBe(hashB);
    expect(hashA).toBe(sha256Sync(canonicalizeParams(a)));
    expect(await canonicalParamsHash({ action: "delete", name: "OTHER" })).not.toBe(hashA);
    expect(hashA).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// memory: dedupe / supersede
// ---------------------------------------------------------------------------

describe("memory dedupe / supersede", () => {
  it("supersedes a >0.9-similar same-category item instead of duplicating", async () => {
    const first = await saveMemory("p1", {
      category: "decision",
      content: "Use Dexie for local persistence in the projects workspace",
      source_conversation_ids: ["c1"],
    });
    expect(first.superseded).toBeNull();

    const second = await saveMemory("p1", {
      category: "decision",
      content: "Use Dexie for local persistence in the projects workspace!",
      source_conversation_ids: ["c2"],
    });
    expect(second.superseded?.id).toBe(first.item.id);
    // The new item inherits BOTH sources (provenance union).
    expect(second.item.source_conversation_ids.sort()).toEqual(["c1", "c2"]);
    // Default listing shows only the active (non-superseded) item.
    const active = await listMemories("p1");
    expect(active.map((m) => m.id)).toEqual([second.item.id]);
    // Full history still contains the superseded row.
    const all = await listMemories("p1", { includeSuperseded: true });
    expect(all).toHaveLength(2);
  });

  it("keeps distinct items in the same category as separate rows", async () => {
    await saveMemory("p1", { category: "decision", content: "Use Dexie for persistence" });
    const second = await saveMemory("p1", {
      category: "decision",
      content: "The login page uses a modal dialog",
    });
    expect(second.superseded).toBeNull();
    expect(await listMemories("p1")).toHaveLength(2);
  });

  it("different categories never supersede each other", async () => {
    await saveMemory("p1", { category: "decision", content: "Use Dexie for persistence everywhere" });
    const pref = await saveMemory("p1", {
      category: "preference",
      content: "Use Dexie for persistence everywhere",
    });
    expect(pref.superseded).toBeNull();
  });

  it("rejects empty content with a typed error", async () => {
    await expect(saveMemory("p1", { category: "task", content: "   " })).rejects.toMatchObject({
      code: "invalid_content",
    });
  });

  it("contentSimilarity: identical → 1, disjoint → 0, near-duplicate above threshold", () => {
    expect(contentSimilarity("use dexie for local persistence", "use dexie for local persistence")).toBe(1);
    expect(contentSimilarity("use dexie for local persistence", "completely unrelated words here")).toBe(0);
    const sim = contentSimilarity(
      "Use Dexie for local persistence in the projects workspace",
      "Use Dexie for local persistence in the projects workspace!",
    );
    expect(sim).toBeGreaterThan(MEMORY_SIMILARITY_THRESHOLD);
  });
});

// ---------------------------------------------------------------------------
// memory: budgeted retrieval
// ---------------------------------------------------------------------------

describe("memory budgeted retrieval", () => {
  const now = Date.parse("2026-02-01T00:00:00.000Z");

  function item(id: string, content: string, overrides: Partial<ProjectMemoryItem> = {}): ProjectMemoryItem {
    return makeMemory(id, "p1", content, { updated_at: NOW, ...overrides });
  }

  it("always includes pinned items first, even when they alone exceed the budget", () => {
    const pinned = item("pin", "Pinned architecture note ".repeat(20), { pinned: true });
    const small = item("small", "tiny");
    const selected = selectMemoriesWithinBudget([small, pinned], "anything", 50, now);
    expect(selected.map((m) => m.id)).toEqual(["pin"]);
  });

  it("stops at the budget for non-pinned items", () => {
    const a = item("a", "a".repeat(40));
    const b = item("b", "b".repeat(40));
    const c = item("c", "c".repeat(40));
    const selected = selectMemoriesWithinBudget([a, b, c], "", 100, now);
    // 100 chars fits exactly a+b; c does not fit → stop.
    expect(selected.map((m) => m.id)).toEqual(["a", "b"]);
  });

  it("ranks by lexical overlap with the query (recency only breaks ties)", () => {
    const streaming = item("streaming", "The streaming duplication bug was fixed by deduping replay events");
    const cooking = item("cooking", "The pasta recipe needs basil and tomatoes");
    const selected = selectMemoriesWithinBudget([cooking, streaming], "streaming replay bug", 1000, now);
    expect(selected[0].id).toBe("streaming");
  });

  it("retrieveMemories excludes superseded items and respects the budget", async () => {
    await saveMemory("p1", { category: "decision", content: "Use Dexie for local persistence in the workspace" });
    const second = await saveMemory("p1", {
      category: "decision",
      content: "Use Dexie for local persistence in the workspace!",
    });
    const other = await saveMemory("p1", { category: "preference", content: "Prefer dark mode" });
    const retrieved = await retrieveMemories("p1", "dexie persistence", 1000);
    expect(retrieved.map((m) => m.id).sort()).toEqual([other.item.id, second.item.id].sort());
    // Budget 0 → nothing fits (none pinned).
    expect(await retrieveMemories("p1", "dexie", 0)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// approvals: lifecycle
// ---------------------------------------------------------------------------

describe("approval lifecycle", () => {
  it("creates a pending approval bound to the params hash with a 15-minute expiry", async () => {
    const approval = await createApprovalRequest({
      conversation_id: "c1",
      project_id: "p1",
      tool_name: "delete_file",
      operation_type: "Delete file",
      operation_parameters: { path: "a.txt" },
      risk_note: "Permanent",
    });
    expect(approval.id.startsWith("apr_")).toBe(true);
    expect(approval.status).toBe("pending");
    expect(approval.params_hash).toBe(await canonicalParamsHash({ path: "a.txt" }));
    const ttl = Date.parse(approval.expires_at ?? "") - Date.parse(approval.created_at);
    expect(ttl).toBe(APPROVAL_TTL_MS);
    expect(await getApproval(approval.id)).toBeDefined();
  });

  it("resolves approve/reject happy paths and refuses double resolution", async () => {
    const approval = await createApprovalRequest({
      conversation_id: "c1",
      tool_name: "manage_env_var",
      operation_type: "Delete env var",
      operation_parameters: { action: "delete", name: "X" },
    });
    const approved = await resolveApproval(approval.id, "approved");
    expect(approved.ok).toBe(true);
    expect(approved.approval?.status).toBe("approved");
    expect(approved.approval?.resolved_at).toBeTruthy();

    const again = await resolveApproval(approval.id, "rejected");
    expect(again.ok).toBe(false);
    expect(again.reason).toBe("already_resolved");

    const other = await createApprovalRequest({
      conversation_id: "c1",
      tool_name: "manage_env_var",
      operation_type: "Delete env var",
      operation_parameters: { action: "delete", name: "Y" },
    });
    const rejected = await resolveApproval(other.id, "rejected");
    expect(rejected.ok).toBe(true);
    expect(rejected.approval?.status).toBe("rejected");

    expect(await resolveApproval("apr_missing", "approved")).toMatchObject({
      ok: false,
      reason: "not_found",
    });
  });

  it("expires stale pendings on resolve and via sweepExpired", async () => {
    const stale = await createApprovalRequest({
      conversation_id: "c1",
      tool_name: "delete_file",
      operation_type: "Delete file",
      operation_parameters: { path: "a" },
      ttl_ms: -1000, // already expired
    });
    const result = await resolveApproval(stale.id, "approved");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("expired");
    expect((await getApproval(stale.id))?.status).toBe("expired");

    // sweepExpired transitions remaining pendings whose time passed.
    const stale2 = await createApprovalRequest({
      conversation_id: "c1",
      tool_name: "delete_file",
      operation_type: "Delete file",
      operation_parameters: { path: "b" },
      ttl_ms: -1000,
    });
    const fresh = await createApprovalRequest({
      conversation_id: "c1",
      tool_name: "delete_file",
      operation_type: "Delete file",
      operation_parameters: { path: "c" },
    });
    const swept = await sweepExpired();
    expect(swept).toBeGreaterThanOrEqual(1);
    expect((await getApproval(stale2.id))?.status).toBe("expired");
    expect((await getApproval(fresh.id))?.status).toBe("pending");
  });

  it("invalidates the approval when the params no longer match (hash binding)", async () => {
    const approval = await createApprovalRequest({
      conversation_id: "c1",
      tool_name: "composio_execute_tool",
      operation_type: "Send Slack message",
      operation_parameters: { toolName: "SLACK_SEND_MESSAGE", args: { channel: "#general" } },
    });
    const mismatched = await resolveApproval(approval.id, "approved", {
      toolName: "SLACK_SEND_MESSAGE",
      args: { channel: "#random" }, // params changed → approval invalid
    });
    expect(mismatched.ok).toBe(false);
    expect(mismatched.reason).toBe("params_changed");
    expect((await getApproval(approval.id))?.status).toBe("expired");
  });

  it("accepts the decision when the CURRENT params hash identically (key order independent)", async () => {
    const approval = await createApprovalRequest({
      conversation_id: "c1",
      tool_name: "delete_file",
      operation_type: "Delete file",
      operation_parameters: { path: "a.txt", recursive: true },
    });
    const matched = await resolveApproval(approval.id, "approved", {
      recursive: true,
      path: "a.txt",
    });
    expect(matched.ok).toBe(true);
    expect(matched.approval?.status).toBe("approved");
  });

  it("completes approved approvals after execution and refuses other states", async () => {
    const approved = await createApprovalRequest({
      conversation_id: "c1",
      tool_name: "delete_file",
      operation_type: "Delete file",
      operation_parameters: { path: "a" },
    });
    await resolveApproval(approved.id, "approved");
    const completed = await completeApproval(approved.id, "Deleted a (12 bytes)");
    expect(completed?.status).toBe("completed");
    expect(completed?.result_summary).toBe("Deleted a (12 bytes)");

    const pending = await createApprovalRequest({
      conversation_id: "c1",
      tool_name: "delete_file",
      operation_type: "Delete file",
      operation_parameters: { path: "b" },
    });
    expect(await completeApproval(pending.id, "should not run")).toBeNull();

    const rejectedRow = await createApprovalRequest({
      conversation_id: "c1",
      tool_name: "delete_file",
      operation_type: "Delete file",
      operation_parameters: { path: "c" },
    });
    await resolveApproval(rejectedRow.id, "rejected");
    expect(await completeApproval(rejectedRow.id, "x")).toBeNull();

    // failed completion path
    const failed = await createApprovalRequest({
      conversation_id: "c1",
      tool_name: "delete_file",
      operation_type: "Delete file",
      operation_parameters: { path: "d" },
    });
    await resolveApproval(failed.id, "approved");
    expect((await completeApproval(failed.id, "rm failed: EACCES", { failed: true }))?.status).toBe("failed");
  });

  it("listApprovals filters by status, project and conversation", async () => {
    const a = await createApprovalRequest({
      conversation_id: "c1",
      project_id: "p1",
      tool_name: "t",
      operation_type: "op",
      operation_parameters: {},
    });
    const b = await createApprovalRequest({
      conversation_id: "c2",
      tool_name: "t",
      operation_type: "op",
      operation_parameters: {},
    });
    await resolveApproval(b.id, "rejected");

    expect((await listApprovals()).map((x) => x.id).sort()).toEqual([a.id, b.id].sort());
    expect((await listApprovals({ status: "pending" })).map((x) => x.id)).toEqual([a.id]);
    expect((await listApprovals({ status: ["rejected", "pending"] })).length).toBe(2);
    expect((await listApprovals({ project_id: "p1" })).map((x) => x.id)).toEqual([a.id]);
    expect((await listApprovals({ project_id: null })).map((x) => x.id)).toEqual([b.id]);
    expect((await listApprovals({ conversation_id: "c2" })).map((x) => x.id)).toEqual([b.id]);
  });
});

// ---------------------------------------------------------------------------
// conversationService projectId scoping (the fetch/create path 1-b consumes)
// ---------------------------------------------------------------------------

describe("conversationService project scoping", () => {
  it("lists by project scope and persists project_id on create", async () => {
    const { conversationService } = await import("@/lib/services");
    await conversationService.create(USER, "general 1");
    const projectChat = await conversationService.create(USER, "in project", undefined, {
      projectId: "p1",
    });
    expect(projectChat.project_id).toBe("p1");

    const all = await conversationService.list(USER, { includeArchived: true });
    expect(all).toHaveLength(2);
    const generalOnly = await conversationService.list(USER, { projectId: null });
    expect(generalOnly.map((c) => c.project_id ?? null)).toEqual([null]);
    const projectOnly = await conversationService.list(USER, { projectId: "p1" });
    expect(projectOnly.map((c) => c.id)).toEqual([projectChat.id]);
    // Undefined scope = all (backwards-compatible default).
    expect(await conversationService.list(USER, {})).toHaveLength(2);
  });
});

"use client";

// Skill management — ONE multi-function tool.
//
// MERGE NOTE (tool-count cap): the five former skill tools
// (list_skills / read_skill / create_skill / edit_skill / delete_skill) were
// merged into this single `manage_skill` tool with an `action` parameter.
//
// MASTER SKILL LIBRARY (2026-10-19): every bundled skill ships inside the
// master library that is attached to EVERY E2B sandbox at startup and
// extracted to /home/user/skills/ (index: /home/user/skills/MASTER-INDEX.md).
// There is nothing to install for library skills: the agent just read_file's
// /home/user/skills/<name>/SKILL.md.
//
// SKILL DIRECTORY AS THE DEFAULT (user request 2026-10-19): the list/fetch
// surface must default to the SKILLS DIRECTORY, never a static handful —
// the agent used to report "6 skill repositories" while the app supported
// hundreds. Now:
//   - action "list" shows the master library (/home/user/skills — 55 skills,
//     ALREADY INSTALLED, read via read_file) PLUS the user's app-installed
//     skills, by default;
//   - action "catalog" = one-call skill surface: master library summary +
//     the LIVE SkillsMP skill directory first page (the same directory
//     Settings → Skills renders — hundreds of skills) + the MCP Market index;
//   - action "search_marketplace" browses/searches that live directory
//     (omit `query` for the top-skill listing, paginated);
//   - action "install_from_marketplace" installs ONE directory skill by slug
//     through the exact pipeline the Settings page uses.
import { registerTool } from "./registry";
import type { ToolResult } from "@/types";
import { skillService, settingsService } from "@/lib/services";
import { bumpWorkspaceVersion } from "./workspace-snapshot";
import { SKILL_MARKETPLACE } from "@/lib/skills/catalog-registry";
import {
  MASTER_SKILLS,
  MASTER_SKILLS_COUNT,
  MASTER_SKILLS_VERSION,
  MASTER_LIBRARY_PATH,
  MASTER_INDEX_PATH,
} from "@/lib/agent/master-skills";
import {
  fetchSkillsMPPage,
  searchSkillsMPSkills,
  installSkillsMPSkill,
  type SkillsMPSkill,
} from "@/lib/skills/installer";

// ---------------------------------------------------------------------------
// SkillsMP directory helpers (same live pipeline the Settings page uses).
// ---------------------------------------------------------------------------

/** Resolve the user's optional SkillsMP API key (500 req/day instead of the
 *  anonymous 50 req/day). Never throws — anonymous access is fine. */
async function getMarketplaceApiKey(userId: string): Promise<string | null> {
  try {
    return await settingsService.getDecryptedSkillsMPApiKey(userId);
  } catch {
    return null;
  }
}

/** AbortSignal for live directory fetches — keeps the tool snappy even when
 *  SkillsMP is slow/unreachable (static metadata still returns). */
function marketplaceTimeout(ms = 8000): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

/** Compact a directory skill for tool output (metadata only — never the
 *  README body, which can be huge). */
function compactMarketplaceSkill(s: SkillsMPSkill) {
  return {
    slug: s.slug,
    name: s.name,
    description: s.description,
    ...(s.author ? { author: s.author } : {}),
    ...(typeof s.stars === "number" ? { stars: s.stars } : {}),
    ...(s.tags && s.tags.length ? { tags: s.tags } : {}),
    ...(s.homepage ? { homepage: s.homepage } : {}),
  };
}

/** One master-library skill, compacted for the "list" action (description
 *  capped — the full text lives in MASTER-INDEX.md / analyze_workspace). */
function compactMasterSkill(name: string, description: string | null) {
  const d = (description ?? "").trim();
  return {
    name,
    description: d.length > 140 ? `${d.slice(0, 137)}…` : d,
    source: "master_library" as const,
    path: `${MASTER_LIBRARY_PATH}/${name}/SKILL.md`,
    read_via: `read_file ${MASTER_LIBRARY_PATH}/${name}/SKILL.md`,
  };
}

const MASTER_LIBRARY_NOTE = `The MASTER LIBRARY (${MASTER_SKILLS_COUNT} skills, version ${MASTER_SKILLS_VERSION}) ships with OnyxAgent and is ALREADY INSTALLED in the sandbox at ${MASTER_LIBRARY_PATH} — nothing to install, just read_file the skill's SKILL.md. Full index: ${MASTER_INDEX_PATH}.`;

const MANAGE_SKILL_DESCRIPTION = `Manage skills — one tool for every skill operation. Skills are SKILL.md instruction files. The DEFAULT skill sources are (1) the MASTER LIBRARY — ${MASTER_SKILLS_COUNT} skills ALWAYS available in the sandbox at ${MASTER_LIBRARY_PATH} (index: ${MASTER_INDEX_PATH}; read those files directly) and (2) the LIVE SkillsMP skill directory — hundreds of community skills, the same one Settings → Skills renders. Pass \`action\` plus the fields that action needs:

- action "list": list EVERY available skill BY DEFAULT — the ${MASTER_SKILLS_COUNT} master-library skills from ${MASTER_LIBRARY_PATH} (already installed; read via read_file) PLUS the user's app-installed skills.
- action "read": read a user-installed skill's full SKILL.md content. Requires \`name\`. (Master-library skills are sandbox files — read_file ${MASTER_LIBRARY_PATH}/<name>/SKILL.md.)
- action "create": create a new skill (available on the next turn). Requires \`name\`, \`description\`, \`content\` (the full SKILL.md markdown).
- action "edit": edit an existing skill's content and/or description. Requires \`name\`; \`content\` and \`description\` are optional (omitted fields are kept).
- action "delete": delete a skill by name. Requires \`name\`.
- action "catalog": the FULL skill surface — master library summary + the LIVE SkillsMP skill directory first page (hundreds of skills) + the MCP Market index. Metadata only.
- action "search_marketplace": search or browse the LIVE SkillsMP skill directory. Optional \`query\` (omit it to browse the top skills), \`page\` (default 1), \`limit\` (default 20, max 50). Returns slugs + metadata.
- action "install_from_marketplace": install ONE skill from the SkillsMP directory into the local registry (then \`read\` it). Requires \`slug\` (from search_marketplace or catalog).`;

registerTool(
  "manage_skill",
  MANAGE_SKILL_DESCRIPTION,
  {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: [
          "list",
          "read",
          "create",
          "edit",
          "delete",
          "catalog",
          "search_marketplace",
          "install_from_marketplace",
        ],
        description: "Which skill operation to perform.",
      },
      name: { type: "string", description: "Skill name (snake_case, unique)." },
      description: { type: "string", description: "Short description of the skill (create) or new description (edit)." },
      content: { type: "string", description: "Full SKILL.md markdown content — instructions, examples, etc. (create, or edit to replace)." },
      query: { type: "string", description: 'Search query for action "search_marketplace" (omit to browse the top of the skill directory).' },
      page: { type: "number", description: 'Directory page number for action "search_marketplace" (default 1).' },
      limit: { type: "number", description: 'Max skills per directory page for action "search_marketplace" (default 20, max 50).' },
      slug: { type: "string", description: 'Skill slug from the SkillsMP directory (action "install_from_marketplace").' },
    },
    required: ["action"],
    additionalProperties: false,
  },
  async (args, ctx): Promise<ToolResult> => {
    const action = String(args.action ?? "");
    const name = args.name as string | undefined;

    // ---- action: list (DEFAULT: master library from /home/user/skills + user skills) ----
    if (action === "list") {
      const skills = await skillService.list(ctx.userId);
      return {
        success: true,
        output: {
          // The master library comes FIRST — it is the default skill source
          // and needs no install (already extracted in every sandbox).
          master_library: {
            count: MASTER_SKILLS_COUNT,
            version: MASTER_SKILLS_VERSION,
            path: MASTER_LIBRARY_PATH,
            index: MASTER_INDEX_PATH,
            note: MASTER_LIBRARY_NOTE,
          },
          skills: [
            ...MASTER_SKILLS.map((s) => compactMasterSkill(s.name, s.description)),
            ...skills.map((s) => ({
              name: s.name,
              description: s.description,
              source: "user" as const,
              is_active: s.is_active,
              created_at: s.created_at,
            })),
          ],
          totals: {
            master_library: MASTER_SKILLS_COUNT,
            user_installed: skills.length,
            all: MASTER_SKILLS_COUNT + skills.length,
          },
          total: MASTER_SKILLS_COUNT + skills.length,
          more_in_directory:
            "This is NOT everything — hundreds more skills are in the LIVE SkillsMP directory: action 'search_marketplace' to browse/search, action 'install_from_marketplace' to add one.",
        },
      };
    }

    // ---- action: read (was read_skill) ----
    if (action === "read") {
      if (!name) return { success: false, output: null, error: "name is required for action 'read'" };
      const skill = await skillService.getByName(ctx.userId, name);
      if (!skill) {
        const master = MASTER_SKILLS.find((s) => s.name === name);
        return {
          success: false,
          output: null,
          error: master
            ? `'${name}' is a MASTER-LIBRARY skill — it lives in the sandbox, not the app registry. Read it directly: read_file ${MASTER_LIBRARY_PATH}/${name}/SKILL.md (index: ${MASTER_INDEX_PATH}).`
            : `Skill '${name}' not found. Run action 'list' for every available skill (master library + user-installed), or action 'search_marketplace' to find one in the live SkillsMP directory.`,
        };
      }
      try {
        const { readTextFile } = await import("@/lib/storage/opfs");
        // The dir_path stored in IndexedDB is like "users/<userId>/skills/<name>"
        // readTextFile expects a full OPFS path.
        const fullPath = `${skill.dir_path}/SKILL.md`;
        const content = await readTextFile(fullPath);
        if (!content || !content.trim()) {
          return {
            success: false,
            output: null,
            error: `Skill '${name}' SKILL.md is empty. The file exists but has no content.`,
          };
        }
        return { success: true, output: { name: skill.name, content, path: fullPath } };
      } catch (e) {
        return {
          success: false,
          output: null,
          error: `Failed to read skill '${name}': ${e instanceof Error ? e.message : String(e)}. The skill may not have been saved to OPFS correctly.`,
        };
      }
    }

    // ---- action: create (was create_skill) ----
    if (action === "create") {
      const description = args.description as string | undefined;
      const content = args.content as string | undefined;
      if (!name || !/^[a-z0-9][a-z0-9_-]*$/i.test(name)) {
        return { success: false, output: null, error: "Invalid skill name (use alphanumeric + dash/underscore)" };
      }
      if (!description || !content) {
        return { success: false, output: null, error: "description and content are required for action 'create'" };
      }
      const existing = await skillService.getByName(ctx.userId, name);
      if (existing) {
        return { success: false, output: null, error: `Skill '${name}' already exists. Use action 'edit' to modify.` };
      }
      try {
        const { writeFile } = await import("@/lib/storage/opfs");
        // Write SKILL.md to OPFS at users/<userId>/skills/<name>/SKILL.md
        const storagePath = await writeFile(ctx.userId, `skills/${name}`, "SKILL.md", content);
        // Save metadata — dir_path is the OPFS directory path
        const dirPath = `users/${ctx.userId}/skills/${name}`;
        await skillService.install(ctx.userId, name, description, dirPath);
        // analyze_workspace reports installed skills — refresh its snapshot
        // cache so a follow-up call sees the new skill (PRD §22).
        bumpWorkspaceVersion("local");
        return { success: true, output: { created: name, path: `${dirPath}/SKILL.md`, storage_path: storagePath } };
      } catch (e) {
        return {
          success: false,
          output: null,
          error: `Failed to create skill: ${e instanceof Error ? e.message : String(e)}`,
        };
      }
    }

    // ---- action: edit (was edit_skill) ----
    if (action === "edit") {
      if (!name) return { success: false, output: null, error: "name is required for action 'edit'" };
      const skill = await skillService.getByName(ctx.userId, name);
      if (!skill) {
        return { success: false, output: null, error: `Skill '${name}' not found` };
      }
      try {
        if (args.content) {
          const { writeFile } = await import("@/lib/storage/opfs");
          await writeFile(ctx.userId, `skills/${name}`, "SKILL.md", args.content as string);
        }
        if (args.description) {
          await skillService.update(skill.id, { description: args.description as string });
        }
        bumpWorkspaceVersion("local"); // skill list/content changed
        return { success: true, output: { edited: name } };
      } catch (e) {
        return {
          success: false,
          output: null,
          error: `Failed to edit skill: ${e instanceof Error ? e.message : String(e)}`,
        };
      }
    }

    // ---- action: delete (was delete_skill) ----
    if (action === "delete") {
      if (!name) return { success: false, output: null, error: "name is required for action 'delete'" };
      const skill = await skillService.getByName(ctx.userId, name);
      if (!skill) {
        return { success: false, output: null, error: `Skill '${name}' not found` };
      }
      try {
        const { removeDir } = await import("@/lib/storage/opfs");
        await removeDir(ctx.userId, `skills/${name}`);
      } catch {
        // OPFS deletion might fail — metadata deletion is more important
      }
      await skillService.delete(skill.id);
      bumpWorkspaceVersion("local"); // skill list changed
      return { success: true, output: { deleted: name } };
    }

    // ---- action: catalog (the FULL skill surface in one call) ----
    if (action === "catalog") {
      // (a) Master library — the built-in default (static, no I/O).
      const master_library = {
        count: MASTER_SKILLS_COUNT,
        version: MASTER_SKILLS_VERSION,
        path: MASTER_LIBRARY_PATH,
        index: MASTER_INDEX_PATH,
        note: MASTER_LIBRARY_NOTE,
      };
      // (b) The LIVE SkillsMP skill directory — first page (the same
      //     directory Settings → Skills renders). Graceful on failure.
      let skill_directory: Record<string, unknown>;
      try {
        const apiKey = await getMarketplaceApiKey(ctx.userId);
        const { items, hasMore } = await fetchSkillsMPPage(1, {
          limit: 20,
          apiKey,
          signal: marketplaceTimeout(),
        });
        const usedFallback = items.length > 0 && items.every((it) => it.isFallback);
        skill_directory = {
          ...SKILL_MARKETPLACE,
          live: !usedFallback,
          page: 1,
          count: items.length,
          has_more: hasMore,
          skills: items.map(compactMarketplaceSkill),
          ...(usedFallback
            ? { warning: "SkillsMP is unreachable right now — static fallback shown. Retry with action 'search_marketplace' later." }
            : {}),
        };
      } catch (e) {
        skill_directory = {
          ...SKILL_MARKETPLACE,
          live: false,
          warning: `Directory listing unavailable (${e instanceof Error ? e.message : String(e)}) — browse it live with action 'search_marketplace'.`,
        };
      }
      // (c) MCP Market index (bundled configs — manage_mcp action "market"
      //     returns the full connection details).
      let mcp_market: unknown = { note: 'Run manage_mcp action "market" for the bundled MCP Market connection configs.' };
      try {
        const { summarizeMcpMarket } = await import("@/lib/skills/catalog-registry");
        mcp_market = summarizeMcpMarket();
      } catch {
        /* keep the pointer note */
      }
      const installed = await skillService.list(ctx.userId).catch(() => []);
      return {
        success: true,
        output: {
          master_library,
          skill_directory,
          mcp_market,
          installed_skills: installed.map((s) => s.name),
          usage: `Master library: pick skills BY NAME from the index, then read_file ${MASTER_LIBRARY_PATH}/<name>/SKILL.md. SkillsMP directory: search_marketplace (omit query to browse) → install_from_marketplace (slug) → read. Never bulk-load; metadata first, read only what the task needs.`,
        },
      };
    }

    // ---- action: search_marketplace (browse/search the LIVE SkillsMP directory) ----
    if (action === "search_marketplace") {
      const query = String(args.query ?? "").trim();
      const page = Math.max(1, Math.floor(Number(args.page ?? 1)) || 1);
      const limit = Math.min(50, Math.max(1, Math.floor(Number(args.limit ?? 20)) || 20));
      try {
        const apiKey = await getMarketplaceApiKey(ctx.userId);
        const signal = marketplaceTimeout();
        if (query) {
          const results = await searchSkillsMPSkills(query, { limit, apiKey, signal });
          return {
            success: true,
            output: {
              source: SKILL_MARKETPLACE.name,
              query,
              count: results.length,
              has_more: results.length >= limit,
              skills: results.map(compactMarketplaceSkill),
              hint: "Install one with action 'install_from_marketplace' (slug), then read it before applying.",
            },
          };
        }
        // No query → browse the directory top (sorted by stars), paginated.
        const { items, hasMore } = await fetchSkillsMPPage(page, { limit, apiKey, signal });
        const usedFallback = items.length > 0 && items.every((it) => it.isFallback);
        return {
          success: true,
          output: {
            source: SKILL_MARKETPLACE.name,
            query: null,
            page,
            count: items.length,
            has_more: hasMore,
            skills: items.map(compactMarketplaceSkill),
            ...(usedFallback ? { warning: "SkillsMP is unreachable right now — static fallback shown. Retry later." } : {}),
            hint: "This is the LIVE skill directory beyond the built-in master library. Pass a `query` to search by keyword, or `page`/`limit` for more. Install with action 'install_from_marketplace' (slug), then read it.",
          },
        };
      } catch (e) {
        return {
          success: false,
          output: null,
          error: `Failed to search the skill directory: ${e instanceof Error ? e.message : String(e)}. SkillsMP may be unreachable or rate-limited — retry later, or check the built-in master library (action 'list').`,
        };
      }
    }

    // ---- action: install_from_marketplace (install ONE directory skill) ----
    if (action === "install_from_marketplace") {
      const slug = String(args.slug ?? "").trim();
      if (!slug) {
        return { success: false, output: null, error: "slug is required for action 'install_from_marketplace' (find slugs with action 'search_marketplace' or 'catalog')" };
      }
      try {
        const apiKey = await getMarketplaceApiKey(ctx.userId);
        const meta = await installSkillsMPSkill(ctx.userId, slug, { apiKey });
        bumpWorkspaceVersion("local"); // skill list changed
        return {
          success: true,
          output: {
            installed: meta.name,
            description: meta.description,
            path: `${meta.dirPath}/SKILL.md`,
            file_count: meta.files.length,
            next_step: `Read it before applying: manage_skill action "read", name "${meta.name}".`,
          },
        };
      } catch (e) {
        return {
          success: false,
          output: null,
          error: `Failed to install '${slug}' from the skill directory: ${e instanceof Error ? e.message : String(e)}`,
        };
      }
    }

    return { success: false, output: null, error: `Unknown action: ${action}` };
  },
  false,
  "general",
);

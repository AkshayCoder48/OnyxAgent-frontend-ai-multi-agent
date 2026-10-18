"use client";

// Skill management — ONE multi-function tool.
//
// MERGE NOTE (tool-count cap): the five former skill tools
// (list_skills / read_skill / create_skill / edit_skill / delete_skill) were
// merged into this single `manage_skill` tool with an `action` parameter.
// Each action preserves the EXACT result shape of the tool it replaced.
//
// Skills PRD additions: `catalog` (the default skill repositories + MCP
// Market index — metadata only), `browse_repository` (per-skill metadata for
// one repository, live from GitHub when the repo has no static index) and
// `install_from_repository` (pull ONE relevant skill into the local registry).
import { registerTool } from "./registry";
import type { ToolResult } from "@/types";
import { skillService } from "@/lib/services";
import { bumpWorkspaceVersion } from "./workspace-snapshot";
import { buildSkillCatalogPayload, SKILL_REPOSITORIES } from "@/lib/skills/catalog-registry";
import { fetchRepositoryIndex, installSkillFromRepository } from "@/lib/skills/repo-browser";

const MANAGE_SKILL_DESCRIPTION = `Manage the user's skills — one tool for every skill operation. Skills are SKILL.md instruction files the agent can install and consult. Pass \`action\` plus the fields that action needs:

- action "list": list all installed skills (name, description, active status). No other fields.
- action "read": read a skill's full SKILL.md content. Requires \`name\`.
- action "create": create a new skill (available on the next turn). Requires \`name\`, \`description\`, \`content\` (the full SKILL.md markdown).
- action "edit": edit an existing skill's content and/or description. Requires \`name\`; \`content\` and \`description\` are optional (omitted fields are kept).
- action "delete": delete a skill by name. Requires \`name\`.
- action "catalog": the DEFAULT SKILL REPOSITORIES index (6 GitHub repos: skill-collections with per-skill metadata, npm-cli repos with sandbox install/run commands) + the MCP Market catalog (10 servers with marketplace URLs). Metadata only — pick what a task needs, never load everything.
- action "browse_repository": per-skill metadata (name, description) for ONE repository. Requires \`repository\` (id from catalog). Repositories without a static index are fetched live from GitHub. npm-cli repos return their sandbox usage instead.
- action "install_from_repository": install ONE skill from a repository into the local registry (then \`read\` it). Requires \`repository\` + \`skill\` (name from the index).`;

registerTool(
  "manage_skill",
  MANAGE_SKILL_DESCRIPTION,
  {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["list", "read", "create", "edit", "delete", "catalog", "browse_repository", "install_from_repository"],
        description: "Which skill operation to perform.",
      },
      name: { type: "string", description: "Skill name (snake_case, unique)." },
      description: { type: "string", description: "Short description of the skill (create) or new description (edit)." },
      content: { type: "string", description: "Full SKILL.md markdown content — instructions, examples, etc. (create, or edit to replace)." },
      repository: { type: "string", description: "Repository id from the catalog (browse_repository / install_from_repository), e.g. \"addhumanity\", \"threejs-game-skills\", \"mengto-skills\"." },
      skill: { type: "string", description: "Skill name from the repository index (install_from_repository)." },
    },
    required: ["action"],
    additionalProperties: false,
  },
  async (args, ctx): Promise<ToolResult> => {
    const action = String(args.action ?? "");
    const name = args.name as string | undefined;

    // ---- action: list (was list_skills) ----
    if (action === "list") {
      const skills = await skillService.list(ctx.userId);
      if (skills.length === 0) {
        return { success: true, output: { skills: [], message: "No skills installed" } };
      }
      return {
        success: true,
        output: {
          skills: skills.map((s) => ({
            name: s.name,
            description: s.description,
            is_active: s.is_active,
            created_at: s.created_at,
          })),
          total: skills.length,
        },
      };
    }

    // ---- action: read (was read_skill) ----
    if (action === "read") {
      if (!name) return { success: false, output: null, error: "name is required for action 'read'" };
      const skill = await skillService.getByName(ctx.userId, name);
      if (!skill) {
        return { success: false, output: null, error: `Skill '${name}' not found` };
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

    // ---- action: catalog (skill repositories + MCP Market index) ----
    if (action === "catalog") {
      const installed = await skillService.list(ctx.userId).catch(() => []);
      return {
        success: true,
        output: {
          ...buildSkillCatalogPayload(),
          installed_skills: installed.map((s) => s.name),
        },
      };
    }

    // ---- action: browse_repository (per-skill metadata, one repo) ----
    if (action === "browse_repository") {
      const repository = args.repository as string | undefined;
      if (!repository) {
        return { success: false, output: null, error: "repository is required for action 'browse_repository' (find ids with action 'catalog')" };
      }
      try {
        const index = await fetchRepositoryIndex(repository);
        if (index.error && index.skills.length === 0) {
          return { success: false, output: null, error: index.error };
        }
        return {
          success: true,
          output: {
            repository: index.repoId,
            repository_name: index.repoName,
            source: index.source,
            skill_count: index.skills.length,
            skills: index.skills.map((s) => ({ name: s.name, description: s.description })),
            ...(index.error ? { warning: index.error } : {}),
            hint: "Metadata only. Install the ones a task needs with action 'install_from_repository', then 'read' them.",
          },
        };
      } catch (e) {
        return {
          success: false,
          output: null,
          error: `Failed to browse repository '${repository}': ${e instanceof Error ? e.message : String(e)}`,
        };
      }
    }

    // ---- action: install_from_repository (pull ONE skill locally) ----
    if (action === "install_from_repository") {
      const repository = args.repository as string | undefined;
      const skill = args.skill as string | undefined;
      if (!repository || !skill) {
        return { success: false, output: null, error: "repository and skill are required for action 'install_from_repository' (find skills with action 'browse_repository' or 'catalog')" };
      }
      const known = SKILL_REPOSITORIES.some((r) => r.id === repository);
      if (!known) {
        return { success: false, output: null, error: `Unknown repository '${repository}'. Use action 'catalog' for the list.` };
      }
      try {
        const meta = await installSkillFromRepository(ctx.userId, repository, skill);
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
          error: `Failed to install '${skill}' from '${repository}': ${e instanceof Error ? e.message : String(e)}`,
        };
      }
    }

    return { success: false, output: null, error: `Unknown action: ${action}` };
  },
  false,
  "general",
);

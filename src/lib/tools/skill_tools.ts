"use client";

// Skill management — ONE multi-function tool.
//
// MERGE NOTE (tool-count cap): the five former skill tools
// (list_skills / read_skill / create_skill / edit_skill / delete_skill) were
// merged into this single `manage_skill` tool with an `action` parameter.
// Each action preserves the EXACT result shape of the tool it replaced.
import { registerTool } from "./registry";
import type { ToolResult } from "@/types";
import { skillService } from "@/lib/services";

const MANAGE_SKILL_DESCRIPTION = `Manage the user's installed skills — one tool for every skill operation. Skills are SKILL.md instruction files the agent can install and consult. Pass \`action\` plus the fields that action needs:

- action "list": list all installed skills (name, description, active status). No other fields.
- action "read": read a skill's full SKILL.md content. Requires \`name\`.
- action "create": create a new skill (available to the agent on the next turn). Requires \`name\`, \`description\`, \`content\` (the full SKILL.md markdown).
- action "edit": edit an existing skill's content and/or description. Requires \`name\`; \`content\` and \`description\` are optional (omitted fields are kept).
- action "delete": delete a skill by name (removes the SKILL.md and its metadata). Requires \`name\`.`;

registerTool(
  "manage_skill",
  MANAGE_SKILL_DESCRIPTION,
  {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["list", "read", "create", "edit", "delete"],
        description: "Which skill operation to perform.",
      },
      name: { type: "string", description: "Skill name (snake_case, unique)." },
      description: { type: "string", description: "Short description of the skill (create) or new description (edit)." },
      content: { type: "string", description: "Full SKILL.md markdown content — instructions, examples, etc. (create, or edit to replace)." },
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
      return { success: true, output: { deleted: name } };
    }

    return { success: false, output: null, error: `Unknown action: ${action}` };
  },
  false,
  "general",
);

"use client";

import { registerTool } from "./registry";
import type { ToolResult } from "@/types";
import { skillService } from "@/lib/services";

registerTool(
  "list_skills",
  "List all installed skills for the current user. Returns name, description, and active status.",
  {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  async (_args, ctx): Promise<ToolResult> => {
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
  },
);

registerTool(
  "read_skill",
  "Read a skill's SKILL.md content. Returns the full markdown content of the skill file.",
  {
    type: "object",
    properties: {
      name: { type: "string", description: "Name of the skill to read" },
    },
    required: ["name"],
    additionalProperties: false,
  },
  async (args, ctx): Promise<ToolResult> => {
    const name = args.name as string;
    const skill = await skillService.getByName(ctx.userId, name);
    if (!skill) {
      return { success: false, output: null, error: `Skill '${name}' not found` };
    }
    try {
      const { readTextFile } = await import("@/lib/storage/opfs");
      // The dir_path stored in IndexedDB is like "users/<userId>/skills/<name>"
      // readTextFile expects a full OPFS path.
      const fullPath = `${skill.dir_path}/SKILL.md`;
      console.log(`[read_skill] Reading from OPFS: ${fullPath}`);
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
      console.error(`[read_skill] Failed to read:`, e);
      return {
        success: false,
        output: null,
        error: `Failed to read skill '${name}': ${e instanceof Error ? e.message : String(e)}. The skill may not have been saved to OPFS correctly.`,
      };
    }
  },
);

registerTool(
  "create_skill",
  "Create a new skill by writing a SKILL.md file. The skill becomes available to the agent on the next turn.",
  {
    type: "object",
    properties: {
      name: { type: "string", description: "Skill name (snake_case, unique)" },
      description: { type: "string", description: "Short description of what the skill does" },
      content: { type: "string", description: "Full SKILL.md markdown content — instructions, examples, etc." },
    },
    required: ["name", "description", "content"],
    additionalProperties: false,
  },
  async (args, ctx): Promise<ToolResult> => {
    const name = args.name as string;
    const description = args.description as string;
    const content = args.content as string;
    if (!name || !/^[a-z0-9][a-z0-9_-]*$/i.test(name)) {
      return { success: false, output: null, error: "Invalid skill name (use alphanumeric + dash/underscore)" };
    }
    const existing = await skillService.getByName(ctx.userId, name);
    if (existing) {
      return { success: false, output: null, error: `Skill '${name}' already exists. Use edit_skill to modify.` };
    }
    try {
      const { writeFile } = await import("@/lib/storage/opfs");
      // Write SKILL.md to OPFS at users/<userId>/skills/<name>/SKILL.md
      const storagePath = await writeFile(ctx.userId, `skills/${name}`, "SKILL.md", content);
      console.log(`[create_skill] Wrote SKILL.md to OPFS: ${storagePath}`);
      // Save metadata — dir_path is the OPFS directory path
      const dirPath = `users/${ctx.userId}/skills/${name}`;
      await skillService.install(ctx.userId, name, description, dirPath);
      console.log(`[create_skill] Saved skill metadata: ${name} at ${dirPath}`);
      return { success: true, output: { created: name, path: `${dirPath}/SKILL.md` } };
    } catch (e) {
      console.error(`[create_skill] Failed:`, e);
      return {
        success: false,
        output: null,
        error: `Failed to create skill: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  },
);

registerTool(
  "edit_skill",
  "Edit an existing skill's SKILL.md content or description.",
  {
    type: "object",
    properties: {
      name: { type: "string", description: "Name of the skill to edit" },
      content: { type: "string", description: "New SKILL.md content (optional — omit to keep existing)" },
      description: { type: "string", description: "New description (optional)" },
    },
    required: ["name"],
    additionalProperties: false,
  },
  async (args, ctx): Promise<ToolResult> => {
    const name = args.name as string;
    const skill = await skillService.getByName(ctx.userId, name);
    if (!skill) {
      return { success: false, output: null, error: `Skill '${name}' not found` };
    }
    try {
      if (args.content) {
        const { writeFile } = await import("@/lib/storage/opfs");
        await writeFile(ctx.userId, `skills/${name}`, "SKILL.md", args.content as string);
        console.log(`[edit_skill] Updated SKILL.md for ${name}`);
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
  },
);

registerTool(
  "delete_skill",
  "Delete a skill by name. Removes the SKILL.md from OPFS and the metadata from IndexedDB.",
  {
    type: "object",
    properties: {
      name: { type: "string", description: "Name of the skill to delete" },
    },
    required: ["name"],
    additionalProperties: false,
  },
  async (args, ctx): Promise<ToolResult> => {
    const name = args.name as string;
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
  },
);

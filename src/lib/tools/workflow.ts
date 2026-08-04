"use client";

import { registerTool } from "./registry";
import * as opfs from "@/lib/storage/opfs";
import { nanoid } from "nanoid";

/**
 * Workflow tool — create, list, edit, delete, and run multi-step workflow pipelines.
 * A workflow is a named sequence of steps (AI prompts or tool calls).
 * Workflows are stored in OPFS at users/<userId>/workflows/.
 */

registerTool(
  "workflow",
  "Create, list, edit, delete, and run multi-step workflow pipelines. A workflow is a sequence of steps — each step is either an AI prompt or a tool call. Steps can reference outputs from previous steps via {{variable}} substitution. Workflows are saved persistently.",
  {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["create", "list", "get", "edit", "delete", "run"],
        description: "Action to perform: create, list, get, edit, delete, or run",
      },
      id: { type: "string", description: "Workflow ID (for get/edit/delete/run)" },
      name: { type: "string", description: "Workflow name (for create/edit)" },
      description: { type: "string", description: "Workflow description (for create/edit)" },
      steps: {
        type: "array",
        description: "Array of step objects (for create/edit). Each step: {type: 'ai'|'tool', name, prompt|tool_name, tool_args}",
        items: {
          type: "object",
          properties: {
            type: { type: "string", enum: ["ai", "tool"] },
            name: { type: "string", description: "Step name (for reference)" },
            prompt: { type: "string", description: "AI prompt (for type='ai'). Use {{var}} for variable substitution." },
            tool_name: { type: "string", description: "Tool name to call (for type='tool')" },
            tool_args: { type: "object", description: "Tool arguments (for type='tool')" },
          },
        },
      },
    },
    required: ["action"],
    additionalProperties: false,
  },
  async (args, ctx) => {
    const action = args.action as string;

    try {
      const workflowsDir = `users/${ctx.userId}/workflows`;
      await opfs.ensurePath(ctx.userId, "workflows");

      if (action === "create") {
        const id = nanoid();
        const workflow = {
          id,
          name: args.name || "Untitled Workflow",
          description: args.description || "",
          steps: (args.steps as unknown[]) || [],
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        await opfs.writeFileAtPath(workflowsDir, `${id}.json`, JSON.stringify(workflow, null, 2));
        return { id, message: `Workflow '${workflow.name}' created with ${workflow.steps.length} steps` };
      }

      if (action === "list") {
        const dir = await opfs.ensurePath(ctx.userId, "workflows");
        const walked = await opfs.walkFiles(dir);
        const workflows = [];
        for (const f of walked) {
          try {
            const file = await f.handle.getFile();
            const content = await file.text();
            const wf = JSON.parse(content);
            workflows.push({
              id: wf.id,
              name: wf.name,
              description: wf.description,
              steps_count: wf.steps?.length || 0,
              updated_at: wf.updated_at,
            });
          } catch {}
        }
        return { workflows, count: workflows.length };
      }

      if (action === "get") {
        const id = args.id;
        if (!id) return { error: "Workflow ID required" };
        const dir = await opfs.ensurePath(ctx.userId, "workflows");
        const walked = await opfs.walkFiles(dir);
        const fileEntry = walked.find((f) => f.path === `${id}.json`);
        if (!fileEntry) return { error: "Workflow not found" };
        const file = await fileEntry.handle.getFile();
        const content = await file.text();
        return JSON.parse(content);
      }

      if (action === "edit") {
        const id = args.id;
        if (!id) return { error: "Workflow ID required" };
        const dir = await opfs.ensurePath(ctx.userId, "workflows");
        const walked = await opfs.walkFiles(dir);
        const fileEntry = walked.find((f) => f.path === `${id}.json`);
        if (!fileEntry) return { error: "Workflow not found" };
        const file = await fileEntry.handle.getFile();
        const content = await file.text();
        const wf = JSON.parse(content);
        if (args.name) wf.name = args.name;
        if (args.description !== undefined) wf.description = args.description;
        if (args.steps) wf.steps = args.steps;
        wf.updated_at = new Date().toISOString();
        await opfs.writeFileAtPath(workflowsDir, `${id}.json`, JSON.stringify(wf, null, 2));
        return { id, message: `Workflow '${wf.name}' updated` };
      }

      if (action === "delete") {
        const id = args.id;
        if (!id) return { error: "Workflow ID required" };
        try {
          const { deleteFile } = await import("@/lib/storage/opfs");
          await deleteFile(`${workflowsDir}/${id}.json`);
          return { id, message: "Workflow deleted" };
        } catch {
          return { error: "Failed to delete workflow" };
        }
      }

      if (action === "run") {
        const id = args.id;
        if (!id) return { error: "Workflow ID required" };
        const dir = await opfs.ensurePath(ctx.userId, "workflows");
        const walked = await opfs.walkFiles(dir);
        const fileEntry = walked.find((f) => f.path === `${id}.json`);
        if (!fileEntry) return { error: "Workflow not found" };
        const file = await fileEntry.handle.getFile();
        const content = await file.text();
        const wf = JSON.parse(content);

        // Note: actually executing the workflow requires the agent runtime,
        // which isn't accessible from a tool. We return the workflow definition
        // so the AI can execute each step manually.
        return {
          id,
          name: wf.name,
          steps: wf.steps,
          message: `Workflow '${wf.name}' loaded. Execute each step sequentially. Use {{output_N}} to reference the output of step N.`,
        };
      }

      return { error: `Unknown action: ${action}` };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  },
  false,
  "workflow",
);

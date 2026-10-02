"use client";

import { registerTool } from "./registry";
import { codeSandboxForCtx } from "@/lib/e2b/sandbox-rotation";
import { bumpWorkspaceVersion } from "./workspace-snapshot";
import {
  getScaffold,
  normalizeAppName,
  projectDir,
  scaffoldKeysDescription,
} from "@/lib/code/scaffolds";

const NO_KEY_ERROR =
  "App scaffolding requires an E2B Sandbox API key. Add one in Settings → Config → E2B Sandbox.";

/**
 * OnyxCode `create_app` (OnyxCode PRD §6) — scaffold a real, runnable
 * project for a given framework into /home/user/projects/<name> in THIS
 * chat's own E2B sandbox (per-chat isolation — one chat = one app). Files
 * are written through the same sandbox write path the other Code Mode tools
 * use (create_file_chunk / edit_file / run_terminal / start_preview…), so
 * they all see them immediately — within THIS chat's isolated filesystem.
 * After scaffolding, the model should call `start_preview` to serve the app
 * at a public URL.
 */
registerTool(
  "create_app",
  `Scaffold a new application project in the E2B sandbox workspace (OnyxCode). Supported frameworks: ${scaffoldKeysDescription()} — ONLY these are supported (no Python/Node.js backends, no CLI tools). Creates the project under /home/user/projects/<name> with real, runnable files. The scaffold ships a PLACEHOLDER landing page — after creating the app you MUST write the REAL app the user asked for (replace the placeholder index/app page with the actual content, pages, styles and behavior) using create_file_chunk with paths like projects/<name>/app/page.tsx, then call start_preview. Never present the placeholder scaffold page as the finished app.`,
  {
    type: "object",
    properties: {
      framework: {
        type: "string",
        description: `Framework to scaffold: ${scaffoldKeysDescription()}.`,
      },
      name: {
        type: "string",
        description:
          "App name (lowercase-with-dashes). Derived from the user's request when omitted.",
      },
      description: {
        type: "string",
        description:
          "One-sentence description of the app — rendered on the scaffolded landing page and used as guidance for its content.",
      },
    },
    required: ["framework"],
    additionalProperties: false,
  },
  async (args, ctx) => {
    const rawFramework = String(args.framework ?? "");
    const scaffold = getScaffold(rawFramework);
    if (!scaffold) {
      return {
        ok: false,
        error: `Unknown framework "${rawFramework}". Supported: ${scaffoldKeysDescription()}.`,
      };
    }
    const appName = normalizeAppName(
      (args.name as string | undefined) || (args.description as string | undefined) || rawFramework,
    );

    const sbx = await codeSandboxForCtx(ctx);
    if (!sbx) {
      return { ok: false, error: NO_KEY_ERROR };
    }

    const progress = ctx.onToolOutput;
    progress?.("", `Scaffolding ${scaffold.label} app "${appName}"…`, "stdout");

    try {
      // THIS chat's own sandbox (one chat = one app = its own filesystem) —
      // the scaffold lands in the app's isolated workspace, never in another
      // chat's.
      const client = sbx.client;
      const dir = projectDir(appName);
      await client.createFolder(dir);

      const files = scaffold.files(appName, args.description as string | undefined);
      const written = await client.batchWrite(
        files.map((f) => ({ path: `${dir}/${f.path}`, content: f.content })),
      );
      if (written.errors.length > 0) {
        return {
          ok: false,
          error: `Failed to write ${written.errors.length} file(s): ${written.errors
            .slice(0, 3)
            .map((e) => `${e.path}: ${e.error}`)
            .join("; ")}`,
        };
      }

      bumpWorkspaceVersion();
      progress?.("", `Created ${files.length} files in ${dir}.`, "stdout");

      return {
        kind: "create_app",
        ok: true,
        name: appName,
        framework: scaffold.key,
        frameworkLabel: scaffold.label,
        path: dir,
        files: files.map((f) => f.path),
        fileCount: files.length,
        hasServer: !!scaffold.serverCommand,
        instructions: scaffold.serverCommand
          ? `The scaffold files are a STARTING POINT ONLY (the landing page is a placeholder). Now write the REAL app the user asked for with create_file_chunk — overwrite projects/${appName}/ index/app pages with the actual content (paths may be written as "projects/${appName}/..." or "/home/user/projects/${appName}/...", both resolve the same). THEN call start_preview.`
          : "This scaffold has no web server — run it with run_terminal (e.g. `node cli.js .`).",
      };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },
  false,
  "code",
);

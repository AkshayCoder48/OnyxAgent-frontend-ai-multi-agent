"use client";

import { registerTool } from "./registry";
import { getE2BClient } from "@/lib/e2b/client";
import { ensureFreshSandboxForCtx } from "@/lib/e2b/sandbox-rotation";
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
 * project for a given framework into /home/user/projects/<name> in the E2B
 * sandbox. Files are written through the same sandbox write path the file
 * tools use, so every other tool (read_file, run_terminal, edit_file…)
 * sees them immediately. After scaffolding, the model should call
 * `start_preview` to serve the app at a public URL.
 */
registerTool(
  "create_app",
  `Scaffold a new application project in the E2B sandbox workspace (OnyxCode). Supported frameworks: ${scaffoldKeysDescription()}. Creates the project under /home/user/projects/<name> with real, runnable files. The scaffold ships a PLACEHOLDER landing page — after creating the app you MUST write the REAL app the user asked for (replace the placeholder index/app page with the actual content, pages, styles and behavior) using create_file_chunk with paths like projects/<name>/app/page.tsx, then call start_preview. Never present the placeholder scaffold page as the finished app. For CLI tools there is no preview — run them with run_terminal.`,
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

    const apiKey = await ensureFreshSandboxForCtx(ctx);
    if (!apiKey) {
      return { ok: false, error: NO_KEY_ERROR };
    }

    const progress = ctx.onToolOutput;
    progress?.("", `Scaffolding ${scaffold.label} app "${appName}"…`, "stdout");

    try {
      const client = getE2BClient(apiKey, null, "shared");
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

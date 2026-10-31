/**
 * Regenerate src/lib/agent/onyx-md.ts AND src/lib/agent/onyx-md-digest.ts
 * from the repo's /Onyx.md.
 *
 * Onyx.md is the agent's runtime documentation (Onyx identity + the
 * compressed tool compendium + the complete GenUI reference). The sandbox
 * route writes it to /home/user/Onyx.md so the model can `read_file` it.
 * Bundling the content as a TS module guarantees the file is available in
 * every deployment environment (Vercel serverless only traces
 * statically-analyzed imports — a runtime fs read of the repo root is NOT
 * traced).
 *
 * The DIGEST is the anti-hallucination companion (PRD §13/§14/§38): a
 * compact (≤8KB) always-injected block that lists EVERY tool by exact name
 * + one-line capability + key constraints, derived AUTOMATICALLY from the
 * "## Tool Compendium" tables in Onyx.md (the source of truth for content).
 * Models used to skip the "read Onyx.md first" instruction and then claim
 * "I don't have access to that tool" about tools that are registered — the
 * digest puts the full tool surface in every system prompt, sized to stay
 * well under the small-provider prompt limits (the scheduler once broke
 * 39KB-prompts-rejecting models with the full inline manual).
 *
 * Parity is enforced by vitest (src/lib/agent/onyx-md-digest.test.ts):
 * every registry tool name must appear in the digest AND every digest name
 * must exist in the registry, plus bg-native/bg-agent TOOLS name parity.
 * The generator itself deliberately stays fs-only (no imports from src/) so
 * it can never break on client-side module graphs; the test is the guardrail.
 *
 * Run after ANY edit to Onyx.md:  bun run scripts/gen-onyx-md.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const md = readFileSync(join(root, "Onyx.md"), "utf-8");

// ---------------------------------------------------------------------------
// 1. Full manual → src/lib/agent/onyx-md.ts
// ---------------------------------------------------------------------------

// Escape for embedding inside a JS template literal:
// backslash first, then backticks, then ${ sequences.
const escaped = md
  .replace(/\\/g, "\\\\")
  .replace(/`/g, "\\`")
  .replace(/\$\{/g, "\\${");

const out = `// AUTO-GENERATED from /Onyx.md — DO NOT EDIT BY HAND.
// Regenerate with: bun run scripts/gen-onyx-md.ts
// This module bundles the FULL Onyx.md (Onyx identity + the compressed tool
// compendium + the complete GenUI reference) so the sandbox always receives
// the documentation the system prompt promises — including when the repo
// file isn't readable at runtime (Vercel serverless bundles traced files
// only).
export const ONYX_MD = \`${escaped}\`;
`;

writeFileSync(join(root, "src/lib/agent/onyx-md.ts"), out);
console.log(`Wrote src/lib/agent/onyx-md.ts (${out.length} chars)`);

// ---------------------------------------------------------------------------
// 2. Tool digest → src/lib/agent/onyx-md-digest.ts
// ---------------------------------------------------------------------------

/** Max characters of "use it when" text kept per tool line. */
const USE_CAP = 180;
/** Hard ceiling for the whole digest block (small providers reject fat prompts). */
const DIGEST_MAX_BYTES = 8192;

// ---------------------------------------------------------------------------
// UMBRELLA CONSOLIDATION — the model-visible surface is a small set of
// action-based UMBRELLA tools + standalone keepers, NOT the ~62 granular
// compendium entries. This map mirrors src/lib/agent/tool-umbrella.ts
// (kept inline so the generator stays fs-only and can never break on the
// client module graph). Drift between the two is caught by the vitest
// parity test (onyx-md-digest.test.ts: digest names ⇄ listTools()).
// ---------------------------------------------------------------------------

const UMBRELLAS: ReadonlyArray<{ name: string; actions: readonly string[]; blurb: string }> = [
  {
    name: "files",
    actions: [
      "list_folder", "read_file", "read_file_section", "create_file", "write_file",
      "edit_file", "delete_file", "delete_folder", "create_folder", "move_file",
      "send_file", "send_folder", "verify_path", "create_file_chunk",
      "list_uploaded_files", "read_uploaded_file", "search_documents", "ocr_document",
    ],
    blurb:
      "Everything file-shaped in the workspace (E2B sandbox /home/user) + uploads + OCR. Pass the operation's parameters alongside `action`.",
  },
  {
    name: "web",
    actions: ["web_search", "image_search", "video_search", "web_fetch"],
    blurb: "Search and read the web. web_fetch is the DEFAULT reader (try /llms.txt for docs).",
  },
  {
    name: "code_exec",
    actions: ["run_python", "run_terminal", "background_task"],
    blurb: "Python, shell, durable background runs in the sandbox.",
  },
  {
    name: "subagents",
    actions: [
      "spawn_subagent", "list_subagents", "set_subagent_config", "query_subagent",
      "steer_subagent", "complete_subagent", "cancel_subagent", "manage_subagent_chat",
    ],
    blurb: "Delegate work to subagents.",
  },
  {
    name: "schedule",
    actions: ["schedule_agent_task", "list_scheduled_tasks", "remove_scheduled_task"],
    blurb: "Cron-schedule sandbox scripts; output lands in /home/user/cron_output.log.",
  },
  {
    name: "integrations",
    actions: [
      "mcp_search_tools", "mcp_call_tool",
      "composio_search_tools", "composio_connect_platform", "composio_execute_tool",
    ],
    blurb: "External integrations: the user's MCP servers + Composio (250+ platforms). Search FIRST, then call.",
  },
  {
    name: "chats",
    actions: ["read_chat", "manage_chats"],
    blurb: "Recall past conversations; read_chat also inspects a subagent's live reply.",
  },
  {
    name: "memory",
    actions: ["manage_memory", "project_memory"],
    blurb: "Persistent facts: user-level (survives chats) and current-project.",
  },
  {
    name: "todos",
    actions: ["manage_todo", "show_todo"],
    blurb: "Plan multi-step work. create returns a stable ID like todo_8f42 — quote it later.",
  },
  {
    name: "media",
    actions: ["media_generation", "create_chart", "preview_image"],
    blurb: "Generate media (Pollinations; chargeable generations need explicit two-step confirmation), charts, inline images.",
  },
  {
    name: "workspace",
    actions: ["analyze_workspace", "security_audit", "manage_env_var"],
    blurb: "Workspace scan (run FIRST on every task), security scan, sandbox env vars.",
  },
  {
    name: "custom_tools",
    actions: ["create_custom_tool", "manage_custom_tool"],
    blurb: "Build reusable tools: http_webhook or python_snippet.",
  },
];

/** Umbrella-dispatched meta-tools that the Onyx.md compendium deliberately
 * does not document as standalone rows (they are covered by the umbrella
 * description + the integrations policy). */
const META_ACTIONS_NOT_IN_COMPENDIUM: ReadonlySet<string> = new Set([
  "mcp_search_tools",
  "mcp_call_tool",
]);


/** Strip markdown emphasis/backticks and collapse whitespace. */
function clean(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\\\|/g, "|")
    .replace(/\s+/g, " ")
    .trim();
}

/** Truncate on a word boundary, keeping punctuation tidy. */
function truncate(text: string, max: number): string {
  const t = clean(text);
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const sp = cut.lastIndexOf(" ");
  return `${(sp > 60 ? cut.slice(0, sp) : cut).replace(/[,;:.]+$/, "")}…`;
}

function buildDigest(source: string): { text: string; tools: string[] } {
  const start = source.indexOf("## Tool Compendium");
  const end = source.indexOf("## Execution Policies", start);
  if (start < 0 || end < 0) {
    throw new Error("Onyx.md: '## Tool Compendium' / '## Execution Policies' sections not found — cannot derive the tool digest.");
  }
  const section = source.slice(start, end);

  // Parse the GRANULAR compendium rows (the full manual's documentation).
  const granular = new Map<string, string>(); // name → digest line

  for (const raw of section.split("\n")) {
    const line = raw.trim();
    const heading = /^###\s+(.+)$/.exec(line);
    if (heading) continue; // section titles don't carry tool rows
    if (!line.startsWith("|")) continue;

    // Markdown tables escape a literal pipe as \| — protect it from the
    // cell split (run_terminal's "Shell with |, &&, ;, >" row), then restore.
    const pipeSafe = line.replace(/\\\|/g, "\u2502");
    // Cells without the outer pipes: [| **tool** | actions | use |] → [tool, actions, use]
    const cells = pipeSafe
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim().replace(/\u2502/g, "|"));
    if (cells.length < 2) continue;

    // Header rows (| Tool | Actions |) and separators carry no bold names.
    const names = [...cells[0]!.matchAll(/\*\*([a-zA-Z0-9_]+)\*\*/g)].map((m) => m[1]!);
    if (!names.length) continue;

    // 3-column tables: [tool, actions, use] · 2-column tables: [tool, use]
    const actions = cells.length >= 3 ? clean(cells[1]!).replace(/·/g, "/") : "";
    const use = cells.length >= 3 ? cells[2]! : cells[1]!;

    for (const name of names) {
      if (granular.has(name)) continue; // "(above)" cross-reference rows
      const prefix = actions && !/^\(no action\)$/.test(actions) ? ` [${actions}]` : "";
      granular.set(name, `${name}${prefix} — ${truncate(use, USE_CAP)}`);
    }
  }

  if (!granular.size) {
    throw new Error("Onyx.md: no tools parsed from the Tool Compendium tables — check the table format.");
  }

  // Group into the model-visible surface: umbrellas + keepers.
  const umbrellaActionToName = new Map<string, string>();
  for (const u of UMBRELLAS) {
    for (const a of u.actions) umbrellaActionToName.set(a, u.name);
  }

  // Drift guards — the compendium must cover every umbrella action (modulo
  // the documented meta-tools), and every granular row must land somewhere.
  for (const u of UMBRELLAS) {
    const missing = u.actions.filter(
      (a) => !granular.has(a) && !META_ACTIONS_NOT_IN_COMPENDIUM.has(a),
    );
    if (missing.length) {
      throw new Error(
        `Onyx.md: umbrella '${u.name}' actions missing from the Tool Compendium: ${missing.join(", ")} — add their rows or update the UMBRELLAS map in this script (it must mirror src/lib/agent/tool-umbrella.ts).`,
      );
    }
  }

  const umbrellaLines: string[] = [];
  const umbrellaNames: string[] = [];
  for (const u of UMBRELLAS) {
    umbrellaNames.push(u.name);
    umbrellaLines.push(`${u.name} [${u.actions.join(" / ")}] — ${u.blurb}`);
  }

  // Keepers: granular tools NOT absorbed by any umbrella, in compendium
  // (document) order.
  const keeperLines: string[] = [];
  const keeperNames: string[] = [];
  for (const [name, line] of granular) {
    if (umbrellaActionToName.has(name)) continue;
    keeperNames.push(name);
    keeperLines.push(line);
  }

  const visible = [...umbrellaNames, ...keeperNames];

  const text = `## TOOL DIGEST — every model-visible tool (${visible.length} total)

Ground truth for what you can do. Your ACTIVE TOOL DEFINITIONS are the final word on what is callable THIS turn.

### Umbrella tools — one name, one \`action\` parameter (the action value is the exact operation)
${umbrellaLines.map((l) => `- ${l}`).join("\n")}

### Single-purpose tools
${keeperLines.map((l) => `- ${l}`).join("\n")}

### Availability rules (anti-hallucination)
- EVERY tool listed above is REAL and CALLABLE. If a tool is in your tool definitions, you HAVE it — NEVER say "I don't have access to that tool" or "I forgot I had those tools" without trying the call first.
- Tool availability is defined ONLY by your active tool definitions this turn — not by your memory, not by this digest alone, not by Onyx.md alone. Dynamic tools (MCP \`mcp_<server>__<tool>\`, custom tools) appear in your definitions when they are active.
- Be honest BOTH ways: never deny a tool you have; never claim or call a tool that is absent from your definitions this turn.
- Detailed usage, execution policies and the full GenUI reference: \`/home/user/Onyx.md\` — read it (the files umbrella's read_file action) when you need more than this digest.`;

  return { text, tools: visible };
}

const digest = buildDigest(md);
const digestBytes = Buffer.byteLength(digest.text, "utf8");
if (digestBytes > DIGEST_MAX_BYTES) {
  throw new Error(
    `Tool digest is ${digestBytes} bytes (max ${DIGEST_MAX_BYTES}) — shorten the "Use it when" column in Onyx.md's Tool Compendium or lower USE_CAP.`,
  );
}

const umbrellaCount = UMBRELLAS.length;
const keeperCount = digest.tools.length - umbrellaCount;

const digestOut = `// AUTO-GENERATED from /Onyx.md — DO NOT EDIT BY HAND.
// Regenerate with: bun run scripts/gen-onyx-md.ts
//
// The TOOL DIGEST — a compact (<${DIGEST_MAX_BYTES} bytes) always-injected
// block listing EVERY MODEL-VISIBLE tool by exact name + one-line capability.
// This is the anti-hallucination companion to the full manual (onyx-md.ts /
// the /home/user/Onyx.md sandbox file): models that skip reading Onyx.md still
// know their complete tool surface, and the availability rules make
// "I don't have that tool" claims about registered tools a prompt violation.
//
// UMBRELLA CONSOLIDATION: the surface is ${digest.tools.length} tools — ${umbrellaCount} action-based
// umbrella tools + ${keeperCount} standalone keepers. Each umbrella takes ONE
// required \`action\` argument whose value is the exact granular operation
// name. The granular tools remain REGISTERED + callable (umbrella dispatch,
// legacy calls) but are hidden from the model-visible list. The generator
// maps the granular Onyx.md compendium onto the umbrella surface using the
// UMBRELLAS map inlined in scripts/gen-onyx-md.ts (mirrors
// src/lib/agent/tool-umbrella.ts).
//
// Parity with the live registry's VISIBLE tools (listTools()) is enforced by
// src/lib/agent/onyx-md-digest.test.ts — every visible registry tool must be
// in the digest and vice versa. After adding/removing/renaming a tool:
// update the Onyx.md compendium AND (if the umbrella surface changed) the
// UMBRELLAS map + src/lib/agent/tool-umbrella.ts, then re-run the generator.

/** Must start with this heading — injection sites use it as the idempotency marker. */
export const ONYX_MD_DIGEST = \`${digest.text.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${")}\`;

/** Every model-visible tool name: the ${umbrellaCount} umbrellas + ${keeperCount} keepers
 * (digest ⇄ registry parity is test-enforced against listTools() — hidden
 * granular tools are excluded by design). */
export const ONYX_MD_DIGEST_TOOLS: readonly string[] = ${JSON.stringify(digest.tools)};
`;

writeFileSync(join(root, "src/lib/agent/onyx-md-digest.ts"), digestOut);
console.log(
  `Wrote src/lib/agent/onyx-md-digest.ts (${digestBytes} bytes, ${digest.tools.length} tools: ${digest.tools.join(", ")})`,
);

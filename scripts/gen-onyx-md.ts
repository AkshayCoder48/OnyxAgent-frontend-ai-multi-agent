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

interface DigestTool {
  name: string;
  line: string;
}
interface DigestCategory {
  title: string;
  tools: DigestTool[];
}

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

  const categories: DigestCategory[] = [];
  const seen = new Set<string>();
  const order: string[] = [];
  let current: DigestCategory | null = null;

  for (const raw of section.split("\n")) {
    const line = raw.trim();
    const heading = /^###\s+(.+)$/.exec(line);
    if (heading) {
      current = { title: clean(heading[1]!), tools: [] };
      categories.push(current);
      continue;
    }
    if (!current || !line.startsWith("|")) continue;

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
      if (seen.has(name)) continue; // "(above)" cross-reference rows
      seen.add(name);
      order.push(name);
      const prefix = actions && !/^\(no action\)$/.test(actions) ? ` [${actions}]` : "";
      current.tools.push({ name, line: `${name}${prefix} — ${truncate(use, USE_CAP)}` });
    }
  }

  if (!order.length) {
    throw new Error("Onyx.md: no tools parsed from the Tool Compendium tables — check the table format.");
  }

  const blocks: string[] = [];
  for (const cat of categories) {
    if (!cat.tools.length) continue;
    blocks.push(`### ${cat.title}\n${cat.tools.map((t) => `- ${t.line}`).join("\n")}`);
  }

  const text = `## TOOL DIGEST — every registered tool (${order.length} total)

Ground truth for what you can do. Your ACTIVE TOOL DEFINITIONS are the final word on what is callable THIS turn.

${blocks.join("\n\n")}

### Availability rules (anti-hallucination)
- EVERY tool listed above is REAL and CALLABLE. If a tool is in your tool definitions, you HAVE it — NEVER say "I don't have access to that tool" or "I forgot I had those tools" without trying the call first.
- Tool availability is defined ONLY by your active tool definitions this turn — not by your memory, not by this digest alone, not by Onyx.md alone. Dynamic tools (MCP \`mcp_<server>__<tool>\`, custom tools) appear in your definitions when they are active.
- Be honest BOTH ways: never deny a tool you have; never claim or call a tool that is absent from your definitions this turn.
- Detailed usage, execution policies and the full GenUI reference: \`/home/user/Onyx.md\` — \`read_file\` it when you need more than this digest.`;

  return { text, tools: order };
}

const digest = buildDigest(md);
const digestBytes = Buffer.byteLength(digest.text, "utf8");
if (digestBytes > DIGEST_MAX_BYTES) {
  throw new Error(
    `Tool digest is ${digestBytes} bytes (max ${DIGEST_MAX_BYTES}) — shorten the "Use it when" column in Onyx.md's Tool Compendium or lower USE_CAP.`,
  );
}

const digestOut = `// AUTO-GENERATED from /Onyx.md — DO NOT EDIT BY HAND.
// Regenerate with: bun run scripts/gen-onyx-md.ts
//
// The TOOL DIGEST — a compact (<${DIGEST_MAX_BYTES} bytes) always-injected
// block listing EVERY registered tool by exact name + one-line capability,
// derived from the "## Tool Compendium" tables in Onyx.md. This is the
// anti-hallucination companion to the full manual (onyx-md.ts / the
// /home/user/Onyx.md sandbox file): models that skip reading Onyx.md still
// know their complete tool surface, and the availability rules make
// "I don't have that tool" claims about registered tools a prompt violation.
//
// Parity with the live registry (src/lib/tools) is enforced by
// src/lib/agent/onyx-md-digest.test.ts — every registry tool must be in the
// digest and vice versa. After adding/removing/renaming a tool: update the
// Onyx.md compendium, then re-run the generator.

/** Must start with this heading — injection sites use it as the idempotency marker. */
export const ONYX_MD_DIGEST = \`${digest.text.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${")}\`;

/** Every tool name parsed from the Onyx.md compendium (digest ⇄ registry parity is test-enforced). */
export const ONYX_MD_DIGEST_TOOLS: readonly string[] = ${JSON.stringify(digest.tools)};
`;

writeFileSync(join(root, "src/lib/agent/onyx-md-digest.ts"), digestOut);
console.log(
  `Wrote src/lib/agent/onyx-md-digest.ts (${digestBytes} bytes, ${digest.tools.length} tools: ${digest.tools.join(", ")})`,
);

/**
 * Regenerate src/lib/agent/onyx-md.ts from the repo's /Onyx.md.
 *
 * Onyx.md is the agent's runtime documentation (Onyx identity + the
 * compressed tool compendium + the complete GenUI reference). The sandbox
 * route writes it to /home/user/Onyx.md so the model can `read_file` it.
 * Bundling the content as a TS module guarantees the file is available in
 * every deployment environment (Vercel serverless only traces
 * statically-analyzed imports — a runtime fs read of the repo root is NOT
 * traced).
 *
 * Run after ANY edit to Onyx.md:  bun run scripts/gen-onyx-md.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const md = readFileSync(join(root, "Onyx.md"), "utf-8");

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

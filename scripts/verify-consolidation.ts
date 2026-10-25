// Quick functional verification of the umbrella consolidation + decision tool.
// Run: bun run scripts/verify-consolidation.ts
import { listTools, getTool, hasTool } from "@/lib/tools/registry";
import "@/lib/tools/index";
import { UMBRELLA_TOOLS, resolveEffectiveToolCall } from "@/lib/agent/tool-umbrella";
import { ONYX_MD_DIGEST_TOOLS } from "@/lib/agent/onyx-md-digest";

const visible = listTools().map((t) => t.name);
console.log("VISIBLE TOOLS (" + visible.length + "):", visible.join(", "));

// 1. Digest parity: visible built-ins ⊆ digest, digest ⊆ visible
const digestSet = new Set(ONYX_MD_DIGEST_TOOLS);
const visibleNotInDigest = visible.filter((n) => !digestSet.has(n));
const digestNotVisible = ONYX_MD_DIGEST_TOOLS.filter((n) => !visible.includes(n));
console.log("\n[digest parity] visible-not-in-digest:", visibleNotInDigest, "| digest-not-visible:", digestNotVisible);

// 2. Hidden tools still registered + executable
const hiddenSample = ["read_file", "web_search", "run_python", "spawn_subagent", "media_generation"];
for (const h of hiddenSample) {
  const def = getTool(h);
  console.log(`[hidden-but-registered] ${h}: registered=${!!def} visible=${visible.includes(h)}`);
}

// 3. Umbrella dispatch — files {action:"read_file"} → granular handler validates
const files = getTool("files")!;
const r1 = await files.handler({ action: "read_file" } as never, {} as never);
console.log("\n[umbrella dispatch] files read_file no-path →", JSON.stringify(r1).slice(0, 160));
const r2 = await files.handler({ action: "bogus_action" } as never, {} as never);
console.log("[umbrella dispatch] files bogus action →", JSON.stringify(r2).slice(0, 200));

// 4. Resolver
const eff = resolveEffectiveToolCall({ id: "t1", name: "web", args: { action: "web_search", query: "hi" }, status: "completed" });
console.log("\n[resolver] web→", JSON.stringify(eff));
const same = { id: "t2", name: "ask_user", args: { questions: [] } };
console.log("[resolver] non-umbrella identity preserved:", resolveEffectiveToolCall(same) === same);

// 5. Decision tool validation
const decision = getTool("decision")!;
const d1 = await decision.handler({ state: "test state" } as never, {} as never);
console.log("\n[decision] missing queries →", JSON.stringify(d1).slice(0, 160));
const d2 = await decision.handler({
  state: "Post: I quit my job and now work 4h/day",
  queries: [
    { id: "hook", question: "What hook type?", kind: "choice", options: [
      { value: "bold_claim", description: "a big claim" }, { value: "story", description: "a narrative" },
    ]},
    { id: "good", question: "Is it good?", kind: "noul" },
    { id: "virality", question: "How viral?", kind: "score", legend: ["weak", "strong"] },
  ],
} as never, {} as never);
console.log("[decision] live call →", JSON.stringify(d2).slice(0, 400));

// 6. Total registered count (visible + hidden)
let registered = 0;
for (const [u] of Object.entries(UMBRELLA_TOOLS)) if (hasTool(u)) registered++;
console.log("\n[umbrellas registered]", registered, "of", Object.keys(UMBRELLA_TOOLS).length);

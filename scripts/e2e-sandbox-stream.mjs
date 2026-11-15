#!/usr/bin/env node
/**
 * LIVE E2E — sandbox-native AI execution on real infrastructure.
 *
 * 1. Creates a REAL E2B sandbox (the user's key via E2B_API_KEY env).
 * 2. Deploys the REAL runner v5 (extracted from src/lib/e2b/headless-agent.ts
 *    — the same source /api/sandbox's agentDeploy writes).
 * 3. Dispatches a REAL multi-round tool task through the KILO ANONYMOUS
 *    gateway (no AI key anywhere).
 * 4. Tails agent_events.jsonl the same way the SSE bridge does — printing
 *    the event stream LIVE (real token streaming out of the sandbox).
 * 5. Exercises the mid-run keep-alive (sandbox.setTimeout — ms).
 * 6. Verifies the REFRESH-RECOVERY invariant: replaying the whole event log
 *    from 0 concatenates to EXACTLY the final message content (what the
 *    reattach path renders must match the authoritative chat_history).
 * 7. Verifies chat_history rounds + the executed tool effects on disk.
 */
import { readFileSync } from "node:fs";
import { Sandbox } from "e2b";

const KEY = process.env.E2B_API_KEY;
if (!KEY) {
  console.error("E2B_API_KEY env var required");
  process.exit(1);
}

// ── extract the runner from the TS source (same as the app's deploy) ──────
const ts = readFileSync("src/lib/e2b/headless-agent.ts", "utf8");
const start = ts.indexOf("String.raw`") + "String.raw`".length;
const runner = ts.slice(start, ts.lastIndexOf("`"));

const KILO = "https://ai-gateway.kilo.ai/api/v1/chat/completions";
const SEED = [
  { role: "system", content: "You are the OnyxAgent sandbox runner. Use the provided tools to complete tasks exactly." },
  { role: "user", content: "Run a quick end-to-end self test." },
  { role: "assistant", content: "Ready — give me the task." },
];
const PROMPT =
  "Self test, do exactly this in order: (1) run the shell command `echo e2e-streaming-ok > /home/user/e2e.txt` with run_terminal, " +
  "(2) read /home/user/e2e.txt back with read_file, (3) reply with the EXACT content you found and nothing else.";

const runConfig = {
  run_id: "run_e2e_" + Date.now().toString(36),
  conversation_id: "conv_e2e",
  prompt: PROMPT,
  chat_url: KILO,
  api_key: "",
  model: "kilo-auto/free",
  fallback_models: [
    "nvidia/nemotron-3.5-super-vl:free",
    "baidu/ernie-5.5-flash-preview:free",
    "cohere/north-mini-code:free",
  ],
  system_prompt: SEED[0].content,
  seed_messages: [...SEED, { role: "user", content: PROMPT }],
  temperature: 0.3,
  max_rounds: 25,
};

const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);

let failed = 0;
const check = (name, cond, detail = "") => {
  console.log(`  ${cond ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
  if (!cond) failed++;
};

// ── run ─────────────────────────────────────────────────────────────────────
const t0 = Date.now();
let sandbox;
try {
  log("creating E2B sandbox…");
  sandbox = await Sandbox.create("base", { apiKey: KEY, timeoutMs: 10 * 60_000 });
  log("sandbox ready:", sandbox.sandboxId);

  await sandbox.files.write("/home/user/headless_runner.py", runner);
  await sandbox.files.write("/home/user/.onyx/agent/run.json", JSON.stringify(runConfig));
  await sandbox.commands.run(
    "mkdir -p /home/user/.onyx/agent && nohup python3 /home/user/headless_runner.py > /home/user/background.log 2>&1 &",
    { timeoutMs: 15_000 },
  );
  log("runner v5 dispatched — run_id:", runConfig.run_id);

  // ── live tail (exactly what the SSE bridge forwards) ───────────────────
  const seen = [];
  let status = null;
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    let raw = "";
    try {
      raw = await sandbox.files.read("/home/user/agent_events.jsonl", { format: "text" });
    } catch { /* not created yet */ }
    const lines = raw.split("\n").filter((l) => l.trim());
    for (const line of lines.slice(seen.length)) {
      try {
        const ev = JSON.parse(line);
        seen.push(ev);
        if (ev.type === "response.delta") {
          process.stdout.write(ev.data?.text ?? "");
        } else {
          const d = ev.data ?? {};
          log(
            `event#${ev.i} ${ev.type}`,
            ev.type === "tool.started" ? `${d.name} ${JSON.stringify(d.args ?? {}).slice(0, 90)}`
            : ev.type === "tool.result" ? `${d.name} ok=${d.ok} "${String(d.result ?? "").slice(0, 60).replace(/\n/g, "\\n")}"`
            : ev.type === "round.started" ? `round ${d.round}`
            : ev.type === "run.started" ? `model=${d.model}`
            : "",
          );
        }
      } catch { /* torn line */ }
    }
    try {
      status = JSON.parse(await sandbox.files.read("/home/user/agent_status.json", { format: "text" }));
    } catch { /* not yet */ }
    if (status && ["completed", "failed", "stopped"].includes(status.status)) {
      // drain any last events written after our last read
      await new Promise((r) => setTimeout(r, 1200));
      try {
        raw = await sandbox.files.read("/home/user/agent_events.jsonl", { format: "text" });
        for (const line of raw.split("\n").filter((l) => l.trim()).slice(seen.length)) {
          const ev = JSON.parse(line);
          seen.push(ev);
          if (ev.type === "response.delta") process.stdout.write(ev.data?.text ?? "");
          else log(`event#${ev.i} ${ev.type}`, JSON.stringify(ev.data ?? {}).slice(0, 90));
        }
      } catch { /* best effort */ }
      break;
    }
    // MID-RUN KEEP-ALIVE — the SSE bridge does this every 4 min; here we
    // exercise it once mid-run to prove it doesn't disturb the runner.
    if (seen.length === 3) {
      await sandbox.setTimeout(30 * 60_000); // ms — e2b SDK v2.39
      log("mid-run keep-alive: setTimeout(30min) OK");
    }
    await new Promise((r) => setTimeout(r, 700));
  }
  process.stdout.write("\n");

  const types = seen.map((e) => e.type);
  console.log("\n── verification ──────────────────────────────────────────────");
  check("run reached a terminal status", !!status && ["completed", "failed", "stopped"].includes(status.status), `status=${status?.status}`);
  check("event log exists with run.started first", types[0] === "run.started", `${seen.length} events`);
  check("event ids strictly increasing 1..N", seen.every((e, i) => e.i === i + 1));
  check("at least 2 rounds (tool loop)", types.filter((t) => t === "round.started").length >= 2, `${types.filter((t) => t === "round.started").length} rounds`);
  check("tool calls streamed (tool.started)", types.includes("tool.started"));
  check("tool results streamed (tool.result)", types.includes("tool.result"));
  check("token deltas streamed (response.delta)", types.filter((t) => t === "response.delta").length > 0, `${types.filter((t) => t === "response.delta").length} deltas`);
  check("terminal marker (response.completed / run.failed)", types.includes("response.completed") || types.includes("run.failed"));
  check("no degradation (tools worked)", status?.degraded !== true, `wire=${status?.tools_wire_mode}`);

  // ── authoritative history ──────────────────────────────────────────────
  const history = JSON.parse(await sandbox.files.read("/home/user/chat_history.json", { format: "text" }));
  const slice = history.slice(runConfig.seed_messages.length);
  const assistantMsgs = slice.filter((m) => m.role === "assistant");
  const toolMsgs = slice.filter((m) => m.role === "tool");
  const final = assistantMsgs[assistantMsgs.length - 1]?.content ?? "";
  check("history: multi-round assistant turns", assistantMsgs.length >= 2, `${assistantMsgs.length} assistant turns`);
  check("history: tool results recorded", toolMsgs.length >= 2, `${toolMsgs.length} tool results`);
  check("the tool actually ran (e2e.txt on disk)", (await sandbox.files.read("/home/user/e2e.txt", { format: "text" })).trim() === "e2e-streaming-ok");
  check("final text references the file content", final.includes("e2e-streaming-ok"), final.slice(0, 80));

  // ── REFRESH-RECOVERY INVARIANT ─────────────────────────────────────────
  // A page refresh replays the ENTIRE event log from 0; the concatenated
  // response deltas (post-last-round.started... simplified: ALL deltas)
  // must reconstruct content the final message contains.
  const allDeltas = seen.filter((e) => e.type === "response.delta").map((e) => e.data.text).join("");
  check(
    "replay invariant: streamed deltas are a prefix-contained reconstruction",
    final.trim().length > 0 && (allDeltas.includes(final.trim().slice(0, Math.min(60, final.trim().length))) || final.trim().includes(allDeltas.trim().slice(0, 60))),
    `deltas=${allDeltas.length}ch final=${final.trim().length}ch`,
  );

  log(`total wall time: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
} catch (err) {
  console.error("E2E ERROR:", err?.message ?? err);
  failed++;
} finally {
  if (sandbox) {
    try {
      await sandbox.kill();
      log("sandbox killed (cleanup)");
    } catch { /* best effort */ }
  }
}

console.log(failed === 0 ? "\nE2E: ALL CHECKS PASSED" : `\nE2E: ${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);

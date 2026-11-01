// Probe 2 — does a detached background process SURVIVE its launcher command's
// E2B timeout, and does the launcher return at all? Tests the exact kick
// shapes the app uses (with and without the script -qec PTY wrapper) plus the
// candidate fixes (setsid, </dev/null).
import { Sandbox } from "/home/z/my-project/onyxagent/node_modules/@e2b/code-interpreter/dist/index.js";

const KEY = process.env.E2B_KEY;
const t0 = Date.now();
const el = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
const log = (...a) => console.log(`[${el()}]`, ...a);

const sbx = await Sandbox.create({ apiKey: KEY, timeoutMs: 3600_000 });
log("sandbox:", sbx.sandboxId);

async function trial(name, command, timeoutMs, markerWaitMs) {
  await sbx.commands.run("rm -f /tmp/marker /tmp/bg.log").catch(() => {});
  const start = Date.now();
  let result = "returned";
  try {
    const r = await sbx.commands.run(command, { timeoutMs });
    result = `returned exit=${r.exitCode ?? 0} out=${(r.stdout || "").trim().slice(0, 60)}`;
  } catch (e) {
    result = "THREW: " + String(e).slice(0, 90);
  }
  log(`${name}: ${((Date.now() - start) / 1000).toFixed(1)}s — ${result}`);
  await new Promise((r) => setTimeout(r, markerWaitMs));
  const m = await sbx.commands.run("cat /tmp/marker 2>/dev/null; echo | cat", { timeoutMs: 15_000 }).catch(() => ({ stdout: "" }));
  log(`${name}: marker after ${markerWaitMs / 1000}s —`, (m.stdout || "").trim() || "ABSENT");
}

try {
  // The app's EXACT kick (browser-session.ts exec_stream → script PTY, 20s timeout)
  // vs a 45s background job: does the kick hang? does the job survive the kill?
  await trial(
    "PTY + nohup (app current)",
    `script -qec 'cd /tmp && nohup bash -c "sleep 45; echo survived > /tmp/marker" > /tmp/bg.log 2>&1 & echo booting' /dev/null`,
    20_000, 50_000,
  );
  // Candidate fix 1: setsid + closed stdin under the same PTY wrapper
  await trial(
    "PTY + setsid </dev/null (fix)",
    `script -qec 'cd /tmp && setsid nohup bash -c "sleep 45; echo survived > /tmp/marker" > /tmp/bg.log 2>&1 < /dev/null & echo booting' /dev/null`,
    20_000, 50_000,
  );
  // Candidate fix 2: no PTY, direct (server-side prepareBrowserRuntime shape)
  await trial(
    "direct + setsid </dev/null (fix)",
    `cd /tmp && setsid nohup bash -c "sleep 45; echo survived > /tmp/marker" > /tmp/bg.log 2>&1 < /dev/null & echo booting`,
    20_000, 50_000,
  );
} finally {
  await sbx.kill().catch(() => {});
  log("done", el());
  process.exit(0);
}

// Live E2B browser-boot probe — replicates the app's exact flow:
//   createAndCacheSandbox (no template, onTimeout pause) →
//   prepareBrowserRuntime (write driver.py + boot.sh, nohup kick) →
//   boot poll (BOOT_POLL_CMD) → navigate action round-trip.
// Prints per-phase timings + live boot.log lines so we can SEE where it sticks.
// Usage: E2B_KEY=$(cat /home/z/my-project/.secrets/e2b.key) node scripts/e2b-boot-probe.mjs [maxWaitSec]
import { Sandbox } from "/home/z/my-project/onyxagent/node_modules/@e2b/code-interpreter/dist/index.js";
import {
  BROWSER_DRIVER_PY_SOURCE,
  BROWSER_BOOT_SH_SOURCE,
  BROWSER_SANDBOX_PATHS,
} from "/home/z/my-project/onyxagent/src/lib/e2b/browser-driver.ts";

const KEY = process.env.E2B_KEY;
if (!KEY) { console.error("E2B_KEY env missing"); process.exit(1); }
const MAX_WAIT_SEC = Number(process.argv[2] || 900);
const BR = BROWSER_SANDBOX_PATHS;
const t0 = Date.now();
const el = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
const log = (...a) => console.log(`[${el()}]`, ...a);

// --- Phase A: create sandbox (app parity: 24h → 1h fallback, pause lifecycle)
let sbx;
try {
  log("creating sandbox (timeoutMs 24h)…");
  sbx = await Sandbox.create({ apiKey: KEY, timeoutMs: 24 * 3600_000, lifecycle: { onTimeout: "pause", autoResume: true } });
  log("created with 24h timeout:", sbx.sandboxId);
} catch (e) {
  log("24h create failed:", String(e).slice(0, 160));
  sbx = await Sandbox.create({ apiKey: KEY, timeoutMs: 3600_000, lifecycle: { onTimeout: "pause", autoResume: true } });
  log("created with 1h fallback:", sbx.sandboxId);
}

try {
  // quick environment diagnostics
  const diag = await sbx.commands.run(
    `python3 -V; python3 -m pip --version; df -h / | tail -1; free -m | head -2; curl -s -o /dev/null -w "pypi_http=%{http_code} t=%{time_total}s\\n" https://pypi.org/simple/cloakbrowser/`,
    { timeoutMs: 30_000 });
  log("env diag:\n" + (diag.stdout || "").trim());

  // --- Phase B: prepareBrowserRuntime replica
  for (const [label, step] of [
    ["makeDir", () => sbx.files.makeDir(BR.dir)],
    ["write driver.py", () => sbx.files.write(BR.driver, BROWSER_DRIVER_PY_SOURCE)],
    ["write boot.sh", () => sbx.files.write(BR.bootSh, BROWSER_BOOT_SH_SOURCE)],
  ]) {
    try { await step(); log(label, "ok"); }
    catch (e) { log(label, "FAILED:", String(e).slice(0, 300)); }
  }
  let kicked = false;
  try {
    const kick = await sbx.commands.run(
      `cd ${BR.dir} && nohup bash boot.sh > ${BR.bootLog} 2>&1 & echo browser_boot_kicked`,
      { timeoutMs: 15_000 });
    log("boot kicked:", (kick.stdout || "").trim());
    kicked = (kick.stdout || "").includes("browser_boot_kicked");
  } catch (e) { log("boot kick FAILED:", String(e).slice(0, 300)); }
  if (!kicked) log("WARNING: boot may not have started — continuing to poll anyway");

  // --- Phase C: poll boot state (same command the client uses)
  const BOOT_POLL_CMD = [
    `if [ -f ${BR.bootFailed} ]; then echo "BOOT_FAILED"`,
    `sed -n '1,60p' ${BR.bootFailed}`,
    `elif test -f ${BR.ready} && pgrep -f "[d]river.py" >/dev/null 2>&1; then echo "READY"`,
    `else tail -n 1 ${BR.bootLog} 2>/dev/null; true; fi`,
  ].join("; ");
  let lastLine = "";
  let ready = false;
  const deadline = Date.now() + MAX_WAIT_SEC * 1000;
  while (Date.now() < deadline) {
    const r = await sbx.commands.run(BOOT_POLL_CMD, { timeoutMs: 30_000 }).catch((e) => ({ stdout: "POLL_ERROR: " + String(e).slice(0, 120) }));
    const out = (r.stdout || "").trim();
    if (out.startsWith("BOOT_FAILED")) {
      log("BOOT FAILED:\n" + out.slice(0, 1500));
      break;
    }
    if (out === "READY") { ready = true; log("DRIVER READY"); break; }
    if (out && out !== lastLine) { lastLine = out; log("boot>", out.slice(0, 300)); }
    await new Promise((res) => setTimeout(res, 2500));
  }

  if (ready) {
    // --- Phase D: navigate action round-trip through the file protocol
    const id = "p" + Date.now().toString(36);
    await sbx.files.write(BR.cmd, JSON.stringify({ id, action: "navigate", url: "https://example.com" }));
    const resPath = `${BR.dir}/res-${id}.json`;
    const actionDeadline = Date.now() + 90_000;
    let res = null;
    while (Date.now() < actionDeadline) {
      try {
        const raw = await sbx.files.read(resPath);
        if (raw && raw.trim()) { res = JSON.parse(raw); break; }
      } catch { /* not yet */ }
      await new Promise((r) => setTimeout(r, 500));
    }
    log("navigate result:", res ? JSON.stringify(res).slice(0, 600) : "NO RESULT within 90s");
    const evts = await sbx.commands.run(`cat ${BR.dir}/events.jsonl 2>/dev/null | tail -5`, { timeoutMs: 15_000 }).catch(() => ({ stdout: "" }));
    log("events tail:\n" + (evts.stdout || "").trim());
  } else if (Date.now() >= deadline) {
    log("TIMED OUT waiting for boot");
    const bl = await sbx.commands.run(`tail -30 ${BR.bootLog} 2>/dev/null; echo ---INSTALL---; tail -20 ${BR.installLog} 2>/dev/null; echo ---PROCS---; ps aux | grep -E "pip|driver.py|cloak|playwright|chrom" | grep -v grep | head -10`, { timeoutMs: 30_000 }).catch(() => ({ stdout: "" }));
    log("diagnostics:\n" + (bl.stdout || "").trim().slice(0, 2500));
  }
} catch (fatal) {
  log("FATAL:", String(fatal && fatal.stack || fatal).slice(0, 1200));
} finally {
  log("killing sandbox…");
  await sbx.kill().catch(() => {});
  log("done. total:", el());
  process.exit(0);
}

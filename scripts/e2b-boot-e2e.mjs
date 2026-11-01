// Probe 4 — END-TO-END validation of the fix through the app's REAL transport
// shape: the boot kick runs inside the `script -qec '…' /dev/null` PTY (exactly
// what /api/sandbox exec_stream does) using the NEW buildDetachedSpawnCommand.
// Success criteria: kick returns promptly with "booting"; boot.sh SURVIVES the
// command's completion (the old nohup kick was killed here); .ready appears;
// a navigate action round-trips with structured output.
import { Sandbox } from "/home/z/my-project/onyxagent/node_modules/@e2b/code-interpreter/dist/index.js";
import {
  BROWSER_DRIVER_PY_SOURCE,
  BROWSER_BOOT_SH_SOURCE,
  BROWSER_SANDBOX_PATHS,
  buildDetachedSpawnCommand,
} from "/home/z/my-project/onyxagent/src/lib/e2b/browser-driver.ts";

const KEY = process.env.E2B_KEY;
const t0 = Date.now();
const el = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
const log = (...a) => console.log(`[${el()}]`, ...a);
const BR = BROWSER_SANDBOX_PATHS;

const sbx = await Sandbox.create({ apiKey: KEY, timeoutMs: 3600_000 });
log("sandbox:", sbx.sandboxId);

// Shell-escape for the PTY wrapper (mirrors the route's exec_stream escape).
const ptyWrap = (cmd) => `script -qec '${cmd.replace(/'/g, "'\\''")}' /dev/null`;

try {
  await sbx.files.makeDir(BR.dir);
  await sbx.files.write(BR.driver, BROWSER_DRIVER_PY_SOURCE);
  await sbx.files.write(BR.bootSh, BROWSER_BOOT_SH_SOURCE);

  // THE FIX UNDER TEST: kick through the PTY with the detached-spawn launcher.
  const kickCmd = buildDetachedSpawnCommand({ cwd: BR.dir, argv: ["bash", "boot.sh"], logPath: BR.bootLog }) + " && echo booting";
  const kickStart = Date.now();
  const kick = await sbx.commands.run(ptyWrap(kickCmd), { timeoutMs: 20_000 });
  log(`kick through PTY returned in ${((Date.now() - kickStart) / 1000).toFixed(1)}s — out=${(kick.stdout || "").trim()}`);
  if (!(kick.stdout || "").includes("booting")) throw new Error("kick did not echo booting");

  // Poll the boot (the client's BOOT_POLL_CMD) — boot.sh must be ALIVE.
  const BOOT_POLL_CMD = [
    `if [ -f ${BR.bootFailed} ]; then echo "BOOT_FAILED"`,
    `sed -n '1,60p' ${BR.bootFailed}`,
    `elif test -f ${BR.ready} && pgrep -f "[d]river.py" >/dev/null 2>&1; then echo "READY"`,
    `else tail -n 1 ${BR.bootLog} 2>/dev/null; true; fi`,
  ].join("; ");
  let last = "", ready = false;
  const deadline = Date.now() + 600_000;
  while (Date.now() < deadline) {
    const r = await sbx.commands.run(ptyWrap(BOOT_POLL_CMD), { timeoutMs: 30_000 }).catch((e) => ({ stdout: "POLL_ERR " + String(e).slice(0, 80) }));
    const out = (r.stdout || "").trim();
    if (out.startsWith("BOOT_FAILED")) { log("BOOT FAILED:\n" + out.slice(0, 1200)); break; }
    if (out === "READY") { ready = true; log("DRIVER READY ✓ (boot survived the PTY kick — the fix works)"); break; }
    if (out && out !== last) { last = out; log("boot>", out.slice(0, 240)); }
    await new Promise((res) => setTimeout(res, 2500));
  }

  if (ready) {
    // Navigate action through the file protocol (as use_browser does).
    const id = "n" + Date.now().toString(36);
    await sbx.files.write(BR.cmd, JSON.stringify({ id, action: "navigate", url: "https://example.com" }));
    let res = null;
    const actionDeadline = Date.now() + 90_000;
    while (Date.now() < actionDeadline) {
      try {
        const raw = await sbx.files.read(`${BR.dir}/res-${id}.json`);
        if (raw && raw.trim()) { res = JSON.parse(raw); break; }
      } catch { /* not yet */ }
      await new Promise((r) => setTimeout(r, 400));
    }
    log("navigate:", res ? JSON.stringify({ success: res.success, title: res.title, url: res.url, output: res.output, durationMs: res.durationMs }) : "NO RESULT in 90s");
    // And the driver process is a live, reparented daemon:
    const ps = await sbx.commands.run(ptyWrap(`ps -o pid,ppid,sid,cmd -p $(pgrep -f "[d]river.py" | head -1) 2>/dev/null; pgrep -f "[d]river.py" | wc -l`), { timeoutMs: 15_000 }).catch(() => ({ stdout: "" }));
    log("driver proc:\n" + (ps.stdout || "").trim());
  }
} catch (e) {
  log("FATAL:", String(e && e.stack || e).slice(0, 900));
} finally {
  await sbx.kill().catch(() => {});
  log("done", el());
  process.exit(0);
}

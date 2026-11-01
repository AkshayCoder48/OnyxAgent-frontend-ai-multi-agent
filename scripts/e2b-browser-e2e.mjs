/**
 * E2E live probe — the browser tool's REAL failure modes, on a REAL E2B
 * sandbox, with the REAL driver source. Key comes from process.env
 * (never hardcoded, never logged).
 *
 * Phases (each idempotent, state under /home/z/.onyx-e2e/ in the sandbox):
 *   boot   — cold boot via boot.sh (pip + ~200MB binaries, narrated)
 *   fast   — navigate example.com, must settle in SECONDS
 *   stuck  — evaluate while(true){} — the watchdog must settle it (~75s)
 *   double — launch a second driver.py — the flock must exit it instantly
 *   log    — dump driver.log tail
 *
 * Usage: E2B_API_KEY=... node scripts/e2b-browser-e2e.mjs <phase> [sandboxId]
 */
import { Sandbox } from "e2b";
import { readFileSync } from "node:fs";

const BR = "/home/user/.onyx/browser";
const KEY = process.env.E2B_API_KEY;
if (!KEY) {
  console.error("E2B_API_KEY env var is required");
  process.exit(1);
}

// Extract the two embedded sources from the TS module without a TS loader:
// naive but sufficient — both are unique template literals in one file.
const drvSrc = readFileSync("src/lib/e2b/browser-driver.ts", "utf8");
const sesSrc = readFileSync("src/lib/e2b/browser-session.ts", "utf8");
const pySrc = drvSrc.split("export const BROWSER_DRIVER_PY_SOURCE = String.raw`")[1].split("`;")[0];
const bootSrc = sesSrc
  .split("const BOOT_SH_SOURCE = `")[1]
  .split("`;")[0]
  .replaceAll("\\$", "$");

const phase = process.argv[2] ?? "boot";
const knownId = process.argv[3];
let sbx = knownId ? await Sandbox.connect(knownId, { apiKey: KEY }) : null;

async function sh(cmd, timeoutSec = 60) {
  const r = await sbx.commands.run(cmd, { timeoutMs: timeoutSec * 1000 });
  return { exit: r.exitCode, out: (r.stdout || "") + (r.stderr || "") };
}

function stamp(t0, label) {
  console.log(`  [${((Date.now() - t0) / 1000).toFixed(1)}s] ${label}`);
}

// ── phase: boot ────────────────────────────────────────────────────────────
if (phase === "boot") {
  const t0 = Date.now();
  if (!sbx) sbx = await Sandbox.create({ apiKey: KEY, timeoutMs: 60 * 60 * 1000 });
  console.log("sandbox:", sbx.sandboxId);
  await sh(`mkdir -p ${BR}/shots ${BR}/profile /home/user/downloads`);
  await sbx.files.write(`${BR}/driver.py`, pySrc);
  await sbx.files.write(`${BR}/boot.sh`, bootSrc);
  await sh(`rm -f ${BR}/.ready ${BR}/.boot-failed ${BR}/boot.log ${BR}/.heartbeat`);
  stamp(t0, "driver.py + boot.sh deployed — launching detached boot");
  await sh(`cd ${BR} && nohup bash boot.sh > boot.log 2>&1 & echo launched`, 30);
  // Poll like the session manager does.
  const deadline = Date.now() + 1000 * 60 * 9;
  let last = "";
  while (Date.now() < deadline) {
    const r = await sh(
      `if [ -f ${BR}/.boot-failed ]; then echo BOOT_FAILED; cat ${BR}/.boot-failed; ` +
        `elif test -f ${BR}/.ready && pgrep -f "[d]river.py" >/dev/null; then echo READY; ` +
        `else tail -n 1 ${BR}/boot.log 2>/dev/null; true; fi`,
      30,
    );
    const out = r.out.trim();
    if (out.startsWith("BOOT_FAILED")) {
      console.log("BOOT FAILED:\n" + out.slice(2000));
      process.exit(2);
    }
    if (out === "READY") {
      stamp(t0, "BOOT READY (browser prebooted)");
      const hb = await sh(`stat -c %Y ${BR}/.heartbeat; cat ${BR}/.version; grep -c . ${BR}/boot.log`, 15);
      console.log("  heartbeat/version/bootlog-lines:", hb.out.replace(/\n/g, " | "));
      console.log("SANDBOX_ID=" + sbx.sandboxId);
      process.exit(0);
    }
    if (out && out !== last) {
      last = out;
      stamp(t0, out.slice(0, 110));
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.log("BOOT TIMEOUT — last boot.log:");
  console.log((await sh(`tail -n 25 ${BR}/boot.log; tail -n 10 ${BR}/boot-install.log 2>/dev/null`, 20)).out);
  process.exit(3);
}

// Shared: one command round-trip (same file protocol as the session manager).
async function cmd(action, extra = {}, timeoutSec = 120) {
  const id = "e" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  await sbx.files.write(`${BR}/cmd.json`, JSON.stringify({ id, action, ...extra }));
  const deadline = Date.now() + timeoutSec * 1000;
  while (Date.now() < deadline) {
    const r = await sh(`cat ${BR}/res-${id}.json 2>/dev/null || echo NONE`, 15);
    if (r.out.trim() !== "NONE") {
      await sh(`rm -f ${BR}/res-${id}.json`, 10);
      return JSON.parse(r.out.trim());
    }
    await new Promise((res) => setTimeout(res, 700));
  }
  return null;
}

// ── phase: fast (navigate must settle in seconds) ─────────────────────────
if (phase === "fast") {
  const t0 = Date.now();
  for (const url of ["https://example.com", "https://httpbin.org/html"]) {
    const r = await cmd("navigate", { url }, 150);
    stamp(t0, `navigate ${url} → ${r ? (r.success ? "OK" : "ERR " + r.error?.type) : "NO REPLY"}`);
    if (r?.success) console.log(`    title=${JSON.stringify(r.title ?? "")} status=${r.status ?? "?"}`);
    if (r?.error) console.log("    msg:", String(r.error.message).slice(0, 160));
  }
  const rd = await cmd("read", {}, 60);
  stamp(t0, `read → ${rd?.success ? "OK (" + String(rd.text ?? "").length + " chars)" : "ERR"}`);
  process.exit(0);
}

// ── phase: stuck (watchdog must settle an infinite loop) ──────────────────
if (phase === "stuck") {
  const t0 = Date.now();
  console.log("sending evaluate while(true){} — the watchdog must settle it…");
  const r = await cmd("evaluate", { code: "var t=Date.now(); while(Date.now()-t < 600000){}" }, 180);
  stamp(t0, `evaluate → ${r ? JSON.stringify(r.success) + " / " + (r.error?.type ?? "no-error") : "NO REPLY (BAD)"}`);
  if (r?.error) console.log("    msg:", String(r.error.message).slice(0, 200));
  // The driver must STILL be alive, and the next command must self-heal.
  const hb = await sh(`pgrep -f "[d]river.py" >/dev/null && echo DRIVER_UP || echo DRIVER_DEAD; stat -c %Y ${BR}/.heartbeat`, 15);
  stamp(t0, "driver after watchdog: " + hb.out.replace(/\n/g, " "));
  const nav = await cmd("navigate", { url: "https://example.com" }, 150);
  stamp(t0, `navigate after watchdog → ${nav ? (nav.success ? "OK (self-healed)" : "ERR " + nav.error?.type) : "NO REPLY (BAD)"}`);
  process.exit(0);
}

// ── phase: double (a second driver must exit via flock) ───────────────────
if (phase === "double") {
  const t0 = Date.now();
  const r = await sh(`cd ${BR} && timeout 15 python3 driver.py; echo "exit=$?"`, 30);
  stamp(t0, "second driver run → " + r.out.trim().replace(/\n/g, " | ").slice(0, 200));
  const n = await sh(`pgrep -f "[d]river.py" | wc -l`, 15);
  stamp(t0, "driver processes alive: " + n.out.trim());
  const nav = await cmd("navigate", { url: "https://example.com" }, 150);
  stamp(t0, `navigate after double-boot attempt → ${nav ? (nav.success ? "OK" : "ERR " + nav.error?.type) : "NO REPLY (BAD)"}`);
  process.exit(0);
}

// ── phase: log ─────────────────────────────────────────────────────────────
if (phase === "log") {
  console.log((await sh(`tail -n 40 ${BR}/driver.log 2>/dev/null`, 20)).out);
  process.exit(0);
}

console.error("unknown phase:", phase);
process.exit(1);

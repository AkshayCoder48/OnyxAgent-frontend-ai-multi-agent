// Probe 6 — run the EXACT liveness + boot-poll commands against a live sandbox
// through BOTH transports (direct commands.run AND the script -qec PTY wrapper
// that /api/sandbox exec_stream uses) to find why the poll never sees READY.
import { Sandbox } from "/home/z/my-project/onyxagent/node_modules/@e2b/code-interpreter/dist/index.js";
const KEY = process.env.E2B_KEY;
const ID = process.argv[2];
const sbx = await Sandbox.connect(ID, { apiKey: KEY });
const ptyWrap = (cmd) => `script -qec '${cmd.replace(/'/g, "'\\''")}' /dev/null`;

const LIVENESS = `test -f /home/user/.onyx/browser/.ready && pgrep -f "[d]river.py" >/dev/null && echo READY || echo NO`;
const POLL = [
  `if [ -f /home/user/.onyx/browser/.boot-failed ]; then echo "BOOT_FAILED"`,
  `sed -n '1,60p' /home/user/.onyx/browser/.boot-failed`,
  `elif test -f /home/user/.onyx/browser/.ready && pgrep -f "[d]river.py" >/dev/null 2>&1; then echo "READY"`,
  `else tail -n 1 /home/user/.onyx/browser/boot.log 2>/dev/null; true; fi`,
].join("; ");

for (const [label, cmd] of [["LIVENESS", LIVENESS], ["BOOT_POLL", POLL]]) {
  for (const [t, wrap] of [["direct", (c) => c], ["pty", ptyWrap]]) {
    const r = await sbx.commands.run(wrap(cmd), { timeoutMs: 30_000 }).catch((e) => ({ stdout: "THREW: " + String(e).slice(0, 100), stderr: "" }));
    console.log(`[${label} via ${t}] exit=${r.exitCode ?? "?"} out=${JSON.stringify((r.stdout || "").slice(0, 120))} err=${(r.stderr || "").slice(0, 60)}`);
  }
}
// pgrep detail: what does pgrep actually see?
const pg = await sbx.commands.run(`pgrep -af "[d]river.py"; echo "exit=$?"; pgrep -c -f driver.py || true`, { timeoutMs: 15_000 });
console.log("pgrep -af:", (pg.stdout || "").trim().slice(0, 300));
process.exit(0);

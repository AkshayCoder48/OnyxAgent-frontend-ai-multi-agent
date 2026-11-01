// Probe 3 — WHICH detach pattern survives E2B's post-command cleanup while
// still letting the launcher command return promptly? All launched through
// the app's real transport shape (script -qec PTY, like exec_stream).
import { Sandbox } from "/home/z/my-project/onyxagent/node_modules/@e2b/code-interpreter/dist/index.js";

const KEY = process.env.E2B_KEY;
const t0 = Date.now();
const el = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
const log = (...a) => console.log(`[${el()}]`, ...a);

const sbx = await Sandbox.create({ apiKey: KEY, timeoutMs: 3600_000 });
log("sandbox:", sbx.sandboxId);

const tooling = await sbx.commands.run(
  `command -v setsid; command -v at; command -v systemd-run; command -v crontab; ls /sbin/atd /usr/sbin/atd 2>/dev/null; ps -p 1 -o comm=`,
  { timeoutMs: 15_000 });
log("tooling:\n" + (tooling.stdout || "").trim());

const SLEEP = 40; // background job lifetime per trial

const trials = [
  ["baseline-nohup", `cd /tmp && nohup bash -c "sleep ${SLEEP}; echo survived > /tmp/m-baseline" > /tmp/l-baseline.log 2>&1 & echo go`],
  ["setsid-nostdin", `cd /tmp && setsid nohup bash -c "sleep ${SLEEP}; echo survived > /tmp/m-setsid" > /tmp/l-setsid.log 2>&1 < /dev/null & echo go`],
  ["py-daemon", `cd /tmp && python3 -c "import subprocess; subprocess.Popen(['bash','-c','sleep ${SLEEP}; echo survived > /tmp/m-py'], stdin=subprocess.DEVNULL, stdout=open('/tmp/l-py.log','ab'), stderr=subprocess.STDOUT, start_new_session=True)" && echo go`],
  ["subshell-disown", `cd /tmp && ( nohup bash -c "sleep ${SLEEP}; echo survived > /tmp/m-sub" > /tmp/l-sub.log 2>&1 < /dev/null & disown ) ; echo go`],
  ["trap-shield", `cd /tmp && nohup bash -c 'trap "" HUP TERM INT; sleep ${SLEEP}; echo survived > /tmp/m-trap' > /tmp/l-trap.log 2>&1 < /dev/null & echo go`],
];

const launched = [];
for (const [name, inner] of trials) {
  const marker = `/tmp/m-${name.replace(/-/g, "")}`; // not used; marker is inside cmd
  await sbx.commands.run(`rm -f /tmp/m-*`).catch(() => {});
  const start = Date.now();
  let outcome;
  try {
    const r = await sbx.commands.run(`script -qec '${inner.replace(/'/g, "'\\''")}' /dev/null`, { timeoutMs: 12_000 });
    outcome = `exit=${r.exitCode ?? 0} out=${(r.stdout || "").trim().slice(0, 40)}`;
  } catch (e) {
    outcome = "THREW " + String(e).slice(0, 60);
  }
  log(`launch ${name}: ${((Date.now() - start) / 1000).toFixed(1)}s — ${outcome}`);
  launched.push(name);
}

log(`waiting ${SLEEP + 5}s for markers…`);
await new Promise((r) => setTimeout(r, (SLEEP + 5) * 1000));
const check = await sbx.commands.run(`ls -la /tmp/m-* 2>/dev/null; echo ---; for f in /tmp/m-*; do echo "$f: $(cat $f 2>/dev/null)"; done`, { timeoutMs: 15_000 }).catch(() => ({ stdout: "CHECK FAILED" }));
log("markers:\n" + (check.stdout || "").trim());

await sbx.kill().catch(() => {});
log("done", el());
process.exit(0);

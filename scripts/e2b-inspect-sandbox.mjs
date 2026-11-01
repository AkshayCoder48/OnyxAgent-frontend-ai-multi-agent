// Probe 5 — inspect a LIVE sandbox's browser state (why didn't it boot?).
import { Sandbox } from "/home/z/my-project/onyxagent/node_modules/@e2b/code-interpreter/dist/index.js";
const KEY = process.env.E2B_KEY;
const ID = process.argv[2];
const sbx = await Sandbox.connect(ID, { apiKey: KEY });
console.log("connected:", sbx.sandboxId);
const r = await sbx.commands.run(
  `cd /home/user/.onyx/browser 2>/dev/null || { echo NO_DIR; exit 0; }
   echo "--- files:"; ls -la | head -20
   echo "--- .ready:"; cat .ready 2>/dev/null || echo MISSING
   echo "--- .version:"; cat .version 2>/dev/null || echo MISSING
   echo "--- .boot-failed:"; cat .boot-failed 2>/dev/null | head -8 || echo MISSING
   echo "--- boot.log tail:"; tail -12 boot.log 2>/dev/null || echo MISSING
   echo "--- install log tail:"; tail -6 boot-install.log 2>/dev/null || echo MISSING
   echo "--- procs:"; ps aux | grep -E "[d]river.py|[b]oot.sh|[c]hrom|[p]ip" | head -8 || echo NONE
   echo "--- runtime import:"; python3 -c "import cloakbrowser, playwright; print('RUNTIME_PRESENT')" 2>&1 | tail -2
   echo "--- events:"; tail -8 events.jsonl 2>/dev/null || echo MISSING`,
  { timeoutMs: 60_000 });
console.log(r.stdout || r.stderr);
await sbx.kill().catch(() => {});
process.exit(0);

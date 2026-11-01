// Probe 7 — drive the APP'S OWN transport (/api/sandbox exec_stream) exactly
// like E2BClient.runCommandStream does, running the browser-session probe
// commands against the live sandbox. Prints the raw SSE frames so we can see
// EXACTLY what the client receives for driverAlive / BOOT_POLL.
const BASE = "http://localhost:3000/api/sandbox";
const KEY = process.env.E2B_KEY;
const SANDBOX_ID = process.argv[2]; // the client's stored sandbox id

const LIVENESS = `test -f /home/user/.onyx/browser/.ready && pgrep -f "[d]river.py" >/dev/null && echo READY || echo NO`;
const POLL = [
  `if [ -f /home/user/.onyx/browser/.boot-failed ]; then echo "BOOT_FAILED"`,
  `sed -n '1,60p' /home/user/.onyx/browser/.boot-failed`,
  `elif test -f /home/user/.onyx/browser/.ready && pgrep -f "[d]river.py" >/dev/null 2>&1; then echo "READY"`,
  `else tail -n 1 /home/user/.onyx/browser/boot.log 2>/dev/null; true; fi`,
].join("; ");

async function execStream(command, label) {
  const t0 = Date.now();
  const res = await fetch(BASE, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify({
      apiKey: KEY,
      action: "exec_stream",
      args: { command, cwd: "/home/user", timeout: 30 },
      conversationId: null,
      sandboxMode: "shared",
      sandboxId: SANDBOX_ID,
    }),
  });
  const frames = [];
  if (!res.ok || !res.body) {
    console.log(`[${label}] HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
    return;
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const ev = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const data = ev.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
      if (data) frames.push(data);
    }
  }
  console.log(`[${label}] ${(Date.now() - t0) / 1000}s frames:`, JSON.stringify(frames).slice(0, 400));
}

await execStream(LIVENESS, "driverAlive probe");
await execStream(POLL, "boot poll");
await execStream(`echo transport_ok`, "sanity echo");
process.exit(0);

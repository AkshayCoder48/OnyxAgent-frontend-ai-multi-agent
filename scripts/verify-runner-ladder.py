#!/usr/bin/env python3
"""Verify the headless runner's streaming + gateway-compatibility ladder end-to-end.

Runs the REAL runner (extracted from src/lib/e2b/headless-agent.ts — the same
source the app deploys) against a scripted mock chat-completions gateway.

Modes (MODE env var):
  normal         — SSE streaming gateway that accepts tools + tool_choice
                   EXPECT: full multi-round run, response.delta events in
                   agent_events.jsonl, run.started/response.completed markers.
  tool_choice    — 400s any request carrying tool_choice (tools OK)
                   EXPECT: ladder rung saves the run — multi-round with tools.
  tools          — 400s any request carrying the tools param
                   EXPECT: LOUD degradation — one text round, degraded=true,
                   visible note in the final content.
  stream_reject  — 400 (message mentions "stream") whenever stream:true
                   EXPECT: runner flips to non-streaming, full multi-round
                   with tools still works (per-round instead of per-token).
  model_missing  — 404 "does not exist" for the configured model
                   EXPECT: rung 0 rotates to fallback_models[0], full
                   multi-round with tools.
"""
import json, os, pathlib, shutil, subprocess, sys, tempfile, threading, time
from collections import Counter
from http.server import BaseHTTPRequestHandler, HTTPServer

MODE = os.environ.get("MODE", "normal")
assert MODE in ("normal", "tool_choice", "tools", "stream_reject", "model_missing"), f"bad MODE {MODE!r}"

REPO = pathlib.Path(__file__).resolve().parent.parent
SRC = REPO / "src/lib/e2b/headless-agent.ts"
WORK = pathlib.Path(tempfile.mkdtemp(prefix="onyx-runner-"))
home = WORK / "home"
(home / ".onyx" / "agent").mkdir(parents=True)

# ── extract the runner (same source the sandbox gets) ───────────────────────
text = SRC.read_text()
start = text.index("String.raw`") + len("String.raw`")
script = text[start : text.rindex("`")]
runner_py = WORK / "headless_runner.py"
runner_py.write_text(script.replace('HOME = "/home/user"', f"HOME = {str(home)!r}", 1))

# ── scripted rounds (OpenAI message shapes) ─────────────────────────────────
STATE = {"n": 0}
ROUNDS = [
    {"content": "", "tool_calls": [{"id": "call_r1", "name": "run_terminal", "arguments": {"command": "echo round-one"}}]},
    {"content": "Working — creating the files now.",
     "tool_calls": [
         {"id": "call_r2a", "name": "create_file", "arguments": {"path": "out/a.txt", "content": "A"}},
         {"id": "call_r2b", "name": "read_file", "arguments": {"path": "out/a.txt"}},
     ]},
    {"content": "All done — 3 tool calls executed over 3 rounds.", "tool_calls": []},
]
TEXT_ONLY = "text-only answer (tools were rejected)"


def sse_body(round_msg):
    """Render one scripted round as OpenAI SSE chunks (content + tool_calls)."""
    chunks = [{"choices": [{"index": 0, "delta": {"role": "assistant"}, "finish_reason": None}]}]
    for i in range(0, len(round_msg["content"]), 7):
        chunks.append({"choices": [{"index": 0, "delta": {"content": round_msg["content"][i:i+7]}, "finish_reason": None}]})
    for tci, tc in enumerate(round_msg["tool_calls"]):
        chunks.append({"choices": [{"index": 0, "delta": {"tool_calls": [{"index": tci, "id": tc["id"], "type": "function", "function": {"name": tc["name"], "arguments": ""}}]}, "finish_reason": None}]})
        args = json.dumps(tc["arguments"])
        for i in range(0, len(args), 9):
            chunks.append({"choices": [{"index": 0, "delta": {"tool_calls": [{"index": tci, "function": {"arguments": args[i:i+9]}}]}, "finish_reason": None}]})
    finish = "tool_calls" if round_msg["tool_calls"] else "stop"
    chunks.append({"choices": [{"index": 0, "delta": {}, "finish_reason": finish}]})
    out = []
    for c in chunks:
        out.append("data: " + json.dumps(c) + "\n\n")
        time.sleep(0.02)
    out.append("data: [DONE]\n\n")
    return "".join(out).encode()


def json_body(round_msg):
    message = {"role": "assistant", "content": round_msg["content"]}
    if round_msg["tool_calls"]:
        message["tool_calls"] = [
            {"id": tc["id"], "type": "function", "function": {"name": tc["name"], "arguments": json.dumps(tc["arguments"])}}
            for tc in round_msg["tool_calls"]
        ]
    return json.dumps({"choices": [{"message": message, "finish_reason": "tool_calls" if round_msg["tool_calls"] else "stop"}]}).encode()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        has_tools = bool(body.get("tools"))
        has_tc = "tool_choice" in body
        wants_stream = bool(body.get("stream"))
        model = body.get("model") or ""

        def reject(code, message):
            msg = json.dumps({"error": {"message": message}}).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(msg)))
            self.end_headers()
            self.wfile.write(msg)

        if MODE == "tools" and has_tools:
            return reject(400, f"mock gateway rejects this param (mode={MODE})")
        if MODE == "tool_choice" and has_tc:
            return reject(400, f"mock gateway rejects this param (mode={MODE})")
        if MODE == "stream_reject" and wants_stream:
            return reject(400, "the stream parameter is not supported by this mock gateway")
        if MODE == "model_missing" and model == "test-model":
            return reject(404, "The requested model 'test-model' does not exist. Use an exact model id.")

        if not has_tools:
            msg = {"content": TEXT_ONLY, "tool_calls": []}
            if wants_stream:
                data = sse_body(msg)
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
            else:
                payload = json_body(msg)
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
            return

        rnd = ROUNDS[min(STATE["n"], len(ROUNDS) - 1)]
        STATE["n"] += 1
        if wants_stream:
            data = sse_body(rnd)
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        else:
            payload = json_body(rnd)
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)


server = HTTPServer(("127.0.0.1", 0), Handler)
port = server.server_address[1]
threading.Thread(target=server.serve_forever, daemon=True).start()

# ── run.json mirroring the app dispatch shape ───────────────────────────────
seed = [
    {"role": "system", "content": "You are the sandbox runner."},
    {"role": "user", "content": "earlier question"},
    {"role": "assistant", "content": "earlier answer"},
    {"role": "user", "content": "Do the multi-round task."},
]
(home / ".onyx" / "agent" / "run.json").write_text(json.dumps({
    "run_id": "run_test123", "conversation_id": "conv1",
    "prompt": "Do the multi-round task.",
    "chat_url": f"http://127.0.0.1:{port}/v1/chat/completions",
    "api_key": "", "model": "test-model",
    "fallback_models": ["fallback-model-a", "fallback-model-b"],
    "system_prompt": "You are the sandbox runner.",
    "seed_messages": seed, "temperature": 0.7, "max_rounds": 400,
}))

proc = subprocess.Popen([sys.executable, str(runner_py)], cwd=str(home),
                        env={**os.environ, "HOME": str(home)},
                        stdout=open(WORK / "launch.log", "w"), stderr=subprocess.STDOUT,
                        start_new_session=True)
code = proc.wait(timeout=180)

hist_path = next(home.rglob("chat_history.json"), None)
status_path = next(home.rglob("agent_status.json"), None)
events_path = next(home.rglob("agent_events.jsonl"), None)
history = json.loads(hist_path.read_text()) if hist_path else []
status = json.loads(status_path.read_text()) if status_path else {}

new_slice = history[len(seed):]
assistant_rounds = [m for m in new_slice if m.get("role") == "assistant"]
tool_calls = sum(len(m.get("tool_calls") or []) for m in assistant_rounds)
final_content = (assistant_rounds[-1].get("content") if assistant_rounds else "") or ""
log_text = (WORK / "launch.log").read_text()

# ── event log inspection ─────────────────────────────────────────────────────
events = []
if events_path and events_path.exists():
    for line in events_path.read_text().splitlines():
        if line.strip():
            try:
                events.append(json.loads(line))
            except Exception:
                pass
counts = Counter(e.get("type") for e in events)
ids_ok = all(e.get("i") == n + 1 for n, e in enumerate(events))

print(f"mode={MODE} exit={code} status={status.get('status')} degraded={status.get('degraded')} "
      f"wire={status.get('tools_wire_mode')} rounds={len(assistant_rounds)} tool_calls={tool_calls} "
      f"events={len(events)} ids_ok={ids_ok}")
print(f"  event counts: {dict(counts)}")
for line in log_text.splitlines():
    if "gateway" in line or "DEGRADING" in line or "rejected" in line or "switching to fallback" in line or "falling back" in line:
        print("  log:", line)
if status.get("degraded"):
    print("  final content tail:", final_content[-180:])

expectations = {
    "normal":        dict(status="completed", degraded=False, wire="full", rounds=3, tools=3, deltas=True),
    "tool_choice":   dict(status="completed", degraded=False, wire="tools", rounds=3, tools=3, deltas=True),
    "tools":         dict(status="completed", degraded=True,  wire="text", rounds=1, tools=0, deltas=True),
    "stream_reject": dict(status="completed", degraded=False, wire="full", rounds=3, tools=3, deltas=False),
    "model_missing": dict(status="completed", degraded=False, wire="full", rounds=3, tools=3, deltas=True),
}[MODE]

ok = (
    status.get("status") == expectations["status"]
    and status.get("degraded") == expectations["degraded"]
    and status.get("tools_wire_mode") == expectations["wire"]
    and len(assistant_rounds) == expectations["rounds"]
    and tool_calls == expectations["tools"]
    and (not status.get("degraded") or "gateway rejected tool calls" in final_content)
    and counts.get("run.started") == 1
    and counts.get("round.started") == expectations["rounds"]
    and counts.get("response.completed", 0) + counts.get("run.failed", 0) == 1
    and (counts.get("response.delta", 0) > 0) == expectations["deltas"]
    and ids_ok
    and counts.get("tool.result", 0) == (3 if expectations["tools"] else 0)
)
print(f"[verdict mode={MODE}] {'PASS' if ok else 'FAIL'}")
shutil.rmtree(WORK, ignore_errors=True)
sys.exit(0 if ok else 1)

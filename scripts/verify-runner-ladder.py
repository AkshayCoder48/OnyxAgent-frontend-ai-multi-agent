#!/usr/bin/env python3
"""Verify the headless runner's gateway-compatibility ladder end-to-end.

Three mock-gateway modes against the REAL runner (extracted from
src/lib/e2b/headless-agent.ts — the same source trigger-worker deploys):

  MODE=normal       — gateway accepts tools + tool_choice
                      EXPECT: full multi-round run (3 rounds, 3 tool calls),
                      completed, degraded=false, tools_wire_mode="full".
  MODE=tool_choice  — gateway 400s any request carrying tool_choice (tools OK)
                      EXPECT: ladder step 1 saves the run — full multi-round
                      with tools working, tools_wire_mode="tools".
  MODE=tools        — gateway 400s any request carrying the tools param
                      EXPECT: loud degradation — one text round, completed,
                      degraded=true, tools_wire_mode="text", and the final
                      message carries the visible "gateway rejected tool
                      calls" note (the old bug: a SILENT one-round answer).
"""
import json, os, pathlib, re, shutil, subprocess, sys, tempfile, threading
from http.server import BaseHTTPRequestHandler, HTTPServer

MODE = os.environ.get("MODE", "normal")
assert MODE in ("normal", "tool_choice", "tools"), f"bad MODE {MODE!r}"

import pathlib, sys
REPO = pathlib.Path(__file__).resolve().parent.parent
SRC = REPO / "src/lib/e2b/headless-agent.ts"
WORK = pathlib.Path(tempfile.mkdtemp(prefix="onyx-runner-"))
home = WORK / "home"
(home / ".onyx" / "agent").mkdir(parents=True)

# ── extract the runner (same source the worker mirror ships) ────────────────
text = SRC.read_text()
start = text.index("String.raw`") + len("String.raw`")
script = text[start : text.rindex("`")]
runner_py = WORK / "headless_runner.py"
runner_py.write_text(script.replace('HOME = "/home/user"', f"HOME = {str(home)!r}", 1))

# ── mock gateway ─────────────────────────────────────────────────────────────
STATE = {"n": 0}
ROUNDS = [
    {"message": {"role": "assistant", "content": "",
                 "tool_calls": [{"id": "call_r1", "type": "function",
                                 "function": {"name": "run_terminal",
                                              "arguments": json.dumps({"command": "echo round-one"})}}]},
     "finish_reason": "tool_calls"},
    {"message": {"role": "assistant", "content": "Working — creating the files now.",
                 "tool_calls": [
                     {"id": "call_r2a", "type": "function",
                      "function": {"name": "create_file",
                                   "arguments": json.dumps({"path": "out/a.txt", "content": "A"})}},
                     {"id": "call_r2b", "type": "function",
                      "function": {"name": "read_file",
                                   "arguments": json.dumps({"path": "out/a.txt"})}}]},
     "finish_reason": "tool_calls"},
    {"message": {"role": "assistant", "content": "All done — 3 tool calls executed over 3 rounds."},
     "finish_reason": "stop"},
]
TEXT_ONLY = {"choices": [{"message": {"role": "assistant", "content": "text-only answer (tools were rejected)"},
                          "finish_reason": "stop"}]}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        has_tools = bool(body.get("tools"))
        has_tc = "tool_choice" in body
        reject = (MODE == "tools" and has_tools) or (MODE == "tool_choice" and has_tc)
        if reject:
            self.send_response(400)
            msg = json.dumps({"error": {"message": f"mock gateway rejects this param (mode={MODE})"}}).encode()
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(msg)))
            self.end_headers()
            self.wfile.write(msg)
            return
        payload = TEXT_ONLY if not has_tools else {"choices": [ROUNDS[min(STATE["n"], len(ROUNDS) - 1)]]}
        if has_tools:
            STATE["n"] += 1
        data = json.dumps(payload).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


server = HTTPServer(("127.0.0.1", 0), Handler)
port = server.server_address[1]
threading.Thread(target=server.serve_forever, daemon=True).start()

# ── run.json mirroring the app/worker dispatch shape ─────────────────────────
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
    "api_key": "test-key", "model": "test-model",
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
history = json.loads(hist_path.read_text()) if hist_path else []
status = json.loads(status_path.read_text()) if status_path else {}

new_slice = history[len(seed):]
assistant_rounds = [m for m in new_slice if m.get("role") == "assistant"]
tool_calls = sum(len(m.get("tool_calls") or []) for m in assistant_rounds)
final_content = (assistant_rounds[-1].get("content") if assistant_rounds else "") or ""
log_text = (WORK / "launch.log").read_text()

print(f"mode={MODE} exit={code} status={status.get('status')} degraded={status.get('degraded')} "
      f"wire={status.get('tools_wire_mode')} rounds={len(assistant_rounds)} tool_calls={tool_calls}")
for line in log_text.splitlines():
    if "gateway" in line or "DEGRADING" in line or "rejected" in line:
        print("  log:", line)
if status.get("degraded"):
    print("  final content tail:", final_content[-220:])

expectations = {
    "normal":      dict(status="completed", degraded=False, wire="full", rounds=3, tools=3),
    "tool_choice": dict(status="completed", degraded=False, wire="tools", rounds=3, tools=3),
    "tools":       dict(status="completed", degraded=True,  wire="text", rounds=1, tools=0),
}[MODE]

ok = (
    status.get("status") == expectations["status"]
    and status.get("degraded") == expectations["degraded"]
    and status.get("tools_wire_mode") == expectations["wire"]
    and len(assistant_rounds) == expectations["rounds"]
    and tool_calls == expectations["tools"]
    and (not status.get("degraded") or "gateway rejected tool calls" in final_content)
)
print(f"[verdict mode={MODE}] {'PASS' if ok else 'FAIL'}")
shutil.rmtree(WORK, ignore_errors=True)
sys.exit(0 if ok else 1)

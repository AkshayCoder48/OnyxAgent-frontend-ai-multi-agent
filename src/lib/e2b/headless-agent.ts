// ============================================================================
// HEADLESS SANDBOX AGENT — the "close and resume" orchestration loop.
//
// This module is the SERVER-side source of truth for the sandbox-resident
// agent: the Python runner script (written to /home/user/headless_runner.py
// and launched detached via `nohup python3 … &`), its protocol file paths,
// and the deploy version stamp (the same version-stamp pattern the sandbox
// browser driver uses — see src/lib/e2b/browser-session.ts).
//
// WHY INSIDE THE SANDBOX: OnyxAgent's foreground loop lives in the browser
// tab, so closing the app kills it. Moving the loop into the sandbox means
// the user can press send, close the browser, switch off the computer (the
// sandbox keeps running on E2B's cloud for up to 24h), and return to the
// completed tool outputs + reasoning steps persisted in
// /home/user/chat_history.json.
//
// PROTOCOL (files inside the sandbox):
//   /home/user/.onyx/agent/run.json        — run config (prompt, LLM
//                                            endpoint/key/model, seed
//                                            messages, limits) — chmod 600
//   /home/user/.onyx/agent/runner-version  — deploy stamp (skip rewrites)
//   /home/user/headless_runner.py          — this script (version-stamped)
//   /home/user/chat_history.json           — full message history (seed +
//                                            the run's assistant/tool
//                                            turns), persisted EVERY round
//   /home/user/agent_status.json           — live status for UI polling
//   /home/user/background.log              — nohup stdout/stderr
//   /home/user/todos.json                  — runner + cron-script todos
//   /home/user/cron_output.log             — scheduled-task output (cron)
// ============================================================================

/** Bump when the runner script below changes — the deploy path rewrites the
 *  file into the sandbox whenever the stamp mismatches. v2: FR-1.3 api_key_pool
 *  rotation (429/401 → advance to the next key in the pool, up to 3 rotations).
 *  v3: native use_browser — the background agent can drive the CloakBrowser
 *  driver through its file protocol (PRD §10: browser tasks survive the
 *  frontend disconnecting).
 *  v7: EXECUTION-PROOF TELEMETRY (PRD §3/§7/§8) — every provider request
 *  emits observed lifecycle events (provider.request_started /
 *  stream_connected / first_token / response_received / request_failed /
 *  request_retry / model_fallback / degraded), every tool dispatch carries a
 *  stable idempotency key (tool_execution_id) + dispatch confirmation +
 *  measured duration, and a daemon heartbeat thread rewrites agent_status
 *  every 10s with live proof fields (runner_pid, last_event_id, provider
 *  stream state, first/last-token timestamps) — so "is the sandbox actually
 *  executing?" is answerable from OUTSIDE with observed facts, and the
 *  watchdog can distinguish a live long tool (fresh heartbeat) from a dead
 *  runner (stale status + pgrep miss). All event types/fields are ADDITIVE —
 *  byte-compatible with the v6 vocabulary the frontend already maps. */
export const HEADLESS_RUNNER_VERSION = 7;

export const RUNNER_PATH = "/home/user/headless_runner.py";
export const AGENT_DIR = "/home/user/.onyx/agent";
export const RUN_CONFIG_PATH = `${AGENT_DIR}/run.json`;
export const RUNNER_VERSION_PATH = `${AGENT_DIR}/runner-version`;
export const CHAT_HISTORY_PATH = "/home/user/chat_history.json";
export const AGENT_STATUS_PATH = "/home/user/agent_status.json";
export const AGENT_EVENTS_PATH = "/home/user/agent_events.jsonl";
export const BACKGROUND_LOG_PATH = "/home/user/background.log";
export const SANDBOX_TODOS_PATH = "/home/user/todos.json";
export const CRON_LOG_PATH = "/home/user/cron_output.log";

/** pgrep pattern for the runner process (bracket trick: the pattern never
 *  matches the probing shell's own cmdline). */
export const RUNNER_PGREP_PATTERN = "[h]eadless_runner.py";

export const HEADLESS_RUNNER_PY = String.raw`#!/usr/bin/env python3
# ============================================================================
# OnyxAgent headless orchestrator — runs INSIDE the E2B sandbox as a detached
# (nohup) process. Reads .onyx/agent/run.json, runs the LLM tool-loop against
# the configured chat-completions endpoint, executes sandbox-native tools,
# and persists progress to chat_history.json + agent_status.json so the app
# UI can sync whenever the user returns — even hours later.
#
# STDLIB ONLY (json/os/subprocess/time/urllib) — no pip install, boots in
# well under a second.
# ============================================================================

import json
import os
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

HOME = "/home/user"
CONFIG_PATH = HOME + "/.onyx/agent/run.json"
HISTORY_PATH = HOME + "/chat_history.json"
STATUS_PATH = HOME + "/agent_status.json"
TODOS_PATH = HOME + "/todos.json"
EVENTS_PATH = HOME + "/agent_events.jsonl"

RUNNER_VERSION = 7
# USER DIRECTIVE: "remove the limit of 24 rounds" — the round budget is now
# effectively unlimited; the real bound is the wall-clock execution window.
MAX_ROUNDS_DEFAULT = 400
TOOL_TIMEOUT_DEFAULT = 300
TOOL_TIMEOUT_MAX = 900
LLM_TIMEOUT_SECONDS = 240
LLM_RETRIES = 3
TOOL_RESULT_MAX_CHARS = 60000
READ_CHUNK_CHARS = 24000

# ---------------------------------------------------------------------------
# Tool schemas (OpenAI function format) — the sandbox-native surface. These
# are ALL sandbox-confined operations (terminal + filesystem inside the
# sandbox + the todos manifest + the sandbox-resident CloakBrowser driver
# via its file protocol), which is what makes an UNATTENDED loop safe: there
# is no host access from in here.
# ---------------------------------------------------------------------------
TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "run_terminal",
            "description": "Run a shell command in the sandbox workspace (/home/user). Supports pipes, &&, redirection. Use for git, npm, pip, grep, system queries, installing packages, running scripts.",
            "parameters": {
                "type": "object",
                "properties": {
                    "command": {"type": "string", "description": "The shell command to execute."},
                    "timeout_seconds": {"type": "integer", "description": "Optional timeout in seconds (default 300, max 900)."},
                },
                "required": ["command"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "create_file",
            "description": "Create (or fully overwrite) a file in the sandbox workspace with the given content. Parent folders are created automatically.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Workspace-relative path, e.g. 'projects/app/main.py'."},
                    "content": {"type": "string", "description": "The full file content to write."},
                },
                "required": ["path", "content"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "read_file",
            "description": "Read a text file from the sandbox workspace. Large files are truncated.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Workspace-relative path."},
                },
                "required": ["path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "edit_file",
            "description": "Replace the FIRST occurrence of old_text with new_text in a file. Errors when old_text is not found.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Workspace-relative path."},
                    "old_text": {"type": "string", "description": "Exact text to find."},
                    "new_text": {"type": "string", "description": "Replacement text."},
                },
                "required": ["path", "old_text", "new_text"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_folder",
            "description": "List a folder in the sandbox workspace with file sizes.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Workspace-relative path (default '.')."},
                },
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "manage_todo",
            "description": "Manage the run's todo list (persisted to /home/user/todos.json). Actions: list, add {title, description?}, update {id, status: not_planned|in_progress|done|not_done, title?, description?}, remove {id}.",
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {"type": "string", "enum": ["list", "add", "update", "remove"]},
                    "id": {"type": "string", "description": "Todo id (for update/remove)."},
                    "title": {"type": "string", "description": "Title (for add/update)."},
                    "description": {"type": "string", "description": "Optional details."},
                    "status": {"type": "string", "enum": ["not_planned", "in_progress", "done", "not_done"]},
                },
                "required": ["action"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "use_browser",
            "description": "Browse and interact with websites in the sandbox's real browser (CloakBrowser) — persistent session (cookies kept), multiple tabs. Actions: navigate (url), click (target), type (target, text, submit?), press (key), scroll (direction?, amount?), wait (ms? | selector? | text?), extract_text (), read (), inspect (filter?, limit?) — interactive elements with refs, snapshot () — page structure, screenshot (fullPage?), evaluate (code), select (target, value), upload (target, files), download (url? | target?), new_tab (url?), switch_tab (tab), close_tab (tab?), back / forward / reload, close. Targets: CSS selector, 'text=…', 'xpath=…', 'ref=eNN', or objects like {role, name} / {text} / {label} / {placeholder}. Only for pages needing real interaction; plain reading of static pages should use run_terminal with curl instead when possible.",
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": [
                            "navigate", "screenshot", "snapshot", "click", "type", "scroll",
                            "extract_text", "inspect", "wait", "back", "forward", "close",
                            "read", "get_page", "get_elements", "press", "evaluate", "select",
                            "upload", "download", "new_tab", "switch_tab", "close_tab",
                            "go_back", "go_forward", "reload", "refresh",
                        ],
                    },
                    "operation": {"type": "string", "description": "Ignored (screen_record is not available headless)."},
                    "url": {"type": "string", "description": "URL to open (navigate / new_tab / download)."},
                    "target": {"description": "Element to act on: a selector string or a semantic object ({role,name}/{text}/{label}/{placeholder}/{css}/{xpath}/{ref})."},
                    "text": {"type": "string", "description": "Text to type."},
                    "submit": {"type": "boolean", "description": "Press Enter after typing."},
                    "clear": {"type": "boolean", "description": "Clear before typing (default true)."},
                    "key": {"type": "string", "description": "Key to press."},
                    "code": {"type": "string", "description": "JavaScript to evaluate in the page."},
                    "direction": {"type": "string", "enum": ["down", "up", "left", "right"]},
                    "amount": {"type": "number"},
                    "ms": {"type": "number"},
                    "selector": {"type": "string"},
                    "fullPage": {"type": "boolean"},
                    "filter": {"type": "string"},
                    "limit": {"type": "number"},
                    "value": {"type": "string"},
                    "files": {"type": "array", "items": {"type": "string"}},
                    "tab": {"description": "Tab index or tab id."},
                },
                "required": ["action"],
            },
        },
    },
]

# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------

def now():
    return time.time()

def read_json(path, default):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default

def write_json(path, data):
    """Atomic-ish write: temp file + rename, so a poller never sees a
    half-written file even if we crash mid-flush."""
    tmp = path + ".tmp"
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
        os.replace(tmp, path)
    except Exception as exc:
        log("write_json failed for %s: %s" % (path, exc))

def log(message):
    try:
        print("[onyx-runner] %s" % message, flush=True)
    except Exception:
        pass

# ---------------------------------------------------------------------------
# Tool-Execution PRD (2026-11-28): argument validation + retry budget.
#
# The TS runtime (runtime.ts) enforces these gates for FOREGROUND turns;
# the detached runner is a SEPARATE execution environment with its own
# dispatch loop, so it needs the same two gates inline. Both are
# deliberately tiny: schema-lite validation (the keywords our TOOLS array
# actually uses) and a literal-repetition budget. They share the same
# structured error shapes as the TS side so the MODEL sees one contract.
# ---------------------------------------------------------------------------

_TOOL_SCHEMAS = {
    t["function"]["name"]: t["function"].get("parameters") or {}
    for t in TOOLS
    if isinstance(t, dict) and isinstance(t.get("function"), dict)
}

def _validate_tool_args(name, args):
    """Schema-lite pre-dispatch validation (PRD Issue 4 / Test A).
    Returns (ok, issue) — issue is a dict with code/field/message when
    invalid. NEVER raises: an unreadable schema validates True."""
    schema = _TOOL_SCHEMAS.get(name) or {}
    if not isinstance(args, dict):
        return False, {"code": "MISSING_REQUIRED_FIELD", "field": "arguments",
                       "message": "Tool arguments must be a JSON object."}
    required = schema.get("required") or []
    props = schema.get("properties") or {}
    for r in required:
        v = args.get(r)
        if v is None or v == "" or (isinstance(v, str) and not v.strip()):
            return False, {"code": "MISSING_REQUIRED_FIELD", "field": str(r),
                           "message": "The %s argument is required%s." % (
                               r, " (it was sent as an empty string)" if v == "" else "")}
    for k, v in args.items():
        ps = props.get(k)
        if not isinstance(ps, dict) or v is None:
            continue
        t = ps.get("type")
        if isinstance(t, str) and not _type_matches(v, t):
            return False, {"code": "INVALID_TYPE", "field": str(k),
                           "message": "Field '%s' must be of type %s." % (k, t)}
        enum = ps.get("enum")
        if isinstance(enum, list) and enum and v not in enum:
            return False, {"code": "INVALID_VALUE", "field": str(k),
                           "message": "Field '%s' must be one of: %s." % (k, ", ".join(str(x) for x in enum))}
    return True, None

def _type_matches(value, declared):
    if declared == "string":
        return isinstance(value, str)
    if declared == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    if declared == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if declared == "boolean":
        return isinstance(value, bool)
    if declared == "array":
        return isinstance(value, list)
    if declared == "object":
        return isinstance(value, dict)
    return True  # unknown type keyword — not enforced

def _canonical_json(value):
    """Order-insensitive serialization for the repetition key."""
    if isinstance(value, dict):
        return "{" + ",".join(
            "%s:%s" % (json.dumps(k, sort_keys=True), _canonical_json(value[k]))
            for k in sorted(value.keys())) + "}"
    if isinstance(value, list):
        return "[" + ",".join(_canonical_json(x) for x in value) + "]"
    return json.dumps(value, sort_keys=True)

MAX_IDENTICAL_FAILURES = 3
MAX_RUN_FAILURES = 25

class RetryBudget:
    """Literal-repetition budget (PRD Issue 3 / Test C) — the runner-side
    twin of the TS RetryBudget. 1st failure advises, 2nd demands a
    strategy change, 3rd+ is refused before dispatch."""

    def __init__(self):
        self.failures = {}
        self.total = 0

    @staticmethod
    def key(name, args):
        return name + "#" + _canonical_json(args)

    def check(self, name, args):
        """('allow', None) | ('advise', tier_msg) | ('block', message)."""
        if self.total >= MAX_RUN_FAILURES:
            return "block", (
                "This run has already recorded %d failed tool dispatches — the attempt budget is "
                "exhausted. Summarize what was attempted and why it failed, and report the task "
                "as BLOCKED with the specific blocker." % self.total)
        n = self.failures.get(self.key(name, args), 0)
        if n == 0:
            return "allow", None
        if n == 1:
            return "advise", (
                "[RECOVERY NOTICE] An identical %s call already failed once. READ the error, "
                "identify the failure category, and fix the cause before retrying." % name)
        if n == 2:
            return "advise", (
                "[RECOVERY NOTICE — STRATEGY CHANGE REQUIRED] The identical %s call has now "
                "failed twice. Retrying it unchanged will be BLOCKED. Change the arguments, "
                "use a different tool, or report the task as BLOCKED." % name)
        return "block", (
            "This EXACT call (%s with identical arguments) has already failed %d times and was "
            "NOT dispatched again. Choose a different approach or report the task as BLOCKED "
            "with this failure as the blocker." % (name, n))

    def record_failure(self, name, args):
        k = self.key(name, args)
        self.failures[k] = self.failures.get(k, 0) + 1
        self.total += 1

    def record_success(self, name, args):
        self.failures.pop(self.key(name, args), None)

def _result_is_error(result):
    """True when a handler's result indicates failure: the runner's string
    convention ('error: …') or a structured {success: false} / {error: …}
    envelope (use_browser, …). Used only for budget bookkeeping."""
    if isinstance(result, str):
        return result.startswith("error:")
    if isinstance(result, dict):
        if result.get("success") is False:
            return True
        err = result.get("error")
        if isinstance(err, dict) and err.get("type"):
            return True
    return False

# ---------------------------------------------------------------------------
# Live event log (agent_events.jsonl) — the run's REPLAY STREAM.
#
# The app's SSE bridge tails this file and forwards events to the browser in
# real time (PRD "Real-Time Sandbox-to-UI Streaming"); "i" is the 1-based
# event id used as the SSE Last-Event-ID so a reconnect replays exactly the
# missing tail (refresh mid-run loses nothing). One JSON object per line,
# append-only within a run; a NEW run truncates the file. Event types mirror
# the app's AgentEvent vocabulary so the client maps them 1:1.
# ---------------------------------------------------------------------------

EVENT_SEQ = 0

def emit_event(etype, data=None):
    global EVENT_SEQ
    EVENT_SEQ += 1
    entry = {"i": EVENT_SEQ, "type": etype, "ts": int(now() * 1000), "run_id": RUN_ID}
    if data is not None:
        entry["data"] = data
    try:
        with open(EVENTS_PATH, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    except Exception:
        pass  # the event log is a live-view convenience — never fatal

def reset_events():
    """Fresh stream per run (the previous run's events are already landed in
    chat_history.json — the authoritative source of truth)."""
    global EVENT_SEQ
    EVENT_SEQ = 0
    try:
        with open(EVENTS_PATH, "w", encoding="utf-8") as f:
            f.write("")
    except Exception:
        pass

# ---------------------------------------------------------------------------
# EXECUTION-PROOF TELEMETRY (v7, PRD §3/§7/§8). PROOF is the runner's live
# observed state — every field is stamped by an ACTUAL event (a connected
# socket, an arrived token, a dispatched handler), never an assumption. It
# rides agent_status.json so the outside world can answer "is the sandbox
# really executing?" with facts: runner pid, provider stream state, first /
# last token timestamps, the in-flight tool's idempotency key.
# ---------------------------------------------------------------------------

PROOF = {
    "request_id": None,        # id of the CURRENT (or last) provider request
    "stream_state": "idle",    # idle | connecting | streaming | non_stream | failed
    "first_token_at": None,    # ms — first arrived token/reasoning/tool_call fragment
    "last_token_at": None,     # ms — most recent arrived fragment (staleness = stalled)
    "tool_execution_id": None, # texec_<call_id> of the in-flight (or last) tool
    "tool_name": None,
    "round": 0,
}
LAST_STATUS = None            # last status payload write_status produced
HEARTBEAT_STOP = threading.Event()

def new_request_id():
    return "req_" + os.urandom(6).hex()

def proof_status_fields():
    return {
        "runner_pid": os.getpid(),
        "last_event_id": EVENT_SEQ,
        "provider_request_id": PROOF["request_id"],
        "provider_stream": PROOF["stream_state"],
        "first_token_at": PROOF["first_token_at"],
        "last_token_at": PROOF["last_token_at"],
        "current_tool_execution_id": PROOF["tool_execution_id"],
    }

def _heartbeat_loop():
    """Daemon heartbeat (v7): rewrite agent_status.json every 10s while the
    run is active. Without it last_update FROZE for the whole duration of a
    long tool call (status only changed on stage transitions), so an outside
    watcher could not tell a live 5-minute terminal run from a dead runner.
    The heartbeat carries the proof fields, so token staleness (provider
    quiet) is observable separately from process liveness."""
    while not HEARTBEAT_STOP.wait(10.0):
        snapshot = LAST_STATUS
        if not snapshot or snapshot.get("status") not in ("running", "starting"):
            return
        try:
            payload = dict(snapshot)
            payload["last_update"] = int(now() * 1000)
            payload.update(proof_status_fields())
            write_json(STATUS_PATH, payload)
        except Exception:
            pass  # the heartbeat is diagnostic — never fatal

def start_heartbeat():
    HEARTBEAT_STOP.clear()
    threading.Thread(target=_heartbeat_loop, daemon=True).start()

def stop_heartbeat():
    HEARTBEAT_STOP.set()

class DeltaBatcher:
    """Batch token deltas before writing an event line — one JSONL entry per
    ~0.35s (or 160 chars) instead of one per token, so the SSE tailer and the
    event file stay lightweight on long generations.

    etype separates content batches (response.delta) from reasoning batches
    (reasoning.delta) — thinking models stream their chain-of-thought in
    delta.reasoning_content / delta.reasoning / delta.thinking, which used to
    be silently DROPPED (the live view showed nothing while the model
    thought, and thinking never landed in history)."""

    def __init__(self, etype="response.delta"):
        self.etype = etype
        self.buf = []
        self.size = 0
        # Initialize to NOW: a zero epoch made "now() - last_flush >= 0.35"
        # always true, so the FIRST token flushed alone as its own event (the
        # reported "only one word of thinking" artifact).
        self.last_flush = now()

    def add(self, text):
        self.buf.append(text)
        self.size += len(text)
        if self.size >= 160 or (now() - self.last_flush) >= 0.35:
            self.flush()

    def flush(self):
        if not self.buf:
            return
        text = "".join(self.buf)
        self.buf = []
        self.size = 0
        self.last_flush = now()
        emit_event(self.etype, {"text": text})

def safe_path(raw):
    """Confine every filesystem tool to /home/user (realpath-resolved)."""
    p = str(raw or "").strip()
    if not p:
        return HOME
    if not p.startswith("/"):
        p = os.path.join(HOME, p)
    real = os.path.realpath(p)
    if real != HOME and not real.startswith(HOME + "/"):
        raise ValueError("path escapes the workspace: " + str(raw))
    return real

def truncate(text, limit):
    if text is None:
        return ""
    if len(text) <= limit:
        return text
    return text[:limit] + "\n...[truncated, %d chars total]" % len(text)

# ---------------------------------------------------------------------------
# Tool implementations
# ---------------------------------------------------------------------------

def tool_run_terminal(args):
    command = str(args.get("command") or "")
    if not command.strip():
        return "error: empty command"
    try:
        timeout = int(args.get("timeout_seconds") or TOOL_TIMEOUT_DEFAULT)
    except (TypeError, ValueError):
        timeout = TOOL_TIMEOUT_DEFAULT
    timeout = max(5, min(timeout, TOOL_TIMEOUT_MAX))
    try:
        proc = subprocess.run(
            command,
            shell=True,
            cwd=HOME,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        out = []
        if proc.stdout:
            out.append(proc.stdout)
        if proc.stderr:
            out.append("[stderr]\n" + proc.stderr)
        out.append("[exit_code=%d]" % proc.returncode)
        return truncate("\n".join(out), TOOL_RESULT_MAX_CHARS)
    except subprocess.TimeoutExpired:
        return "error: command timed out after %ds" % timeout
    except Exception as exc:
        return "error: " + str(exc)

def tool_create_file(args):
    path = safe_path(args.get("path"))
    content = args.get("content")
    if content is None:
        content = ""
    os.makedirs(os.path.dirname(path) or HOME, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(str(content))
    return "wrote %d bytes to %s" % (len(str(content)), os.path.relpath(path, HOME))

def tool_read_file(args):
    path = safe_path(args.get("path"))
    if not os.path.isfile(path):
        return "error: file not found: " + os.path.relpath(path, HOME)
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        return truncate(f.read(READ_CHUNK_CHARS + 10), READ_CHUNK_CHARS)

def tool_edit_file(args):
    path = safe_path(args.get("path"))
    if not os.path.isfile(path):
        return "error: file not found: " + os.path.relpath(path, HOME)
    old_text = str(args.get("old_text") or "")
    new_text = str(args.get("new_text") or "")
    if not old_text:
        return "error: old_text is empty"
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        content = f.read()
    idx = content.find(old_text)
    if idx < 0:
        return "error: old_text not found in " + os.path.relpath(path, HOME)
    content = content[:idx] + new_text + content[idx + len(old_text):]
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)
    return "edited " + os.path.relpath(path, HOME)

def tool_list_folder(args):
    path = safe_path(args.get("path") or ".")
    if not os.path.isdir(path):
        return "error: folder not found: " + os.path.relpath(path, HOME)
    entries = []
    try:
        for name in sorted(os.listdir(path)):
            full = os.path.join(path, name)
            if os.path.isdir(full):
                entries.append(name + "/")
            else:
                try:
                    size = os.path.getsize(full)
                except OSError:
                    size = 0
                entries.append("%s (%d bytes)" % (name, size))
    except Exception as exc:
        return "error: " + str(exc)
    if not entries:
        return "(empty folder)"
    return truncate("\n".join(entries), TOOL_RESULT_MAX_CHARS)

def load_todos():
    data = read_json(TODOS_PATH, None)
    if isinstance(data, list):
        return data
    return []

def save_todos(todos):
    write_json(TODOS_PATH, todos)

TODO_STATUSES = ("not_planned", "in_progress", "done", "not_done")

# ---------------------------------------------------------------------------
# use_browser — native bridge to the sandbox-resident CloakBrowser driver
# (PRD §10: browser tasks survive the frontend disconnecting). The driver
# (deployed at sandbox creation by /api/sandbox prepareBrowserRuntime)
# speaks the file protocol: write cmd.json → poll res-<id>.json. The
# driver's own watchdog bounds every action server-side, so this poll
# ALWAYS resolves with a structured result.
# ---------------------------------------------------------------------------

BROWSER_DIR = "/home/user/.onyx/browser"
BROWSER_CMD_PATH = os.path.join(BROWSER_DIR, "cmd.json")
BROWSER_READY_PATH = os.path.join(BROWSER_DIR, ".ready")
BROWSER_BOOT_SH = os.path.join(BROWSER_DIR, "boot.sh")
BROWSER_BOOT_FAILED_PATH = os.path.join(BROWSER_DIR, ".boot-failed")
BROWSER_BOOT_CEILING_SECONDS = 600   # cold first install legitimately takes minutes
BROWSER_ACTION_CEILING_SECONDS = 150 # generous; the driver watchdog answers first


def _browser_driver_ready():
    if not os.path.exists(BROWSER_READY_PATH):
        return False
    try:
        out = subprocess.run(
            ["pgrep", "-f", "[d]river.py"],
            capture_output=True, timeout=10,
        )
        return out.returncode == 0
    except Exception:
        return False


def _ensure_browser_driver():
    """Kick boot.sh (already deployed at sandbox creation) and wait for
    .ready. Returns (ok, error_message)."""
    if _browser_driver_ready():
        return True, None
    if not os.path.exists(BROWSER_BOOT_SH):
        return False, "the sandbox browser driver is not deployed (boot.sh missing in ~/.onyx/browser)"
    try:
        subprocess.Popen(
            ["bash", "-c", "cd " + BROWSER_DIR + " && nohup bash boot.sh >> boot.log 2>&1 &"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
    except Exception as exc:
        return False, "could not launch the browser boot: " + str(exc)
    deadline = time.time() + BROWSER_BOOT_CEILING_SECONDS
    while time.time() < deadline:
        if os.path.exists(BROWSER_BOOT_FAILED_PATH):
            detail = ""
            try:
                with open(BROWSER_BOOT_FAILED_PATH, "r", encoding="utf-8", errors="replace") as f:
                    detail = f.read()[-300:]
            except Exception:
                pass
            return False, "browser runtime install failed: " + detail
        if _browser_driver_ready():
            return True, None
        time.sleep(2)
    return False, "browser driver did not become ready within %ds" % BROWSER_BOOT_CEILING_SECONDS


def tool_use_browser(args):
    action = str(args.get("action") or "")
    if not action:
        return "error: action is required for use_browser"
    ok, err = _ensure_browser_driver()
    if not ok:
        return json.dumps({
            "success": False,
            "action": action,
            "error": {"type": "browser_startup_failed", "message": err},
            "output": "Browser failed to start: " + str(err),
        }, ensure_ascii=False)
    cmd = {"id": "h" + str(int(time.time() * 1000)), "action": action}
    for k in ("operation", "url", "target", "text", "submit", "clear", "key",
              "code", "direction", "amount", "ms", "selector", "fullPage",
              "filter", "limit", "value", "files", "tab"):
        if args.get(k) is not None:
            cmd[k] = args.get(k)
    try:
        tmp = BROWSER_CMD_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(json.dumps(cmd, ensure_ascii=False))
        os.replace(tmp, BROWSER_CMD_PATH)
    except Exception as exc:
        return json.dumps({
            "success": False,
            "action": action,
            "error": {"type": "browser_error", "message": str(exc)},
            "output": "Could not send the browser command: " + str(exc),
        }, ensure_ascii=False)
    res_path = os.path.join(BROWSER_DIR, "res-" + str(cmd["id"]) + ".json")
    deadline = time.time() + BROWSER_ACTION_CEILING_SECONDS
    while time.time() < deadline:
        if os.path.exists(res_path):
            try:
                with open(res_path, "r", encoding="utf-8", errors="replace") as f:
                    payload = json.load(f)
                try:
                    os.remove(res_path)
                except Exception:
                    pass
                return truncate(json.dumps(payload, ensure_ascii=False), TOOL_RESULT_MAX_CHARS)
            except Exception:
                # torn read (atomic rename raced) — retry on the next tick
                pass
        time.sleep(0.5)
    return json.dumps({
        "success": False,
        "action": action,
        "error": {"type": "timeout", "message": "browser action timed out after %ds" % BROWSER_ACTION_CEILING_SECONDS},
        "output": "Browser action timed out.",
    }, ensure_ascii=False)


def tool_manage_todo(args):
    # "operation" is accepted as an alias for "action" (models mix the two);
    # create/add and delete/remove are both valid; todo_id/todoId/id all work.
    action = str(args.get("action") or args.get("operation") or "list").strip().lower()
    def tid():
        return str(args.get("todo_id") or args.get("todoId") or args.get("id") or "")
    todos = load_todos()
    if action in ("list", "read"):
        if not todos:
            return "(no todos)"
        return json.dumps(todos, ensure_ascii=False)
    if action in ("add", "create"):
        title = str(args.get("title") or "").strip()
        if not title:
            return "error: title is required for add"
        todo = {
            "id": "todo-%d-%04d" % (int(now() * 1000), len(todos) % 10000),
            "title": title,
            "description": args.get("description"),
            "status": "not_planned",
            "created_at": int(now()),
            "updated_at": int(now()),
        }
        todos.append(todo)
        save_todos(todos)
        return json.dumps(todo, ensure_ascii=False)
    if action == "update":
        target = tid()
        for todo in todos:
            if todo.get("id") == target:
                if args.get("title") is not None:
                    todo["title"] = str(args.get("title"))
                if args.get("description") is not None:
                    todo["description"] = args.get("description")
                status = args.get("status")
                if status in TODO_STATUSES:
                    todo["status"] = status
                todo["updated_at"] = int(now())
                save_todos(todos)
                return json.dumps(todo, ensure_ascii=False)
        return "error: todo not found: " + target
    if action in ("remove", "delete"):
        target = tid()
        remaining = [t for t in todos if t.get("id") != target]
        if len(remaining) == len(todos):
            return "error: todo not found: " + target
        save_todos(remaining)
        return "removed " + target
    return "error: unknown action: " + action

TOOL_HANDLERS = {
    "run_terminal": tool_run_terminal,
    "create_file": tool_create_file,
    "write_file": tool_create_file,
    "read_file": tool_read_file,
    "edit_file": tool_edit_file,
    "list_folder": tool_list_folder,
    "manage_todo": tool_manage_todo,
    "use_browser": tool_use_browser,
}

# ---------------------------------------------------------------------------
# LLM transport (stdlib urllib — no openai package needed)
# ---------------------------------------------------------------------------

class LlmError(Exception):
    def __init__(self, message, http_status=None):
        super(LlmError, self).__init__(message)
        self.http_status = http_status

# FR-1.3 rotational key pool: index of the key currently in use (module-global
# so it survives across rounds within one run). Advanced by
# llm_chat_with_retries on 429 (and 401 with a multi-key pool).
KEY_INDEX = 0

# GATEWAY COMPATIBILITY STATE (mirrors the app runtime's wire-compat ladder —
# see src/lib/agent/wire-compat.ts). Strict gateways 400 on OpenAI-standard
# tool structures; the foreground survives by learning these steps per
# provider. The runner learns them per RUN instead:
#   TOOLS_WIRE_MODE — "full"  : tools + tool_choice:"auto"
#                     "tools" : tools only (gateway rejects tool_choice)
#                     "text"  : no tools params at all (DEGRADED text run)
#   WIRE_SANITIZE    — flatten role:tool traffic to plain user/assistant
#                      text (gateways that 400 on the tool role, e.g.
#                      'Invalid role "tool"').
#   DEGRADED         — the run lost tool calling; the final message carries
#                      a visible note so a one-round text answer is never a
#                      silent mystery again.
TOOLS_WIRE_MODE = "full"
WIRE_SANITIZE = False
DEGRADED = False

# STREAM TRANSPORT — "on" tries SSE streaming first (real-time response.delta
# events to the UI); a gateway that rejects stream:true flips it to "off" and
# every later request uses the plain JSON path (the run still completes, just
# without token-level live view — the per-round history writes remain).
STREAM_MODE = "on"

# Model ids already attempted this run (rung 0 of the retry ladder — a
# missing/rotated model id switches to the next fallback candidate once).
MODEL_TRIES = set()


def parse_sse_stream(resp, req_id):
    """SSE-parse a streaming chat completion (OpenAI chunk format).

    Emits batched response.delta AND reasoning.delta events as tokens arrive
    (DeltaBatcher keeps the event log ~3 lines/second instead of one per
    token) and accumulates tool_call argument fragments across chunks.
    Reasoning streams via delta.reasoning_content (DeepSeek-style),
    delta.reasoning (vLLM relays) or delta.thinking (Anthropic-style) —
    whichever a gateway uses, the thinking reaches the UI live and lands in
    history. Returns the same reply dict the non-streaming path builds,
    plus a "reasoning" field. Raises on a dead stream (no content, no
    reasoning, no tool calls, no finish) so the retry ladder — not a bogus
    "budget exhausted" ending — handles empty gateway responses.

    v7 PROOF: the first arrived fragment emits provider.first_token (an
    OBSERVED event — the gateway delivered bytes), and every fragment
    stamps PROOF["last_token_at"] so the heartbeat can distinguish "model
    is thinking/tokens arriving" from "provider stream stalled"."""
    content_parts = []
    reasoning_parts = []
    tool_acc = {}
    finish_reason = None
    batcher = DeltaBatcher()
    think_batcher = DeltaBatcher("reasoning.delta")
    first_token_kind = None

    def mark_fragment(kind):
        nonlocal first_token_kind
        ts = int(now() * 1000)
        PROOF["last_token_at"] = ts
        if first_token_kind is None:
            first_token_kind = kind
            PROOF["first_token_at"] = ts
            PROOF["stream_state"] = "streaming"
            emit_event("provider.first_token", {
                "request_id": req_id,
                "kind": kind,
                "ts": ts,
            })

    for raw in resp:
        line = raw.decode("utf-8", "replace").strip()
        if not line or not line.startswith("data:"):
            continue
        payload = line[5:].strip()
        if payload == "[DONE]":
            break
        try:
            chunk = json.loads(payload)
        except Exception:
            continue
        choices = chunk.get("choices") or []
        if not choices:
            continue
        choice = choices[0]
        delta = choice.get("delta") or {}
        text = delta.get("content")
        if isinstance(text, str) and text:
            content_parts.append(text)
            batcher.add(text)
            mark_fragment("content")
        # Thinking-model chain-of-thought — every known field name, one batcher.
        thought = None
        for key in ("reasoning_content", "reasoning", "thinking"):
            candidate = delta.get(key)
            if isinstance(candidate, str) and candidate:
                thought = candidate
                break
        if thought is not None:
            reasoning_parts.append(thought)
            think_batcher.add(thought)
            mark_fragment("reasoning")
        for tc in (delta.get("tool_calls") or []):
            mark_fragment("tool_call")
            try:
                idx = int(tc.get("index") or 0)
            except Exception:
                idx = 0
            slot = tool_acc.setdefault(idx, {"id": "", "name": "", "args": ""})
            if tc.get("id"):
                slot["id"] = str(tc["id"])
            fn = tc.get("function") or {}
            if fn.get("name"):
                slot["name"] += str(fn["name"])
            if fn.get("arguments"):
                slot["args"] += str(fn["arguments"])
        if choice.get("finish_reason"):
            finish_reason = choice.get("finish_reason")
    batcher.flush()
    think_batcher.flush()
    PROOF["stream_state"] = "idle"
    if not content_parts and not tool_acc and not reasoning_parts:
        raise LlmError("empty streaming response from the model gateway")
    tool_calls = []
    for idx in sorted(tool_acc):
        slot = tool_acc[idx]
        tool_calls.append({
            "id": slot["id"] or ("call_%s_%d" % (RUN_ID or "run", idx)),
            "type": "function",
            "function": {"name": slot["name"], "arguments": slot["args"] or "{}"},
        })
    return {
        "content": "".join(content_parts),
        "reasoning": "".join(reasoning_parts),
        "tool_calls": tool_calls,
        "finish_reason": finish_reason,
    }


def sanitize_messages_for_gateway(messages):
    """Flatten tool-role traffic to plain text (wire-compat step A).

    Strict gateways 400 on role:"tool" entries and on tool_calls blocks.
    Tool results become user-role '[tool result | name]' lines; assistant
    tool_calls become '[used tool …]' text. The model still sees the full
    conversation, just in plain-chat shape."""
    out = []
    for m in messages:
        role = m.get("role")
        if role == "tool":
            name = m.get("name") or m.get("tool_call_id") or "tool"
            out.append({
                "role": "user",
                "content": "[tool result | %s]: %s" % (name, m.get("content") or ""),
            })
        elif role == "assistant" and m.get("tool_calls"):
            parts = []
            if (m.get("content") or "").strip():
                parts.append(m["content"])
            for spec in m["tool_calls"]:
                fn = (spec or {}).get("function") or {}
                parts.append("[used tool %s with args %s]" % (
                    fn.get("name") or "?", fn.get("arguments") or "{}"))
            out.append({"role": "assistant", "content": "\n".join(parts)})
        elif role == "assistant" and m.get("reasoning"):
            # Persisted thinking is for the UI/history — strict gateways can
            # 400 on unknown message fields, so it never goes back on the wire.
            out.append({"role": "assistant", "content": m.get("content") or ""})
        else:
            out.append(m)
    return out

def llm_chat(cfg, messages, use_tools):
    url = str(cfg.get("chat_url") or "")
    if not url:
        raise LlmError("run config is missing chat_url")
    api_key = str(cfg.get("api_key") or "")
    pool_raw = cfg.get("api_key_pool")
    api_keys = [str(k) for k in pool_raw if str(k)] if isinstance(pool_raw, list) else []
    if api_keys:
        api_key = api_keys[KEY_INDEX % len(api_keys)]
    model = str(cfg.get("model") or "")

    # Wire-compat: flatten tool-role traffic for gateways that reject it.
    send_messages = sanitize_messages_for_gateway(messages) if WIRE_SANITIZE else messages

    body = {
        "model": model,
        "messages": send_messages,
        "stream": STREAM_MODE == "on",
    }
    temperature = cfg.get("temperature")
    if isinstance(temperature, (int, float)):
        body["temperature"] = temperature
    if use_tools:
        body["tools"] = TOOLS
        if TOOLS_WIRE_MODE == "full":
            body["tool_choice"] = "auto"

    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = "Bearer " + api_key

    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    # v7 PROOF: an OBSERVED request lifecycle — the id is generated here, the
    # connected/failed events fire on real socket outcomes. No keys, no
    # message content — just the facts an outside watchdog needs.
    req_id = new_request_id()
    PROOF["request_id"] = req_id
    PROOF["stream_state"] = "connecting"
    PROOF["first_token_at"] = None
    PROOF["last_token_at"] = None
    emit_event("provider.request_started", {
        "request_id": req_id,
        "model": model,
        "stream": body.get("stream") is True,
        "tools": use_tools,
        "wire_mode": TOOLS_WIRE_MODE,
    })
    try:
        with urllib.request.urlopen(req, timeout=LLM_TIMEOUT_SECONDS) as resp:
            ctype = (resp.headers.get("Content-Type") or "").lower()
            if body.get("stream") and "event-stream" in ctype:
                emit_event("provider.stream_connected", {
                    "request_id": req_id,
                    "content_type": ctype[:60],
                })
                return parse_sse_stream(resp, req_id)
            # A gateway that IGNORES stream:true and answers plain JSON — or a
            # deliberate non-stream request — takes the legacy path.
            emit_event("provider.stream_connected", {
                "request_id": req_id,
                "content_type": ctype[:60],
                "mode": "non_stream",
            })
            PROOF["stream_state"] = "non_stream"
            payload = json.loads(resp.read().decode("utf-8", "replace"))
            emit_event("provider.response_received", {"request_id": req_id})
    except urllib.error.HTTPError as exc:
        detail = ""
        try:
            detail = exc.read().decode("utf-8", "replace")[:500]
        except Exception:
            pass
        PROOF["stream_state"] = "failed"
        emit_event("provider.request_failed", {
            "request_id": req_id,
            "http_status": exc.code,
        })
        raise LlmError("HTTP %d from the model gateway: %s" % (exc.code, detail), exc.code)
    except Exception as exc:
        PROOF["stream_state"] = "failed"
        emit_event("provider.request_failed", {
            "request_id": req_id,
            "http_status": None,
        })
        raise LlmError(str(exc))

    try:
        choice = payload["choices"][0]
        message = choice.get("message") or {}
        # Thinking models expose chain-of-thought under one of three fields.
        reasoning = ""
        for key in ("reasoning_content", "reasoning", "thinking"):
            candidate = message.get(key)
            if isinstance(candidate, str) and candidate:
                reasoning = candidate
                break
        return {
            "content": message.get("content") or "",
            "reasoning": reasoning,
            "tool_calls": message.get("tool_calls") or [],
            "finish_reason": choice.get("finish_reason"),
        }
    except (KeyError, IndexError, TypeError) as exc:
        raise LlmError("malformed gateway response: " + str(exc))

def _model_missing(exc):
    text = str(exc).lower()
    return ("does not exist" in text or "not found" in text or "no such model" in text
            or "unknown model" in text or "invalid model" in text)

def llm_chat_with_retries(cfg, messages, use_tools):
    """Retry transient failures (429/5xx/network) with backoff. Structured
    400/404 handling walks the GATEWAY COMPATIBILITY LADDER (mirrors the app
    runtime's wire-compat; the old behavior degraded SILENTLY to a text-only
    run on the FIRST 400, which turned every background run on a strict
    gateway into a one-round text answer with no explanation):
      rung 0 — model fallback: a missing/rotated model id (404 / "does not
                exist") tries cfg.fallback_models in order (the Kilo anon
                tier ids reroute server-side; concrete :free ids rotate).
      rung A — stream-off: a gateway that rejects stream:true falls back to
               the plain JSON path (run completes; live view becomes
               per-round instead of per-token).
      step 1 — drop tool_choice, keep tools (gateways that reject it),
      step 2 — keep tools, flatten tool-role messages ('Invalid role
                "tool"' gateways),
      step 3 — tools off (text-only DEGRADATION, loudly marked: the final
                message + status both say the run lost tool calling)."""
    global KEY_INDEX, TOOLS_WIRE_MODE, WIRE_SANITIZE, DEGRADED, STREAM_MODE
    delay = 3.0
    last_error = None
    pool_raw = cfg.get("api_key_pool")
    api_keys = [str(k) for k in pool_raw if str(k)] if isinstance(pool_raw, list) else []
    rotations = 0
    for attempt in range(1, LLM_RETRIES + 1):
        try:
            return llm_chat(cfg, messages, use_tools)
        except LlmError as exc:
            last_error = exc
            # rung 0 — missing/rotated model: try the next fallback id once.
            if (exc.http_status == 404 or (exc.http_status == 400 and _model_missing(exc))):
                candidates = [str(cfg.get("model") or "")] + [
                    str(m) for m in (cfg.get("fallback_models") or []) if str(m)
                ]
                tried = MODEL_TRIES
                nxt = next((m for m in candidates if m and m not in tried), None)
                if nxt is not None:
                    tried.add(nxt)
                    if str(cfg.get("model") or "") not in tried:
                        tried.add(str(cfg.get("model") or ""))
                    emit_event("provider.model_fallback", {
                        "from": str(cfg.get("model") or ""),
                        "to": nxt,
                    })
                    log("model %s unavailable — switching to fallback %s" % (cfg.get("model"), nxt))
                    cfg["model"] = nxt
                    return llm_chat_with_retries(cfg, messages, use_tools)
            if exc.http_status == 400:
                # rung A — explicit stream rejection (before touching tools).
                if STREAM_MODE == "on" and "stream" in str(exc).lower():
                    STREAM_MODE = "off"
                    emit_event("provider.compatibility", {"mode": "stream_off"})
                    log("gateway rejected stream:true — falling back to non-streaming requests")
                    return llm_chat_with_retries(cfg, messages, use_tools)
                if use_tools:
                    if TOOLS_WIRE_MODE == "full":
                        TOOLS_WIRE_MODE = "tools"
                        emit_event("provider.compatibility", {"mode": "tool_choice_dropped"})
                        log("gateway rejected the tool_choice param — retrying with tools only (tool_choice dropped)")
                        return llm_chat_with_retries(cfg, messages, use_tools)
                    if not WIRE_SANITIZE and any(m.get("role") == "tool" for m in messages):
                        WIRE_SANITIZE = True
                        emit_event("provider.compatibility", {"mode": "tool_role_flattened"})
                        log("gateway rejected the tool-role messages — flattening tool traffic to plain text (tools kept)")
                        return llm_chat_with_retries(cfg, messages, use_tools)
                    DEGRADED = True
                    TOOLS_WIRE_MODE = "text"
                    emit_event("provider.compatibility", {"mode": "tools_off_degraded"})
                    log("gateway rejected the tools payload — DEGRADING to a text-only run (the final message will say so)")
                    return llm_chat_with_retries(cfg, messages, False)
                # A tools-off request still 400s — the stream param is the
                # last remaining suspect; flip it and retry once.
                if STREAM_MODE == "on":
                    STREAM_MODE = "off"
                    log("gateway 400 with tools already off — falling back to non-streaming requests")
                    return llm_chat_with_retries(cfg, messages, use_tools)
            if (
                api_keys
                and rotations < 3
                and attempt < LLM_RETRIES
                and (exc.http_status == 429 or (exc.http_status == 401 and len(api_keys) > 1))
            ):
                rotations += 1
                KEY_INDEX += 1
                log("rotating api key (index %d)" % (KEY_INDEX % len(api_keys)))
                time.sleep(5.0)
                continue
            transient = exc.http_status is None or exc.http_status in (408, 409, 429, 500, 502, 503, 504) or exc.http_status >= 500
            if not transient or attempt == LLM_RETRIES:
                raise
            emit_event("provider.request_retry", {
                "attempt": attempt,
                "retries": LLM_RETRIES,
                "http_status": exc.http_status,
                "delay_s": delay,
            })
            log("LLM attempt %d/%d failed (%s) — retrying in %.0fs" % (attempt, LLM_RETRIES, exc, delay))
            time.sleep(delay)
            delay = min(delay * 2, 30.0)
    raise last_error

# ---------------------------------------------------------------------------
# Status reporting
# ---------------------------------------------------------------------------

RUN_ID = ""
STARTED_AT = 0.0

def write_status(status, stage=None, round_no=None, total_rounds=None,
                 current_tool=None, error=None, prompt_preview=None,
                 finished=False):
    payload = {
        "status": status,
        "stage": stage,
        "round": round_no,
        "total_rounds": total_rounds,
        "current_tool": current_tool,
        "run_id": RUN_ID,
        "last_update": int(now() * 1000),
        "started_at": int(STARTED_AT * 1000),
        "finished_at": int(now() * 1000) if finished else None,
        "error": error,
        "prompt_preview": prompt_preview,
        "runner_version": RUNNER_VERSION,
        "degraded": DEGRADED,
        "tools_wire_mode": TOOLS_WIRE_MODE,
    }
    # v7: observed execution-proof fields ride EVERY status write (and the
    # 10s heartbeat between them) — pid, replay-cursor position, provider
    # stream state, token timestamps, in-flight tool key.
    payload.update(proof_status_fields())
    global LAST_STATUS
    LAST_STATUS = payload
    write_json(STATUS_PATH, payload)

# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------

def main():
    global RUN_ID, STARTED_AT

    cfg = read_json(CONFIG_PATH, None)
    if not isinstance(cfg, dict) or not cfg.get("prompt"):
        write_status("failed", stage="error", error="missing or invalid run config", finished=True)
        log("missing or invalid run config at " + CONFIG_PATH)
        return 1

    RUN_ID = str(cfg.get("run_id") or "")
    STARTED_AT = now()
    prompt_preview = str(cfg.get("prompt") or "")[:160]
    total_rounds = int(cfg.get("max_rounds") or MAX_ROUNDS_DEFAULT)

    messages = []
    seed = cfg.get("seed_messages")
    if isinstance(seed, list):
        for m in seed:
            if isinstance(m, dict) and isinstance(m.get("content"), str):
                messages.append({"role": m.get("role") or "user", "content": m["content"]})
    if not messages:
        messages = [{"role": "user", "content": str(cfg.get("prompt"))}]

    # EXECUTION DISCIPLINE (Tool-Execution PRD §4, 2026-11-28): the seed
    # system prompt comes from the app, but the runner is a separate
    # execution environment — its dispatch loop enforces argument
    # validation and a repetition budget, and the model must KNOW that so
    # it self-corrects in one round instead of guessing. Prepend (not
    # replace) so the app's system prompt keeps priority in tone and
    # identity; this block only adds the execution contract.
    _EXECUTION_RULES = (
        "EXECUTION DISCIPLINE — evidence over narration (runtime-enforced):\n"
        "1. Execute, don't pretend: CALL the tool. Narrating what you would do without the call accomplishes nothing.\n"
        "2. No fabricated results: never report an HTTP status, install output, or API response unless the actual tool result containing it is in this conversation. Say 'not verified' when you lack evidence.\n"
        "3. No premature completion: before your final answer, compare the ORIGINAL request against what actually ran. Label the outcome COMPLETED / PARTIALLY_COMPLETED / BLOCKED / FAILED — never COMPLETED with unexecuted or unverified steps.\n"
        "4. Recover intelligently: read each error, classify it, change strategy. Calls with invalid arguments are refused with the exact field named — fix the arguments, do not repeat the call. An identical failing call is blocked after 3 attempts.\n"
        "5. Investigate before asking: discover missing information (request shapes, page controls, payloads) with run_terminal/use_browser — ask the user only for auth, irreversible approvals, or genuinely undiscoverable inputs.\n"
        "6. HTTP 200 is not functional success: verify the response structure and that returned data corresponds to your submitted input.\n"
        "7. Method provenance: if the user named an execution method, report honestly if you had to fall back to another.\n"
        "8. Milestones only: brief notes at real milestones; never a narration message that substitutes for the tool call.\n\n"
        "AUTONOMOUS PROBLEM SOLVING — the obstacle is input, not output:\n"
        "9. Solve the OBJECTIVE, not just the requested method: genuinely try a named method (check, install, start, verify, connect) before any DISCLOSED fallback — never silently substitute.\n"
        "10. Missing dependency = solvable: detect it, identify the environment (OS/arch/runtime), use the OFFICIAL install method (pip/npm/apt/vendor script), verify the install, retry the task.\n"
        "11. Discover your environment before declaring a capability absent: check what's installed (which, ls, pip list, npm ls), what engines run (the browser reports every rung tried), whether the capability can be ADDED.\n"
        "12. Research unfamiliar failures (official docs, GitHub issues) and APPLY the fix — research ends in an attempted solution, not a list.\n"
        "13. Build temporary workarounds when needed (scripts, harnesses, clients) — validated, cleaned up, and only when fixing the existing path is impractical.\n"
        "14. No permission-seeking for ordinary reversible work (sandbox installs, temp scripts, restarting your own browser, diagnostics) — do it. Ask only for money, production changes, data deletion, permission changes, or irreversible actions, naming the specific blocker.\n"
        "15. Forbidden passive exits: 'not available' (before investigating why), 'I'll use the default' (before trying the requested method), 'cannot execute' (undiagnosed), 'package missing' (before installing), 'environment unsupported' (before checking), 'would you like me to try another approach?' (try the best safe alternative yourself), 'I don't know the payload' (capture the real requests and find out)."
    )
    if messages and messages[0].get("role") == "system":
        messages[0]["content"] = _EXECUTION_RULES + "\n\n" + str(messages[0].get("content") or "")
    else:
        messages.insert(0, {"role": "system", "content": _EXECUTION_RULES})

    write_status("running", stage="thinking", round_no=0, total_rounds=total_rounds,
                 prompt_preview=prompt_preview)
    log("run %s starting — %d seed messages, model=%s" % (RUN_ID, len(messages), cfg.get("model")))
    write_json(HISTORY_PATH, messages)

    # Fresh replay stream + run-start marker for the SSE bridge.
    reset_events()
    MODEL_TRIES.clear()
    MODEL_TRIES.add(str(cfg.get("model") or ""))
    emit_event("run.started", {
        "prompt_preview": prompt_preview,
        "model": str(cfg.get("model") or ""),
        "fallback_models": [str(m) for m in (cfg.get("fallback_models") or []) if str(m)],
        "max_rounds": total_rounds,
        "seed_count": len(messages),
    })
    # v7: the heartbeat keeps agent_status.json fresh every 10s for the whole
    # run (long tools no longer freeze last_update) and carries the proof
    # fields — the outside watchdog can see a live process + token activity.
    start_heartbeat()

    use_tools = True
    final_text = ""
    failure = None
    # Tool-Execution PRD (2026-11-28): the run-scoped retry budget.
    retry_budget = RetryBudget()

    for round_no in range(1, total_rounds + 1):
        PROOF["round"] = round_no
        emit_event("round.started", {"round": round_no, "total_rounds": total_rounds})
        if round_no > 1:
            # CONTINUATION PROOF: this round only runs because the previous
            # round's tool results were appended to the context and sent back
            # to the provider — the counts prove the loop, not a restart.
            emit_event("provider.continuation_started", {
                "round": round_no,
                "tool_results_in_context": sum(1 for m in messages if m.get("role") == "tool"),
                "message_count": len(messages),
            })
        try:
            reply = llm_chat_with_retries(cfg, messages, use_tools)
        except LlmError as exc:
            failure = str(exc)
            break
        except Exception as exc:  # never let one bad round kill the status file
            failure = str(exc)
            break

        entry = {"role": "assistant", "content": reply.get("content") or ""}
        reasoning = str(reply.get("reasoning") or "")
        if reasoning:
            # Preserve the model's thinking in history — the landing converts
            # it into the message's thinking UI ("not even showing full
            # thinking" fix) and future rounds re-read it as context.
            entry["reasoning"] = reasoning
        tool_calls = reply.get("tool_calls") or []
        if tool_calls:
            entry["tool_calls"] = tool_calls
        messages.append(entry)
        write_json(HISTORY_PATH, messages)

        if not tool_calls:
            final_text = entry["content"]
            break

        first_name = ""
        for spec in tool_calls:
            fn = (spec or {}).get("function") or {}
            first_name = first_name or str(fn.get("name") or "")
        write_status("running", stage="tool", round_no=round_no, total_rounds=total_rounds,
                     current_tool=first_name or None, prompt_preview=prompt_preview)
        log("round %d/%d — %d tool call(s), first: %s" % (round_no, total_rounds, len(tool_calls), first_name))

        for spec in tool_calls:
            call_id = str((spec or {}).get("id") or ("call_%d" % int(now() * 1000)))
            fn = (spec or {}).get("function") or {}
            name = str(fn.get("name") or "")
            # IDEMPOTENCY KEY (PRD §4): run_id + the provider's call_id — a
            # reconnect/replay never re-executes a tool; the key identifies
            # THIS dispatch in every event, status field and the history.
            tool_execution_id = "texec_" + (call_id or ("cx_%d" % int(now() * 1000)))
            try:
                call_args = json.loads(fn.get("arguments") or "{}")
                if not isinstance(call_args, dict):
                    call_args = {"value": call_args}
            except Exception:
                call_args = None

            handler = TOOL_HANDLERS.get(name)
            emit_event("tool.started", {
                "call_id": call_id,
                "name": name,
                "tool_execution_id": tool_execution_id,
                "args": call_args if isinstance(call_args, dict) else None,
            })
            PROOF["tool_execution_id"] = tool_execution_id
            PROOF["tool_name"] = name
            dispatch_started = now()

            # ARGUMENT VALIDATION (Tool-Execution PRD Issue 4): check the
            # call against the tool's declared schema BEFORE dispatch. A
            # missing/empty required field or a wrong type is refused with
            # a structured INVALID_ARGUMENTS result — never executed, never
            # counted as executed, with the exact field named so the model
            # can fix the call in one round.
            args_ok = True
            args_issue = None
            if call_args is not None and handler is not None:
                args_ok, args_issue = _validate_tool_args(name, call_args)
            if not args_ok:
                invalid = {
                    "error": {
                        "code": args_issue.get("code", "INVALID_ARGUMENTS"),
                        "field": args_issue.get("field", ""),
                        "tool": name,
                        "message": (args_issue.get("message") or "Invalid arguments.")
                                   + " The call was NOT executed. Re-issue it with corrected arguments.",
                    }
                }
                result = json.dumps(invalid, ensure_ascii=False)
                dispatched = False
                retry_budget.record_failure(name, call_args if isinstance(call_args, dict) else {})
            elif handler is None:
                result = "error: unknown tool: " + name
                dispatched = False
            else:
                # RETRY BUDGET (Tool-Execution PRD Issue 3): gate literal
                # repetition of a failing call BEFORE dispatch.
                verdict, budget_msg = retry_budget.check(
                    name, call_args if isinstance(call_args, dict) else {})
                if verdict == "block":
                    blocked = {
                        "error": {
                            "code": "REPETITION_BLOCKED",
                            "tool": name,
                            "message": budget_msg,
                            "blocked": True,
                        }
                    }
                    result = json.dumps(blocked, ensure_ascii=False)
                    dispatched = False
                else:
                    # DISPATCH CONFIRMED (PRD §4): this event fires immediately
                    # before the handler runs — a tool card may only claim
                    # "executing" from this moment on, and tool.result carries
                    # the measured duration of the REAL execution.
                    dispatched = True
                    emit_event("tool.dispatched", {
                        "tool_execution_id": tool_execution_id,
                        "call_id": call_id,
                        "name": name,
                        "dispatch_confirmed": True,
                    })
                    try:
                        result = handler(call_args)
                    except Exception as exc:
                        result = "error: " + str(exc)
                    # Budget bookkeeping: a failure in this class escalates
                    # the next identical call; a success resets it. The
                    # advice note rides the result the model actually sees.
                    if str(result).startswith("error:") or _result_is_error(result):
                        retry_budget.record_failure(
                            name, call_args if isinstance(call_args, dict) else {})
                        if verdict == "advise" and budget_msg:
                            result = str(result) + "\n\n" + budget_msg
                    else:
                        retry_budget.record_success(
                            name, call_args if isinstance(call_args, dict) else {})
            if call_args is None:
                result = "error: tool arguments were not valid JSON"
                dispatched = False
            duration_ms = int((now() - dispatch_started) * 1000)

            if not isinstance(result, str):
                try:
                    result = json.dumps(result, ensure_ascii=False)
                except Exception:
                    result = str(result)
            result = truncate(result, TOOL_RESULT_MAX_CHARS)
            emit_event("tool.result", {
                "call_id": call_id,
                "name": name,
                "tool_execution_id": tool_execution_id,
                "dispatched": dispatched,
                "duration_ms": duration_ms,
                "ok": not str(result).startswith("error:"),
                "result": str(result)[:4000],
            })
            PROOF["tool_execution_id"] = None
            PROOF["tool_name"] = None
            messages.append({
                "role": "tool",
                "tool_call_id": call_id,
                "name": name,
                "content": result,
            })

        # Persist after EVERY round — a pause/kill mid-run still leaves a
        # consistent history + a resumable status on disk.
        write_json(HISTORY_PATH, messages)
        write_status("running", stage="thinking", round_no=round_no, total_rounds=total_rounds,
                     prompt_preview=prompt_preview)

    if failure is not None:
        stop_heartbeat()
        emit_event("run.failed", {"error": failure, "round": round_no})
        write_status("failed", stage="error", round_no=total_rounds, total_rounds=total_rounds,
                     error=failure, prompt_preview=prompt_preview, finished=True)
        log("run %s FAILED: %s" % (RUN_ID, failure))
        return 1

    if not final_text:
        # Round budget exhausted with tool calls still coming — close out
        # honestly instead of hanging forever.
        messages.append({
            "role": "assistant",
            "content": "I reached the background run's round budget (%d rounds) while still working. Here is everything I completed so far — re-run me to continue." % total_rounds,
        })
        write_json(HISTORY_PATH, messages)

    if DEGRADED and final_text and messages and messages[-1].get("role") == "assistant":
        # LOUD degradation — a one-round text answer must never land as a
        # silent mystery ("it's saving one round only"). The note rides the
        # final message content, so every landing path (live adoption,
        # reattach-on-return, append) shows it with zero client changes.
        note = ("\n\n_(Background-run note: the model gateway rejected tool calls for this"
                " run, so it could only answer as plain text — no sandbox tools were executed."
                " For full background runs, use a provider/model that supports function calling.)_")
        messages[-1]["content"] = (messages[-1].get("content") or "") + note
        final_text = messages[-1]["content"]
        write_json(HISTORY_PATH, messages)

    stop_heartbeat()
    emit_event("response.completed", {
        "content": final_text,
        "degraded": DEGRADED,
        "model": str(cfg.get("model") or ""),
        "streamed": STREAM_MODE == "on",
        "message_count": len(messages),
    })
    write_status("completed", stage="done", round_no=total_rounds, total_rounds=total_rounds,
                 prompt_preview=prompt_preview, finished=True)
    log("run %s completed after %d messages" % (RUN_ID, len(messages)))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        stop_heartbeat()
        write_status("stopped", finished=True)
        sys.exit(130)
    except Exception as fatal:
        stop_heartbeat()
        try:
            write_status("failed", stage="error", error=str(fatal), finished=True)
        except Exception:
            pass
        log("fatal: %s" % fatal)
        sys.exit(1)
`;

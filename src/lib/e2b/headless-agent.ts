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
 *  file into the sandbox whenever the stamp mismatches. */
export const HEADLESS_RUNNER_VERSION = 1;

export const RUNNER_PATH = "/home/user/headless_runner.py";
export const AGENT_DIR = "/home/user/.onyx/agent";
export const RUN_CONFIG_PATH = `${AGENT_DIR}/run.json`;
export const RUNNER_VERSION_PATH = `${AGENT_DIR}/runner-version`;
export const CHAT_HISTORY_PATH = "/home/user/chat_history.json";
export const AGENT_STATUS_PATH = "/home/user/agent_status.json";
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
import time
import urllib.error
import urllib.request

HOME = "/home/user"
CONFIG_PATH = HOME + "/.onyx/agent/run.json"
HISTORY_PATH = HOME + "/chat_history.json"
STATUS_PATH = HOME + "/agent_status.json"
TODOS_PATH = HOME + "/todos.json"

RUNNER_VERSION = 1
MAX_ROUNDS_DEFAULT = 24
TOOL_TIMEOUT_DEFAULT = 300
TOOL_TIMEOUT_MAX = 900
LLM_TIMEOUT_SECONDS = 240
LLM_RETRIES = 3
TOOL_RESULT_MAX_CHARS = 60000
READ_CHUNK_CHARS = 24000

# ---------------------------------------------------------------------------
# Tool schemas (OpenAI function format) — the sandbox-native surface. These
# are ALL sandbox-confined operations (terminal + filesystem inside the
# sandbox + the todos manifest), which is what makes an UNATTENDED loop
# safe: there is no browser, no vault, no host access from in here.
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

def tool_manage_todo(args):
    action = str(args.get("action") or "list")
    todos = load_todos()
    if action == "list":
        if not todos:
            return "(no todos)"
        return json.dumps(todos, ensure_ascii=False)
    if action == "add":
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
        tid = str(args.get("id") or "")
        for todo in todos:
            if todo.get("id") == tid:
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
        return "error: todo not found: " + tid
    if action == "remove":
        tid = str(args.get("id") or "")
        remaining = [t for t in todos if t.get("id") != tid]
        if len(remaining) == len(todos):
            return "error: todo not found: " + tid
        save_todos(remaining)
        return "removed " + tid
    return "error: unknown action: " + action

TOOL_HANDLERS = {
    "run_terminal": tool_run_terminal,
    "create_file": tool_create_file,
    "write_file": tool_create_file,
    "read_file": tool_read_file,
    "edit_file": tool_edit_file,
    "list_folder": tool_list_folder,
    "manage_todo": tool_manage_todo,
}

# ---------------------------------------------------------------------------
# LLM transport (stdlib urllib — no openai package needed)
# ---------------------------------------------------------------------------

class LlmError(Exception):
    def __init__(self, message, http_status=None):
        super(LlmError, self).__init__(message)
        self.http_status = http_status

def llm_chat(cfg, messages, use_tools):
    url = str(cfg.get("chat_url") or "")
    if not url:
        raise LlmError("run config is missing chat_url")
    api_key = str(cfg.get("api_key") or "")
    model = str(cfg.get("model") or "")

    body = {
        "model": model,
        "messages": messages,
        "stream": False,
    }
    temperature = cfg.get("temperature")
    if isinstance(temperature, (int, float)):
        body["temperature"] = temperature
    if use_tools:
        body["tools"] = TOOLS
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
    try:
        with urllib.request.urlopen(req, timeout=LLM_TIMEOUT_SECONDS) as resp:
            payload = json.loads(resp.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as exc:
        detail = ""
        try:
            detail = exc.read().decode("utf-8", "replace")[:500]
        except Exception:
            pass
        raise LlmError("HTTP %d from the model gateway: %s" % (exc.code, detail), exc.code)
    except Exception as exc:
        raise LlmError(str(exc))

    try:
        choice = payload["choices"][0]
        message = choice.get("message") or {}
        return {
            "content": message.get("content") or "",
            "tool_calls": message.get("tool_calls") or [],
            "finish_reason": choice.get("finish_reason"),
        }
    except (KeyError, IndexError, TypeError) as exc:
        raise LlmError("malformed gateway response: " + str(exc))

def llm_chat_with_retries(cfg, messages, use_tools):
    """Retry transient failures (429/5xx/network) with backoff. A 400 while
    tools are enabled triggers ONE tools-off retry (strict gateways / models
    without function support degrade to a text-only run)."""
    delay = 3.0
    last_error = None
    for attempt in range(1, LLM_RETRIES + 1):
        try:
            return llm_chat(cfg, messages, use_tools)
        except LlmError as exc:
            last_error = exc
            if exc.http_status == 400 and use_tools:
                log("gateway rejected the tools payload — degrading to a text-only run")
                return llm_chat(cfg, messages, False)
            transient = exc.http_status is None or exc.http_status in (408, 409, 429, 500, 502, 503, 504) or exc.http_status >= 500
            if not transient or attempt == LLM_RETRIES:
                raise
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
    }
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

    write_status("running", stage="thinking", round_no=0, total_rounds=total_rounds,
                 prompt_preview=prompt_preview)
    log("run %s starting — %d seed messages, model=%s" % (RUN_ID, len(messages), cfg.get("model")))
    write_json(HISTORY_PATH, messages)

    use_tools = True
    final_text = ""
    failure = None

    for round_no in range(1, total_rounds + 1):
        try:
            reply = llm_chat_with_retries(cfg, messages, use_tools)
        except LlmError as exc:
            failure = str(exc)
            break
        except Exception as exc:  # never let one bad round kill the status file
            failure = str(exc)
            break

        entry = {"role": "assistant", "content": reply.get("content") or ""}
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
            try:
                call_args = json.loads(fn.get("arguments") or "{}")
                if not isinstance(call_args, dict):
                    call_args = {"value": call_args}
            except Exception:
                call_args = None

            handler = TOOL_HANDLERS.get(name)
            if call_args is None:
                result = "error: tool arguments were not valid JSON"
            elif handler is None:
                result = "error: unknown tool: " + name
            else:
                try:
                    result = handler(call_args)
                except Exception as exc:
                    result = "error: " + str(exc)

            if not isinstance(result, str):
                try:
                    result = json.dumps(result, ensure_ascii=False)
                except Exception:
                    result = str(result)
            messages.append({
                "role": "tool",
                "tool_call_id": call_id,
                "name": name,
                "content": truncate(result, TOOL_RESULT_MAX_CHARS),
            })

        # Persist after EVERY round — a pause/kill mid-run still leaves a
        # consistent history + a resumable status on disk.
        write_json(HISTORY_PATH, messages)
        write_status("running", stage="thinking", round_no=round_no, total_rounds=total_rounds,
                     prompt_preview=prompt_preview)

    if failure is not None:
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

    write_status("completed", stage="done", round_no=total_rounds, total_rounds=total_rounds,
                 prompt_preview=prompt_preview, finished=True)
    log("run %s completed after %d messages" % (RUN_ID, len(messages)))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        write_status("stopped", finished=True)
        sys.exit(130)
    except Exception as fatal:
        try:
            write_status("failed", stage="error", error=str(fatal), finished=True)
        except Exception:
            pass
        log("fatal: %s" % fatal)
        sys.exit(1)
`;

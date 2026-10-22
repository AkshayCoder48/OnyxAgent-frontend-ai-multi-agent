"use client";

import { registerTool } from "./registry";
import { chatSandboxForCtx } from "@/lib/e2b/sandbox-rotation";
import { bumpWorkspaceVersion } from "./workspace-snapshot";

/**
 * SCHEDULED TASKS (sandbox cron) — Part 2 of the persistent-sandbox
 * architecture. The E2B sandbox is a full Linux box that stays alive for
 * up to 24h, so the standard Linux cron daemon inside it can run the
 * agent-authored scripts on a schedule — even while the user's app is
 * closed.
 *
 * Flow the model follows:
 *   1. `create_file` the script (e.g. nightly_audit.py) into the workspace.
 *   2. `schedule_agent_task` with a cron expression + the script name.
 *   3. `list_scheduled_tasks` shows the crontab + the cron_output.log tail.
 *   4. `remove_scheduled_task` clears one script's entries (or everything).
 *
 * Scheduled scripts commonly append `sched-…`-prefixed todos to
 * /home/user/todos.json — the detached-run sync merges those into the
 * conversation's todo list so they render in the UI when the user returns.
 *
 * CRON AVAILABILITY: the code-interpreter image ships crontab but NOT a
 * running daemon. The ensure-script below installs cron (best-effort,
 * non-interactive) and starts the daemon; when neither is possible the
 * tools report it honestly instead of pretending the schedule exists.
 */

const NO_KEY_ERROR =
  "Scheduled tasks require an E2B Sandbox API key. Add one in Settings → Config → E2B Sandbox.";

const CRON_LOG = "/home/user/cron_output.log";

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/** POSIX single-quote escaping for shell snippets. */
export function shellQuote(value: string): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * Validate a cron expression: five standard fields (minute hour day month
 * weekday — each allowing `*`, lists, ranges, steps) or one of the @
 * shorthands. NOT validated: month/day names + 6-field quarts syntax.
 */
export function validateCronExpression(expr: string): { ok: true } | { ok: false; error: string } {
  const trimmed = (expr ?? "").trim().replace(/\s+/g, " ");
  if (!trimmed) return { ok: false, error: "The cron expression is empty." };
  if (/^@(hourly|daily|midnight|weekly|monthly|reboot)$/.test(trimmed)) {
    return { ok: true };
  }
  const fields = trimmed.split(" ");
  if (fields.length !== 5) {
    return {
      ok: false,
      error: `A cron expression needs exactly 5 fields (minute hour day-of-month month day-of-week) — got ${fields.length}: "${trimmed}".`,
    };
  }
  const field = /^(?:\*|\d+|\d+-\d+|\d+\/\d+|\*\/\d+)(?:\s*(?:,)\s*(?:\*|\d+|\d+-\d+|\d+\/\d+|\*\/\d+))*$/;
  for (const f of fields) {
    if (!field.test(f)) {
      return { ok: false, error: `"${f}" is not a valid cron field (allowed: *, numbers, ranges 1-5, steps */5, comma lists).` };
    }
  }
  return { ok: true };
}

/** Validate a script name: workspace-relative, no escapes, must be an
 *  existing file the model already created. */
export function validateScriptName(name: string): { ok: true; clean: string } | { ok: false; error: string } {
  const trimmed = (name ?? "").trim().replace(/^\/+/, "");
  if (!trimmed) return { ok: false, error: "The script name is empty." };
  if (!/^[A-Za-z0-9._\-/]+$/.test(trimmed)) {
    return { ok: false, error: `The script name may only contain letters, digits, dot, dash, slash: "${trimmed}".` };
  }
  if (trimmed.includes("..") || trimmed.startsWith("/")) {
    return { ok: false, error: "The script name must stay inside the /home/user workspace." };
  }
  if (!/\.(py|sh)$/i.test(trimmed)) {
    return { ok: false, error: 'Only .py and .sh scripts can be scheduled.' };
  }
  return { ok: true, clean: trimmed };
}

/** The crontab line for one scheduled script. */
export function buildCronLine(cronExpression: string, scriptName: string): string {
  return `${cronExpression.trim().replace(/\s+/g, " ")} cd /home/user && python3 ${scriptName} >> ${CRON_LOG} 2>&1`;
}

/** Ensure crontab exists (install when missing, best-effort + non-root
 *  safe) and the cron daemon is running. Echoes a status marker. */
export const ENSURE_CRON_SCRIPT = [
  "if ! command -v crontab >/dev/null 2>&1; then",
  "  (apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq cron >/dev/null 2>&1)",
  "  || (sudo -n apt-get update -qq >/dev/null 2>&1 && sudo -n apt-get install -y -qq cron >/dev/null 2>&1)",
  "  || true",
  "fi",
  "if ! command -v crontab >/dev/null 2>&1; then echo CRON_MISSING; exit 0; fi",
  "if pgrep -x cron >/dev/null 2>&1 || pgrep -x crond >/dev/null 2>&1; then echo CRON_OK_RUNNING; exit 0; fi",
  "(cron >/dev/null 2>&1 || sudo -n cron >/dev/null 2>&1 || service cron start >/dev/null 2>&1 || sudo -n service cron start >/dev/null 2>&1 || /usr/sbin/cron >/dev/null 2>&1 || true)",
  "if pgrep -x cron >/dev/null 2>&1 || pgrep -x crond >/dev/null 2>&1; then echo CRON_OK_STARTED; else echo CRON_WARN_NO_DAEMON; fi",
].join("\n");

/** Idempotent inject: drop any exact duplicate of the line, then append it. */
export function buildCronInjectCommand(cronExpression: string, scriptName: string): string {
  const line = shellQuote(buildCronLine(cronExpression, scriptName));
  return [
    `LINE=${line}`,
    "(crontab -l 2>/dev/null | grep -vF -x \"$LINE\" || true; echo \"$LINE\") | crontab - && echo INJECTED",
  ].join("\n");
}

/** Remove every crontab entry that mentions the given script. */
export function buildCronRemoveCommand(scriptName: string): string {
  return `(crontab -l 2>/dev/null | grep -vF ${shellQuote(scriptName)} || true) | crontab - && echo REMOVED`;
}

/** Parse the ensure-script's marker into a structured verdict. */
export function parseCronEnsure(stdout: string): {
  crontabAvailable: boolean;
  daemon: "running" | "started" | "unavailable" | "unknown";
  marker: string;
} {
  const out = (stdout ?? "").trim();
  if (out.includes("CRON_MISSING")) {
    return { crontabAvailable: false, daemon: "unavailable", marker: "CRON_MISSING" };
  }
  if (out.includes("CRON_OK_RUNNING")) {
    return { crontabAvailable: true, daemon: "running", marker: "CRON_OK_RUNNING" };
  }
  if (out.includes("CRON_OK_STARTED")) {
    return { crontabAvailable: true, daemon: "started", marker: "CRON_OK_STARTED" };
  }
  if (out.includes("CRON_WARN_NO_DAEMON")) {
    return { crontabAvailable: true, daemon: "unavailable", marker: "CRON_WARN_NO_DAEMON" };
  }
  return { crontabAvailable: false, daemon: "unknown", marker: out.slice(0, 120) };
}

// ---------------------------------------------------------------------------
// Tool registrations
// ---------------------------------------------------------------------------

registerTool(
  "schedule_agent_task",
  `Schedule a Python/shell script (already created in the workspace via create_file) to run inside the E2B sandbox on a cron schedule — e.g. "*/30 * * * *" (every 30 min), "0 8 * * *" (daily 8:00), "@hourly". The sandbox runs up to 24h, so scheduled jobs keep firing even while the app is closed; output appends to /home/user/cron_output.log (read it with list_scheduled_tasks). Scripts can update /home/user/todos.json (id prefix "sched-") to surface results in the chat UI.`,
  {
    type: "object",
    properties: {
      cron_expression: {
        type: "string",
        description: 'Standard 5-field cron or @hourly/@daily/@weekly/@monthly, e.g. "*/15 * * * *", "30 8 * * *".',
      },
      script_name: {
        type: "string",
        description: "Workspace-relative script path, e.g. nightly_audit.py (create it first with create_file).",
      },
      description: {
        type: "string",
        description: "Optional human note about what this schedule does (recorded in the result).",
      },
    },
    required: ["cron_expression", "script_name"],
    additionalProperties: false,
  },
  async (args, ctx) => {
    const cronExpression = String(args.cron_expression ?? "");
    const scriptNameRaw = String(args.script_name ?? "");
    const note = args.description ? String(args.description) : undefined;

    const exprCheck = validateCronExpression(cronExpression);
    if (!exprCheck.ok) return { error: exprCheck.error };
    const nameCheck = validateScriptName(scriptNameRaw);
    if (!nameCheck.ok) return { error: nameCheck.error };
    const scriptName = nameCheck.clean;

    const sbx = await chatSandboxForCtx(ctx);
    if (!sbx) return { error: NO_KEY_ERROR };
    const client = sbx.client;

    // 1) Ensure crontab + daemon (installs cron on first use — slow-ish).
    const ensure = await client.exec(ENSURE_CRON_SCRIPT, { timeout: 120 });
    const verdict = parseCronEnsure(ensure.stdout + "\n" + ensure.stderr);
    if (!verdict.crontabAvailable) {
      return {
        error:
          "The sandbox image has no cron support (crontab missing and the install failed). Scheduled tasks are unavailable in this sandbox.",
        marker: verdict.marker,
      };
    }

    // 2) The script must already exist — never schedule a phantom.
    const exists = await client.exec(
      `test -f ${shellQuote(`/home/user/${scriptName}`)} && echo EXISTS || echo MISSING`,
      { timeout: 15 },
    );
    if (!(exists.stdout ?? "").includes("EXISTS")) {
      return {
        error: `Script not found: /home/user/${scriptName}. Create it first with create_file (e.g. write the python file), then schedule it.`,
      };
    }

    // 3) Inject (idempotent — re-scheduling the same pair replaces the entry).
    const inject = await client.exec(buildCronInjectCommand(cronExpression, scriptName), { timeout: 20 });
    if ((inject.exit_code ?? -1) !== 0 || !(inject.stdout ?? "").includes("INJECTED")) {
      return {
        error: `Failed to write the crontab entry: ${(inject.stderr || inject.stdout || "unknown error").slice(0, 300)}`,
      };
    }

    // 4) Extend the sandbox window to the full 24h NOW — scheduled tasks
    //    must keep firing while the app is closed, and the pagehide
    //    auto-pause is skipped for cron sandboxes (server-side cron guard).
    //    The keepalive action resets the E2B timeout countdown explicitly.
    void client.keepalive();

    bumpWorkspaceVersion();
    return {
      ok: true,
      message: `Scheduled ${scriptName} with pattern "${cronExpression.trim()}"${note ? ` — ${note}` : ""}.`,
      cron_expression: cronExpression.trim(),
      script_name: scriptName,
      cron_line: buildCronLine(cronExpression, scriptName),
      daemon: verdict.daemon,
      log: CRON_LOG,
      note: "Scheduled tasks run while the sandbox is alive (up to 24h; the sandbox is never auto-paused while schedules are installed — it pauses safely at the 24h limit and auto-resumes on your next visit). Check results with list_scheduled_tasks.",
    };
  },
  true, // requires_approval — modifies the sandbox's system scheduler
  "automation",
);

registerTool(
  "list_scheduled_tasks",
  "List the sandbox's scheduled cron tasks (created via schedule_agent_task) plus the tail of /home/user/cron_output.log — the run log the scheduled scripts append to. Use it to check what ran and what each job produced.",
  {
    type: "object",
    properties: {
      log_lines: {
        type: "integer",
        description: "How many trailing log lines to include (default 40).",
      },
    },
    required: [],
    additionalProperties: false,
  },
  async (args, ctx) => {
    const sbx = await chatSandboxForCtx(ctx);
    if (!sbx) return { error: NO_KEY_ERROR };
    const logLines = Math.min(Math.max(Number(args.log_lines) || 40, 5), 200);
    const res = await sbx.client.exec(
      [
        "echo __CRON_BEGIN__",
        "crontab -l 2>/dev/null || echo __NO_CRONTAB__",
        "echo __LOG_BEGIN__",
        `tail -n ${logLines} ${CRON_LOG} 2>/dev/null || echo __NO_LOG__`,
        "echo __END__",
      ].join("\n"),
      { timeout: 20 },
    );
    const out = res.stdout ?? "";
    const crontab = out
      .split("__CRON_BEGIN__")[1]?.split("__LOG_BEGIN__")[0]?.trim() ?? "";
    const logTail = out.split("__LOG_BEGIN__")[1]?.split("__END__")[0]?.trim() ?? "";
    const entries = crontab
      ? crontab
          .split("\n")
          .filter((l) => l.trim() && !l.startsWith("#") && l.includes("/home/user"))
          .map((line) => {
            const parts = line.trim().split(/\s+/);
            return {
              cron_expression: parts.slice(0, 5).join(" "),
              command: parts.slice(5).join(" "),
              script_name: parts.slice(5).join(" ").match(/python3\s+(\S+)/)?.[1] ?? null,
            };
          })
      : [];
    return {
      ok: true,
      entries,
      cron_available: !crontab.includes("__NO_CRONTAB__"),
      log_tail: logTail && !logTail.includes("__NO_LOG__") ? logTail : null,
      log_path: CRON_LOG,
      hint: entries.length === 0 ? "No scheduled tasks yet — create a script with create_file, then schedule_agent_task." : undefined,
    };
  },
  false,
  "automation",
);

registerTool(
  "remove_scheduled_task",
  "Remove scheduled cron tasks from the sandbox: every entry targeting one script (script_name), or ALL entries (all: true). Created by schedule_agent_task.",
  {
    type: "object",
    properties: {
      script_name: {
        type: "string",
        description: "Remove every cron entry that runs this script (workspace-relative path).",
      },
      all: {
        type: "boolean",
        description: "Remove the ENTIRE crontab (every scheduled task).",
      },
    },
    required: [],
    additionalProperties: false,
  },
  async (args, ctx) => {
    const sbx = await chatSandboxForCtx(ctx);
    if (!sbx) return { error: NO_KEY_ERROR };
    const all = args.all === true;
    const scriptName = args.script_name ? String(args.script_name) : "";
    if (!all && !scriptName) {
      return { error: "Pass script_name (remove one script's entries) or all: true (clear everything)." };
    }
    if (scriptName) {
      const check = validateScriptName(scriptName);
      if (!check.ok) return { error: check.error };
    }
    const command = all
      ? "crontab -r 2>/dev/null; echo CLEARED"
      : buildCronRemoveCommand(scriptName);
    const res = await sbx.client.exec(command, { timeout: 20 });
    const out = (res.stdout ?? "").trim();
    if ((res.exit_code ?? -1) !== 0) {
      return { error: `Failed to update the crontab: ${(res.stderr || "unknown error").slice(0, 300)}` };
    }
    bumpWorkspaceVersion();
    return {
      ok: true,
      message: all
        ? "Removed every scheduled task (crontab cleared)."
        : `Removed the scheduled entries for ${scriptName}.`,
      cleared_all: all,
      marker: out.slice(0, 60),
    };
  },
  true, // requires_approval — clears system scheduler state
  "automation",
);

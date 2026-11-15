#!/usr/bin/env python3
"""Trigger.dev removal — batch 1: mechanical single-block edits."""
import pathlib, sys

ROOT = pathlib.Path("/home/z/my-project/OnyxAgent-frontend-ai-multi-agent")
EDITS: list[tuple[str, str, str]] = []


def edit(rel: str, old: str, new: str) -> None:
    EDITS.append((rel, old, new))


# 1) projects/service.test.ts — verno pin 8 → 9 (v9 drops background_tasks)
edit(
    "src/lib/projects/service.test.ts",
    """    // v4 added the project tables; v5 added detached_runs (sandbox-agent
    // "close and resume"); v6 added the business tables; v7 added its
    // stores; v8 DROPS the business tables (Business Mode removal) — all
    // additive/destructive migrations, so a legacy v3 database upgrades
    // straight through to the current version.
    expect(app.verno).toBe(8);""",
    """    // v4 added the project tables; v5 added detached_runs (sandbox-agent
    // "close and resume"); v6 added the business tables; v7 added its
    // stores; v8 DROPS the business tables (Business Mode removal); v9
    // DROPS background_tasks (Trigger.dev removal) — all additive/destructive
    // migrations, so a legacy v3 database upgrades straight through to the
    // current version.
    expect(app.verno).toBe(9);""",
)

# 2) query-keys.ts — remove the tasks group
edit(
    "src/lib/query-keys.ts",
    """  tasks: {
    all: () => ["tasks"] as const,
    /** USER-SCOPED list of background task runs (use-background-tasks.ts). */
    list: (userId?: string) => ["tasks", "list", userId ?? "anon"] as const,
    /** Single run view with accumulated FR-3.2 progress chunks. */
    detail: (runId: string) => ["tasks", "run", runId] as const,
    /** FR-2.1 cron schedules (Settings → Schedules pane). */
    schedules: () => ["tasks", "schedules"] as const,
    /** Trigger.dev Cloud orchestrator config (Settings → API Keys). */
    cloudConfig: () => ["tasks", "cloud-config"] as const,
  },
""",
    "",
)

# 3) tool-display-names.ts — drop background_task
edit(
    "src/lib/tool-display-names.ts",
    '  remove_scheduled_tasks: "Scheduled Tasks",\n  background_task: "Background Task",\n',
    '  remove_scheduled_tasks: "Scheduled Tasks",\n',
)

# 4) tool-stack-summaries.ts — drop background_task
edit(
    "src/lib/tool-stack-summaries.ts",
    '  webcmd: rule("Ran", "Command"),\n  background_task: rule("Started", "Background Task", "Background Tasks"),\n',
    '  webcmd: rule("Ran", "Command"),\n',
)

# 5) tool-umbrella.ts — drop background_task from code_exec
edit(
    "src/lib/agent/tool-umbrella.ts",
    '  code_exec: ["run_python", "run_terminal", "background_task"],\n',
    '  code_exec: ["run_python", "run_terminal"],\n',
)

# 6) consolidated.ts — rewrite the code_exec description (no background_task;
#    run_terminal background:true now spawns detached in the sandbox)
edit(
    "src/lib/tools/consolidated.ts",
    """- "run_terminal" (command, background?) — shell with |, &&, ;, >. 120s timeout, 256KB cap. Pass background:true for jobs that would exceed it (durable, up to 30 min).
- "background_task" (action, …) — durable background runs (create / status / list / cancel) that survive tab close.`,
""",
    """- "run_terminal" (command, background?) — shell with |, &&, ;, >. 120s timeout, 256KB cap. Pass background:true to run the command DETACHED inside the sandbox (nohup-style, log file, survives app close) when it would exceed the budget.`,
""",
)

# 7) tools/index.ts — drop the background_task import
edit(
    "src/lib/tools/index.ts",
    'import "./sandbox_schedule";\nimport "./background_task";\nimport "./consolidated";\n',
    'import "./sandbox_schedule";\nimport "./consolidated";\n',
)

# 8) request-scoping.ts — comment
edit(
    "src/lib/tools/request-scoping.ts",
    "  // Code & execution (umbrella: run_python / run_terminal / background_task)\n",
    "  // Code & execution (umbrella: run_python / run_terminal)\n",
)

# 9) auth-store.ts — trim the dead turn-handoff reference in the historical note
edit(
    "src/stores/auth-store.ts",
    """ * null userId (Settings → E2B key save died with Dexie "Invalid key
 * provided", so the key NEVER persisted, so the pagehide turn-handoff
 * prewarm read no key and the close-handoff never fired: every running
 * turn died on refresh as "interrupted"). Anchoring the store instance on""",
    """ * null userId (Settings → E2B key save died with Dexie "Invalid key
 * provided", so the key NEVER persisted). Anchoring the store instance on""",
)

# 10) onyx-md.ts — drop the background_task row
edit(
    "src/lib/agent/onyx-md.ts",
    "| **move_file** | *(move or rename)* | Move a file to a new path, or rename in place (same dir + new name = rename). |\n| **background_task** | create · status · list · cancel | Durable background runs (E2B sandbox via Trigger.dev Cloud) — survive tab close, up to 30 min. |\n",
    "| **move_file** | *(move or rename)* | Move a file to a new path, or rename in place (same dir + new name = rename). |\n",
)

# 11) onyx-md-digest.ts — code_exec line
edit(
    "src/lib/agent/onyx-md-digest.ts",
    "- code_exec [run_python / run_terminal / background_task] — Python, shell, durable background runs in the sandbox.\n",
    "- code_exec [run_python / run_terminal] — Python + shell in the sandbox; run_terminal background=true runs a command detached (log file, survives app close).\n",
)

# 12) gen-onyx-md.ts — code_exec actions + blurb
edit(
    "scripts/gen-onyx-md.ts",
    """    actions: ["run_python", "run_terminal", "background_task"],
    blurb: "Python, shell, durable background runs in the sandbox.",""",
    """    actions: ["run_python", "run_terminal"],
    blurb: "Python + shell in the sandbox; run_terminal background=true runs a command detached (log file, survives app close).",""",
)

# 13) sandbox/route.ts — reword the starting-run-guard comment (beacon gone)
edit(
    "src/app/api/sandbox/route.ts",
    """        // STARTING-RUN GUARD: the pagehide turn-handoff beacon writes
        // run.json + a "starting" status BEFORE the Python runner boots —
        // pgrep cannot see it yet, and the pause beacon (fired by the same
        // unload) would freeze the run at birth. Skip while the status file
        // says starting/running or the run config is fresh (<3 minutes).""",
    """        // STARTING-RUN GUARD: the detached-run launcher (agent_start)
        // writes run.json + a "starting" status BEFORE the Python runner
        // boots — pgrep cannot see it yet, and a pause request arriving in
        // that window would freeze the run at birth. Skip while the status
        // file says starting/running or the run config is fresh (<3 minutes).""",
)

# 14) constants.ts — stale comment above RAG
edit(
    "src/lib/constants.ts",
    "  // Trigger.dev Cloud orchestration (Background Task Execution Framework).\n  RAG: \"/rag\",",
    "  RAG: \"/rag\",",
)

ok, fail = 0, []
for rel, old, new in EDITS:
    p = ROOT / rel
    text = p.read_text()
    if old not in text:
        fail.append(rel)
        continue
    if text.count(old) != 1:
        fail.append(f"{rel} (ambiguous: {text.count(old)} matches)")
        continue
    p.write_text(text.replace(old, new))
    ok += 1

print(f"applied {ok}/{len(EDITS)}")
if fail:
    print("FAILED:", *fail, sep="\n  ")
    sys.exit(1)

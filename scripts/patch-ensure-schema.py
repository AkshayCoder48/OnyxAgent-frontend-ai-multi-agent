#!/usr/bin/env python3
"""Insert `await ensureTasksSchema();` at the top of every exported HTTP
handler in the /api/tasks routes (see src/lib/tasks/prisma.ts — fresh
per-instance serverless databases have no tables until the DDL runs)."""
import re, sys

ROUTES = [
    "src/app/api/tasks/approval/route.ts",
    "src/app/api/tasks/artifact/[id]/route.ts",
    "src/app/api/tasks/cancel/route.ts",
    "src/app/api/tasks/schedules/[id]/route.ts",
    "src/app/api/tasks/schedules/route.ts",
    "src/app/api/tasks/status/route.ts",
    "src/app/api/tasks/sync/route.ts",
    "src/app/api/tasks/trigger/route.ts",
]

IMPORT_OLD = 'import { prisma } from "@/lib/tasks/prisma";'
IMPORT_NEW = 'import { ensureTasksSchema, prisma } from "@/lib/tasks/prisma";'
SIG_RE = re.compile(r"^(export async function (?:GET|POST|PATCH|DELETE|PUT)\()", re.M)

for route in ROUTES:
    src = open(route).read()
    if "ensureTasksSchema" in src:
        print(f"[skip] {route} (already guarded)")
        continue
    assert IMPORT_OLD in src, f"{route}: prisma import not found"
    src = src.replace(IMPORT_OLD, IMPORT_NEW, 1)
    out, count, i = [], 0, 0
    lines = src.split("\n")
    while i < len(lines):
        line = lines[i]
        out.append(line)
        if SIG_RE.match(line):
            # multi-line signature: advance to the line that opens the body
            j = i
            while j < len(lines) and not lines[j].rstrip().endswith("{"):
                j += 1
                out.append(lines[j])
            # sanity: the next line must not already be the guard
            assert j + 1 < len(lines), f"{route}: body not found after signature"
            out.append("  // Fresh per-instance serverless DBs have no tables until the DDL runs")
            out.append("  // (memoized singleton — free after the first call).")
            out.append("  await ensureTasksSchema();")
            count += 1
            i = j + 1
            continue
        i += 1
    assert count >= 1, f"{route}: no handlers patched"
    open(route, "w").write("\n".join(out))
    print(f"[ok] {route}: {count} handler(s) guarded")
print("done")

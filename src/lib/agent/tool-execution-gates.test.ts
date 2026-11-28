/**
 * Runtime integration of the Tool-Execution PRD gates (2026-11-28) —
 * source-level assertions on runtime.ts + the headless runner, the same
 * style the browser-driver tests use (the runtime's dispatch loop is a
 * 600-line closure that can't be unit-invoked; the CONTRACTS are what
 * must not silently regress):
 *
 *   · the arg-validation gate runs BEFORE the handler, is ledger-recorded,
 *     and returns the structured INVALID_ARGUMENTS shape;
 *   · the retry-budget gate blocks repetition before dispatch;
 *   · every settled tool result feeds the execution ledger + budget;
 *   · the completion check challenges on LEDGER disagreement even when
 *     the text looks like a final answer;
 *   · the runner (detached runs) has the same two gates inline;
 *   · both system prompts carry the PRD §4 execution rules.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const RUNTIME_SRC = readFileSync(join(__dirname, "runtime.ts"), "utf8");
const RUNNER_TS_SRC = readFileSync(
  join(__dirname, "..", "e2b", "headless-agent.ts"),
  "utf8",
);

describe("runtime.ts — argument validation gate (PRD Issue 4)", () => {
  it("imports the validator + structured result builder", () => {
    expect(RUNTIME_SRC).toContain(
      'import { validateToolArgs, invalidArgumentsResult } from "@/lib/tools/arg-validator";',
    );
  });

  it("validates BEFORE dispatch — the gate precedes the handler execution path", () => {
    const gateAt = RUNTIME_SRC.indexOf("validateToolArgs(execArgs, toolDef.parameters)");
    const handlerAt = RUNTIME_SRC.indexOf("execHandler", gateAt);
    const budgetAt = RUNTIME_SRC.indexOf("retryBudget.check(execName, execArgs)");
    expect(gateAt).toBeGreaterThan(-1);
    // Validation is the FIRST gate…
    expect(budgetAt).toBeGreaterThan(gateAt);
    // …and both precede the actual handler execution.
    expect(handlerAt).toBeGreaterThan(budgetAt);
  });

  it("a validation refusal is never executed: structured result + status error + ledger record", () => {
    const callAt = RUNTIME_SRC.indexOf("validateToolArgs(execArgs, toolDef.parameters)");
    // The gate block: from the `if (toolDef) {` that WRAPS the call (one
    // line above it) to the retry-budget comment that follows.
    const from = RUNTIME_SRC.lastIndexOf("if (toolDef) {", callAt);
    const to = RUNTIME_SRC.indexOf("// RETRY BUDGET", callAt);
    const gate = RUNTIME_SRC.slice(from, to);
    expect(gate).toContain("invalidArgumentsResult(execName, vres.issue, toolDef.parameters)");
    expect(gate).toContain('status: "error"');
    expect(gate).toContain("executionLedger.record(");
    expect(gate).toContain("not executed");
  });
});

describe("runtime.ts — retry budget gate (PRD Issue 3)", () => {
  it("blocks repetition BEFORE dispatch with a structured refusal", () => {
    const gate = RUNTIME_SRC.slice(
      RUNTIME_SRC.indexOf("const repetition = retryBudget.check(execName, execArgs);"),
      RUNTIME_SRC.indexOf("if (!toolDef) {", RUNTIME_SRC.indexOf("const repetition = retryBudget.check")),
    );
    expect(gate).toContain('repetition.action === "block"');
    expect(gate).toContain("RetryBudget.blockedResult");
    expect(gate).toContain("executionLedger.record(");
  });

  it("records every settled result into the ledger and budget", () => {
    const settle = RUNTIME_SRC.indexOf("ExecutionLedger.classify(result,");
    expect(settle).toBeGreaterThan(-1);
    expect(RUNTIME_SRC).toContain("retryBudget.recordFailure(execName, effectiveArgs)");
    expect(RUNTIME_SRC).toContain("retryBudget.recordSuccess(execName, effectiveArgs)");
    // The recovery advice is APPENDED to the tool result the model sees.
    expect(RUNTIME_SRC).toContain("RetryBudget.adviceNote(repetition, execName)");
  });

  it("the turn-scope constructs both ledgers", () => {
    expect(RUNTIME_SRC).toContain("const retryBudget = new RetryBudget();");
    expect(RUNTIME_SRC).toContain("const executionLedger = new ExecutionLedger();");
  });
});

describe("runtime.ts — ledger-aware completion validator (PRD Issue 2)", () => {
  it("the completion check triggers on LEDGER disagreement even when text looks final", () => {
    const checkAt = RUNTIME_SRC.indexOf("const ledgerVerdict = executionLedger.verdict();");
    expect(checkAt).toBeGreaterThan(-1);
    // The full condition block: text heuristic OR ledger disagreement,
    // still bounded by the max-challenges guard.
    const from = RUNTIME_SRC.indexOf("if (", RUNTIME_SRC.indexOf("const ledgerDisagrees ="));
    const to = RUNTIME_SRC.indexOf("completionChallenges += 1;", from);
    const condition = RUNTIME_SRC.slice(from, to);
    expect(condition).toContain("!looksLikeFinalAnswer(roundResult.content) || ledgerDisagrees");
    expect(condition).toContain("completionChallenges < 2");
  });

  it("the challenge carries the ledger statistics", () => {
    expect(RUNTIME_SRC).toContain("${ledgerVerdict.completion} — ${ledgerVerdict.summary}");
    expect(RUNTIME_SRC).toContain("Never report a task as complete when the ledger shows failures or unverified work");
  });

  it("ledgerDisagrees covers FAILED, PARTIALLY_COMPLETED and BLOCKED", () => {
    const block = RUNTIME_SRC.slice(
      RUNTIME_SRC.indexOf("const ledgerDisagrees ="),
      RUNTIME_SRC.indexOf("if (", RUNTIME_SRC.indexOf("const ledgerDisagrees =")),
    );
    expect(block).toContain('"FAILED"');
    expect(block).toContain('"PARTIALLY_COMPLETED"');
    expect(block).toContain('"BLOCKED"');
  });

  it("the system prompt carries the PRD §4 execution rules", () => {
    expect(RUNTIME_SRC).toContain("## EXECUTION DISCIPLINE — evidence over narration");
    expect(RUNTIME_SRC).toContain("No fabricated results");
    expect(RUNTIME_SRC).toContain("No premature completion");
    expect(RUNTIME_SRC).toContain("Recover intelligently");
    expect(RUNTIME_SRC).toContain("Investigate before asking");
    expect(RUNTIME_SRC).toContain("HTTP 200 ≠ success");
    expect(RUNTIME_SRC).toContain("Method provenance");
    expect(RUNTIME_SRC).toContain("Milestones only");
  });
});

describe("headless-agent.ts — the runner carries the same gates (detached runs)", () => {
  it("has the schema-lite validator wired before dispatch", () => {
    expect(RUNNER_TS_SRC).toContain("def _validate_tool_args(name, args):");
    expect(RUNNER_TS_SRC).toContain("args_ok, args_issue = _validate_tool_args(name, call_args)");
    // Structured refusal shape, never executed.
    expect(RUNNER_TS_SRC).toContain('"code": args_issue.get("code"');
    expect(RUNNER_TS_SRC).toContain("The call was NOT executed");
  });

  it("has the RetryBudget class wired before dispatch", () => {
    expect(RUNNER_TS_SRC).toContain("class RetryBudget:");
    expect(RUNNER_TS_SRC).toContain("verdict, budget_msg = retry_budget.check(");
    expect(RUNNER_TS_SRC).toContain('"code": "REPETITION_BLOCKED"');
    expect(RUNNER_TS_SRC).toContain("MAX_IDENTICAL_FAILURES = 3");
    expect(RUNNER_TS_SRC).toContain("MAX_RUN_FAILURES = 25");
  });

  it("records failures/successes and appends recovery advice to the result", () => {
    expect(RUNNER_TS_SRC).toContain("retry_budget.record_failure(");
    expect(RUNNER_TS_SRC).toContain("retry_budget.record_success(");
    expect(RUNNER_TS_SRC).toContain('if verdict == "advise" and budget_msg:');
  });

  it("prepends the execution-discipline rules to the seed system prompt", () => {
    expect(RUNNER_TS_SRC).toContain("_EXECUTION_RULES = (");
    expect(RUNNER_TS_SRC).toContain("EXECUTION DISCIPLINE — evidence over narration");
    expect(RUNNER_TS_SRC).toContain("No fabricated results");
    // Prepend (not replace) — the app's system prompt keeps priority.
    expect(RUNNER_TS_SRC).toContain('messages[0]["content"] = _EXECUTION_RULES + "\\n\\n" + str(messages[0].get("content") or "")');
  });
});

/**
 * Tool-Execution PRD acceptance tests (§8) for the three new runtime
 * modules. The runtime-level integration (dispatch gates in runtime.ts)
 * is covered by the runtime test file's source-level assertions; these
 * unit tests exercise the CONTRACTS:
 *
 *   Test A — missing tool arguments      → arg-validator refuses, names field
 *   Test C — repeated browser failures   → retry budget escalates then blocks
 *   Test D — fake completion prevention  → ledger verdict exposes failures
 *   Test E — HTTP 200 invalid function   → evidence classes separate them
 */
import { describe, it, expect } from "vitest";
import {
  validateToolArgs,
  invalidArgumentsResult,
} from "./arg-validator";
import { RetryBudget, stableArgsHash } from "./retry-budget";
import { ExecutionLedger } from "./execution-ledger";

// A representative schema: run_terminal (required string) and use_browser
// (required enum action + optional typed fields) — the two tools from the
// incident report.
const TERMINAL_SCHEMA = {
  type: "object",
  properties: {
    command: { type: "string", description: "The shell command to execute." },
    timeout_seconds: { type: "integer" },
  },
  required: ["command"],
};

const BROWSER_SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["navigate", "click", "type", "upload", "evaluate"] },
    url: { type: "string" },
    files: { type: "array", items: { type: "string" } },
    submit: { type: "boolean" },
  },
  required: ["action"],
};

describe("validateToolArgs (PRD Issue 4 / Test A)", () => {
  it("passes a valid call", () => {
    const r = validateToolArgs({ command: "npm install" }, TERMINAL_SCHEMA);
    expect(r.valid).toBe(true);
    expect(r.issue).toBeUndefined();
  });

  it("refuses a MISSING required field and names it exactly", () => {
    const r = validateToolArgs({ timeout_seconds: 30 }, TERMINAL_SCHEMA);
    expect(r.valid).toBe(false);
    expect(r.issue?.code).toBe("MISSING_REQUIRED_FIELD");
    expect(r.issue?.field).toBe("command");
    expect(r.issue?.message).toContain("command");
  });

  it("refuses an EMPTY-STRING required field (the observed 'empty command field' failure)", () => {
    const r = validateToolArgs({ command: "" }, TERMINAL_SCHEMA);
    expect(r.valid).toBe(false);
    expect(r.issue?.code).toBe("MISSING_REQUIRED_FIELD");
    expect(r.issue?.field).toBe("command");
  });

  it("refuses whitespace-only required fields", () => {
    const r = validateToolArgs({ command: "   " }, TERMINAL_SCHEMA);
    expect(r.valid).toBe(false);
    expect(r.issue?.field).toBe("command");
  });

  it("refuses a wrong TYPE and says what was expected", () => {
    const r = validateToolArgs({ command: 123 }, TERMINAL_SCHEMA);
    expect(r.valid).toBe(false);
    expect(r.issue?.code).toBe("INVALID_TYPE");
    expect(r.issue?.message).toContain("string");
  });

  it("refuses a non-enum value for enum fields", () => {
    const r = validateToolArgs({ action: "fly_to_moon" }, BROWSER_SCHEMA);
    expect(r.valid).toBe(false);
    expect(r.issue?.code).toBe("INVALID_VALUE");
    expect(r.issue?.field).toBe("action");
  });

  it("validates array item types", () => {
    const r = validateToolArgs({ action: "upload", files: [42] }, BROWSER_SCHEMA);
    expect(r.valid).toBe(false);
    expect(r.issue?.field).toBe("files[0]");
  });

  it("accepts optional fields of the right type", () => {
    const r = validateToolArgs({ action: "type", text: "hello", submit: true }, BROWSER_SCHEMA);
    expect(r.valid).toBe(true);
  });

  it("never rejects when the schema is unreadable (back-compat for hand-rolled parameters)", () => {
    expect(validateToolArgs({ anything: 1 }, null).valid).toBe(true);
    expect(validateToolArgs({ anything: 1 }, {}).valid).toBe(true);
  });

  it("the structured INVALID_ARGUMENTS payload carries code+field+hint", () => {
    const r = validateToolArgs({}, TERMINAL_SCHEMA);
    expect(r.valid).toBe(false);
    const payload = invalidArgumentsResult("run_terminal", r.issue!, TERMINAL_SCHEMA);
    expect(payload.error.code).toBe("MISSING_REQUIRED_FIELD");
    expect(payload.error.field).toBe("command");
    expect(payload.error.tool).toBe("run_terminal");
    expect(payload.error.message).toContain("NOT executed");
    // The hint shows the model the corrected-args shape so it can fix the
    // call in ONE round (no endless retry loop — Test A).
    expect(payload.error.hint).toContain("command");
  });
});

describe("RetryBudget (PRD Issue 3 / Test C)", () => {
  const browserCall = { action: "navigate", url: "https://imagedescriber.online" };

  it("first identical failure passes with retry advice", () => {
    const b = new RetryBudget();
    b.recordFailure("use_browser", browserCall);
    const v = b.check("use_browser", browserCall);
    expect(v.action).toBe("allow-with-advice");
    if (v.action === "allow-with-advice") {
      expect(v.tier).toBe("retry_advice");
      expect(RetryBudget.adviceNote(v, "use_browser")).toContain("RECOVERY NOTICE");
    }
  });

  it("second identical failure demands a strategy change", () => {
    const b = new RetryBudget();
    b.recordFailure("use_browser", browserCall);
    b.recordFailure("use_browser", browserCall);
    const v = b.check("use_browser", browserCall);
    expect(v.action).toBe("allow-with-advice");
    if (v.action === "allow-with-advice") {
      expect(v.tier).toBe("strategy_change");
      expect(RetryBudget.adviceNote(v, "use_browser")).toContain("STRATEGY CHANGE REQUIRED");
    }
  });

  it("third identical failure is BLOCKED before dispatch (Test C)", () => {
    const b = new RetryBudget();
    for (let i = 0; i < 3; i++) b.recordFailure("use_browser", browserCall);
    const v = b.check("use_browser", browserCall);
    expect(v.action).toBe("block");
    if (v.action === "block") {
      expect(v.reason).toBe("repetition_exhausted");
      const payload = RetryBudget.blockedResult("use_browser", v.reason, v.message);
      expect(payload.error.code).toBe("REPETITION_BLOCKED");
      expect(payload.error.blocked).toBe(true);
      expect(payload.error.message).toContain("3 times");
    }
  });

  it("a CHANGED argument set is a different call-class (legitimate iteration never blocked)", () => {
    const b = new RetryBudget();
    for (let i = 0; i < 3; i++) b.recordFailure("use_browser", browserCall);
    const v = b.check("use_browser", { action: "navigate", url: "https://other.example" });
    expect(v.action).toBe("allow");
  });

  it("a SUCCESS in the class resets it — a retry that worked ends the repetition concern", () => {
    const b = new RetryBudget();
    b.recordFailure("use_browser", browserCall);
    b.recordSuccess("use_browser", browserCall);
    expect(b.check("use_browser", browserCall).action).toBe("allow");
  });

  it("the task-level attempt budget caps total failures across DIFFERENT calls", () => {
    const b = new RetryBudget();
    for (let i = 0; i < 25; i++) b.recordFailure("run_terminal", { command: `cmd-${i}` });
    const v = b.check("run_terminal", { command: "fresh-call" });
    expect(v.action).toBe("block");
    if (v.action === "block") expect(v.reason).toBe("turn_budget_exhausted");
  });

  it("stableArgsHash is key-order insensitive (provider JSON key order varies)", () => {
    expect(stableArgsHash({ a: 1, b: [2, 3] })).toBe(stableArgsHash({ b: [2, 3], a: 1 }));
    expect(stableArgsHash({ a: 1 })).not.toBe(stableArgsHash({ a: 2 }));
  });
});

describe("ExecutionLedger (PRD Issues 2/7/8 / Tests D & E)", () => {
  it("records executed vs failed and reports honest counts", () => {
    const led = new ExecutionLedger();
    led.record({ id: "1", tool: "read_file", state: "executed", evidence: ["functional_ok"], externalBlocker: false, note: "" });
    led.record({ id: "2", tool: "use_browser", state: "failed", evidence: [], externalBlocker: false, note: "browser_error" });
    expect(led.attempted).toBe(2);
    expect(led.executed).toBe(1);
    expect(led.failed).toBe(1);
    expect(led.verified).toBe(1);
  });

  it("same id never double-records (idempotent against event replays)", () => {
    const led = new ExecutionLedger();
    const e = { id: "1", tool: "t", state: "executed" as const, evidence: [] as never[], externalBlocker: false, note: "" };
    led.record(e);
    led.record(e);
    expect(led.attempted).toBe(1);
  });

  it("Test E: HTTP 200 with placeholder data — http_ok but NOT functional_ok", () => {
    const cls = ExecutionLedger.classify(
      {
        http_status: 200,
        data: {
          code: 200,
          descList: [{ desc: "placeholder result", mdDesc: "<p>placeholder</p>" }],
        },
      },
      "completed",
    );
    // Wait — "placeholder" in the body should flag the placeholder class.
    expect(cls.state).toBe("executed");
    expect(cls.evidence).toContain("http_ok");
    expect(cls.evidence).toContain("schema_ok");
    expect(cls.evidence).toContain("placeholder");
    expect(cls.evidence).not.toContain("functional_ok");
  });

  it("Test E (positive): HTTP 200 with REAL analysis output is functional evidence", () => {
    const cls = ExecutionLedger.classify(
      {
        http_status: 200,
        data: {
          code: 200,
          descList: [
            {
              desc: "A frosted glass menu with soft shadows and rounded corners",
              plainText: "A frosted glass menu with soft shadows and rounded corners",
            },
          ],
        },
      },
      "completed",
    );
    expect(cls.evidence).toContain("http_ok");
    expect(cls.evidence).toContain("functional_ok");
    expect(cls.evidence).not.toContain("placeholder");
  });

  it("an error result with a browser-startup code is an EXTERNAL blocker", () => {
    const cls = ExecutionLedger.classify(
      { error: { type: "browser_startup_failed", message: "profile in use" } },
      "error",
    );
    expect(cls.state).toBe("failed");
    expect(cls.externalBlocker).toBe(true);
  });

  it("Test D: all-failed turns give FAILED/BLOCKED verdicts — never COMPLETED", () => {
    const led = new ExecutionLedger();
    led.record({ id: "1", tool: "run_terminal", state: "failed", evidence: [], externalBlocker: false, note: "exit 1" });
    led.record({ id: "2", tool: "run_terminal", state: "failed", evidence: [], externalBlocker: false, note: "exit 1" });
    const v = led.verdict();
    expect(v.completion).toBe("FAILED");
    expect(v.summary).toContain("no operation executed successfully");
  });

  it("executed-but-unverified work is PARTIALLY_COMPLETED (never COMPLETED)", () => {
    const led = new ExecutionLedger();
    led.record({ id: "1", tool: "web_fetch", state: "executed", evidence: ["http_ok"], externalBlocker: false, note: "" });
    const v = led.verdict();
    expect(v.completion).toBe("PARTIALLY_COMPLETED");
    expect(v.summary).toContain("none carried functional verification");
  });

  it("mixed turns are PARTIALLY_COMPLETED with the honest counts", () => {
    const led = new ExecutionLedger();
    led.record({ id: "1", tool: "use_browser", state: "executed", evidence: ["functional_ok"], externalBlocker: false, note: "" });
    led.record({ id: "2", tool: "use_browser", state: "failed", evidence: [], externalBlocker: false, note: "" });
    expect(led.verdict().completion).toBe("PARTIALLY_COMPLETED");
  });

  it("all-verified turns are COMPLETED", () => {
    const led = new ExecutionLedger();
    led.record({ id: "1", tool: "use_browser", state: "executed", evidence: ["functional_ok"], externalBlocker: false, note: "" });
    led.record({ id: "2", tool: "run_terminal", state: "executed", evidence: ["functional_ok"], externalBlocker: false, note: "" });
    expect(led.verdict().completion).toBe("COMPLETED");
  });

  it("no attempts at all is NOT_STARTED", () => {
    expect(new ExecutionLedger().verdict().completion).toBe("NOT_STARTED");
  });
});

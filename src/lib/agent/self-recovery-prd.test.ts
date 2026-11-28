/**
 * Self-Recovery PRD acceptance tests (§§2, 6, 11 / Tests 1-6) for the
 * recovery orchestrator + the runtime integration points.
 */
import { describe, it, expect } from "vitest";
import {
  classifyFailure,
  investigationDirective,
  objectiveVsMethod,
  isPassiveFailureResponse,
  MAX_DIRECTIVES_PER_CATEGORY,
} from "./recovery-orchestrator";

describe("classifyFailure — PRD §6 category matrix", () => {
  it("classifies a missing python module as missing_dependency (Test 2)", () => {
    const r = classifyFailure("run_terminal", {
      error: { message: "ModuleNotFoundError: No module named 'lightpanda'" },
    });
    expect(r.category).toBe("missing_dependency");
  });

  it("classifies command-not-found as missing_dependency (the CLI case)", () => {
    const r = classifyFailure("run_terminal", {
      error: { message: "sh: lightpanda: command not found" },
    });
    expect(r.category).toBe("missing_dependency");
  });

  it("classifies browser_startup_failed as browser_failure (Test 1)", () => {
    const r = classifyFailure("use_browser", {
      error: { type: "browser_startup_failed", message: "profile in use" },
    });
    expect(r.category).toBe("browser_failure");
  });

  it("classifies the engine capability gate as environment_limitation", () => {
    const r = classifyFailure("use_browser", {
      error: { type: "unsupported_capability", message: "no screenshots" },
    });
    expect(r.category).toBe("environment_limitation");
  });

  it("classifies runtime-refused repetition as repetition_blocked (Test 6)", () => {
    const r = classifyFailure("run_terminal", {
      error: { code: "REPETITION_BLOCKED", message: "identical call failed 3 times" },
    });
    expect(r.category).toBe("repetition_blocked");
  });

  it("classifies invalid-arguments refusals (the arg gate)", () => {
    const r = classifyFailure("use_browser", {
      error: { code: "MISSING_REQUIRED_FIELD", field: "action" },
    });
    expect(r.category).toBe("invalid_arguments");
  });

  it("classifies DNS/connection as network_failure; timeouts separately", () => {
    expect(
      classifyFailure("web_fetch", { error: { message: "getaddrinfo ENOTFOUND example.com" } }).category,
    ).toBe("network_failure");
    expect(
      classifyFailure("run_terminal", { error: { message: "command timed out after 30s" } }).category,
    ).toBe("timeout");
  });

  it("classifies 401/403 as auth_failure (the ONE legitimate ask-user case)", () => {
    expect(
      classifyFailure("web_fetch", { error: { message: "401 Unauthorized: missing API key" } }).category,
    ).toBe("auth_failure");
  });

  it("classifies permission denied as permission_failure", () => {
    expect(
      classifyFailure("run_terminal", { error: { message: "mkdir: permission denied" } }).category,
    ).toBe("permission_failure");
  });

  it("falls back to browser_failure for the browser tool, unknown otherwise", () => {
    expect(classifyFailure("use_browser", { error: { message: "weird" } }).category).toBe("browser_failure");
    expect(classifyFailure("run_terminal", { error: { message: "mystery" } }).category).toBe("unknown");
  });
});

describe("investigationDirective — the loop under the failure", () => {
  it("contains the category, the concrete steps and the forbidden exits", () => {
    const d = investigationDirective("missing_dependency", "run_terminal", 1, 1);
    expect(d).toBeTruthy();
    expect(d!).toContain("MISSING DEPENDENCY");
    // PRD §4's workflow: identify env → official method → install → verify.
    expect(d!).toContain("OFFICIAL installation method");
    expect(d!).toContain("Verify the installed version");
    expect(d!).toContain("FORBIDDEN final responses");
    expect(d!).toContain("would you like me to try another approach?");
  });

  it("the browser directive demands genuine effort on the requested engine (Test 5)", () => {
    const d = investigationDirective("browser_failure", "use_browser", 1, 1);
    expect(d!).toContain("investigate ITS install/boot requirements before substituting");
    expect(d!).toContain("DISCLOSING the switch as a fallback");
  });

  it("the repetition directive forces a strategy change (Test 6)", () => {
    const d = investigationDirective("repetition_blocked", "run_terminal", 1, 1);
    expect(d!).toContain("MUST change strategy");
    expect(d!).toContain("BLOCKED");
  });

  it("is bounded: the (MAX+1)th directive of a category is null (no noise)", () => {
    expect(investigationDirective("network_failure", "t", MAX_DIRECTIVES_PER_CATEGORY + 1, 1)).toBeNull();
    expect(investigationDirective("network_failure", "t", MAX_DIRECTIVES_PER_CATEGORY, 1)).toBeTruthy();
  });
});

describe("objectiveVsMethod — PRD §2 (solve the objective, not the method)", () => {
  it("splits 'use Lightpanda to test the API' into objective + method", () => {
    const { objective, method } = objectiveVsMethod("Use Lightpanda to test the Image Describer API");
    expect(method).toBe("lightpanda");
    expect(objective.toLowerCase()).toContain("test");
    expect(objective.toLowerCase()).not.toContain("use lightpanda");
  });

  it("no method named → objective is the whole prompt, method undefined", () => {
    const { objective, method } = objectiveVsMethod("Summarize this article");
    expect(method).toBeUndefined();
    expect(objective).toBe("Summarize this article");
  });
});

describe("isPassiveFailureResponse — PRD §11 forbidden exits", () => {
  it("catches every documented bad response", () => {
    expect(isPassiveFailureResponse("Lightpanda is not available on this system.")).toBe(true);
    expect(isPassiveFailureResponse("I'll use the default browser instead.")).toBe(true);
    expect(isPassiveFailureResponse("I cannot execute this in the current environment.")).toBe(true);
    expect(isPassiveFailureResponse("The package is missing so the test cannot run.")).toBe(true);
    expect(isPassiveFailureResponse("The environment does not support this feature.")).toBe(true);
    expect(isPassiveFailureResponse("Would you like me to try another approach?")).toBe(true);
    expect(isPassiveFailureResponse("I don't have access to that resource.")).toBe(true);
  });

  it("does not flag honest completion reports", () => {
    expect(isPassiveFailureResponse("All three tests passed; here are the verified results.")).toBe(false);
    expect(isPassiveFailureResponse("BLOCKED: the API requires a paid key — the specific blocker is the missing credential.")).toBe(false);
  });
});

describe("runtime integration — the wiring contract (source-level)", () => {
  it("runtime.ts imports and uses the orchestrator", async () => {
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync("src/lib/agent/runtime.ts", "utf8"),
    );
    expect(src).toContain('from "@/lib/agent/recovery-orchestrator"');
    // Directive appended to the failed tool result.
    expect(src).toContain("classifyFailure(execName, result)");
    expect(src).toContain("investigationDirective(");
    expect(src).toContain("recoveryCategoryCounts");
    // Passive-exit challenge.
    expect(src).toContain("isPassiveFailureResponse(roundResult.content)");
    expect(src).toContain("PASSIVE FAILURE EXIT");
    // Objective/method context in the challenge.
    expect(src).toContain("objectiveVsMethod(");
    expect(src).toContain("The user's request names a METHOD");
    // The prompt rules.
    expect(src).toContain("## AUTONOMOUS PROBLEM SOLVING — the obstacle is input, not output");
    expect(src).toContain("The passive exits are forbidden");
  });

  it("headless-agent.ts carries the same rules for detached runs", async () => {
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync("src/lib/e2b/headless-agent.ts", "utf8"),
    );
    expect(src).toContain("AUTONOMOUS PROBLEM SOLVING");
    expect(src).toContain("Solve the OBJECTIVE, not just the requested method");
    expect(src).toContain("Forbidden passive exits");
  });

  it("browser-driver.ts has the Lightpanda primary rung + capability gate", async () => {
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync("src/lib/e2b/browser-driver.ts", "utf8"),
    );
    // Primary rung before the stealth engines.
    const lp = src.indexOf("attempt 0 (PRIMARY): Lightpanda");
    const cloak = src.indexOf("attempt 1: CloakBrowser");
    expect(lp).toBeGreaterThan(-1);
    expect(cloak).toBeGreaterThan(lp);
    // Install via the OFFICIAL vendor script (pinned).
    expect(src).toContain("curl -fsSL https://pkg.lightpanda.io/install.sh");
    // CDP connect + serving probe.
    expect(src).toContain('connect_over_cdp(LIGHTPANDA_CDP)');
    expect(src).toContain("def _lightpanda_serving");
    // Capability gate with escape hatch + port handover.
    expect(src).toContain("def capability_gate");
    expect(src).toContain("wanted_capabilities");
    expect(src).toContain("def _stop_lightpanda");
    // Live cast skipped on the non-rendering engine.
    expect(src).toContain('if runtime == "lightpanda"');
  });

  it("use_browser.ts exposes wanted_capabilities in the schema", async () => {
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync("src/lib/tools/use_browser.ts", "utf8"),
    );
    expect(src).toContain("wanted_capabilities");
    expect(src).toContain('enum: ["visual"]');
    expect(src).toContain("Lightpanda");
  });

  it("chat header has no browser button; the ⋮ menu keeps access", async () => {
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync("src/components/chat/chat-workspace.tsx", "utf8"),
    );
    // The header button block was removed…
    expect(src).not.toContain('title="Browser (live view)"');
    // …and the menu entry exists.
    expect(src).toContain("Browser live view");
    expect(src).toContain("moved here from the header");
  });
});

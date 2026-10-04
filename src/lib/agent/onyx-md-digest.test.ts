// @vitest-environment node
/**
 * PRD §13/§14/§38 — tool-availability GROUND TRUTH parity tests.
 *
 * The TOOL DIGEST (onyx-md-digest.ts, generated from Onyx.md) is injected
 * into every system prompt so the model can never truthfully-lack or
 * falsely-deny knowledge of a registered tool. These tests pin the digest
 * to the LIVE registry (both directions) so drift is impossible:
 *
 *   registry ➜ digest   a tool registered in src/lib/tools but missing from
 *                       the digest = the model is never told it exists
 *                       (the original "I don't have access to that tool"
 *                       hallucination).
 *   digest ➜ registry   a tool in the digest that isn't registered = the
 *                       prompt advertises a tool the runtime can't execute.
 *
 * Also enforced: the digest size budget (small providers reject fat
 * prompts), the sandbox-native tool-name parity between the bg runner's
 * TOOLS array and BG_NATIVE_TOOL_NAMES, and the idempotent injection
 * helper used by every prompt path.
 *
 * If a test here fails after adding/removing/renaming a tool: update the
 * Onyx.md "Tool Compendium" tables, then run
 *   bun run scripts/gen-onyx-md.ts
 * to regenerate onyx-md.ts + onyx-md-digest.ts.
 */
import { describe, it, expect } from "vitest";
import "@/lib/tools/index"; // side-effect: registers every built-in tool
import { listTools } from "@/lib/tools/registry";
import { ONYX_MD_DIGEST, ONYX_MD_DIGEST_TOOLS } from "./onyx-md-digest";
import { TOOL_DIGEST_MARKER, ensureToolDigest, hasToolDigest } from "./tool-digest";
import { BG_NATIVE_TOOL_NAMES } from "@/lib/e2b/bg-native-tools";
import { BG_AGENT_SCRIPT } from "@/lib/e2b/bg-agent-script";

const registryNames = (): string[] => listTools().map((t) => t.name);

/** Native sandbox-only tools (in the bg runner's TOOLS array with FULL
 * descriptions + parameter schemas, but NOT registered in the browser
 * registry — they run entirely inside the sandbox). They must not be
 * advertised in the digest (foreground agent turns cannot call them — that
 * would violate the anti-hallucination rules), so they are exempt from the
 * registry and digest parity checks below. */
const NATIVE_ONLY_TOOLS = new Set(["start_web_session", "manage_web_session"]);

/** Tool names mentioned in digest list lines ("- name — ..."). */
const digestListedNames = (): string[] =>
  [...ONYX_MD_DIGEST.matchAll(/^- ([a-z0-9_]+)[ —[]/gm)].map((m) => m[1]!);

describe("tool digest ⇄ registry parity (PRD §13/§14)", () => {
  it("every REGISTERED tool appears in the digest (no invisible tools)", () => {
    const registered = registryNames();
    expect(registered.length).toBeGreaterThanOrEqual(50); // sanity: the side-effect imports registered the toolset
    const listed = new Set(digestListedNames());
    const missing = registered.filter((n) => !listed.has(n));
    expect(missing, `tools registered but absent from the digest: ${missing.join(", ")}. Update Onyx.md's Tool Compendium and re-run scripts/gen-onyx-md.ts`).toEqual([]);
  });

  it("every digest tool exists in the registry (no phantom tools)", () => {
    const registered = new Set(registryNames());
    const phantom = digestListedNames().filter((n) => !registered.has(n));
    expect(phantom, `digest advertises unregistered tools: ${phantom.join(", ")}. Remove them from Onyx.md's Tool Compendium and re-run scripts/gen-onyx-md.ts`).toEqual([]);
  });

  it("ONYX_MD_DIGEST_TOOLS matches the digest text exactly", () => {
    expect([...ONYX_MD_DIGEST_TOOLS]).toEqual(digestListedNames());
  });

  it("digest stays within the prompt budget (≤8KB)", () => {
    const bytes = Buffer.byteLength(ONYX_MD_DIGEST, "utf8");
    expect(bytes).toBeLessThanOrEqual(8192);
  });

  it("digest carries the anti-hallucination rules, both directions", () => {
    expect(ONYX_MD_DIGEST.startsWith(TOOL_DIGEST_MARKER)).toBe(true);
    // Never deny a tool you have:
    expect(ONYX_MD_DIGEST).toMatch(/NEVER say "I don't have access to that tool"/i);
    expect(ONYX_MD_DIGEST).toMatch(/if a tool is in your tool definitions, you HAVE it/i);
    // Never claim a tool you don't have:
    expect(ONYX_MD_DIGEST).toMatch(/never claim or call a tool that is absent from your definitions/i);
    // Availability is runtime-grounded, not memory/manual-grounded:
    expect(ONYX_MD_DIGEST).toMatch(/defined ONLY by your active tool definitions this turn/i);
    // Full manual pointer kept (detailed usage still lives in Onyx.md):
    expect(ONYX_MD_DIGEST).toMatch(/\/home\/user\/Onyx\.md/);
  });
});

describe("sandbox runner tool parity (bg-agent)", () => {
  it("every bg-native tool name is a registered browser tool (or native sandbox-only)", () => {
    const registered = new Set(registryNames());
    const phantom = [...BG_NATIVE_TOOL_NAMES].filter(
      (n) => !registered.has(n) && !NATIVE_ONLY_TOOLS.has(n),
    );
    expect(phantom, `BG_NATIVE_TOOL_NAMES lists unregistered tools: ${phantom.join(", ")}`).toEqual([]);
  });

  it("the bg runner's TOOLS array matches BG_NATIVE_TOOL_NAMES exactly", () => {
    const scriptTools = [...BG_AGENT_SCRIPT.matchAll(/\n {4}name: "([a-z0-9_]+)",/g)].map((m) => m[1]!);
    expect(new Set(scriptTools)).toEqual(new Set(BG_NATIVE_TOOL_NAMES));
    // ...and every REGISTRY-DOCUMENTED script tool is digest-documented (the
    // runner's slim name-only list relies on the digest for capabilities).
    // Native sandbox-only tools carry full descriptions inside the script
    // itself and are exempt (see NATIVE_ONLY_TOOLS).
    const digestNames = new Set(ONYX_MD_DIGEST_TOOLS);
    const undocumented = scriptTools.filter(
      (n) => !digestNames.has(n) && !NATIVE_ONLY_TOOLS.has(n),
    );
    expect(undocumented, `bg runner tools missing from the digest: ${undocumented.join(", ")}`).toEqual([]);
  });
});

describe("ensureToolDigest injection helper", () => {
  it("appends the digest to a bare prompt exactly once", () => {
    const injected = ensureToolDigest("You are a test agent.");
    expect(hasToolDigest(injected)).toBe(true);
    expect(injected).toContain("You are a test agent.");
    expect(injected.match(new RegExp(TOOL_DIGEST_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))!.length).toBe(1);
  });

  it("is idempotent — a prompt that already carries the digest is returned unchanged", () => {
    const once = ensureToolDigest("base prompt");
    expect(ensureToolDigest(once)).toBe(once);
  });
});

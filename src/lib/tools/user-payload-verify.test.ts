/**
 * Direct verification with the user's EXACT reported payload (message 2):
 *   toolName: GOOGLEDRIVE_FIND_FILE
 *   args: "{\"q\": \"name contains 'clip'\", \"corpora\": \"allDrives\", ...}"
 * — a double-stringified JSON object with embedded single quotes.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/composio/browser", () => ({
  resolveComposioHeaders: async () => ({
    "x-composio-key": "test-key",
    "x-composio-user": "u1",
    "x-composio-session": "s-test",
  }),
  persistComposioSessionId: async () => undefined,
}));
vi.mock("@/lib/composio/branding", () => ({ recordToolToolkits: () => undefined }));

import { getTool } from "./registry";
import { coerceComposioArgs } from "./composio_tools";
import "./index"; // registers built-ins

// The user's verbatim arguments block (from the report):
const USER_PAYLOAD = {
  toolName: "GOOGLEDRIVE_FIND_FILE",
  args:
    '{"q": "name contains \'clip\'", "corpora": "allDrives", "supportsAllDrives": true, "includeItemsFromAllDrives": true}',
};

let wire: Record<string, unknown> | null = null;

describe("user-reported GOOGLEDRIVE_FIND_FILE payload (message 2)", () => {
  it("coerceComposioArgs parses the exact string", () => {
    const out = coerceComposioArgs(USER_PAYLOAD.args);
    expect(out).toEqual({
      q: "name contains 'clip'",
      corpora: "allDrives",
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
  });

  it("the registered handler EXECUTES it — no 'args must be an object' error", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: { body?: string }) => {
      wire = JSON.parse(init?.body ?? "{}");
      return new Response(JSON.stringify({ ok: true, sessionId: "s1", data: { items: [] } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const tool = getTool("composio_execute_tool")!;
    const r = await tool.handler(USER_PAYLOAD as never, { userId: "u1" } as never);
    vi.unstubAllGlobals();

    expect(r.success).toBe(true);
    expect((r as { error?: string }).error).toBeUndefined();
    // The wire body carries the PARSED object, not the string:
    expect(wire).toEqual({
      toolName: "GOOGLEDRIVE_FIND_FILE",
      args: {
        q: "name contains 'clip'",
        corpora: "allDrives",
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      },
    });
  });

  it("the umbrella path (integrations action) also works with string args", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: { body?: string }) => {
      wire = JSON.parse(init?.body ?? "{}");
      return new Response(JSON.stringify({ ok: true, sessionId: "s1", data: null }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const umbrella = getTool("integrations")!;
    const r = await umbrella!.handler(
      {
        action: "composio_execute_tool",
        toolName: "GOOGLEDRIVE_FIND_FILE",
        args: USER_PAYLOAD.args,
      } as never,
      { userId: "u1" } as never,
    );
    vi.unstubAllGlobals();

    expect(r.success ?? (r as { ok?: boolean }).ok ?? true).not.toBe(false);
    expect((r as { error?: string }).error).toBeUndefined();
    expect(wire).toEqual({
      toolName: "GOOGLEDRIVE_FIND_FILE",
      args: {
        q: "name contains 'clip'",
        corpora: "allDrives",
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      },
    });
  });
});

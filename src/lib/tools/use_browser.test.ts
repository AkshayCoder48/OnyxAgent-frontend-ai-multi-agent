/**
 * use_browser tool tests — the AI-facing contract of the CloakBrowser + E2B
 * reimplementation (2026-11-01).
 *
 * PRD §5/§7 pinned here:
 *  - the handler NEVER throws — every failure resolves to a structured
 *    result so the agent always receives an answer;
 *  - every result carries kind/success/action/output/error/durationMs,
 *    with `output` non-empty on BOTH success and failure;
 *  - argument validation fails fast with actionable messages;
 *  - unknown actions enumerate the supported set (one-round self-correction).
 *
 * The sandbox layer is mocked at chatSandboxForCtx; the REAL
 * sendBrowserCommand pipeline (browser-session.ts) runs underneath against
 * a fake sandbox client that speaks the driver file protocol.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "@/lib/tools/registry";

const hoisted = vi.hoisted(() => ({
  client: null as unknown,
}));

vi.mock("@/lib/e2b/sandbox-rotation", () => ({
  chatSandboxForCtx: vi.fn(async () => ({
    apiKey: "test-key",
    conversationId: null,
    mode: "shared" as const,
    client: hoisted.client,
  })),
  ensureFreshSandbox: vi.fn(async () => undefined),
  resolveSandboxApiKey: vi.fn(async () => "test-key"),
}));

import { getTool } from "@/lib/tools/registry";
import "@/lib/tools/index"; // side-effect: registers the built-ins
import { __browserTimeoutsOverride, resetBrowserSessionCache, type BrowserSandboxClient } from "@/lib/e2b/browser-session";
import { BROWSER_DRIVER_VERSION } from "@/lib/e2b/browser-driver";

// ---------------------------------------------------------------------------
// Fake sandbox client (same file protocol as browser-session.test.ts)
// ---------------------------------------------------------------------------

interface FakeOpts {
  onCommand?: (cmd: Record<string, unknown>) => Record<string, unknown>;
  hangExec?: boolean;
}

function makeFakeClient(opts: FakeOpts = {}): BrowserSandboxClient & { files: Map<string, string> } {
  const files = new Map<string, string>();
  const resFiles = new Map<string, string>();
  return {
    files,
    async writeFile(path, content) {
      files.set(path, content);
      if (path.endsWith("/cmd.json")) {
        const cmd = JSON.parse(content) as Record<string, unknown>;
        const id = String(cmd.id ?? "");
        const payload = opts.onCommand
          ? opts.onCommand(cmd)
          : {
              success: true,
              action: String(cmd.action),
              url: "https://example.com/",
              title: "Example Domain",
              status: 200,
              runtime: "cloakbrowser",
              output: "Navigated to Example Domain (https://example.com/).",
            };
        resFiles.set(`/home/user/.onyx/browser/res-${id}.json`, JSON.stringify(payload));
      }
    },
    async readFile(path) {
      if (resFiles.has(path)) return resFiles.get(path)!;
      if (files.has(path)) return files.get(path)!;
      throw new Error(`ENOENT: ${path}`);
    },
    async *runCommandStream(command: string) {
      if (opts.hangExec) await new Promise(() => {});
      if (command.includes('echo "READY"') || command.includes("echo READY")) {
        yield { type: "stdout", data: "READY" };
        yield { type: "result", exit_code: 0 };
        return;
      }
      if (command.includes(".version")) {
        yield { type: "stdout", data: BROWSER_DRIVER_VERSION };
        yield { type: "result", exit_code: 0 };
        return;
      }
      if (command.includes("import cloakbrowser")) {
        yield { type: "stdout", data: "RUNTIME_PRESENT" };
        yield { type: "result", exit_code: 0 };
        return;
      }
      if (command.includes("echo booting")) {
        yield { type: "stdout", data: "booting" };
        yield { type: "result", exit_code: 0 };
        return;
      }
      yield { type: "result", exit_code: 0 };
    },
  };
}

function makeCtx(over: Partial<ToolContext> = {}): ToolContext {
  return {
    userId: "test-user",
    emit: vi.fn(),
    e2bApiKey: "test-key",
    ...over,
  } as ToolContext;
}

beforeEach(() => {
  resetBrowserSessionCache();
  Object.assign(__browserTimeoutsOverride, {
    httpCallMs: 40,
    streamDeadline: 60,
    bootPollIntervalMs: 5,
    resultPollIntervalMs: 5,
  });
});

// ---------------------------------------------------------------------------

describe("use_browser — validation (fail fast, structured, never throws)", () => {
  it("rejects an unknown action by enumerating the supported set", async () => {
    hoisted.client = makeFakeClient();
    const tool = getTool("use_browser")!;
    const res = (await tool.handler({ action: "teleport" }, makeCtx())) as Record<string, unknown>;
    expect(res.success).toBe(false);
    expect(res.kind).toBe("browser");
    const err = res.error as { type: string; message: string };
    expect(err.type).toBe("bad_request");
    expect(err.message).toContain("navigate");
    expect(err.message).toContain("extract_text");
    expect(typeof res.output).toBe("string");
    expect((res.output as string).length).toBeGreaterThan(0);
  });

  it.each([
    [{ action: "navigate" }, "url is required for action 'navigate'."],
    [{ action: "download" }, "url or target is required for action 'download'."],
    [{ action: "evaluate" }, "code is required for action 'evaluate'."],
    [{ action: "select" }, "value is required for action 'select'."],
  ])("validates required args: %j", async (args, message) => {
    hoisted.client = makeFakeClient();
    const tool = getTool("use_browser")!;
    const res = (await tool.handler(args, makeCtx())) as Record<string, unknown>;
    expect(res.success).toBe(false);
    expect((res.error as { message: string }).message).toBe(message);
  });
});

describe("use_browser — the structured output contract (PRD §5)", () => {
  it("a navigate result carries url/title/output/screenshot/error/durationMs + passthrough", async () => {
    hoisted.client = makeFakeClient();
    const tool = getTool("use_browser")!;
    const res = (await tool.handler({ action: "navigate", url: "https://example.com" }, makeCtx())) as Record<string, unknown>;
    expect(res.kind).toBe("browser");
    expect(res.success).toBe(true);
    expect(res.action).toBe("navigate");
    expect(res.url).toBe("https://example.com/");
    expect(res.title).toBe("Example Domain");
    expect(res.output).toBe("Navigated to Example Domain (https://example.com/).");
    expect(res.screenshot).toBeNull();
    expect(res.error).toBeNull();
    expect(typeof res.durationMs).toBe("number");
    expect(res.runtime).toBe("cloakbrowser");
  });

  it("a screenshot result exposes the dataUrl as `screenshot`", async () => {
    hoisted.client = makeFakeClient({
      onCommand: (cmd) => ({
        success: true,
        action: String(cmd.action),
        dataUrl: "data:image/png;base64,AAAA",
        path: "/home/user/.onyx/browser/shots/shot-1.png",
        output: "Screenshot captured.",
      }),
    });
    const tool = getTool("use_browser")!;
    const res = (await tool.handler({ action: "screenshot" }, makeCtx())) as Record<string, unknown>;
    expect(res.success).toBe(true);
    expect(res.screenshot).toBe("data:image/png;base64,AAAA");
    expect(res.output).toBe("Screenshot captured.");
  });

  it("synthesizes a readable output when the driver reply lacks one", async () => {
    hoisted.client = makeFakeClient({
      onCommand: (cmd) => ({ success: true, action: String(cmd.action), url: "https://x.example/", title: "X" }),
    });
    const tool = getTool("use_browser")!;
    const res = (await tool.handler({ action: "navigate", url: "https://x.example" }, makeCtx())) as Record<string, unknown>;
    expect(res.success).toBe(true);
    expect((res.output as string).trim().length).toBeGreaterThan(0);
  });

  it("a driver error surfaces structured + readable, success:false", async () => {
    hoisted.client = makeFakeClient({
      onCommand: () => ({
        success: false,
        error: { type: "element_not_found", message: "locator resolved to 0 elements: #missing" },
      }),
    });
    const tool = getTool("use_browser")!;
    const res = (await tool.handler({ action: "click", target: "#missing" }, makeCtx())) as Record<string, unknown>;
    expect(res.success).toBe(false);
    expect((res.error as { type: string }).type).toBe("element_not_found");
    expect(res.output).toContain("element_not_found");
    expect(typeof res.durationMs).toBe("number");
  });

  it("a hung sandbox resolves as a structured timeout — the tool NEVER hangs or throws", async () => {
    hoisted.client = makeFakeClient({ hangExec: true });
    const tool = getTool("use_browser")!;
    const res = (await tool.handler({ action: "navigate", url: "https://example.com" }, makeCtx())) as Record<string, unknown>;
    expect(res.success).toBe(false);
    expect((res.error as { type: string }).type).toBe("browser_startup_failed");
    expect(typeof res.output).toBe("string");
    expect((res.output as string).length).toBeGreaterThan(0);
  }, 8_000);

  it("no sandbox key resolves to the actionable sandbox_unavailable error", async () => {
    const rotation = await import("@/lib/e2b/sandbox-rotation");
    vi.mocked(rotation.chatSandboxForCtx).mockResolvedValueOnce(null);
    const tool = getTool("use_browser")!;
    const res = (await tool.handler({ action: "navigate", url: "https://example.com" }, makeCtx())) as Record<string, unknown>;
    expect(res.success).toBe(false);
    expect((res.error as { type: string }).type).toBe("sandbox_unavailable");
    expect((res.error as { message: string }).message).toContain("E2B Sandbox API key");
  });

  it("progress lines narrate the lifecycle through onToolOutput", async () => {
    hoisted.client = makeFakeClient();
    const onToolOutput = vi.fn();
    const tool = getTool("use_browser")!;
    await tool.handler({ action: "navigate", url: "https://example.com" }, makeCtx({ onToolOutput }));
    const lines = onToolOutput.mock.calls.map((c) => String(c[1]));
    expect(lines.some((l) => l.includes("Browser navigate started."))).toBe(true);
  });
});

describe("use_browser — schema surface (PRD §5 + compat aliases)", () => {
  it("registers the full action enum including the PRD core", () => {
    const tool = getTool("use_browser")!;
    const en = (tool.parameters as { properties: { action: { enum: string[] } } }).properties.action.enum;
    for (const a of ["navigate", "screenshot", "snapshot", "click", "type", "scroll", "extract_text", "inspect", "wait", "back", "forward", "close"]) {
      expect(en).toContain(a);
    }
    // compat aliases stay accepted (old conversations keep working)
    for (const a of ["read", "get_page", "get_elements", "press", "evaluate", "select", "upload", "download", "new_tab", "switch_tab", "close_tab", "go_back", "go_forward", "reload", "refresh", "screen_record"]) {
      expect(en).toContain(a);
    }
  });
});

// ---------------------------------------------------------------------------
// remember_page — the KB auto-ingest action (KB deepening, 2026-11-05).
// The driver captures the page; the CLIENT handler saves it to the OnyxBase
// Knowledge Base through the shared remember-page pipeline.
// ---------------------------------------------------------------------------

vi.mock("@/lib/kb/remember-page", () => ({
  rememberPageToKB: vi.fn(),
}));

import { rememberPageToKB } from "@/lib/kb/remember-page";

const REMEMBER_PAYLOAD = {
  success: true,
  action: "remember_page",
  url: "https://docs.example.com/guide",
  title: "The Guide",
  text: "Page body text worth keeping.",
  textLength: 29,
  truncated: false,
  navLog: [{ url: "https://docs.example.com/", title: "Home", ts: 1730000000000 }],
  output: "Captured \"The Guide\" (https://docs.example.com/guide) — 29 chars of page text, 1 pages in this session's history.",
};

describe("use_browser — remember_page (KB auto-ingest)", () => {
  it("captures the page and saves it to the KB (ai source, note + history defaults)", async () => {
    hoisted.client = makeFakeClient({ onCommand: () => ({ ...REMEMBER_PAYLOAD }) });
    const saved = vi.mocked(rememberPageToKB).mockResolvedValueOnce({
      ok: true,
      item: { id: "kb_abc123", title: "The Guide" } as never,
      contentChars: 4200,
      historyIncluded: true,
    });
    const tool = getTool("use_browser")!;
    const res = (await tool.handler(
      { action: "remember_page", note: "The canonical guide — decision made from it" },
      makeCtx(),
    )) as Record<string, unknown>;

    // the save call carries the capture + the curated note
    expect(saved).toHaveBeenCalledWith("test-user", {
      url: "https://docs.example.com/guide",
      title: "The Guide",
      text: "Page body text worth keeping.",
      note: "The canonical guide — decision made from it",
      navLog: REMEMBER_PAYLOAD.navLog,
      includeHistory: true,
      source: "ai",
    });
    // the result announces the saved item
    expect(res.success).toBe(true);
    expect(res.saved).toBe(true);
    expect(res.kbId).toBe("kb_abc123");
    expect(res.kbTitle).toBe("The Guide");
    expect(res.historyIncluded).toBe(true);
    expect((res.output as string)).toContain("kb_abc123");
    expect((res.output as string)).toContain("browse history included");
  });

  it("include_history:false flows through to the save", async () => {
    hoisted.client = makeFakeClient({ onCommand: () => ({ ...REMEMBER_PAYLOAD }) });
    const saved = vi.mocked(rememberPageToKB).mockResolvedValueOnce({
      ok: true,
      item: { id: "kb_nohist", title: "The Guide" } as never,
      contentChars: 10,
      historyIncluded: false,
    });
    const tool = getTool("use_browser")!;
    await tool.handler({ action: "remember_page", include_history: false }, makeCtx());
    const call = saved.mock.calls.at(-1)![1]!;
    expect(call).toMatchObject({ includeHistory: false });
  });

  it("an honest KB failure fails the tool with the message — the capture rides along", async () => {
    hoisted.client = makeFakeClient({ onCommand: () => ({ ...REMEMBER_PAYLOAD }) });
    vi.mocked(rememberPageToKB).mockResolvedValueOnce({
      ok: false,
      code: "NOT_CONFIGURED",
      message: "Remembering pages needs an OnyxBase key.",
    });
    const tool = getTool("use_browser")!;
    const res = (await tool.handler({ action: "remember_page" }, makeCtx())) as Record<string, unknown>;
    expect(res.success).toBe(false);
    expect((res.error as { type: string }).type).toBe("kb_not_configured");
    expect((res.error as { message: string }).message).toContain("OnyxBase key");
    expect((res.output as string)).toContain("OnyxBase key");
    // the captured page text still reaches the model
    expect(res.text).toBe("Page body text worth keeping.");
  });

  it("the schema exposes remember_page + note + include_history", () => {
    const tool = getTool("use_browser")!;
    const params = tool.parameters as {
      properties: Record<string, { enum?: string[]; type?: string }>;
    };
    expect(params.properties.action.enum).toContain("remember_page");
    expect(params.properties.note?.type).toBe("string");
    expect(params.properties.include_history?.type).toBe("boolean");
  });
});


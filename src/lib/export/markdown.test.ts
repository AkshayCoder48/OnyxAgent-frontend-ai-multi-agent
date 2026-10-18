import { describe, expect, it } from "vitest";
import {
  buildMarkdownExport,
  exportTitle,
  speakerLabel,
} from "./markdown";
import { splitCodeSegments, stripCodeBlocks, hasCodeBlocks } from "./segments";
import type { ExportConversation, ExportMessage, ExportOptions } from "./types";

/* ---------------------------------------------------------------------------
 * Test fixtures — a small but representative conversation: user asks about
 * migrations, assistant answers with a fenced code block and a tool call.
 * ------------------------------------------------------------------------ */

function msg(partial: Partial<ExportMessage> & Pick<ExportMessage, "id" | "role">): ExportMessage {
  return {
    content: "",
    created_at: "2026-02-03T14:05:00.000Z",
    ...partial,
  };
}

const CONVERSATION: ExportConversation = {
  title: "Database Architecture",
  created_at: "2026-02-03T13:00:00.000Z",
  messages: [
    msg({
      id: "m1",
      role: "user",
      created_at: "2026-02-03T14:05:00.000Z",
      content: "How should we structure database migrations?",
      file_names: ["schema.png"],
    }),
    msg({
      id: "m2",
      role: "assistant",
      created_at: "2026-02-03T14:06:00.000Z",
      model_name: "gpt-4o",
      content:
        "The migration strategy should preserve compatibility.\n\n```sql\nALTER TABLE users\n  ADD COLUMN project_id TEXT;\n```\n\nThat keeps old rows valid.",
      tool_calls: [
        {
          tool_name: "web_search",
          status: "completed",
          duration_ms: 123,
          result_summary: "Found 5 results",
        },
      ],
    }),
  ],
};

const ALL_ON: ExportOptions = {
  title: undefined,
  includeTimestamps: true,
  includeSpeakers: true,
  includeToolCalls: true,
  includeCode: true,
  includeFileNames: true,
  includeToc: false,
  pageNumbers: false,
  projectName: "OnyxAgent Development",
  exportDate: "2026-10-18",
};

/* ------------------------------------------------------------------------ */

describe("buildMarkdownExport — header", () => {
  it("renders the PRD example structure: # title, Project:, Exported:", () => {
    const md = buildMarkdownExport(CONVERSATION, "clean", ALL_ON);
    expect(md).toContain("# Database Architecture");
    expect(md).toContain("Project: OnyxAgent Development");
    expect(md).toContain("Exported: 2026-10-18");
  });

  it("uses the title override when provided", () => {
    const md = buildMarkdownExport(CONVERSATION, "clean", { ...ALL_ON, title: "Custom Title" });
    expect(md).toContain("# Custom Title");
    expect(md).not.toContain("# Database Architecture");
  });

  it("falls back to 'Conversation' for an empty title", () => {
    expect(exportTitle({ ...CONVERSATION, title: "" }, ALL_ON)).toBe("Conversation");
    expect(exportTitle(CONVERSATION, { ...ALL_ON, title: "   " })).toBe("Conversation");
  });

  it("omits the Project line when no projectName is set", () => {
    const md = buildMarkdownExport(CONVERSATION, "clean", { ...ALL_ON, projectName: null });
    expect(md).not.toContain("Project:");
  });
});

describe("buildMarkdownExport — ordering", () => {
  it("preserves the original message order (user before assistant)", () => {
    const md = buildMarkdownExport(CONVERSATION, "clean", ALL_ON);
    const userHeading = md.indexOf("## USER");
    const assistantHeading = md.indexOf("## ASSISTANT");
    expect(userHeading).toBeGreaterThanOrEqual(0);
    expect(assistantHeading).toBeGreaterThan(userHeading);
    expect(md.indexOf("How should we structure")).toBeLessThan(
      md.indexOf("The migration strategy"),
    );
  });

  it("renders every message — none silently dropped", () => {
    const conv: ExportConversation = {
      ...CONVERSATION,
      messages: Array.from({ length: 12 }, (_, i) =>
        msg({ id: `m${i}`, role: i % 2 === 0 ? "user" : "assistant", content: `Message ${i}` }),
      ),
    };
    const md = buildMarkdownExport(conv, "clean", ALL_ON);
    for (let i = 0; i < 12; i++) expect(md).toContain(`Message ${i}`);
  });
});

describe("buildMarkdownExport — content toggles", () => {
  it("omits speaker headings when includeSpeakers is off", () => {
    const md = buildMarkdownExport(CONVERSATION, "clean", { ...ALL_ON, includeSpeakers: false });
    expect(md).not.toContain("## USER");
    expect(md).not.toContain("## ASSISTANT");
    // Message bodies still present, in order.
    expect(md.indexOf("How should we structure")).toBeLessThan(md.indexOf("The migration strategy"));
  });

  it("omits timestamps but keeps the model name when includeTimestamps is off", () => {
    const md = buildMarkdownExport(CONVERSATION, "clean", { ...ALL_ON, includeTimestamps: false });
    expect(md).not.toContain("14:05");
    expect(md).not.toContain("14:06");
    expect(md).toContain("*gpt-4o*");
  });

  it("omits the Tool Activity block when includeToolCalls is off", () => {
    const md = buildMarkdownExport(CONVERSATION, "clean", { ...ALL_ON, includeToolCalls: false });
    expect(md).not.toContain("Tool Activity");
    expect(md).not.toContain("web_search");
  });

  it("omits the Files line when includeFileNames is off", () => {
    const md = buildMarkdownExport(CONVERSATION, "clean", { ...ALL_ON, includeFileNames: false });
    expect(md).not.toContain("**Files:**");
    expect(md).not.toContain("schema.png");
  });

  it("includes the Files line with backticked names when on", () => {
    const md = buildMarkdownExport(CONVERSATION, "clean", ALL_ON);
    expect(md).toContain("**Files:** `schema.png`");
  });
});

describe("buildMarkdownExport — code fencing", () => {
  it("preserves fenced code blocks verbatim when includeCode is on", () => {
    const md = buildMarkdownExport(CONVERSATION, "clean", ALL_ON);
    expect(md).toContain("```sql\nALTER TABLE users\n  ADD COLUMN project_id TEXT;\n```");
  });

  it("replaces fenced code blocks with a placeholder when includeCode is off", () => {
    const md = buildMarkdownExport(CONVERSATION, "clean", { ...ALL_ON, includeCode: false });
    expect(md).not.toContain("ALTER TABLE");
    expect(md).toContain("[Code block omitted]");
    expect(md).toContain("That keeps old rows valid.");
  });

  it("keeps prose around a replaced block, marking exactly one omission per block", () => {
    const twoBlocks = msg({
      id: "m3",
      role: "assistant",
      content: "before\n```js\nlet a = 1;\n```\nmiddle\n```py\nx = 2\n```\nafter",
    });
    const md = buildMarkdownExport(
      { ...CONVERSATION, messages: [twoBlocks] },
      "clean",
      { ...ALL_ON, includeCode: false },
    );
    expect(md.match(/\[Code block omitted\]/g)).toHaveLength(2);
    for (const part of ["before", "middle", "after"]) expect(md).toContain(part);
    expect(md).not.toContain("let a");
  });
});

describe("buildMarkdownExport — tool activity blocks", () => {
  it("renders the PRD-style attribute bullets for a completed tool", () => {
    const md = buildMarkdownExport(CONVERSATION, "clean", ALL_ON);
    expect(md).toContain("### Tool Activity");
    expect(md).toContain("- Tool: web_search");
    expect(md).toContain("- Status: Completed");
    expect(md).toContain("- Duration: 123 ms");
    expect(md).toContain("- Result: Found 5 results");
  });

  it("renders Failed status and clusters multiple tools with a blank line", () => {
    const conv: ExportConversation = {
      ...CONVERSATION,
      messages: [
        msg({
          id: "m1",
          role: "assistant",
          content: "ran tools",
          tool_calls: [
            { tool_name: "read_file", status: "failed" },
            { tool_name: "web_search", status: "completed", duration_ms: 2500 },
          ],
        }),
      ],
    };
    const md = buildMarkdownExport(conv, "clean", ALL_ON);
    expect(md).toContain("- Tool: read_file");
    expect(md).toContain("- Status: Failed");
    expect(md).toContain("- Tool: web_search");
    expect(md).toContain("- Duration: 2.5 s");
    // Clusters separated by exactly one blank line.
    expect(md).toContain("- Status: Failed\n\n- Tool: web_search");
  });

  it("renders no Tool Activity when the message has no tool records", () => {
    const conv: ExportConversation = {
      ...CONVERSATION,
      messages: [msg({ id: "m1", role: "user", content: "hi" })],
    };
    const md = buildMarkdownExport(conv, "clean", ALL_ON);
    expect(md).not.toContain("Tool Activity");
  });
});

describe("buildMarkdownExport — layouts", () => {
  it("numbers messages like [001] USER in the technical layout", () => {
    const md = buildMarkdownExport(CONVERSATION, "technical", ALL_ON);
    expect(md).toContain("## [001] USER");
    expect(md).toContain("## [002] ASSISTANT");
  });

  it("separates messages with --- rules in professional/technical layouts", () => {
    for (const layout of ["professional", "technical"] as const) {
      const md = buildMarkdownExport(CONVERSATION, layout, ALL_ON);
      expect(md).toContain("\n---\n");
    }
  });

  it("has no horizontal rules in clean/compact layouts", () => {
    for (const layout of ["clean", "compact"] as const) {
      const md = buildMarkdownExport(CONVERSATION, layout, ALL_ON);
      expect(md).not.toContain("\n---\n");
    }
  });
});

describe("buildMarkdownExport — formatting details", () => {
  it("ends with a single trailing newline and no 3+ blank lines", () => {
    const md = buildMarkdownExport(CONVERSATION, "professional", ALL_ON);
    expect(md.endsWith("\n")).toBe(true);
    expect(md.endsWith("\n\n")).toBe(false);
    expect(md).not.toMatch(/\n{3,}/);
  });

  it("formats timestamps deterministically as UTC", () => {
    const md = buildMarkdownExport(CONVERSATION, "clean", ALL_ON);
    expect(md).toContain("*2026-02-03 14:05 UTC*");
    expect(md).toContain("*2026-02-03 14:06 UTC · gpt-4o*");
  });
});

/* ------------------------------------------------------------------------ */

describe("splitCodeSegments", () => {
  it("splits alternating text and code segments", () => {
    const segs = splitCodeSegments("a\n```ts\nconst x = 1;\n```\nb");
    expect(segs).toEqual([
      { type: "text", text: "a" },
      { type: "code", text: "const x = 1;", lang: "ts" },
      { type: "text", text: "b" },
    ]);
  });

  it("treats an unclosed fence as code to the end", () => {
    const segs = splitCodeSegments("intro\n```python\nprint(1)");
    expect(segs).toEqual([
      { type: "text", text: "intro" },
      { type: "code", text: "print(1)", lang: "python" },
    ]);
  });

  it("only closes a fence with the same character", () => {
    const segs = splitCodeSegments("~~~\n``` stays code\n~~~\nafter");
    expect(segs).toEqual([
      { type: "code", text: "``` stays code", lang: "" },
      { type: "text", text: "after" },
    ]);
  });

  it("detects code blocks", () => {
    expect(hasCodeBlocks("plain text")).toBe(false);
    expect(hasCodeBlocks("plain\n```js\nx\n```")).toBe(true);
  });

  it("stripCodeBlocks replaces blocks with the placeholder", () => {
    expect(stripCodeBlocks("x\n```\ny\n```\nz")).toBe("x\n[Code block omitted]\nz");
  });
});

describe("speakerLabel", () => {
  it("maps roles to display labels", () => {
    expect(speakerLabel("user")).toBe("USER");
    expect(speakerLabel("assistant")).toBe("ASSISTANT");
  });
});

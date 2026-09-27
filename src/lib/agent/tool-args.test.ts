import { describe, expect, it } from "vitest";
import {
  malformedToolResult,
  parseToolCallArguments,
  repairTruncatedJson,
  wireSafeArguments,
} from "./tool-args";

describe("repairTruncatedJson", () => {
  it("returns null for empty or non-object input", () => {
    expect(repairTruncatedJson("")).toBeNull();
    expect(repairTruncatedJson("   ")).toBeNull();
    expect(repairTruncatedJson("not json at all")).toBeNull();
    expect(repairTruncatedJson('"just a string"')).toBeNull();
  });

  it("returns valid JSON unchanged (as a candidate)", () => {
    expect(repairTruncatedJson('{"a":1}')).toBe('{"a":1}');
  });

  it("closes a missing brace — the Create File case", () => {
    expect(repairTruncatedJson('{"path": "/home/user/gym_cutting_diet.md"')).toBe(
      '{"path": "/home/user/gym_cutting_diet.md"}',
    );
  });

  it("closes an unterminated string value", () => {
    expect(repairTruncatedJson('{"path": "/home/user/gym')).toBe(
      '{"path": "/home/user/gym"}',
    );
  });

  it("handles escaped quotes inside truncated strings", () => {
    expect(repairTruncatedJson('{"content": "say \\"hi')).toBe('{"content": "say \\"hi"}');
  });

  it("drops a trailing incomplete escape before closing the string", () => {
    // The final backslash is an incomplete escape sequence.
    expect(repairTruncatedJson('{"content": "line\\n')).toBe('{"content": "line\\n"}');
    expect(repairTruncatedJson('{"content": "trailing\\')).toBe('{"content": "trailing"}');
  });

  it("closes nested containers in reverse order", () => {
    expect(repairTruncatedJson('{"a": {"b": [1, 2')).toBe('{"a": {"b": [1, 2]}}');
  });

  it("trims a dangling trailing comma", () => {
    expect(repairTruncatedJson('{"a": 1, "b": 2,')).toBe('{"a": 1, "b": 2}');
    expect(repairTruncatedJson('{"a": [1, 2, 3,')).toBe('{"a": [1, 2, 3]}');
  });

  it("handles multiline content with newlines inside strings", () => {
    const raw = '{"path": "notes.md", "content": "# Title\\nline 2\\nline 3';
    expect(JSON.parse(repairTruncatedJson(raw)!)).toEqual({
      path: "notes.md",
      content: "# Title\nline 2\nline 3",
    });
  });

  it("returns null for mismatched closers", () => {
    expect(repairTruncatedJson('{"a": 1]')).toBeNull();
    expect(repairTruncatedJson('{"a": [}')).toBeNull();
  });
});

describe("parseToolCallArguments", () => {
  it("parses valid JSON object", () => {
    const r = parseToolCallArguments('{"path":"a.md"}');
    expect(r.args).toEqual({ path: "a.md" });
    expect(r.malformed).toBe(false);
    expect(r.repaired).toBe(false);
  });

  it("empty / undefined → empty args, not malformed", () => {
    expect(parseToolCallArguments(undefined).args).toEqual({});
    expect(parseToolCallArguments("").args).toEqual({});
    expect(parseToolCallArguments("  ").malformed).toBe(false);
  });

  it("repairs a truncated call and marks it repaired", () => {
    const r = parseToolCallArguments('{"path": "/home/user/x.md", "content": "# hi');
    expect(r.malformed).toBe(true);
    expect(r.repaired).toBe(true);
    expect(r.args).toEqual({ path: "/home/user/x.md", content: "# hi" });
  });

  it("returns a structured error for unrepairable payloads", () => {
    const r = parseToolCallArguments('{"path": "/home/user/gym_cutting_diet.md"');
    // Note: the simple missing-brace case IS repairable; force an
    // unrepairable one:
    const bad = parseToolCallArguments("}{ broken");
    expect(bad.malformed).toBe(true);
    expect(bad.repaired).toBe(false);
    expect(bad.args).toEqual({});
    expect(bad.error?.code).toBe("MALFORMED_TOOL_ARGUMENTS");
  });

  it("non-object JSON (array/number/string) is malformed, never executed", () => {
    const r = parseToolCallArguments("[1,2,3]");
    expect(r.malformed).toBe(true);
    expect(r.args).toEqual({});
  });
});

describe("wireSafeArguments", () => {
  it("round-trips valid args", () => {
    expect(wireSafeArguments('{"a":1}')).toBe('{"a":1}');
  });

  it("replays repaired args as valid JSON", () => {
    expect(wireSafeArguments('{"path":"a.md"')).toBe('{"path":"a.md"}');
  });

  it("NEVER replays unrepairable raw text — falls back to {}", () => {
    expect(wireSafeArguments("}{ broken")).toBe("{}");
    expect(wireSafeArguments(undefined)).toBe("{}");
  });
});

describe("malformedToolResult", () => {
  it("produces a structured, stringifiable tool result", () => {
    const r = malformedToolResult('{"path": "/home');
    expect(r.error.code).toBe("MALFORMED_TOOL_ARGUMENTS");
    expect(typeof r.error.message).toBe("string");
    expect(() => JSON.stringify(r)).not.toThrow();
  });
});

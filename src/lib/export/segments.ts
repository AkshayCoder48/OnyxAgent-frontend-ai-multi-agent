/**
 * Export feature — fenced-code segmenting (isomorphic, pure).
 *
 * Splits a message's markdown content into alternating text / code segments
 * so every renderer (PDF, DOCX, Markdown) treats fenced code blocks the same
 * way:
 *  - with `includeCode` ON the code segments render as monospace shaded
 *    blocks with preserved line breaks and wrapping;
 *  - with `includeCode` OFF the code segments are replaced by a
 *    `[Code block omitted]` placeholder instead of being silently dropped
 *    (PRD §12.6 "Avoid silently omitting messages" — the reader should be
 *    able to tell a block was intentionally left out).
 *
 * Handles ``` fences (with optional language tag) and ~~~ fences. An
 * UNCLOSED fence treats the remainder of the content as code — never the
 * reverse (unclosed code must not leak out as prose).
 */

export interface CodeSegment {
  type: "text" | "code";
  text: string;
  /** Language tag from the opening fence (```ts …) — empty when absent. */
  lang?: string;
}

/** Marker substituted for code blocks when code inclusion is off. */
export const CODE_OMITTED_PLACEHOLDER = "[Code block omitted]";

const FENCE_RE = /^(\s*)(`{3,}|~{3,})(.*)$/;

/**
 * Split `content` into ordered text/code segments.
 * Pure function — deterministic output for a given input.
 */
export function splitCodeSegments(content: string): CodeSegment[] {
  const lines = content.split("\n");
  const segments: CodeSegment[] = [];
  let current: CodeSegment = { type: "text", text: "" };
  let inCode = false;
  let fenceChar = "`";

  const pushCurrent = () => {
    // Drop fully-empty leading/trailing text segments but keep interior
    // blank lines (they separate paragraphs).
    if (current.text.length > 0) segments.push(current);
  };

  for (const line of lines) {
    const match = inCode ? null : FENCE_RE.exec(line);
    if (!inCode && match) {
      pushCurrent();
      inCode = true;
      fenceChar = match[2]![0]!;
      current = {
        type: "code",
        text: "",
        lang: match[3]?.trim() ?? "",
      };
    } else if (inCode) {
      // Only the SAME character sequence closes the fence (``` closes ```,
      // ~~~ closes ~~~; ``` inside a ~~~ block stays code).
      const closeMatch = /^(\s*)(`{3,}|~{3,})\s*$/.exec(line);
      if (closeMatch && closeMatch[2]![0] === fenceChar) {
        pushCurrent();
        inCode = false;
        current = { type: "text", text: "" };
      } else {
        current.text += (current.text ? "\n" : "") + line;
      }
    } else {
      current.text += (current.text ? "\n" : "") + line;
    }
  }
  // Unclosed fence → the remainder stays a code segment.
  pushCurrent();
  return segments;
}

/**
 * Strip fenced code blocks from content (used when `includeCode` is off).
 * Each block becomes `[Code block omitted]`; inline code (`…`) is preserved
 * (the toggle is about code BLOCKS).
 */
export function stripCodeBlocks(content: string, placeholder = CODE_OMITTED_PLACEHOLDER): string {
  return splitCodeSegments(content)
    .map((s) => (s.type === "code" ? placeholder : s.text))
    .join("\n");
}

/** True when the content contains at least one fenced code block. */
export function hasCodeBlocks(content: string): boolean {
  return splitCodeSegments(content).some((s) => s.type === "code");
}

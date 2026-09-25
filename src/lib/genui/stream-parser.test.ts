import { describe, expect, it } from "vitest";
import { buildTextSegments } from "./stream-parser";
import { GENUI_CLOSE, GENUI_OPEN } from "./types";
import type { GenUISpec } from "./types";

/**
 * PRD §21 segmentation behavior — the "Creating …" creation-line contract:
 *   • An OPEN block that hasn't parsed into a node yet still emits a
 *     spec-less streaming segment (no blank gap while the JSON arrives).
 *   • A transient parse regression keeps the last GOOD spec (cache).
 *   • Completion (close sentinel / complete-mode) flips streaming to false.
 */
describe("buildTextSegments — PRD §21 creation-line segments", () => {
  it("emits a spec-less streaming segment before any node parses", () => {
    const segs = buildTextSegments(`Hold on…${GENUI_OPEN}{"nodes":[{"ty`, undefined, false);
    expect(segs).toEqual([
      { type: "text", text: "Hold on…" },
      { type: "genui", spec: undefined, streaming: true },
    ]);
  });

  it("parses the first node as soon as its type arrives (still streaming)", () => {
    const segs = buildTextSegments(
      `${GENUI_OPEN}{"nodes":[{"type":"card_grid","col`,
      undefined,
      false,
    );
    expect(segs).toHaveLength(1);
    expect(segs[0]!.type).toBe("genui");
    expect(segs[0]!.streaming).toBe(true);
    expect(segs[0]!.spec!.nodes[0]!.type).toBe("card_grid");
  });

  it("keeps the last-good spec across a transient parse regression (cache)", () => {
    const cache = new Map<number, GenUISpec>();
    // Flush 1: a card parses.
    const first = buildTextSegments(`${GENUI_OPEN}{"nodes":[{"type":"card"`, cache, false);
    expect(first[0]!.spec!.nodes[0]!.type).toBe("card");
    // Flush 2: the type string is mid-rewrite and no longer parses to a
    // known node — the cached card spec must survive (no blanking).
    const second = buildTextSegments(`${GENUI_OPEN}{"nodes":[{"type":"ca`, cache, false);
    expect(second[0]!.spec!.nodes[0]!.type).toBe("card");
    expect(second[0]!.streaming).toBe(true);
  });

  it("flips streaming to false when the close sentinel arrives", () => {
    const segs = buildTextSegments(
      `${GENUI_OPEN}{"nodes":[{"type":"card","title":"Hi"}]}${GENUI_CLOSE}Done!`,
      undefined,
      false,
    );
    expect(segs.map((s) => s.type)).toEqual(["genui", "text"]);
    expect(segs[0]!.streaming).toBe(false);
    expect(segs[0]!.spec!.nodes[0]!.props?.title).toBe("Hi");
    expect(segs[1]!.text).toBe("Done!");
  });

  it("complete-mode closes an unterminated block at end-of-text", () => {
    const segs = buildTextSegments(
      `${GENUI_OPEN}{"nodes":[{"type":"card","title":"No close"}]}`,
      undefined,
      true,
    );
    expect(segs).toHaveLength(1);
    expect(segs[0]!.streaming).toBe(false);
    expect(segs[0]!.spec!.nodes[0]!.props?.title).toBe("No close");
  });
});

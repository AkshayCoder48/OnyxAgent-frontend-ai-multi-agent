/**
 * Shared lexical scorer tests (Task 2-d; the SAME module Task 2-b's hybrid
 * search will reuse for its lexical half).
 */
import { describe, expect, it } from "vitest";
import {
  bestWindowExcerpt,
  lexicalScore,
  lexicalScoreText,
  rankDocuments,
  tfMap,
  tokenize,
  tokenSet,
} from "./score";

describe("tokenize", () => {
  it("splits alphanumeric runs and lowercases", () => {
    expect(tokenize("Hello, OnyxAgent! 42 things")).toEqual([
      "hello",
      "onyxagent",
      "42",
      "things",
    ]);
  });

  it("drops stopwords by default", () => {
    expect(tokenize("the state of the art")).toEqual(["state", "art"]);
  });

  it("keeps stopwords when asked", () => {
    expect(tokenize("the state of the art", { keepStopwords: true })).toEqual([
      "the",
      "state",
      "of",
      "the",
      "art",
    ]);
  });

  it("returns an empty array for empty / punct-only text", () => {
    expect(tokenize("")).toEqual([]);
    expect(tokenize("   ")).toEqual([]);
    expect(tokenize("!!! --- ???")).toEqual([]);
  });
});

describe("tokenSet / tfMap", () => {
  it("tokenSet dedupes", () => {
    const s = tokenSet("run run run fast");
    expect(s.size).toBe(2);
    expect(s.has("run")).toBe(true);
    expect(s.has("fast")).toBe(true);
  });

  it("tfMap counts occurrences", () => {
    expect(tfMap(["a", "b", "a", "a"])).toEqual(
      new Map([
        ["a", 3],
        ["b", 1],
      ]),
    );
  });
});

describe("lexicalScore", () => {
  it("scores 1 for identical token mass", () => {
    expect(lexicalScoreText("streaming bug fix", "streaming bug fix")).toBe(1);
  });

  it("scores 0 for disjoint texts", () => {
    expect(lexicalScoreText("kubernetes deployment", "gardening tips for spring")).toBe(0);
  });

  it("scores partial overlap between 0 and 1", () => {
    const s = lexicalScoreText("streaming bug", "the streaming architecture decision");
    expect(s).toBeGreaterThan(0);
    expect(s).toBeLessThan(1);
  });

  it("returns 0 for an empty query", () => {
    expect(lexicalScore([], ["anything"])).toBe(0);
    expect(lexicalScoreText("", "document")).toBe(0);
  });

  it("ignores stopwords on both sides", () => {
    // "the" is a stopword — its presence/absence must not change the score.
    const a = lexicalScoreText("fix the bug", "the bug was fixed");
    const b = lexicalScoreText("fix bug", "bug was fixed");
    expect(a).toBe(b);
  });

  it("repeated document terms raise the score but never past 1", () => {
    const once = lexicalScoreText("deploy release", "deploy once");
    const many = lexicalScoreText("deploy release", "deploy deploy deploy deploy");
    expect(many).toBeGreaterThan(once);
    expect(many).toBeLessThanOrEqual(1);
  });
});

describe("rankDocuments", () => {
  const docs = [
    { id: "a", text: "Fix the streaming bug in the SSE parser" },
    { id: "b", text: "Gardening tips: roses in spring" },
    { id: "c", text: "Streaming architecture decision: backpressure queue" },
    { id: "d", text: "Streaming streaming streaming — the retry ladder" },
  ];

  it("ranks by score, drops zero-score docs", () => {
    const ranked = rankDocuments("streaming bug", docs, { textOf: (d) => d.text, idOf: (d) => d.id });
    // a hits both terms (capped at 1), d hits streaming×3 (capped at 1),
    // c hits streaming only — b hits nothing and is dropped.
    expect(ranked.map((r) => r.item.id)).toEqual(["a", "d", "c"]);
    expect(ranked[0]!.score).toBeGreaterThan(0);
    expect(ranked.some((r) => r.item.id === "b")).toBe(false);
  });

  it("term repetition raises the rank", () => {
    const ranked = rankDocuments("streaming retry", docs, { textOf: (d) => d.text, idOf: (d) => d.id });
    expect(ranked[0]!.item.id).toBe("d");
    // zero-hit doc b is dropped
    expect(ranked.some((r) => r.item.id === "b")).toBe(false);
  });

  it("empty query ranks nothing", () => {
    expect(rankDocuments("the of and", docs, { textOf: (d) => d.text })).toEqual([]);
  });

  it("ties break deterministically by id", () => {
    const tied = [
      { id: "z", text: "alpha" },
      { id: "a", text: "alpha" },
    ];
    const ranked = rankDocuments("alpha", tied, { textOf: (d) => d.text, idOf: (d) => d.id });
    expect(ranked.map((r) => r.item.id)).toEqual(["a", "z"]);
  });
});

describe("bestWindowExcerpt", () => {
  const long =
    "Intro sentence about nothing in particular. ".repeat(6) +
    "The streaming bug was caused by a backpressure queue overflow in the SSE parser. " +
    "Outro sentence about nothing in particular. ".repeat(6);

  it("returns the full text when it fits", () => {
    expect(bestWindowExcerpt("short text", "query", 100)).toBe("short text");
  });

  it("centers on the best-matching window", () => {
    const ex = bestWindowExcerpt(long, "streaming bug backpressure", 120);
    expect(ex).toContain("streaming bug");
    expect(ex.startsWith("…")).toBe(true);
    expect(ex.endsWith("…")).toBe(true);
    expect(ex.length).toBeLessThanOrEqual(123); // 120 + ellipses
  });

  it("falls back to a head excerpt with no query hits", () => {
    const ex = bestWindowExcerpt(long, "zzzz", 60);
    expect(ex.endsWith("…")).toBe(true);
    expect(ex.startsWith("…")).toBe(false);
  });

  it("handles empty input", () => {
    expect(bestWindowExcerpt("", "query")).toBe("");
  });
});

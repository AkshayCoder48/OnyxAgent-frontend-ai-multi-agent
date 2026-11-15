// @vitest-environment jsdom
/**
 * markup-integrity tests — pin the structural checks that
 * create_file_chunk now runs after every markup append (chunked-writing
 * postmortem 2026-11-15). Each case mirrors one symptom from the report:
 * style outside head, duplicated sections, unclosed tags, orphaned
 * closers, mid-tag chunk boundaries — plus the clean-document baseline.
 */

import { describe, expect, it } from "vitest";
import {
  analyzeMarkupIntegrity,
  hasMidTagTail,
  isMarkupPath,
} from "./markup-integrity";

const kinds = (s: string) => analyzeMarkupIntegrity(s).issues.map((i) => i.kind);

describe("analyzeMarkupIntegrity — clean baselines", () => {
  it("accepts a complete, balanced document", () => {
    const doc = `<!DOCTYPE html>
<html><head><title>t</title><style>body{color:#fff}</style></head>
<body><div id="a"><ul><li>one</li><li>two</li></ul><script>if (1 < 2) { ok(); }</script></div></body></html>`;
    const r = analyzeMarkupIntegrity(doc);
    expect(r.ok).toBe(true);
    expect(r.midTagTail).toBe(false);
    expect(r.issues).toEqual([]);
  });

  it("accepts browser-fixable optional closers (li/p/td without </li>)", () => {
    const doc = `<html><body><ul><li>one<li>two</ul><p>para<p>next</body></html>`;
    expect(analyzeMarkupIntegrity(doc).ok).toBe(true);
  });

  it("accepts attributes containing '>' inside quotes", () => {
    const doc = `<html><body><a title="a > b" href="#">x</a></body></html>`;
    expect(analyzeMarkupIntegrity(doc).ok).toBe(true);
  });
});

describe("analyzeMarkupIntegrity — the report's symptoms", () => {
  it("flags style after </body> (styles outside the document regions)", () => {
    const r = analyzeMarkupIntegrity(
      `<html><head></head><body><p>x</p></body><style>.a{}</style></html>`,
    );
    expect(r.issues.some((i) => i.kind === "style-outside-head-or-body")).toBe(true);
  });

  it("flags duplicate ids (duplicated sections)", () => {
    const r = analyzeMarkupIntegrity(
      `<html><body><section id="s1">a</section><section id="s1">b</section></body></html>`,
    );
    const dup = r.issues.find((i) => i.kind === "duplicate-id");
    expect(dup).toBeDefined();
    expect(dup!.message).toContain("s1");
  });

  it("flags an unclosed structural container (chunk split before its closer)", () => {
    const r = analyzeMarkupIntegrity(`<html><body><div><span>x</span></body></html>`);
    expect(r.issues.some((i) => i.kind === "unclosed-tag")).toBe(true);
  });

  it("flags an orphaned closing tag (closer without opener)", () => {
    const r = analyzeMarkupIntegrity(`<html><body><p>x</p></div></body></html>`);
    expect(r.issues.some((i) => i.kind === "orphaned-closer")).toBe(true);
  });

  it("flags a mid-tag tail (chunk boundary split a tag)", () => {
    const r = analyzeMarkupIntegrity(`<html><body><div class="head`);
    expect(r.midTagTail).toBe(true);
    expect(r.issues.some((i) => i.kind === "mid-tag-tail")).toBe(true);
  });

  it("flags a tail split inside a quoted attribute", () => {
    const r = analyzeMarkupIntegrity(`<html><body><div class="roo`);
    expect(r.midTagTail).toBe(true);
  });

  it("flags an unclosed <style> running to EOF", () => {
    const r = analyzeMarkupIntegrity(`<html><head><style>.a { color: red;`);
    expect(r.issues.some((i) => i.kind === "unclosed-tag")).toBe(true);
  });

  it("never walks tags inside script/style raw text", () => {
    // The <div> inside the JS string is content, not markup.
    const doc = `<html><body><script>const s = "<div>not a tag</div>";</script></body></html>`;
    expect(analyzeMarkupIntegrity(doc).ok).toBe(true);
  });
});

describe("helpers", () => {
  it("hasMidTagTail detects the split seam", () => {
    expect(hasMidTagTail(`<div class="x`)).toBe(true);
    expect(hasMidTagTail(`<div class="x">ok</div>`)).toBe(false);
    expect(hasMidTagTail(`plain text`)).toBe(false);
  });

  it("isMarkupPath covers the markup family", () => {
    expect(isMarkupPath("projects/app/index.html")).toBe(true);
    expect(isMarkupPath("a/b/c.SVG")).toBe(true);
    expect(isMarkupPath("src/app/page.tsx")).toBe(false);
    expect(isMarkupPath("notes.md")).toBe(false);
  });
});

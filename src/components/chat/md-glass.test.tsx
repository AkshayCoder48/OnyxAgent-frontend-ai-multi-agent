// @vitest-environment jsdom
/**
 * md-glass tests (glass markdown kit, user upload 2026-11-15).
 *
 * Pins:
 *  - preprocessStandaloneLinks: whole-paragraph external links (with/without
 *    title), angle autolinks and bare URLs get card markers; citation
 *    ordinals are document-order; links with more text, internal/mailto
 *    hrefs, fragment URLs and fenced code stay untouched.
 *  - standaloneLinkCard: a paragraph whose only child is a marked link
 *    renders the right card (cite vs link); ordinary paragraphs pass null.
 *  - kvItemsFromListChildren: `**Term:** value` bullet lists (≥2 items)
 *    extract; mixed lists, task checkboxes and single items do not.
 *  - End-to-end through the real renderer: the marked-up markdown renders
 *    citation + link-preview cards and a key-value grid.
 */

import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import React from "react";
import {
  kvItemsFromListChildren,
  parseCardTitle,
  preprocessStandaloneLinks,
  standaloneLinkCard,
} from "./md-glass";
import { MarkdownContent } from "./markdown-content.impl";

describe("preprocessStandaloneLinks", () => {
  it("marks a standalone link without a title as a link-preview card", () => {
    const out = preprocessStandaloneLinks("See this:\n\n[GitHub](https://github.com)\n\nNice, right?");
    expect(out).toContain('[GitHub](https://github.com "onyx-card:link:0:")');
  });

  it("marks a standalone link WITH a title as a numbered citation card", () => {
    const out = preprocessStandaloneLinks(
      "[First](https://a.dev \"Design systems\")\n\n[Second](https://b.dev \"Architecture notes\")",
    );
    expect(out).toContain('"onyx-card:cite:1:Design systems"');
    expect(out).toContain('"onyx-card:cite:2:Architecture notes"');
  });

  it("rewrites bare-URL and angle-autolink paragraphs into marked links", () => {
    const out = preprocessStandaloneLinks("https://example.com/page");
    expect(out).toBe('[https://example.com/page](https://example.com/page "onyx-card:link:0:")');
    const out2 = preprocessStandaloneLinks("<https://example.com/x>");
    expect(out2).toBe('[https://example.com/x](https://example.com/x "onyx-card:link:0:")');
    // A URL embedded in prose stays inline.
    const prose = "Check https://example.com/page for details.";
    expect(preprocessStandaloneLinks(prose)).toBe(prose);
  });

  it("leaves inline links, internal/mailto/fragment links and prose alone", () => {
    const md = "Read [the docs](https://docs.dev/guide) for more.";
    expect(preprocessStandaloneLinks(md)).toBe(md);
    const frag = "[Jump](https://example.com/#section)";
    expect(preprocessStandaloneLinks(frag)).toBe(frag);
    const mail = "[Mail me](mailto:a@b.dev)";
    expect(preprocessStandaloneLinks(mail)).toBe(mail);
  });

  it("never rewrites links inside fenced code blocks", () => {
    const md = "Example:\n\n```md\n[card](https://example.com)\n```\n\nAfter.";
    expect(preprocessStandaloneLinks(md)).toBe(md);
  });

  it("keeps multi-link paragraphs inline (only WHOLE paragraphs cardify)", () => {
    const md = "[A](https://a.dev) and [B](https://b.dev)";
    expect(preprocessStandaloneLinks(md)).toBe(md);
  });
});

describe("parseCardTitle / standaloneLinkCard", () => {
  it("parses the marker protocol", () => {
    expect(parseCardTitle("onyx-card:link:0:")).toEqual({
      kind: "link",
      ordinal: 0,
      originalTitle: "",
    });
    expect(parseCardTitle("onyx-card:cite:3:Some notes")).toEqual({
      kind: "cite",
      ordinal: 3,
      originalTitle: "Some notes",
    });
    expect(parseCardTitle("Ordinary title")).toBeNull();
    expect(parseCardTitle(undefined)).toBeNull();
  });

  it("routes a marked paragraph child to the right card", () => {
    const linkEl = React.createElement(
      "a",
      { href: "https://github.com", title: "onyx-card:link:0:" },
      "GitHub",
    );
    const citeEl = React.createElement(
      "a",
      { href: "https://a.dev", title: "onyx-card:cite:1:Design systems" },
      "First",
    );
    // Render the returned card elements and assert their surfaces.
    const { unmount, getByText } = render(<>{standaloneLinkCard([linkEl])}</>);
    expect(getByText("Open website ↗")).toBeTruthy();
    unmount();
    const c = render(<>{standaloneLinkCard([citeEl])}</>);
    expect(c.getByText("View source ↗")).toBeTruthy();
    expect(c.getByText("01")).toBeTruthy();
    expect(c.getByText("Design systems")).toBeTruthy();
    c.unmount();
    // Ordinary paragraphs and unmarked links pass through.
    expect(standaloneLinkCard(["just text"])).toBeNull();
    const plain = React.createElement("a", { href: "https://x.dev" }, "x");
    expect(standaloneLinkCard([plain])).toBeNull();
  });
});

describe("kvItemsFromListChildren", () => {
  const li = (...kids: React.ReactNode[]) =>
    React.createElement("li", { key: "li" }, ...kids);
  const strong = (t: string) => React.createElement("strong", null, t);

  it("extracts term/value pairs from an all-**Term:** list", () => {
    const items = kvItemsFromListChildren([
      li(strong("Provider:"), " OpenAI-compatible"),
      li(strong("Model:"), " Onyx Pro"),
      li(strong("Context:"), " 128K"),
    ]);
    expect(items).not.toBeNull();
    expect(items!.map((i) => i.term)).toEqual(["Provider", "Model", "Context"]);
  });

  it("rejects mixed lists, task checkboxes, single items and non-lists", () => {
    expect(kvItemsFromListChildren([li(strong("A:"), " 1"), li("plain bullet")])).toBeNull();
    const checkbox = React.createElement("input", { type: "checkbox", checked: true });
    expect(kvItemsFromListChildren([li(checkbox, " task"), li(strong("B:"), " 2")])).toBeNull();
    expect(kvItemsFromListChildren([li(strong("Only:"), " one")])).toBeNull();
    expect(kvItemsFromListChildren("nope")).toBeNull();
    // Term without the trailing colon is not a definition.
    expect(kvItemsFromListChildren([li(strong("No colon"), " x"), li(strong("B:"), " 2")])).toBeNull();
  });
});

describe("MarkdownContent — glass kit rendering (end to end)", () => {
  it("renders citation + link-preview cards and a key-value grid", () => {
    const md = [
      "Here are the details.",
      "",
      "[Design systems](https://example.com/design \"Reference · Documentation\")",
      "",
      "[GitHub](https://github.com)",
      "",
      "- **Provider:** OpenAI-compatible",
      "- **Model:** Onyx Pro",
      "- **Context:** 128K",
    ].join("\n");
    const { container } = render(<MarkdownContent content={md} />);
    const html = container.innerHTML;
    // 22 · citation card with ordinal 01 + description
    expect(html).toContain("View source");
    expect(html).toContain("01");
    expect(html).toContain("Reference · Documentation");
    // 18 · link preview card
    expect(html).toContain("Open website");
    expect(html).toContain("github.com");
    // 27 · key-value grid replaces the bullet list (the label renders as
    // "Provider" — uppercase is a CSS text-transform, not DOM text).
    expect(html).toContain(">Provider<");
    expect(html).toContain("Onyx Pro");
    expect(container.querySelector("ul")).toBeNull();
    // The synthetic marker never leaks into the DOM.
    expect(html).not.toContain("onyx-card:");
  });

  it("renders display math on the glass surface (single $ stays literal)", () => {
    const md = "Inline price is $5 and $10, but:\n\n$$E = mc^2$$";
    const { container } = render(<MarkdownContent content={md} />);
    const html = container.innerHTML;
    expect(container.querySelector(".katex-display")).not.toBeNull();
    expect(container.querySelector(".katex")).not.toBeNull();
    // The $ prices are NOT math.
    expect(html).toContain("$5");
  });

  it("keeps ordinary prose lists as bullets", () => {
    const md = "- first point\n- second point";
    const { container } = render(<MarkdownContent content={md} />);
    expect(container.querySelector("ul")).not.toBeNull();
    expect(container.querySelector(".md-glass-cell")).toBeNull();
  });
});

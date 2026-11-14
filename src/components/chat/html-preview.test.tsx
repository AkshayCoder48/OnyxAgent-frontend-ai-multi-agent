// @vitest-environment jsdom
/**
 * html-preview tests (user request 2026-11-14 — the app detects HTML code
 * blocks and offers a live Preview button next to Save; the preview_html
 * agent tool was removed the same day).
 *
 * Pins:
 *  - isPreviewableHtml: HTML fence slugs and document/fragment shapes pass;
 *    non-HTML languages, plain text and tiny fragments do not.
 *  - The card renders the snippet in a SANDBOXED iframe (scripts allowed,
 *    same-origin NOT — untrusted HTML cannot reach the app).
 *  - The center tap zone flips to fullscreen; the zone disappears in
 *    fullscreen; the shrink icon returns to the small box.
 *  - Esc and the close (X) button close the card.
 */

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import {
  HtmlPreviewButton,
  HtmlPreviewCard,
  isPreviewableHtml,
} from "./html-preview";

describe("isPreviewableHtml — which blocks get a Preview button", () => {
  it("accepts HTML fence language slugs", () => {
    expect(isPreviewableHtml("html", "<h1>Hello</h1>")).toBe(true);
    expect(isPreviewableHtml("HTML", "<div>demo</div>")).toBe(true);
    expect(isPreviewableHtml("htm", "<p>x</p>")).toBe(true);
    expect(isPreviewableHtml("xhtml", "<div>x</div>")).toBe(true);
  });

  it("accepts untagged blocks that look like documents", () => {
    expect(isPreviewableHtml(null, "<!doctype html><html><body>Hi</body></html>")).toBe(true);
    expect(isPreviewableHtml(null, "<html>\n<body>Game</body>\n</html>")).toBe(true);
  });

  it("accepts untagged page fragments with a render-root tag", () => {
    expect(isPreviewableHtml(null, '<div class="app"><canvas id="c"></canvas></div>')).toBe(true);
    expect(isPreviewableHtml(null, "<style>body{color:red}</style><div>hi</div>")).toBe(true);
    expect(isPreviewableHtml(null, "<section><p>content</p></section>")).toBe(true);
  });

  it("rejects non-HTML languages and non-markup text", () => {
    expect(isPreviewableHtml("python", "print('<div>not html</div>')")).toBe(false);
    expect(isPreviewableHtml("js", "const x = '<div>'")).toBe(false);
    expect(isPreviewableHtml("json", '{"html": "<div>x</div>}')).toBe(false);
    expect(isPreviewableHtml("plaintext", "just some text < about tags")).toBe(false);
  });

  it("rejects markup-shaped text that is not a page fragment", () => {
    // An XML invoice is not something the preview card should render.
    expect(isPreviewableHtml("xml", "<invoice><total>42</total></invoice>")).toBe(false);
    // Too short / empty.
    expect(isPreviewableHtml("html", "")).toBe(false);
    expect(isPreviewableHtml("html", "<p>x")).toBe(false);
  });
});

describe("HtmlPreviewButton — the code-block header affordance", () => {
  it("opens the preview card on click", () => {
    render(<HtmlPreviewButton code="<h1>Hi</h1>" />);
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Preview this HTML block" }));
    expect(screen.getByRole("dialog", { name: "HTML preview" })).toBeTruthy();
  });
});

describe("HtmlPreviewCard — sandboxed render + fullscreen + close", () => {
  const CODE = "<!doctype html><html><body><h1>Demo</h1></body></html>";

  it("renders the snippet in a sandboxed iframe (scripts yes, same-origin no)", () => {
    render(<HtmlPreviewCard code={CODE} onClose={() => {}} />);
    const frame = screen.getByTitle("HTML preview");
    expect(frame.getAttribute("srcDoc")).toBe(CODE);
    const sandbox = frame.getAttribute("sandbox") ?? "";
    expect(sandbox).toContain("allow-scripts");
    expect(sandbox).not.toContain("allow-same-origin");
  });

  it("the center tap zone flips the card to fullscreen and disappears there", () => {
    render(<HtmlPreviewCard code={CODE} onClose={() => {}} />);
    const dialog = screen.getByRole("dialog", { name: "HTML preview" });
    expect(dialog.getAttribute("data-fullscreen")).toBe("false");

    const center = screen.getByRole("button", {
      name: "Show the HTML preview fullscreen",
    });
    fireEvent.click(center);
    expect(dialog.getAttribute("data-fullscreen")).toBe("true");
    // In fullscreen the center zone is gone (the whole page is interactive)
    // and a shrink affordance appears.
    expect(
      screen.queryByRole("button", { name: "Show the HTML preview fullscreen" }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Shrink the HTML preview" }));
    expect(dialog.getAttribute("data-fullscreen")).toBe("false");
  });

  it("the cross button and Esc close the card", () => {
    const onClose = vi.fn();
    const { rerender } = render(<HtmlPreviewCard code={CODE} onClose={onClose} />);

    fireEvent.click(screen.getByRole("button", { name: "Close the HTML preview" }));
    expect(onClose).toHaveBeenCalledTimes(1);

    // Esc also closes (the parent unmounts on close in real wiring).
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);

    // Unmount path is clean (listener removed).
    rerender(<div />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

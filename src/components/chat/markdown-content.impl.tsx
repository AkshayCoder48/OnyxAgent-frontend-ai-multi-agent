"use client";

import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { createLowlight, common as commonLangs } from "lowlight";
import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import { ChevronDown, ExternalLink } from "lucide-react";

import { CopyButton } from "./copy-button";
import { CompanionCursor } from "@/components/assistant-ui/elements";
import type { MarkdownContentProps } from "./markdown-content";
import { SaveCodeButton } from "./code-save-dialog";
import type { SourceItem } from "@/lib/chat-sources";

/** Parse `language-xyz` from a fenced-code `<code>` className. */
function languageLabel(className: string | undefined): string | null {
  if (!className) return null;
  const match = /(?:^|\s)language-([a-z0-9+\-]+)/i.exec(className);
  return match && match[1] ? match[1].toLowerCase() : null;
}

// ── HTML <details>/<summary> COLLAPSIBLES ────────────────────────────────────
// Models frequently wrap answer sections in raw HTML details blocks:
//   <details><summary>Why it matters →</summary>…markdown…</details>
// react-markdown escapes raw HTML (no rehype-raw — XSS-safe by default), so
// these rendered as literal tags. We pre-split COMPLETE blocks out of the
// markdown and render them as native <details> collapsibles (Terra-styled);
// the body renders as markdown inside. Incomplete blocks (still streaming,
// no closing tag) keep rendering as plain text until they complete — the
// same one-shot completion model GenUI blocks use.

type MdSegment =
  | { kind: "md"; text: string }
  | { kind: "details"; summary: string; body: string };

const DETAILS_BLOCK_RE =
  /<details\b[^>]*>\s*<summary\b[^>]*>([\s\S]*?)<\/summary\s*>([\s\S]*?)<\/details\s*>/gi;

/** Split markdown (already citation-preprocessed) into md + details segments. */
function splitHtmlDetails(content: string): MdSegment[] {
  DETAILS_BLOCK_RE.lastIndex = 0;
  const segs: MdSegment[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = DETAILS_BLOCK_RE.exec(content)) !== null) {
    if (m.index > last) segs.push({ kind: "md", text: content.slice(last, m.index) });
    segs.push({
      kind: "details",
      summary: decodeHtmlEntities(stripInlineHtmlTags(m[1] ?? "")),
      body: (m[2] ?? "").trim(),
    });
    last = m.index + m[0].length;
  }
  if (segs.length === 0) return [{ kind: "md", text: content }];
  if (last < content.length) segs.push({ kind: "md", text: content.slice(last) });
  return segs;
}

const HTML_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  rarr: "\u2192", larr: "\u2190", uarr: "\u2191", darr: "\u2193", harr: "\u2194",
  mdash: "\u2014", ndash: "\u2013", hellip: "\u2026", bull: "\u2022", middot: "\u00B7",
  copy: "\u00A9", reg: "\u00AE", trade: "\u2122", deg: "\u00B0", times: "\u00D7",
  divide: "\u00F7", plusmn: "\u00B1", laquo: "\u00AB", raquo: "\u00BB",
  ldquo: "\u201C", rdquo: "\u201D", lsquo: "\u2018", rsquo: "\u2019",
};

function safeCodePoint(cp: number): string {
  if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) return "";
  try {
    return String.fromCodePoint(cp);
  } catch {
    return "";
  }
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => safeCodePoint(parseInt(d, 10)))
    .replace(/&([a-z][a-z0-9]*);/gi, (m, name: string) => HTML_ENTITIES[name.toLowerCase()] ?? m);
}

function stripInlineHtmlTags(s: string): string {
  // Drop tags but keep a space where they stood so "a<b>b</b>c" → "a b c",
  // then collapse the whitespace runs that creates.
  return s
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Native <details> collapsible, Terra-styled — matches the tool-name
 *  disclosure anatomy (chevron · quiet label) and animates via the marker
 *  rotation. No JS state: the browser owns open/close. */
function HtmlDetailsBlock({ summary, children }: { summary: string; children: React.ReactNode }) {
  return (
    <details className="border-foreground/10 bg-foreground/[0.015] group my-3 rounded-xl border">
      <summary
        className="hover:text-foreground flex cursor-pointer list-none items-center gap-2 px-3.5 py-2.5 text-sm font-medium text-foreground/75 transition-colors [&::-webkit-details-marker]:hidden"
      >
        <ChevronDown
          className="text-muted-foreground h-3.5 w-3.5 shrink-0 transition-transform duration-200 group-open:rotate-180"
          aria-hidden
        />
        {summary || "Details"}
      </summary>
      <div className="border-foreground/10 border-t px-3.5 pt-3 pb-3.5 text-[15px] leading-[1.68]">
        {children}
      </div>
    </details>
  );
}

/**
 * Pre-process markdown to turn bare citation markers [N] into markdown links
 * with a special `#cite-N` href. The `a` component override below detects this
 * and renders a superscript citation chip (Beta V1.2, AICSS "Inline
 * Citations" recipe) with a hover tooltip naming the source.
 *
 * Only replaces [N] that is NOT followed by `(` (already a link) or `:` (link
 * reference definition). Code spans/blocks are left as-is because the regex
 * doesn't enter them — in practice agent responses never cite inside code.
 */
function preprocessCitations(content: string): string {
  return content.replace(/\[(\d{1,3})\](?![\(:])/g, (_, n) => `[[${n}]](#cite-${n})`);
}

// ── STREAMING TEXT — PLAIN PACED REVEAL ─────────────────────────────────────
// (Animation state ≠ text state.) The typewriter (useTypewriter in
// message-item) paces the reveal char-by-char and the markdown renders
// whatever is revealed as PLAIN TEXT at full ink — NO per-word and NO
// per-character blur/fade animations (user spec: the reveal pacing itself
// is the motion; the message-level entrance fade handles the "whole
// response fades in" feel). The context here only carries the trailing
// state the CODE BLOCK needs:
//   • CODE BLOCKS — the trailing code block renders plain monospace while
//     it grows (soft line-flash only, no text fade) and the settled
//     syntax-highlighted tree once complete — highlighting, colors, copy
//     and scrolling intact.
//   • HISTORICAL MESSAGES — `stream.streaming` is false for hydrated
//     history: zero animation DOM, fully settled render.
const StreamFreshContext = React.createContext<{
  streaming: boolean;
  lastWord: string;
}>({
  streaming: false,
  lastWord: "",
});

// Citation sources for THIS message (Beta V1.2). Provided by MarkdownContent
// per render so the module-scoped `a` override can look up the source title
// for the superscript chip's tooltip — same context pattern as the stream.
const CiteSourcesContext = React.createContext<readonly SourceItem[]>([]);

/** Find the source a [n] marker points at (first web match by index). */
function findSource(sources: readonly SourceItem[], n: number): SourceItem | undefined {
  return sources.find((s) => s.index === n && s.type === "web") ?? sources.find((s) => s.index === n);
}

/** Extract the last non-whitespace word of a string, lowercased + stripped
 *  of markdown punctuation — used to detect the trailing code block. */
function lastPlainWord(s: string): string {
  const words = s.replace(/[*_`~[\]]/g, " ").split(/\s+/).filter(Boolean);
  const last = words.length ? words[words.length - 1] : undefined;
  return last ? last.toLowerCase() : "";
}

/** Strip any CURSOR markers that leaked into paragraph children.
 *  Defensive — the content should already be cleaned before parsing,
 *  but this catches any residual markers. */
function stripCursorMarkers(child: React.ReactNode): React.ReactNode {
  if (typeof child === "string") {
    return child
      .replaceAll("\u0000CURSOR\u0000", "")
      .replaceAll(/\u0000?CURSOR\u0000?/g, "")
      .replaceAll(":CURSOR:", "");
  }
  if (Array.isArray(child)) {
    return child.map(stripCursorMarkers);
  }
  return child;
}

/**
 * Paragraph renderer. Streamed text renders PLAIN at full ink — the
 * typewriter in message-item paces the reveal; there are NO per-word or
 * per-character fade/blur spans (the char-stream machinery was removed per
 * user spec). Only the defensive cursor-marker strip remains.
 */
function StreamParagraph({ children, ...props }: React.ComponentPropsWithoutRef<"p">) {
  return (
    <p className="mb-3 leading-relaxed last:mb-0" {...props}>
      {stripCursorMarkers(children)}
    </p>
  );
}

/** Recursively extract the plain text of a node tree (for the code-block
 *  Copy button — works for highlighted code, not just raw strings). */
function extractText(nodes: React.ReactNode): string {
  if (nodes == null || typeof nodes === "boolean") return "";
  if (typeof nodes === "string" || typeof nodes === "number") return String(nodes);
  if (Array.isArray(nodes)) return nodes.map(extractText).join("");
  if (React.isValidElement(nodes)) {
    return extractText((nodes.props as { children?: React.ReactNode }).children);
  }
  return "";
}

// ── SYNTAX HIGHLIGHTING — memoized, stream-stable (spec §12/§19–§21) ────────
// rehype-highlight re-tokenized EVERY code block on EVERY markdown re-parse
// (each typewriter tick) — the dominant CPU cost of streaming code-heavy
// responses (the "laggy on large chats" report). Highlighting now
// lives HERE, behind a content-keyed module cache:
//
//   • UNCHANGED code blocks return the CACHED React element tree — the same
//     element reference, so React bails out of that subtree entirely: zero
//     re-highlight, zero re-reconcile while the message streams around it.
//   • Only the ACTIVELY GROWING block re-highlights (one block, and only
//     when it is not the trailing one — see CodeBlock below).
//   • Syntax colors, indentation, whitespace and the Copy button are fully
//     preserved; the cache is bounded with insertion-order eviction.
const lowlight = createLowlight(commonLangs);
const HIGHLIGHT_CACHE_MAX = 64;
const highlightCache = new Map<string, React.ReactNode>();

/** Cheap FNV-1a string hash — collision-safe cache keys for code content. */
function hashString(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36) + ":" + s.length;
}

/** Highlight `code` as `lang` → React node. Cached by (lang, content hash):
 * identical content always returns the SAME element reference (React bail). */
function highlightedCode(code: string, lang: string | null): React.ReactNode {
  const key = `${lang ?? "plain"}:${hashString(code)}`;
  const cached = highlightCache.get(key);
  if (cached !== undefined) return cached;
  let node: React.ReactNode;
  if (lang && lowlight.registered(lang)) {
    try {
      const tree = lowlight.highlight(lang, code);
      node = toJsxRuntime(tree, { jsx, jsxs, Fragment });
    } catch {
      node = code;
    }
  } else {
    node = code;
  }
  highlightCache.set(key, node);
  if (highlightCache.size > HIGHLIGHT_CACHE_MAX) {
    const oldest = highlightCache.keys().next().value;
    if (oldest !== undefined) highlightCache.delete(oldest);
  }
  return node;
}

/**
 * Code block — the warm-charcoal `.chat-code` card (Terra spec):
 *
 *   • While this block is the one currently ENDING the streamed content
 *     (code actively streaming in), the body renders as plain monospace
 *     text grouped per line — each new line mounts with the soft
 *     `onyx-code-line` background flash (background-only: text is always
 *     full ink, NO per-char/per-word fade). Syntax tokens arrive chunked,
 *     so per-char spans inside them would break the plain-line render.
 *   • Otherwise (settled, or a code block the stream has moved past) the
 *     body renders the memoized syntax-highlighted tree (`highlightedCode`)
 *     — colors appear the moment the block completes, and never re-render
 *     while anything else streams.
 *
 * `white-space` stays `pre` on the parent `<pre>`, and Copy copies the raw
 * extracted text — indentation, line breaks and formatting are preserved in
 * both modes.
 */
function CodeBlock({ children, ...props }: React.ComponentPropsWithoutRef<"pre"> & { children?: React.ReactNode }) {
  const stream = React.useContext(StreamFreshContext);
  const codeElement = children as React.ReactElement<{
    children?: React.ReactNode;
    className?: string;
  }>;
  const codeChildren = codeElement?.props?.children;
  const codeContent = typeof codeChildren === "string" ? codeChildren : extractText(codeChildren);
  const lang = languageLabel(codeElement?.props?.className);

  // Is this block the trailing edge of the stream? (Its raw text ends the
  // streamed content — code is arriving right now.)
  const trailing =
    stream.streaming &&
    (() => {
      const t = codeContent.replace(/\s+/g, " ").trim().toLowerCase();
      const w = stream.lastWord.toLowerCase();
      return !!t && !!w && t.endsWith(w);
    })();

  let body: React.ReactNode;
  if (trailing && codeContent) {
    // ACTIVE CODE — plain text, one span per line (stable keys) so a
    // completed line never re-renders as code grows. The `onyx-code-line`
    // flash is background-only (no text opacity change); the characters
    // render plain at full ink and the block settles into syntax colors
    // the moment it completes.
    const lines = codeContent.split("\n");
    body = (
      <code className={lang ? `language-${lang}` : undefined}>
        {lines.map((line, i) => (
          <span key={`cl-${i}`} className="onyx-code-line">
            {line}
            {i < lines.length - 1 ? "\n" : ""}
          </span>
        ))}
      </code>
    );
  } else {
    // SETTLED CODE — memoized syntax-highlighted tree (colors on).
    body = codeContent ? (
      <code className={lang ? `language-${lang}` : undefined}>{highlightedCode(codeContent, lang)}</code>
    ) : (
      children
    );
  }

  // Warm charcoal code block (Terra spec): #262019 canvas, #1F1A15 header
  // strip with language/filename on the left and Save + Copy affordances on
  // the right; muted warm syntax tones come from the `.chat-code` hljs scope.
  return (
    <div className="group chat-code my-4 max-w-full overflow-hidden rounded-xl" style={{ backgroundColor: "var(--chat-code-bg)" }}>
      {(lang || codeContent) && (
        <div
          className="flex items-center justify-between px-3.5 py-2 font-mono text-[11px] normal-case tracking-normal"
          style={{ backgroundColor: "var(--chat-code-header-bg)", color: "#a5947c" }}
        >
          <span>{lang ?? "code"}</span>
          {codeContent && (
            <span className="flex shrink-0 items-center gap-1">
              {/* Save to Files — asks for location / name / extension. */}
              <SaveCodeButton
                code={codeContent}
                lang={lang}
                className="text-[#a5947c] hover:text-[#e8decc]"
              />
              <CopyButton
                text={codeContent}
                label="Copy"
                className="h-6 gap-1 rounded-md px-1.5 text-[11px] text-[#a5947c] hover:bg-white/5 hover:text-[#e8decc] bg-transparent"
              />
            </span>
          )}
        </div>
      )}
      <pre
        className="scrollbar-thin max-w-full overflow-x-auto p-3.5 text-[12.5px] leading-relaxed"
        style={{ color: "var(--chat-code-fg)" }}
        {...props}
      >
        {body}
      </pre>
    </div>
  );
}

// ── Text container components. Referenced by the SHARED_COMPONENTS map
// below; each applies its Terra styling. Streamed text renders PLAIN at
// full ink (the typewriter paces the reveal — no per-word/per-char
// animation DOM). ─────────────────────────────────────────────────────

function ListItem({ children, ...props }: React.ComponentPropsWithoutRef<"li">) {
  const checkbox = Array.isArray(children)
    ? children.find(
        (c) =>
          React.isValidElement(c) &&
          ((c as React.ReactElement<{ type?: string }>).props?.type === "checkbox"),
      )
    : null;
  if (checkbox && React.isValidElement(checkbox)) {
    const isChecked = Boolean((checkbox as React.ReactElement<{ checked?: boolean }>).props?.checked);
    const remaining = Array.isArray(children) ? children.filter((c) => c !== checkbox) : children;
    return (
      <li
        className="flex items-start gap-2 leading-relaxed list-none"
        {...props}
      >
        <span
          className={`mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded border text-[10px] ${
            isChecked
              ? "bg-primary border-primary text-primary-foreground"
              : "border-foreground/25 bg-transparent"
          }`}
          aria-checked={isChecked}
          role="checkbox"
        >
          {isChecked ? "✓" : ""}
        </span>
        <span className="flex-1">{remaining}</span>
      </li>
    );
  }
  return (
    <li className="leading-relaxed" {...props}>
      {children}
    </li>
  );
}

function Heading1({ children, ...props }: React.ComponentPropsWithoutRef<"h1">) {
  return (
    <h1
      className="font-display mt-4 mb-2 text-xl font-bold tracking-tight first:mt-0"
      {...props}
    >
      {children}
    </h1>
  );
}

function Heading2({ children, ...props }: React.ComponentPropsWithoutRef<"h2">) {
  return (
    <h2
      className="font-display mt-4 mb-2 text-lg font-semibold tracking-tight first:mt-0"
      {...props}
    >
      {children}
    </h2>
  );
}

function Heading3({ children, ...props }: React.ComponentPropsWithoutRef<"h3">) {
  return (
    <h3 className="font-display mt-3 mb-2 text-base font-semibold first:mt-0" {...props}>
      {children}
    </h3>
  );
}

function QuoteBlock({ children, ...props }: React.ComponentPropsWithoutRef<"blockquote">) {
  return (
    <blockquote
      className="border-brand/40 text-foreground/75 my-3 border-l-2 pl-4 italic"
      {...props}
    >
      {children}
    </blockquote>
  );
}

function ThCell({ children, ...props }: React.ComponentPropsWithoutRef<"th">) {
  return (
    <th
      className="border-foreground/10 border-b px-3 py-2 text-left font-mono text-[11px] font-semibold tracking-wider uppercase"
      {...props}
    >
      {children}
    </th>
  );
}

function TdCell({ children, ...props }: React.ComponentPropsWithoutRef<"td">) {
  return (
    <td className="border-foreground/8 border-b px-3 py-2 last:border-0" {...props}>
      {children}
    </td>
  );
}

function DtTerm({ children, ...props }: React.ComponentPropsWithoutRef<"dt">) {
  return <dt className="font-semibold text-foreground" {...props}>{children}</dt>;
}

function DdDef({ children, ...props }: React.ComponentPropsWithoutRef<"dd">) {
  return <dd className="text-foreground/75 ml-4" {...props}>{children}</dd>;
}

/**
 * Memoized component override map — the `components` object is passed to
 * `<ReactMarkdown>` on every render, and since ReactMarkdown does a shallow
 * comparison on its props, a new object literal every render would defeat
 * memoization. Hoisting it to module scope keeps the reference stable.
 */
const SHARED_COMPONENTS = {
  pre: CodeBlock,
  code({ className, children, ...props }: React.ComponentPropsWithoutRef<"code">) {
    const isInline = !className;
    if (isInline) {
      // Inline code = paper chip (Terra spec). BRAND-AWARE INK: the text
      // follows --color-primary (Settings → Appearance brand presets —
      // cyan/terracotta/emerald/amber/orange/rose + light/dark themes).
      // The old hardcoded #0e7490 / #67e8f9 pair stayed cyan under EVERY
      // brand — the "highlighted text is always cyan" bug.
      return (
        <code
          className="bg-secondary text-primary rounded px-1.5 py-0.5 font-mono text-[0.85em]"
          {...props}
        >
          {children}
        </code>
      );
    }
    return (
      <code className={className} {...props}>
        {children}
      </code>
    );
  },
  a({ href, children, ...props }: React.ComponentPropsWithoutRef<"a">) {
    if (href?.startsWith("#cite-")) {
      const n = parseInt(href.slice(6), 10);
      if (!Number.isNaN(n)) {
        return <CitationChip n={n}>{children}</CitationChip>;
      }
    }
    const isExternal = !!href && /^https?:\/\//i.test(href);
    return (
      <a
        href={href}
        target={isExternal ? "_blank" : undefined}
        rel={isExternal ? "noopener noreferrer" : undefined}
        className="text-foreground hover:text-brand-hover decoration-brand hover:decoration-brand inline-flex items-baseline gap-0.5 font-medium underline decoration-2 underline-offset-[3px] transition-colors"
        {...props}
      >
        {children}
        {isExternal && (
          <ExternalLink className="text-foreground/60 inline h-[0.8em] w-[0.8em] shrink-0 -translate-y-[1px]" />
        )}
      </a>
    );
  },
  p: StreamParagraph,
  ul({ children, ...props }: React.ComponentPropsWithoutRef<"ul">) {
    return (
      <ul
        className="marker:text-foreground/40 mb-3 ml-5 list-disc space-y-1 last:mb-0"
        {...props}
      >
        {children}
      </ul>
    );
  },
  ol({ children, ...props }: React.ComponentPropsWithoutRef<"ol">) {
    return (
      <ol
        className="marker:text-foreground/40 mb-3 ml-5 list-decimal space-y-1 last:mb-0"
        {...props}
      >
        {children}
      </ol>
    );
  },
  li: ListItem,
  h1: Heading1,
  h2: Heading2,
  h3: Heading3,
  blockquote: QuoteBlock,
  table({ children, ...props }: React.ComponentPropsWithoutRef<"table">) {
    return (
      <div className="border-foreground/10 my-3 overflow-x-auto rounded-lg border">
        <table className="min-w-full text-sm" {...props}>
          {children}
        </table>
      </div>
    );
  },
  thead({ children, ...props }: React.ComponentPropsWithoutRef<"thead">) {
    return (
      <thead className="bg-foreground/[0.04]" {...props}>
        {children}
      </thead>
    );
  },
  th: ThCell,
  td: TdCell,
  hr({ ...props }: React.ComponentPropsWithoutRef<"hr">) {
    return <hr className="border-foreground/10 my-4" {...props} />;
  },
  img({ src, alt, ...props }: React.ComponentPropsWithoutRef<"img">) {
    return (
      <img
        src={typeof src === "string" ? src : ""}
        alt={alt ?? ""}
        loading="lazy"
        className="my-3 max-w-full rounded-lg border border-foreground/10"
        {...props}
      />
    );
  },
  del({ children, ...props }: React.ComponentPropsWithoutRef<"del">) {
    return (
      <del className="text-foreground/60" {...props}>
        {children}
      </del>
    );
  },
  mark({ children, ...props }: React.ComponentPropsWithoutRef<"mark">) {
    return (
      <mark className="bg-primary/20 text-foreground rounded px-1" {...props}>
        {children}
      </mark>
    );
  },
  dl({ children, ...props }: React.ComponentPropsWithoutRef<"dl">) {
    return <dl className="my-3 space-y-1" {...props}>{children}</dl>;
  },
  dt: DtTerm,
  dd: DdDef,
  kbd({ children, ...props }: React.ComponentPropsWithoutRef<"kbd">) {
    return (
      <kbd
        className="bg-muted border-foreground/20 text-foreground/80 inline-flex h-5 items-center rounded border px-1.5 font-mono text-[11px] font-semibold shadow-sm"
        {...props}
      >
        {children}
      </kbd>
    );
  },
  sub({ children, ...props }: React.ComponentPropsWithoutRef<"sub">) {
    return <sub className="text-[0.75em]" {...props}>{children}</sub>;
  },
  sup({ children, ...props }: React.ComponentPropsWithoutRef<"sup">) {
    return <sup className="text-[0.75em]" {...props}>{children}</sup>;
  },
} as const;

// Ref to the latest onCiteClick so the shared components map (which is
// hoisted to module scope for stable reference) can access the current
// callback without being recreated on every render.
const onCiteClickRef = React.createRef<((index: number) => void) | null>();
const showCursorRef = React.createRef<boolean>();

/** Superscript citation chip (Beta V1.2 — AICSS "Inline Citations").
 *  Rendered for every `#cite-N` link: a compact 18px circular badge with the
 *  source number, a hover tooltip naming the source, and a click that opens
 *  the sources panel (or the source URL directly when no panel is wired).
 *
 *  SIZING (citation-circle fix): the badge is a FIXED 18px (h-[18px]
 *  min-w-[18px], 10px font) regardless of the surrounding text size — it
 *  stays compact inside paragraphs AND headings, never inflates line
 *  height (vertical-align: middle, no align-super box-raising), never
 *  pushes text apart, and stays independent of how long the citation
 *  metadata is (the tooltip truncates). The ::before pseudo-element
 *  extends the hit area ~6px in every direction so the 18px badge remains
 *  comfortably tappable on touch devices. */
function CitationChip({ n }: { n: number; children?: React.ReactNode }) {
  const sources = React.useContext(CiteSourcesContext);
  const source = findSource(sources, n);
  const tip = source
    ? source.title + (source.subtitle ? " · " + source.subtitle : "")
    : `Source [${n}]`;
  const label = `Source ${n}: ${tip}`;
  return (
    <span className="group/cite relative mx-[2px] inline-flex align-middle">
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          const click = onCiteClickRef.current;
          if (click) click(n);
          else if (source?.url) window.open(source.url, "_blank", "noopener,noreferrer");
        }}
        className="cite-chip relative inline-flex h-[18px] min-w-[18px] cursor-pointer select-none items-center justify-center rounded-full border border-foreground/15 bg-foreground/[0.055] px-[3px] font-mono text-[10px] font-semibold leading-none text-foreground/70 tabular-nums transition-colors before:absolute before:-inset-2 before:rounded-full before:content-[''] hover:border-primary/45 hover:bg-primary/10 hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        aria-label={label}
      >
        {n}
      </button>
      <span
        role="tooltip"
        className="bg-foreground text-background pointer-events-none absolute bottom-full left-1/2 z-20 mb-1.5 max-w-[240px] -translate-x-1/2 truncate rounded-md px-2 py-1 text-[10px] font-normal tracking-normal whitespace-nowrap opacity-0 shadow-md transition-opacity duration-150 group-hover/cite:opacity-100"
      >
        {tip}
      </span>
    </span>
  );
}

// Shared plugin arrays — stable references so ReactMarkdown's memoization works.
// NOTE: rehype-highlight is GONE — syntax highlighting now lives in the
// CodeBlock override behind a content-keyed memo cache (see
// `highlightedCode`), so a growing message never re-tokenizes its settled
// code blocks. This alone removes the dominant parse cost of streaming
// code-heavy responses.
const REMARK_PLUGINS = [remarkGfm];

// Stable empty array for the sources context default (avoids a new [] per
// render, which would churn every consumer).
const EMPTY_SOURCES: readonly SourceItem[] = [];

/**
 * MarkdownContent — the heavy markdown renderer (react-markdown +
 * remark-gfm; syntax highlighting memoized inside CodeBlock).
 *
 * PERF: Wrapped in React.memo + useDeferredValue so streaming text deltas
 * don't re-parse the full markdown tree on every reveal flush. Instead:
 *   1. `useDeferredValue(content)` lets React defer the markdown re-parse
 *      to a low-priority render so it never blocks input/scroll.
 *   2. `React.memo` with a content-identity short-circuit skips re-render
 *      entirely when the content hasn't changed (e.g. parent re-rendered
 *      but `content` prop is identical).
 *   3. The `components` map + plugin arrays are hoisted to module scope
 *      so ReactMarkdown's internal shallow-compare sees stable props.
 */
export const MarkdownContent = React.memo(function MarkdownContent({
  content,
  onCiteClick,
  sources,
  showCursor,
  streaming,
}: MarkdownContentProps) {
  // Keep the ref in sync so the shared `a` override can call the latest
  // onCiteClick without forcing a re-creation of the components map.
  React.useEffect(() => {
    onCiteClickRef.current = onCiteClick ?? null;
  });
  // Keep showCursor in a ref so the `p` override can read it without being
  // recreated on every render (the components map is module-scoped).
  React.useEffect(() => {
    showCursorRef.current = showCursor ?? false;
  });

  // Defer the markdown re-parse: React will render a stale version (the
  // previous `deferredContent`) during urgent frames and catch up during
  // idle time. This keeps scrolling / input responsive even while the AI
  // is streaming at rapid intervals.
  const deferredContent = React.useDeferredValue(content);

  // Trailing-stream state, computed fresh each render and provided via
  // context (no ref mutation, no render lag). The lastWord of the DEFERRED
  // content decides whether the trailing CODE BLOCK is still growing (its
  // plain-line render) or settled (syntax highlight). Prose carries no
  // per-char state — text renders plain at full ink.
  const streamState = {
    streaming: !!streaming,
    lastWord: streaming ? lastPlainWord(deferredContent) : "",
  };

  // Strip ALL cursor markers from content. The marker may appear as:
  //   - \u0000CURSOR\u0000 (null-terminated, original format)
  //   - CURSOR (null chars stripped during JSON serialization)
  //   - :CURSOR: (alternative format)
  // We strip all variants and render the cursor as a React sibling instead.
  const cleanContent = deferredContent
    .replaceAll("\u0000CURSOR\u0000", "")
    .replaceAll(/\u0000?CURSOR\u0000?/g, "")
    .replaceAll(":CURSOR:", "");
  // Beta V1.2: citations ALWAYS preprocess — the [n] markers render as
  // superscript chips while the answer streams (Perplexity-style), not only
  // after the turn completes.
  const processed = preprocessCitations(cleanContent);

  // Split COMPLETE <details><summary>…</summary>…</details> blocks out of the
  // markdown → native collapsibles. Fast path: no "<details" in the content →
  // single ReactMarkdown render (zero overhead for normal messages).
  const segments = React.useMemo(
    () => (processed.includes("<details") ? splitHtmlDetails(processed) : null),
    [processed],
  );

  // The markdown body: either the segment list (alternating markdown +
  // collapsibles) or the whole content in one ReactMarkdown.
  const mdProps = {
    remarkPlugins: REMARK_PLUGINS,
    components: SHARED_COMPONENTS as React.ComponentProps<typeof ReactMarkdown>["components"],
  };
  const rendered: React.ReactNode = segments
    ? segments.map((seg, i) =>
        seg.kind === "md" ? (
          seg.text.trim() ? (
            <ReactMarkdown key={`md-${i}`} {...mdProps}>
              {seg.text}
            </ReactMarkdown>
          ) : null
        ) : (
          <HtmlDetailsBlock key={`details-${i}`} summary={seg.summary}>
            <ReactMarkdown {...mdProps}>{seg.body}</ReactMarkdown>
          </HtmlDetailsBlock>
        ),
      )
    : (
      <ReactMarkdown {...mdProps}>{processed}</ReactMarkdown>
    );

  // When cursor is off, render directly (no wrapper div, no cursor) — this
  // prevents the wrapper div from adding block-level spacing and the cursor
  // from remaining in completed messages.
  // When cursor is on, wrap in a div that makes the last <p> inline so the
  // cursor flows right after the last letter.
  // Both paths provide the citation sources context (Beta V1.2) so the
  // superscript chips can resolve their tooltips.
  if (!showCursor) {
    return (
      <CiteSourcesContext.Provider value={sources ?? EMPTY_SOURCES}>
        <StreamFreshContext.Provider value={streamState}>{rendered}</StreamFreshContext.Provider>
      </CiteSourcesContext.Provider>
    );
  }

  return (
    <div className="streaming-cursor-wrapper">
      <CiteSourcesContext.Provider value={sources ?? EMPTY_SOURCES}>
        <StreamFreshContext.Provider value={streamState}>{rendered}</StreamFreshContext.Provider>
      </CiteSourcesContext.Provider>
      {/* THE COMPANION — a cute little face riding inline right after the
          latest streamed letter (user spec: the companion IS the cursor). */}
      <CompanionCursor size={15} />
    </div>
  );
}, (prev, next) => {
  // Short-circuit: if the content string AND showCursor are identical, skip
  // re-render. This handles the case where a parent re-rendered but the
  // `content` prop didn't change (e.g. another message updated).
  return (
    prev.content === next.content &&
    prev.onCiteClick === next.onCiteClick &&
    prev.sources === next.sources &&
    prev.showCursor === next.showCursor &&
    prev.streaming === next.streaming
  );
});

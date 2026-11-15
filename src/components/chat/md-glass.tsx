"use client";

import React from "react";
import { ExternalLink } from "lucide-react";

/**
 * GLASS MARKDOWN KIT (user upload 2026-11-15, onyxagent-glass-markdown-kit)
 * — the app-side components of the numbered kit that the AI OUTPUT renderer
 * (markdown-content.impl.tsx) mounts. Implemented numbers only (the user
 * excluded 2–7, 9, 11–17, 19–21, 23–26, 29–30):
 *
 *   18 · Link preview card — a paragraph that is JUST an external link
 *        renders as a glass card with a gradient thumb, title, hostname and
 *        an "Open website ↗" affordance (the whole card is the link).
 *   22 · Citation card — a standalone link written WITH a title
 *        (`[Design systems](https://… "Documentation")`) renders as a
 *        numbered glass citation card instead (the title becomes the
 *        description), numbered 01, 02… in document order.
 *   27 · Key-value grid — a bullet list where EVERY item is
 *        `**Term:** value` renders as a 2-column grid of glass cells
 *        (label + strong value) instead of bullets.
 *
 * Colour-awareness: every accent rides the app's theme vars — surfaces,
 * hairlines and muted text are color-mix() derivations of
 * --color-foreground (so dark, light AND custom brand schemes each get a
 * correct glass), interactive accents ride --color-brand, and the code
 * chrome keeps the kit's warm tones per theme (see globals.css `md-glass`
 * block). No hardcoded one-theme-only colors.
 *
 * Streaming-safe: cards/kv-grids are derived purely from CONTENT (the
 * standalone-link pass runs in the same preprocessing chain as citations,
 * before parsing), so they are stable across re-parses, appear the moment
 * their paragraph completes and never re-number mid-stream.
 */

// ---------------------------------------------------------------------------
// 18/22 · Standalone link paragraphs → link-preview / citation cards.
// ---------------------------------------------------------------------------

/** Marker protocol: standalone-link paragraphs get a synthetic link TITLE
 * (invisible in rendered output) that survives into the parsed <a> props and
 * routes the paragraph renderer. `onyx-card:kind:ordinal:rest` where kind is
 * link|cite and rest carries the user's original title (citations). */
const CARD_TITLE_PREFIX = "onyx-card:";

export interface CardTitleInfo {
  kind: "link" | "cite";
  ordinal: number;
  originalTitle: string;
}

/** Parse the synthetic card title, or null when it is an ordinary title. */
export function parseCardTitle(title: unknown): CardTitleInfo | null {
  if (typeof title !== "string" || !title.startsWith(CARD_TITLE_PREFIX)) return null;
  const rest = title.slice(CARD_TITLE_PREFIX.length);
  const m = /^(link|cite):(\d+):([\s\S]*)$/.exec(rest);
  if (!m) return null;
  return { kind: m[1] === "cite" ? "cite" : "link", ordinal: parseInt(m[2]!, 10), originalTitle: m[3] ?? "" };
}

/** Build the synthetic title (inverse of parseCardTitle). */
function cardTitle(kind: "link" | "cite", ordinal: number, originalTitle: string): string {
  return `${CARD_TITLE_PREFIX}${kind}:${ordinal}:${originalTitle}`;
}

/** Extract the hostname for the card's muted line (bare URLs → no host). */
function hostOf(href: string): string | null {
  try {
    return new URL(href).host || null;
  } catch {
    return null;
  }
}

/** External http(s) href (cards never open internal anchors/mailto). */
function isExternalHref(href: unknown): href is string {
  return typeof href === "string" && /^https?:\/\//i.test(href);
}

/** Human label for a link: its text, or the bare URL when the text is the
 *  URL itself (bare-URL paragraphs), or the hostname. */
function linkLabel(text: string, href: string): string {
  const t = text.trim();
  if (t && !/^https?:\/\//i.test(t)) return t;
  const host = hostOf(href);
  if (host) return host;
  return t || href;
}

/**
 * Paragraph-level card detection: returns the 18/22 card for a paragraph
 * whose ENTIRE content is one preprocessed standalone link (see
 * preprocessStandaloneLinks), or null for ordinary paragraphs.
 *
 * The paragraph's child arrives as a react-markdown element (the `a`
 * override as its type) carrying href + the synthetic card title in its
 * props; surrounding pure-whitespace string children are tolerated.
 */
export function standaloneLinkCard(children: React.ReactNode): React.ReactNode | null {
  const kids = Array.isArray(children) ? children : [children];
  const real = kids.filter(
    (k) => !(typeof k === "string" && k.trim() === ""),
  );
  if (real.length !== 1 || !React.isValidElement(real[0])) return null;
  const el = real[0];
  const props = el.props as { href?: unknown; title?: unknown; children?: React.ReactNode };
  if (!isExternalHref(props.href)) return null;
  const info = parseCardTitle(props.title);
  if (!info) return null;
  const href = props.href as string;
  const label = linkLabel(plainText(props.children), href);
  if (info.kind === "cite") {
    return (
      <CitationCard
        n={info.ordinal}
        href={href}
        label={label}
        description={info.originalTitle}
      />
    );
  }
  return <LinkPreviewCard href={href} label={label} host={hostOf(href)} />;
}

/**
 * Shared fence-aware transform: runs `transform` over every NON-fenced span
 * of the content (fenced code blocks pass through byte-for-byte). This is
 * the safety rail every markdown preprocessor here rides — a link or a
 * `$$…$$` inside a code fence is content, never a component.
 */
function mapNonFencedSpans(content: string, transform: (span: string) => string): string {
  const out: string[] = [];
  let pos = 0;
  const fenceRe = /(^|\n)[ \t]*(`{3,}|~{3,})[^\n]*\n([\s\S]*?)(?:\n[ \t]*\2[ \t]*(?=\n|$)|$)/g;
  let fence: RegExpExecArray | null;
  while ((fence = fenceRe.exec(content)) !== null) {
    if (fence.index > pos) out.push(transform(content.slice(pos, fence.index)));
    out.push(fence[0]);
    pos = fence.index + fence[0].length;
  }
  if (pos < content.length) out.push(transform(content.slice(pos)));
  return out.join("");
}

/**
 * Kit 10 preprocessing: a paragraph that is exactly one SINGLE-LINE
 * `$$…$$` expression is expanded to the multiline form — remark-math parses
 * same-line-closing dollars as INLINE math, so without this the common
 * `$$E = mc^2$$` one-liner would never reach the display-math glass
 * surface. Prose `$$…$$` with surrounding words and fenced code are left
 * untouched.
 */
export function preprocessDisplayMath(content: string): string {
  if (!content.includes("$$")) return content;
  return mapNonFencedSpans(content, (span) =>
    span
      .split(/(\n{2,})/)
      .map((part) => {
        const para = part.trim();
        const m = /^\$\$([^$\n][\s\S]*)\$\$$/.exec(para);
        const inner = m?.[1]?.trim();
        // Single line, non-empty, no further dollars (prose like
        // "$$a$$ to $$b$$" is never touched). Function replacement — a
        // replacement STRING would collapse "$$" into "$".
        if (m && inner && !inner.includes("\n") && !inner.includes("$")) {
          return part.replace(para, () => `$$\n${inner}\n$$`);
        }
        return part;
      })
      .join(""),
  );
}

/**
 * Fence-aware preprocessing: mark standalone external-link paragraphs.
 *
 * A paragraph (blank-line separated) that contains ONLY one markdown link
 * `[text](href "title"?)`, one angle autolink `<https://…>` or one bare URL
 * `https://…` gets a synthetic title:
 *   - with a real title  → `onyx-card:cite:N:<title>` (citation card, N =
 *     document-order ordinal among citations);
 *   - without            → `onyx-card:link:0:` (link-preview card).
 * Fenced code blocks are skipped entirely (fence tracking), internal/mailto
 * links and URLs carrying their own #fragment are left untouched (the card
 * would eat the fragment), and bare/angle URLs are rewritten into explicit
 * markdown links so the marker can ride the title.
 */
export function preprocessStandaloneLinks(content: string): string {
  if (!content.includes("http")) return content;

  /** One paragraph that is exactly a link (text-form), angle autolink or
   *  bare URL. Group 2 = text, 3 = href, 4 = title. */
  const LINK_PARA_RE =
    /^\[((?:[^\[\]]|\[[^\]]*\])*)\]\(<?(https?:\/\/[^)\s>]+)>?(?:\s+"([^"\n]*)")?\)$/;
  const ANGLE_URL_RE = /^<(https?:\/\/[^>\s]+)>$/;
  const BARE_URL_RE = /^(https?:\/\/[^\s<>]+)$/;

  /** Transform one non-fenced span, threading the citation ordinal. */
  const transformSpan = (span: string, cite: { n: number }): string => {
    const hasMarker =
      span.includes("](http") ||
      span.includes("]<http") ||
      span.includes("<http") ||
      /(^|\n)\s*https?:\/\//.test(span);
    if (!hasMarker) return span;
    // Keep the blank-line separators; only whole paragraphs are candidates.
    return span
      .split(/(\n{2,})/)
      .map((part) => {
        const para = part.trim();
        if (!para || !/https?:\/\//.test(para)) return part;

        let text: string | null = null;
        let href: string | null = null;
        let title: string | null = null;

        const link = LINK_PARA_RE.exec(para);
        if (link) {
          text = link[1] ?? "";
          href = link[2] ?? null;
          title = link[3] ?? null;
        } else {
          const angle = ANGLE_URL_RE.exec(para);
          const bare = angle ? null : BARE_URL_RE.exec(para);
          const url = (angle ? angle[1] : bare ? bare[1] : null) as string | null;
          if (url) {
            text = url;
            href = url;
          }
        }

        if (!href || !text) return part; // not a standalone link paragraph
        if (href.includes("#")) return part; // fragment-bearing URLs keep their fragment
        if (title) {
          const n = ++cite.n;
          // Function replacements — a "$" in text/href must never be
          // treated as a replacement pattern.
          return part.replace(para, () => `[${text}](${href} "${cardTitle("cite", n, title)}")`);
        }
        return part.replace(para, () => `[${text}](${href} "${cardTitle("link", 0, "")}")`);
      })
      .join("");
  };

  // The citation ordinal threads through spans in document order.
  const cite = { n: 0 };
  return mapNonFencedSpans(content, (span) => transformSpan(span, cite));
}

// ---------------------------------------------------------------------------
// Card components.
// ---------------------------------------------------------------------------

/** 18 · Link preview card — the whole card is the external link. */
export function LinkPreviewCard({ href, label, host }: { href: string; label: string; host: string | null }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="md-glass-card hover:border-[color:var(--glass-line-2)] my-3 flex items-center gap-3.5 px-3.5 py-3 no-underline transition-colors"
    >
      <span
        aria-hidden
        className="grid h-[52px] w-[58px] shrink-0 place-items-center rounded-xl text-xl"
        style={{
          background:
            "linear-gradient(135deg, color-mix(in srgb, var(--color-brand) 32%, transparent), color-mix(in srgb, var(--color-foreground) 14%, transparent))",
          color: "var(--color-brand)",
        }}
      >
        <ExternalLink className="h-5 w-5" aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <strong className="text-foreground block truncate text-[13px] font-semibold">{label}</strong>
        <span className="text-muted-foreground block truncate text-[11px]">{host}</span>
        <span className="mt-0.5 block text-[11px] font-medium" style={{ color: "var(--color-brand)" }}>
          Open website ↗
        </span>
      </span>
    </a>
  );
}

/** 22 · Citation card — numbered teal reference (ordinal from the preprocess). */
export function CitationCard({
  n,
  href,
  label,
  description,
}: {
  n: number;
  href: string;
  label: string;
  description: string;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="md-glass-card hover:border-[color:var(--glass-line-2)] my-3 flex items-start gap-3 px-3.5 py-3 no-underline transition-colors"
    >
      <span
        aria-hidden
        className="grid h-[25px] w-[25px] shrink-0 place-items-center rounded-lg font-mono text-[11px] font-semibold"
        style={{
          background: "color-mix(in srgb, var(--color-brand) 13%, transparent)",
          color: "var(--color-brand)",
        }}
      >
        {String(n).padStart(2, "0")}
      </span>
      <span className="min-w-0 flex-1">
        <strong className="text-foreground block text-[12.5px] font-semibold">{label}</strong>
        {description && (
          <span className="text-muted-foreground mt-0.5 block text-[11px] leading-relaxed">{description}</span>
        )}
        <span className="mt-0.5 block text-[11px] font-medium" style={{ color: "var(--color-brand)" }}>
          View source ↗
        </span>
      </span>
    </a>
  );
}

// ---------------------------------------------------------------------------
// 27 · Key-value grid — `**Term:** value` bullet lists.
// ---------------------------------------------------------------------------

/** Recursively extract an element tree's plain text (same idea as the impl's
 *  extractText, local copy to keep this module self-contained). */
function plainText(nodes: React.ReactNode): string {
  if (nodes == null || typeof nodes === "boolean") return "";
  if (typeof nodes === "string" || typeof nodes === "number") return String(nodes);
  if (Array.isArray(nodes)) return nodes.map(plainText).join("");
  if (React.isValidElement(nodes)) {
    return plainText((nodes.props as { children?: React.ReactNode }).children);
  }
  return "";
}

export interface KvItem {
  term: string;
  valueChildren: React.ReactNode;
}

/**
 * Detect a key-value bullet list: EVERY <li>'s children start with a
 * <strong> whose text ends in ":" and are followed by non-empty inline
 * content. At least two items. Returns the extracted items, or null when
 * any item deviates (plain bullets, task checkboxes, nested lists…).
 *
 * The <li> children arrive as react-markdown elements (the overrides are
 * just element types) — the raw markdown children, before ListItem's
 * streaming fade wraps them.
 */
export function kvItemsFromListChildren(children: React.ReactNode): KvItem[] | null {
  // react-markdown separates block children with plain "\n" strings — the
  // real items are the element children.
  const lis = (Array.isArray(children) ? children : [children]).filter(
    (c) => !(typeof c === "string" && c.trim() === ""),
  );
  if (lis.length < 2) return null;
  const items: KvItem[] = [];
  for (const li of lis) {
    if (!React.isValidElement(li)) return null;
    const kids = (li.props as { children?: React.ReactNode }).children;
    if (!Array.isArray(kids) || kids.length < 2) return null;
    const [first, ...rest] = kids;
    if (!React.isValidElement(first) || first.type !== "strong") return null;
    const term = plainText((first.props as { children?: React.ReactNode }).children ?? "").trim();
    if (!term.endsWith(":") || term.length < 2) return null;
    // The value must actually say something (skip "**Term:**" alone).
    const valueChildren = rest.length === 1 ? rest[0] : rest;
    if (!plainText(valueChildren).trim()) return null;
    items.push({ term: term.replace(/:$/, ""), valueChildren });
  }
  return items.length >= 2 ? items : null;
}

/** 27 · The grid — 2 glass cells per row (single column under 640px). */
export function KvGrid({ items }: { items: KvItem[] }) {
  return (
    <div className="my-3 grid grid-cols-1 gap-2 min-[640px]:grid-cols-2">
      {items.map((it, i) => (
        <div key={`kv-${i}`} className="md-glass-cell px-3 py-2.5">
          <span className="text-muted-foreground block text-[10px] font-bold tracking-[0.1em] uppercase">
            {it.term}
          </span>
          <strong className="text-foreground text-[13px] font-semibold">{it.valueChildren}</strong>
        </div>
      ))}
    </div>
  );
}

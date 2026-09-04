"use client";

import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { ChevronDown, ExternalLink } from "lucide-react";

import { CopyButton } from "./copy-button";
import { OrbCursor } from "@/components/assistant-ui/elements";
import type { MarkdownContentProps } from "./markdown-content";
import type { SourceItem } from "@/lib/chat-sources";

/** Parse `language-xyz` from a `<code>` className that rehype-highlight emits. */
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

// Streaming state for the blue→ink word tint (the "StreamingText" streamer
// effect): while the message streams, the trailing paragraph's newest two
// words render tinted `text-blue-500` and settle back to ink over ~700ms
// (via `transition-colors duration-700` + stable word-index keys).
// Delivered through React context so the module-scoped paragraph component
// can read it WITHOUT mutation during render (React Compiler lint) and
// WITHOUT lagging a render behind (an effect-synced ref would render the
// tint one delta late, which makes the trailing-paragraph check fail).
const StreamTintContext = React.createContext<{ streaming: boolean; lastWord: string }>({
  streaming: false,
  lastWord: "",
});

// Citation sources for THIS message (Beta V1.2). Provided by MarkdownContent
// per render so the module-scoped `a` override can look up the source title
// for the superscript chip's tooltip — same context pattern as the tint.
const CiteSourcesContext = React.createContext<readonly SourceItem[]>([]);

/** Find the source a [n] marker points at (first web match by index). */
function findSource(sources: readonly SourceItem[], n: number): SourceItem | undefined {
  return sources.find((s) => s.index === n && s.type === "web") ?? sources.find((s) => s.index === n);
}

/** Extract the last non-whitespace word of a string, lowercased + stripped
 *  of markdown punctuation — used to detect the trailing paragraph. */
function lastPlainWord(s: string): string {
  const words = s.replace(/[*_`~[\]]/g, " ").split(/\s+/).filter(Boolean);
  const last = words.length ? words[words.length - 1] : undefined;
  return last ? last.toLowerCase() : "";
}

/**
 * Split the trailing plain-string child of a paragraph into word spans with
 * the blue→ink tint on the newest two words. Returns a new children array, or
 * null when the paragraph is not the trailing one (its text does not end with
 * the stream's last word) — in that case the caller renders as usual.
 *
 * Stable keys by token index mean a word that leaves the two-word "fresh"
 * window only gets a className change, which `transition-colors` animates
 * back to ink — exactly the reference StreamingText behavior.
 */
function tintStreamingParagraph(
  children: React.ReactNode,
  stream: { streaming: boolean; lastWord: string },
): React.ReactNode[] | null {
  if (!stream.streaming || !stream.lastWord) return null;

  const parts: React.ReactNode[] = Array.isArray(children) ? children : [children];
  let lastStrIdx = -1;
  let paraText = "";
  for (let i = 0; i < parts.length; i++) {
    const child = parts[i];
    if (typeof child === "string") {
      if (child.trim().length > 0) lastStrIdx = i;
      paraText += child;
    }
  }
  if (lastStrIdx < 0) return null;

  const norm = paraText.replace(/\s+/g, " ").trim().toLowerCase();
  const lastWord = stream.lastWord.toLowerCase();
  // Only the paragraph that currently ENDS the streamed content gets the
  // tint — earlier paragraphs don't end with the content's last word.
  if (!norm || !norm.endsWith(lastWord)) return null;

  const raw = parts[lastStrIdx] as string;
  // Preserve the exact inter-word whitespace by splitting with separators.
  const tokens = raw.split(/(\s+)/);
  const wordIdx: number[] = [];
  tokens.forEach((t, i) => {
    if (t.trim().length > 0) wordIdx.push(i);
  });
  const fresh = new Set(wordIdx.slice(-2));

  const out = parts.slice();
  out[lastStrIdx] = tokens.map((t, i) => {
    if (t.trim().length === 0) return t;
    const isFresh = fresh.has(i);
    return (
      <span
        key={i}
        className={
          "transition-colors duration-700 " +
          (isFresh ? "text-blue-500" : "text-foreground")
        }
      >
        {t}
      </span>
    );
  });
  return out;
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
 * Paragraph renderer with the streaming tint: when the message is streaming
 * and this paragraph is the trailing one, its newest two words land in blue
 * and settle into ink (StreamingText recipe). Otherwise renders as usual
 * (with defensive CURSOR-marker stripping). An uppercase component so it can
 * read StreamTintContext via useContext per the rules-of-hooks lint.
 */
function TintedParagraph({ children, ...props }: React.ComponentPropsWithoutRef<"p">) {
  const stream = React.useContext(StreamTintContext);
  const tinted = tintStreamingParagraph(children, stream);
  if (tinted) {
    return (
      <p className="mb-3 leading-relaxed last:mb-0" {...props}>
        {tinted}
      </p>
    );
  }
  return (
    <p className="mb-3 leading-relaxed last:mb-0" {...props}>
      {stripCursorMarkers(children)}
    </p>
  );
}

/**
 * Memoized component override map — the `components` object is passed to
 * `<ReactMarkdown>` on every render, and since ReactMarkdown does a shallow
 * comparison on its props, a new object literal every render would defeat
 * memoization. Hoisting it to module scope keeps the reference stable.
 */
const SHARED_COMPONENTS = {
  pre({ children, ...props }: React.ComponentPropsWithoutRef<"pre"> & { children?: React.ReactNode }) {
    const codeElement = children as React.ReactElement<{
      children?: string;
      className?: string;
    }>;
    const codeContent =
      typeof codeElement?.props?.children === "string" ? codeElement.props.children : "";
    const lang = languageLabel(codeElement?.props?.className);

    // Warm charcoal code block (Terra spec): #262019 canvas, #1F1A15 header
    // strip with language/filename on the left and a Copy affordance on the
    // right; muted warm syntax tones come from the `.chat-code` hljs scope.
    return (
      <div className="group chat-code my-4 max-w-full overflow-hidden rounded-xl" style={{ backgroundColor: "var(--chat-code-bg)" }}>
        {(lang || codeContent) && (
          <div
            className="flex items-center justify-between px-3.5 py-2 font-mono text-[11px] normal-case tracking-normal"
            style={{ backgroundColor: "var(--chat-code-header-bg)", color: "#a5947c" }}
          >
            <span>{lang ?? "code"}</span>
            {codeContent && (
              <CopyButton
                text={codeContent}
                label="Copy"
                className="h-6 gap-1 rounded-md px-1.5 text-[11px] text-[#a5947c] hover:bg-white/5 hover:text-[#e8decc] bg-transparent"
              />
            )}
          </div>
        )}
        <pre
          className="scrollbar-thin max-w-full overflow-x-auto p-3.5 text-[12.5px] leading-relaxed"
          style={{ color: "var(--chat-code-fg)" }}
          {...props}
        >
          {children}
        </pre>
      </div>
    );
  },
  code({ className, children, ...props }: React.ComponentPropsWithoutRef<"code">) {
    const isInline = !className;
    if (isInline) {
      // Inline code = paper chip with deep-terracotta text (Terra spec).
      return (
        <code
          className="bg-secondary rounded px-1.5 py-0.5 font-mono text-[0.85em] text-[#a8421f] dark:text-[#e39b6e]"
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
  p: TintedParagraph,
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
  li({ children, ...props }: React.ComponentPropsWithoutRef<"li">) {
    const checkbox = Array.isArray(children)
      ? children.find(
          (c) =>
            React.isValidElement(c) &&
            ((c as React.ReactElement<{ type?: string }>).props?.type === "checkbox"),
        )
      : null;
    if (checkbox && React.isValidElement(checkbox)) {
      const isChecked = Boolean((checkbox as React.ReactElement<{ checked?: boolean }>).props?.checked);
      const remaining = Array.isArray(children)
        ? children.filter((c) => c !== checkbox)
        : children;
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
  },
  h1({ children, ...props }: React.ComponentPropsWithoutRef<"h1">) {
    return (
      <h1
        className="font-display mt-4 mb-2 text-xl font-bold tracking-tight first:mt-0"
        {...props}
      >
        {children}
      </h1>
    );
  },
  h2({ children, ...props }: React.ComponentPropsWithoutRef<"h2">) {
    return (
      <h2
        className="font-display mt-4 mb-2 text-lg font-semibold tracking-tight first:mt-0"
        {...props}
      >
        {children}
      </h2>
    );
  },
  h3({ children, ...props }: React.ComponentPropsWithoutRef<"h3">) {
    return (
      <h3 className="font-display mt-3 mb-2 text-base font-semibold first:mt-0" {...props}>
        {children}
      </h3>
    );
  },
  blockquote({ children, ...props }: React.ComponentPropsWithoutRef<"blockquote">) {
    return (
      <blockquote
        className="border-brand/40 text-foreground/75 my-3 border-l-2 pl-4 italic"
        {...props}
      >
        {children}
      </blockquote>
    );
  },
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
  th({ children, ...props }: React.ComponentPropsWithoutRef<"th">) {
    return (
      <th
        className="border-foreground/10 border-b px-3 py-2 text-left font-mono text-[11px] font-semibold tracking-wider uppercase"
        {...props}
      >
        {children}
      </th>
    );
  },
  td({ children, ...props }: React.ComponentPropsWithoutRef<"td">) {
    return (
      <td className="border-foreground/8 border-b px-3 py-2 last:border-0" {...props}>
        {children}
      </td>
    );
  },
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
  dt({ children, ...props }: React.ComponentPropsWithoutRef<"dt">) {
    return <dt className="font-semibold text-foreground" {...props}>{children}</dt>;
  },
  dd({ children, ...props }: React.ComponentPropsWithoutRef<"dd">) {
    return <dd className="text-foreground/75 ml-4" {...props}>{children}</dd>;
  },
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
 *  Rendered for every `#cite-N` link: a small raised chip with the source
 *  number, a hover tooltip naming the source, and a click that opens the
 *  sources panel (or the source URL directly when no panel is wired). */
function CitationChip({ n }: { n: number; children?: React.ReactNode }) {
  const sources = React.useContext(CiteSourcesContext);
  const source = findSource(sources, n);
  const tip = source
    ? source.title + (source.subtitle ? " · " + source.subtitle : "")
    : `Source [${n}]`;
  const label = `Source ${n}: ${tip}`;
  return (
    <span className="group/cite relative mx-[1px] inline-block align-super">
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          const click = onCiteClickRef.current;
          if (click) click(n);
          else if (source?.url) window.open(source.url, "_blank", "noopener,noreferrer");
        }}
        className="border-foreground/15 bg-foreground/[0.06] text-foreground/75 hover:border-primary/45 hover:bg-primary/15 hover:text-primary inline-flex h-[1.2em] min-w-[1.2em] cursor-pointer items-center justify-center rounded-full px-[0.3em] font-mono text-[0.62em] font-semibold leading-none tabular-nums transition-colors"
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
const REMARK_PLUGINS = [remarkGfm];
const REHYPE_PLUGINS = [rehypeHighlight];

// Stable empty array for the sources context default (avoids a new [] per
// render, which would churn every consumer).
const EMPTY_SOURCES: readonly SourceItem[] = [];

/**
 * MarkdownContent — the heavy markdown renderer (react-markdown +
 * remark-gfm + rehype-highlight).
 *
 * PERF: Wrapped in React.memo + useDeferredValue so streaming text deltas
 * don't re-parse the full markdown tree on every 30ms flush. Instead:
 *   1. `useDeferredValue(content)` lets React defer the markdown re-parse
 *      to a low-priority render so it never blocks input/scroll.
 *   2. `React.memo` with a content-length short-circuit skips re-render
 *      entirely when the content hasn't meaningfully changed (e.g. parent
 *      re-rendered but `content` prop is identical).
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
  // Streaming tint state for the trailing paragraph — computed fresh each
  // render and provided via context (no ref mutation, no render lag).
  const streamTint = {
    streaming: !!streaming,
    lastWord: streaming ? lastPlainWord(content) : "",
  };

  // Defer the markdown re-parse: React will render a stale version (the
  // previous `deferredContent`) during urgent frames and catch up during
  // idle time. This keeps scrolling / input responsive even while the AI
  // is streaming at 30ms intervals.
  const deferredContent = React.useDeferredValue(content);
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
    rehypePlugins: REHYPE_PLUGINS,
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
        <StreamTintContext.Provider value={streamTint}>{rendered}</StreamTintContext.Provider>
      </CiteSourcesContext.Provider>
    );
  }

  return (
    <div className="streaming-cursor-wrapper">
      <CiteSourcesContext.Provider value={sources ?? EMPTY_SOURCES}>
        <StreamTintContext.Provider value={streamTint}>{rendered}</StreamTintContext.Provider>
      </CiteSourcesContext.Provider>
      <OrbCursor variant="C2" size={14} />
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

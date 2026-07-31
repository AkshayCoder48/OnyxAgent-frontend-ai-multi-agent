"use client";

import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { ExternalLink } from "lucide-react";

import { CopyButton } from "./copy-button";
import { WritingCursor } from "./writing-cursor";
import type { MarkdownContentProps } from "./markdown-content";

/** Parse `language-xyz` from a `<code>` className that rehype-highlight emits. */
function languageLabel(className: string | undefined): string | null {
  if (!className) return null;
  const match = /(?:^|\s)language-([a-z0-9+\-]+)/i.exec(className);
  return match && match[1] ? match[1].toLowerCase() : null;
}

/**
 * Pre-process markdown to turn bare citation markers [N] into markdown links
 * with a special `#cite-N` href. The `a` component override below detects this
 * and renders an interactive CitationBadge instead of a regular link.
 *
 * Only replaces [N] that is NOT followed by `(` (already a link) or `:` (link
 * reference definition). Code spans/blocks are left as-is because the regex
 * doesn't enter them — in practice agent responses never cite inside code.
 */
function preprocessCitations(content: string): string {
  return content.replace(/\[(\d{1,3})\](?![\(:])/g, (_, n) => `[[${n}]](#cite-${n})`);
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

    return (
      <div className="group border-border bg-muted my-3 max-w-full overflow-hidden rounded-xl border">
        {(lang || codeContent) && (
          <div className="border-foreground/8 text-foreground/55 flex items-center justify-between border-b px-3 py-1.5 font-mono text-[10px] tracking-wider uppercase">
            <span>{lang ?? "text"}</span>
            {codeContent && (
              <CopyButton text={codeContent} className="opacity-100 transition-opacity" />
            )}
          </div>
        )}
        <pre
          className="scrollbar-thin max-w-full overflow-x-auto p-3.5 text-[12.5px] leading-relaxed"
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
      return (
        <code
          className="bg-foreground/8 text-foreground rounded px-1.5 py-0.5 font-mono text-[0.85em]"
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
    if (href?.startsWith("#cite-") && onCiteClickRef.current) {
      const n = parseInt(href.slice(6), 10);
      if (!Number.isNaN(n)) {
        return (
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              onCiteClickRef.current?.(n);
            }}
            className="bg-foreground/10 text-foreground/70 hover:bg-foreground/20 mx-0.5 inline-flex h-[1.1em] cursor-pointer items-center rounded px-1 align-middle font-mono text-[0.72em] font-semibold tabular-nums transition-colors"
            title={`Source [${n}]`}
          >
            {n}
          </button>
        );
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
  p({ children, ...props }: React.ComponentPropsWithoutRef<"p">) {
    // Strip any CURSOR_MARKER that leaked into paragraph children.
    // The cursor is rendered by the wrapper div (outside ReactMarkdown)
    // — we just need to clean the marker from the text here.
    function stripMarker(child: React.ReactNode): React.ReactNode {
      if (typeof child === "string") {
        return child.replaceAll("\u0000CURSOR\u0000", "");
      }
      if (Array.isArray(child)) {
        return child.map(stripMarker);
      }
      return child;
    }
    return (
      <p className="mb-3 leading-relaxed last:mb-0" {...props}>
        {stripMarker(children)}
      </p>
    );
  },
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

// Shared plugin arrays — stable references so ReactMarkdown's memoization works.
const REMARK_PLUGINS = [remarkGfm];
const REHYPE_PLUGINS = [rehypeHighlight];

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
  showCursor,
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
  // is streaming at 30ms intervals.
  const deferredContent = React.useDeferredValue(content);
  // Strip any cursor markers from content — we render the cursor as a
  // sibling AFTER the markdown, but use a wrapper that makes the last
  // paragraph display: inline so the cursor flows right after the last
  // letter (not on a new line below).
  const cleanContent = deferredContent.replaceAll("\u0000CURSOR\u0000", "");
  const processed = onCiteClick ? preprocessCitations(cleanContent) : cleanContent;

  return (
    <div className={showCursor ? "streaming-cursor-wrapper" : undefined}>
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={REHYPE_PLUGINS}
        components={SHARED_COMPONENTS as React.ComponentProps<typeof ReactMarkdown>["components"]}
      >
        {processed}
      </ReactMarkdown>
      {showCursor && <WritingCursor size="0.9em" />}
    </div>
  );
}, (prev, next) => {
  // Short-circuit: if the content string is identical, skip re-render
  // entirely. This handles the case where a parent re-rendered but the
  // `content` prop didn't change (e.g. another message updated).
  return prev.content === next.content && prev.onCiteClick === next.onCiteClick;
});

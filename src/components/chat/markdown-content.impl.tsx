"use client";

import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { ExternalLink } from "lucide-react";

import { CopyButton } from "./copy-button";
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

export function MarkdownContent({ content, onCiteClick }: MarkdownContentProps) {
  const processed = onCiteClick ? preprocessCitations(content) : content;
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeHighlight]}
      components={{
        pre({ children, ...props }) {
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
              {/* Use overflow-x-auto for horizontal scroll on long lines.
               * The wrapper has max-w-full + overflow-hidden so the code
               * block never forces the message bubble wider than its
               * container. Long lines scroll horizontally inside the pre. */}
              <pre
                className="scrollbar-thin max-w-full overflow-x-auto p-3.5 text-[12.5px] leading-relaxed"
                {...props}
              >
                {children}
              </pre>
            </div>
          );
        },
        code({ className, children, ...props }) {
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
        a({ href, children, ...props }) {
          if (href?.startsWith("#cite-") && onCiteClick) {
            const n = parseInt(href.slice(6), 10);
            if (!Number.isNaN(n)) {
              return (
                <button
                  type="button"
                  onClick={(e) => {
                    e.preventDefault();
                    onCiteClick(n);
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
        p({ children, ...props }) {
          return (
            <p className="mb-3 leading-relaxed last:mb-0" {...props}>
              {children}
            </p>
          );
        },
        ul({ children, ...props }) {
          return (
            <ul
              className="marker:text-foreground/40 mb-3 ml-5 list-disc space-y-1 last:mb-0"
              {...props}
            >
              {children}
            </ul>
          );
        },
        ol({ children, ...props }) {
          return (
            <ol
              className="marker:text-foreground/40 mb-3 ml-5 list-decimal space-y-1 last:mb-0"
              {...props}
            >
              {children}
            </ol>
          );
        },
        li({ children, ...props }) {
          // GFM task list: <li><input type="checkbox" ...>
          const checkbox = Array.isArray(children)
            ? children.find(
                (c) =>
                  React.isValidElement(c) && (c as React.ReactElement).props?.type === "checkbox",
              )
            : null;
          if (checkbox && React.isValidElement(checkbox)) {
            const isChecked = Boolean((checkbox as React.ReactElement<{ checked?: boolean }>).props?.checked);
            // Remove the checkbox from children so we render our own.
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
        h1({ children, ...props }) {
          return (
            <h1
              className="font-display mt-4 mb-2 text-xl font-bold tracking-tight first:mt-0"
              {...props}
            >
              {children}
            </h1>
          );
        },
        h2({ children, ...props }) {
          return (
            <h2
              className="font-display mt-4 mb-2 text-lg font-semibold tracking-tight first:mt-0"
              {...props}
            >
              {children}
            </h2>
          );
        },
        h3({ children, ...props }) {
          return (
            <h3 className="font-display mt-3 mb-2 text-base font-semibold first:mt-0" {...props}>
              {children}
            </h3>
          );
        },
        blockquote({ children, ...props }) {
          return (
            <blockquote
              className="border-brand/40 text-foreground/75 my-3 border-l-2 pl-4 italic"
              {...props}
            >
              {children}
            </blockquote>
          );
        },
        table({ children, ...props }) {
          return (
            <div className="border-foreground/10 my-3 overflow-x-auto rounded-lg border">
              <table className="min-w-full text-sm" {...props}>
                {children}
              </table>
            </div>
          );
        },
        thead({ children, ...props }) {
          return (
            <thead className="bg-foreground/[0.04]" {...props}>
              {children}
            </thead>
          );
        },
        th({ children, ...props }) {
          return (
            <th
              className="border-foreground/10 border-b px-3 py-2 text-left font-mono text-[11px] font-semibold tracking-wider uppercase"
              {...props}
            >
              {children}
            </th>
          );
        },
        td({ children, ...props }) {
          return (
            <td className="border-foreground/8 border-b px-3 py-2 last:border-0" {...props}>
              {children}
            </td>
          );
        },
        hr({ ...props }) {
          return <hr className="border-foreground/10 my-4" {...props} />;
        },
        img({ src, alt, ...props }) {
          // Render markdown images with rounded corners + max-width.
          // eslint-disable-next-line @next/next/no-img-element
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
        // Strikethrough (~~text~~) — GFM supports it, just needs styling.
        del({ children, ...props }) {
          return (
            <del className="text-foreground/60" {...props}>
              {children}
            </del>
          );
        },
        // Inline code emphasis (==text==) — not standard GFM but some models use it.
        mark({ children, ...props }) {
          return (
            <mark className="bg-primary/20 text-foreground rounded px-1" {...props}>
              {children}
            </mark>
          );
        },
        // Definition lists (dl/dt/dd) — rare but some models use them.
        dl({ children, ...props }) {
          return <dl className="my-3 space-y-1" {...props}>{children}</dl>;
        },
        dt({ children, ...props }) {
          return <dt className="font-semibold text-foreground" {...props}>{children}</dt>;
        },
        dd({ children, ...props }) {
          return <dd className="text-foreground/75 ml-4" {...props}>{children}</dd>;
        },
        // Keyboard keys (<kbd>) — styled like a physical key.
        kbd({ children, ...props }) {
          return (
            <kbd
              className="bg-muted border-foreground/20 text-foreground/80 inline-flex h-5 items-center rounded border px-1.5 font-mono text-[11px] font-semibold shadow-sm"
              {...props}
            >
              {children}
            </kbd>
          );
        },
        // Subscript / superscript (rare in LLM output but supported by some models).
        sub({ children, ...props }) {
          return <sub className="text-[0.75em]" {...props}>{children}</sub>;
        },
        sup({ children, ...props }) {
          return <sup className="text-[0.75em]" {...props}>{children}</sup>;
        },
      }}
    >
      {processed}
    </ReactMarkdown>
  );
}

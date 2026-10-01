"use client";

import * as React from "react";
import { useMemo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import { Check } from "lucide-react";
import { CodeBlock } from "./code-block";

const FILENAME_BY_LANGUAGE: Record<string, string> = {
  tsx: "snippet.tsx",
  jsx: "snippet.jsx",
  ts: "snippet.ts",
  js: "snippet.js",
  mjs: "snippet.mjs",
  py: "snippet.py",
  sh: "snippet.sh",
  bash: "snippet.sh",
  json: "snippet.json",
  css: "snippet.css",
  html: "snippet.html",
  md: "snippet.md",
};

/** Extract the raw code string and language from the <code> element inside <pre>. */
function extractCodeBlock(children: React.ReactNode): { code: string; language: string } {
  const child = Array.isArray(children) ? children[0] : children;
  if (React.isValidElement(child)) {
    const props = child.props as { children?: React.ReactNode; className?: string };
    const code = typeof props.children === "string" ? props.children : "";
    const language = /language-([\w-]+)/.exec(props.className ?? "")?.[1] ?? "";
    return { code, language };
  }
  return { code: "", language: "" };
}

/** Pull the rendered content out of a react-markdown <li> element. */
function listItemContent(child: React.ReactNode): React.ReactNode {
  if (React.isValidElement(child)) {
    const props = child.props as { children?: React.ReactNode };
    return props.children;
  }
  return child;
}

const editorialComponents: Components = {
  p: ({ children }) => (
    <p className="text-[15px] leading-[1.68] text-ink">{children}</p>
  ),
  a: ({ children, href }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-terra underline decoration-terra-soft-border underline-offset-[3px] transition-colors hover:text-terra-deep"
    >
      {children}
    </a>
  ),
  strong: ({ children }) => <strong className="font-semibold text-ink">{children}</strong>,
  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-terra-soft-border pl-4 text-[15px] italic leading-[1.68] text-ink-soft">
      {children}
    </blockquote>
  ),
  h1: ({ children }) => (
    <h1 className="font-serif text-[22px] font-semibold leading-snug text-ink">{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="font-serif text-[20px] font-semibold leading-snug text-ink">{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="font-serif text-[17px] font-semibold leading-snug text-ink">{children}</h3>
  ),
  ol: ({ children }) => (
    <ol className="my-1 space-y-3">
      {React.Children.map(children, (child, index) => (
        <li key={index} className="flex list-none">
          <span
            aria-hidden
            className="mr-3 min-w-[1.4em] pt-px text-right font-serif text-[18px] font-medium leading-[1.5] text-terra"
          >
            {index + 1}.
          </span>
          <span className="min-w-0 flex-1 text-[15px] leading-[1.68] text-ink">
            {listItemContent(child)}
          </span>
        </li>
      ))}
    </ol>
  ),
  ul: ({ children }) => (
    <ul className="my-1 space-y-2.5">
      {React.Children.map(children, (child, index) => (
        <li key={index} className="flex list-none items-start">
          <span
            aria-hidden
            className="mr-3 mt-px flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full border border-terra-soft-border bg-terra-soft"
          >
            <Check className="h-3 w-3 text-terra" />
          </span>
          <span className="min-w-0 flex-1 text-[15px] leading-[1.68] text-ink">
            {listItemContent(child)}
          </span>
        </li>
      ))}
    </ul>
  ),
  pre: ({ children }) => {
    const { code, language } = extractCodeBlock(children);
    const filename = FILENAME_BY_LANGUAGE[language] ?? "snippet.txt";
    return <CodeBlock code={code} language={language} filename={filename} />;
  },
  code: ({ children }) => (
    <code className="rounded-md bg-paper px-1.5 py-0.5 font-mono text-[13px] text-terra-deep">
      {children}
    </code>
  ),
};

export function Markdown({ children }: { children: string }) {
  // Parsing is the expensive part — during streaming the parent re-renders
  // every ~80ms, so the parsed tree is cached per exact text input.
  const parsed = useMemo(
    () => <ReactMarkdown components={editorialComponents}>{children}</ReactMarkdown>,
    [children],
  );
  return <div className="space-y-4 text-ink">{parsed}</div>;
}

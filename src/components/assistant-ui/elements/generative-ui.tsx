"use client";

import * as React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";
import { paperCardClass } from "./surfaces";

/**
 * Generative UI — a styled component vocabulary for rendering structured
 * generative output (assistant-ui `generative-ui` recipe, Terra retheme).
 *
 * `renderGenerativeUI` walks a `{ $type, ...props }` tree: `$type` selects a
 * component from the library, every other key becomes a prop, and a
 * `children` key nests further nodes (scalars pass through as plain text,
 * objects render recursively). `styledGenerativeUILibrary` is the default
 * vocabulary (headings, text, cards, lists, markdown, callouts, dividers)
 * with its Markdown entry parsing GitHub-flavored markdown via
 * react-markdown instead of dumping the raw source as plain text. An
 * unknown `$type` logs a console error in development and renders nothing.
 */

export interface GenerativeUINode {
  [key: string]: unknown;
}

export interface GenerativeUIComponent {
  /** Human description (used by tool schemas / docs). */
  description?: string;
  render: (props: Record<string, unknown>) => React.ReactNode;
}

export interface GenerativeUILibrary {
  [type: string]: GenerativeUIComponent;
}

export interface GenerativeUIContext {
  status: "streaming" | "done";
  dispatch?: (action: unknown) => void;
}

/** Render a children spec: scalars as text, objects recursively. */
function renderChildren(
  children: unknown,
  library: GenerativeUILibrary,
  context: GenerativeUIContext,
): React.ReactNode {
  const one = (child: unknown): React.ReactNode => {
    if (child === null || child === undefined) return null;
    if (typeof child === "string" || typeof child === "number" || typeof child === "boolean") {
      return String(child);
    }
    return renderGenerativeUI(child, library, context);
  };
  if (Array.isArray(children)) {
    return children.map((child, i) => <React.Fragment key={i}>{one(child)}</React.Fragment>);
  }
  return one(children);
}

/** Forward only safe DOM string props (drop the spec's structural keys). */
function domProps(props: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(props)) {
    if (k === "$type" || k === "value" || k === "level" || k === "title" || k === "children") continue;
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

/** Read `children` (already rendered) or fall back to `value` as text. */
function content(props: Record<string, unknown>): React.ReactNode {
  const { children, value } = props;
  if (children !== undefined) return children as React.ReactNode;
  return value === undefined ? null : String(value);
}

/* ── The styled vocabulary ─────────────────────────────────────────────── */

export const styledGenerativeUILibrary: GenerativeUILibrary = {
  Heading: {
    description: "A section heading (levels 1–4).",
    render: (props) => {
      const lvl = Math.min(Math.max(Number(props.level) || 2, 1), 4);
      const Tag = (["h1", "h2", "h3", "h4"] as const)[lvl - 1]!;
      return (
        <Tag data-aui="heading" {...domProps(props)}>
          {content(props)}
        </Tag>
      );
    },
  },
  Text: {
    description: "A paragraph of text.",
    render: (props) => (
      <p data-aui="text" className="text-sm leading-relaxed text-foreground/85" {...domProps(props)}>
        {content(props)}
      </p>
    ),
  },
  Markdown: {
    description: "GitHub-flavored markdown, parsed and styled.",
    render: (props) => (
      <div data-aui="markdown" className="prose-sm assistant-prose max-w-none text-sm text-foreground/85" {...domProps(props)}>
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{String(props.value ?? "")}</ReactMarkdown>
      </div>
    ),
  },
  Card: {
    description: "A titled card grouping content.",
    render: (props) => (
      <div data-aui="card" className={cn(paperCardClass, "max-w-md p-3")} {...domProps(props)}>
        {props.title !== undefined && (
          <p className="mb-2 text-sm font-medium text-foreground/90">{String(props.title)}</p>
        )}
        <div className="space-y-2">{content(props)}</div>
      </div>
    ),
  },
  List: {
    description: "A bulleted list of items.",
    render: (props) => (
      <ul data-aui="list" className="ml-4 list-disc space-y-1 text-sm text-foreground/85" {...domProps(props)}>
        {content(props)}
      </ul>
    ),
  },
  ListItem: {
    description: "One list entry.",
    render: (props) => (
      <li data-aui="list-item" className="leading-relaxed" {...domProps(props)}>
        {content(props)}
      </li>
    ),
  },
  Divider: {
    description: "A hairline rule.",
    render: (props) => <div data-aui="divider" className="my-2 border-t border-border" {...domProps(props)} />,
  },
  Callout: {
    description: "A highlighted note.",
    render: (props) => (
      <div
        data-aui="callout"
        className="rounded-lg border border-primary/25 bg-primary/[0.07] px-3 py-2 text-sm text-foreground/85"
        {...domProps(props)}
      >
        {content(props)}
      </div>
    ),
  },
};

/* ── The renderer ──────────────────────────────────────────────────────── */

export function renderGenerativeUI(
  node: unknown,
  library: GenerativeUILibrary = styledGenerativeUILibrary,
  context: GenerativeUIContext = { status: "done" },
): React.ReactNode {
  if (node === null || node === undefined || node === false) return null;
  if (typeof node === "string" || typeof node === "number" || typeof node === "boolean") {
    // Bare scalars render through the Text vocabulary.
    return library.Text?.render({ value: String(node) }) ?? String(node);
  }
  if (Array.isArray(node)) {
    return renderChildren(node, library, context);
  }
  if (typeof node === "object" && !React.isValidElement(node)) {
    const spec = node as Record<string, unknown>;
    const type = spec.$type;
    if (typeof type !== "string") {
      if (process.env.NODE_ENV === "development") {
        console.error("[generative-ui] node is missing a string $type:", spec);
      }
      return null;
    }
    const component = library[type];
    if (!component) {
      if (process.env.NODE_ENV === "development") {
        console.error(`[generative-ui] unknown $type "${type}" — not in the library`);
      }
      return null;
    }
    // children nests further nodes (rendered); every other key besides
    // $type becomes a plain prop.
    const { $type: _type, children, ...props } = spec;
    return component.render({
      ...props,
      ...(children !== undefined
        ? { children: renderChildren(children, library, context) }
        : {}),
    });
  }
  return null;
}

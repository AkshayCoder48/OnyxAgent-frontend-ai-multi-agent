"use client";

import dynamic from "next/dynamic";
import type { SourceItem } from "@/lib/chat-sources";

export interface MarkdownContentProps {
  content: string;
  onCiteClick?: (index: number) => void;
  /** Web/RAG sources for this message (Beta V1.2). Drives the superscript
   *  citation chips' hover tooltips — the marker itself comes from the
   *  text's [n] tokens, so chips render even while streaming. */
  sources?: readonly SourceItem[];
  /** When true, renders the writing cursor inline at the end of the last
   *  paragraph — right next to the last letter, NOT on a new line below. */
  showCursor?: boolean;
  /** True while the message is actively streaming. Enables the blue→ink
   *  word tint on the newest words of the trailing paragraph (the
   *  "StreamingText" streamer effect). */
  streaming?: boolean;
}

/**
 * Public markdown renderer. The heavy markdown stack (react-markdown +
 * remark-gfm + rehype-highlight) is split into `markdown-content.impl.tsx` and
 * loaded on demand via `next/dynamic`, keeping it out of the initial bundle of
 * pages that never render chat markdown. The prop API is unchanged, so callers
 * (message rendering, file preview) need no changes.
 *
 * `ssr: false` is safe here — chat content is client-rendered and streamed in.
 * The fallback mirrors the streamed text so progressive rendering still shows
 * content immediately while the renderer chunk loads, then swaps to the rich
 * markdown output once ready.
 */
const MarkdownContentImpl = dynamic(
  () => import("./markdown-content.impl").then((m) => m.MarkdownContent),
  {
    ssr: false,
    loading: () => <p className="text-foreground/55 leading-relaxed whitespace-pre-wrap">&nbsp;</p>,
  },
);

export function MarkdownContent({ content, onCiteClick, sources, showCursor, streaming }: MarkdownContentProps) {
  return (
    <MarkdownContentImpl
      content={content}
      onCiteClick={onCiteClick}
      sources={sources}
      showCursor={showCursor}
      streaming={streaming}
    />
  );
}

"use client";

import dynamic from "next/dynamic";

export interface MarkdownContentProps {
  content: string;
  onCiteClick?: (index: number) => void;
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

export function MarkdownContent({ content, onCiteClick, showCursor, streaming }: MarkdownContentProps) {
  return (
    <MarkdownContentImpl
      content={content}
      onCiteClick={onCiteClick}
      showCursor={showCursor}
      streaming={streaming}
    />
  );
}

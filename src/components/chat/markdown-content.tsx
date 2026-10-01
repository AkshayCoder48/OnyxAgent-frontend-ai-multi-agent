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
  /** True while the message is actively streaming. Enables the
   *  character-level streaming fade on the trailing text (each fresh char
   *  mounts as a `.letter-in` span: opacity 0.5→1, blur 5px→0, 0.02s/char
   *  stagger — one continuous per-character stream, never word-based). */
  streaming?: boolean;
  /** How many characters were revealed in the last ~700ms (the live
   *  typewriter's fresh window). Drives the size of the trailing
   *  animated-char window so it stays pop-free at any reveal pace. */
  freshChars?: number;
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

export function MarkdownContent({ content, onCiteClick, sources, showCursor, streaming, freshChars }: MarkdownContentProps) {
  return (
    <MarkdownContentImpl
      content={content}
      onCiteClick={onCiteClick}
      sources={sources}
      showCursor={showCursor}
      streaming={streaming}
      freshChars={freshChars}
    />
  );
}

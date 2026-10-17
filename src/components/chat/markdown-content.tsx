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
  /** True while the message is actively streaming. Keeps the trailing
   *  code block in its plain-line live render (no re-highlight while it
   *  grows) and activates the WORD-FADE stream: each revealed word is
   *  wrapped in a span that fades in, the fades chaining word after word
   *  (the word-typewriter paces the reveal to the fade duration). */
  streaming?: boolean;
  /** Fade duration (ms) the stream engine chose for the most recent word.
   *  Drives the per-word fade-in animation while `streaming` — each word
   *  span bakes this as its animationDuration at mount, so later changes
   *  never re-time an already-running fade. */
  fadeMs?: number;
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

export function MarkdownContent({ content, onCiteClick, sources, showCursor, streaming, fadeMs }: MarkdownContentProps) {
  return (
    <MarkdownContentImpl
      content={content}
      onCiteClick={onCiteClick}
      sources={sources}
      showCursor={showCursor}
      streaming={streaming}
      fadeMs={fadeMs}
    />
  );
}

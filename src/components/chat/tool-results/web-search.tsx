"use client";
import { Globe } from "lucide-react";
import { LinkPreview } from "@/components/assistant-ui/elements";

interface WebHit {
  title: string;
  url: string;
  content: string;
  score?: number | null;
}

export interface WebSearchPayload {
  query: string;
  results: WebHit[];
}

/** Parse a structured `web_search` tool result, or null if it isn't one
 *  (error string / legacy text → caller falls back to the default renderer). */
export function parseWebSearch(result: string): WebSearchPayload | null {
  try {
    const p = JSON.parse(result);
    if (p && typeof p === "object" && p.kind === "web_search" && Array.isArray(p.results)) {
      return { query: String(p.query ?? ""), results: p.results as WebHit[] };
    }
  } catch {
    /* not JSON — fall back to the raw renderer */
  }
  return null;
}

/** Hostname of a URL, or null when it isn't parseable. */
function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

export function WebSearchResults({ data }: { data: WebSearchPayload }) {
  // Only http(s) hits with a parseable hostname become cards — never feed
  // LinkPreview garbage (it also self-gates unsafe protocols).
  const cards = data.results.flatMap((hit, i) => {
    if (!hit.url || !/^https?:\/\//i.test(hit.url)) return [];
    const hostname = hostnameOf(hit.url);
    if (!hostname) return [];
    return [{ hit, hostname, key: `${hit.url}-${i}` }];
  });

  if (cards.length === 0) {
    return (
      <div className="text-muted-foreground flex items-center gap-2 py-2 text-sm">
        <Globe className="h-4 w-4" />
        No web results found
      </div>
    );
  }

  return (
    <div className="space-y-3 py-1">
      <div className="text-foreground/55 flex items-center gap-2 font-mono text-[10px] tracking-wider uppercase">
        <Globe className="h-3 w-3" />
        <span>
          {cards.length} web result{cards.length !== 1 ? "s" : ""}
        </span>
      </div>

      {/* LINK PREVIEW (assistant-ui "Link preview" element): the results
          unfurl as a horizontally scrollable row of cards — swipe on touch,
          drag-scroll/trackpad or arrow keys (the row is focusable) on
          desktop. `items-stretch` + `h-full` keep every card the same height
          regardless of title/snippet length. */}
      <div
        role="group"
        aria-label="Web search results"
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- WAI-ARIA scrollable-region pattern: a labeled focusable group lets keyboard users reach the row and scroll it with arrow keys.
        tabIndex={0}
        className="scrollbar-thin snap-x snap-mandatory focus-visible:outline-primary flex items-stretch gap-3 overflow-x-auto overscroll-x-contain pb-2 focus-visible:outline-2 focus-visible:outline-offset-4"
      >
        {cards.map(({ hit, hostname, key }) => (
          <LinkPreview
            key={key}
            href={hit.url}
            title={hit.title}
            description={hit.content}
            siteName={hostname.replace(/^www\./, "")}
            favicon={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(hostname)}&sz=64`}
            imageAlt={hit.title ? `Preview image from ${hit.title}` : ""}
            layout="card"
            className="h-full w-[240px] shrink-0 snap-start sm:w-[260px]"
          />
        ))}
      </div>
    </div>
  );
}

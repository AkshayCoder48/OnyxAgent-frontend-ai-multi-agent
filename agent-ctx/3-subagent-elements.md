# Task 3 — new-elements (subagent-elements)

Task: Create assistant-ui elements — LinkPreview + QuoteReply/SelectionToolbar + quote store.

## Files created

1. `src/components/assistant-ui/elements/link-preview.tsx` — the assistant-ui "link preview"
   element, Terra-themed (props-driven, no runtime).
   - `LinkPreview({ href, title?, description?, image?, imageAlt? = "", siteName?, favicon?,
     layout? = "card", className?, ...articleProps })` — `<article data-slot="link-preview"
     data-layout="card|compact">`, extra article props forwarded to root.
   - Unsafe URL handling: `new URL(href)` in try/catch; ONLY http:/https: become anchors —
     anything else (javascript:, data:, relative, garbage) renders the identical card as inert
     text (span, no href). Title/siteName default to URL host, then the raw href string.
   - Title anchor: `target="_blank" rel="noopener noreferrer"` + sr-only "(opens in a new
     tab)"; its `after:absolute after:inset-0` stretches the hit target across the whole card
     (only when linkable; the article carries `relative`).
   - Media fail-soft, per-src: `onError` remembers the broken src — the preview image's frame
     is removed entirely; the favicon falls back to a small square with the site's initial.
     Both `loading="lazy"`; image alt from `imageAlt`.
   - Styling per spec: `rounded-xl border border-border bg-secondary/60 transition-shadow
     hover:shadow-sm`; card image `aspect-[16/9] w-full rounded-t-xl object-cover`; compact
     `flex items-stretch` with a flush-left `h-16 w-16 rounded-l-xl` thumbnail; site row
     `text-[11px] text-muted-foreground`; title `text-sm font-medium text-foreground`;
     description `text-xs text-muted-foreground line-clamp-2`.
   - Helpers: `extractFirstUrl(text)` (regex `https?:\/\/[^\s"'<>)\]]+`, strips trailing
     `.,;:!?`) and `extractUrls(text, max = 4)` (unique, in order).
2. `src/components/assistant-ui/elements/quote-reply.tsx` — the assistant-ui "quote" element,
   runtime selection variant.
   - `SelectionToolbar({ onQuote })` — fixed-position portal toolbar (createPortal →
     document.body, mounted gate) that appears when a non-empty selection's anchor AND focus
     nodes sit inside an ancestor `[data-quoteable]` (explicit `"false"` opt-out honored).
     Listens: document `mouseup` + `keyup` (immediate, ignoring events inside the toolbar),
     `selectionchange` (debounced 150ms), hides on scroll (window capture), resize, Escape
     (keydown; its keyup can't re-show), collapse/empty, or leaving quoteable areas.
     Positions above the selection start, centered on the rect (`range.getBoundingClientRect()`,
     zero-size rect → start-container element rect), then measures and clamps into the
     viewport with 8px margins (clamp paired to its anchor by object identity — no stale
     bleed). Quote button: lucide `Quote` icon + label, `text-xs`; `onMouseDown` preventDefault
     keeps the selection alive for the click. Click → `onQuote(text.trim())` → selection
     cleared → toolbar hidden. Animation: `quote-toolbar-in` class (fade + scale, 150ms).
     `rounded-lg border border-border bg-background shadow-lg px-1 py-0.5`, z-50, opaque.
     All setState strictly inside listeners/effects; every listener cleaned up on unmount.
   - `ComposerQuotePreview({ quote, onDismiss })` — inset block for above the composer:
     `animate-fade-in rounded-lg border border-border bg-muted/50 px-3 py-2` with a
     `border-l-2 border-l-primary` accent bar, mono "Quoted text" micro-label (the shared
     `monoLabelClass`), `line-clamp-3` quoted text, ghost X dismiss button (aria-label
     "Remove quote"). Null quote renders nothing. Static `QuoteReply` variant intentionally
     skipped (runtime flow is the full feature).
3. `src/stores/quote-store.ts` — `useQuoteStore` zustand store following the existing store
   conventions (`"use client"`, `create<QuoteState>()`): `quote: { text } | null`,
   `setQuote(text)`, `clearQuote()`. Session-only, NOT persisted (a quote is ephemeral).

## Files modified

- `src/components/assistant-ui/elements/index.ts` — appended:
  `export { LinkPreview, extractFirstUrl, extractUrls, type LinkPreviewProps } from "./link-preview";`
  `export { SelectionToolbar, ComposerQuotePreview } from "./quote-reply";`
- `src/stores/index.ts` — appended `export { useQuoteStore } from "./quote-store";`
  (additive, matches the store re-export pattern).
- `src/app/globals.css` — bottom block
  `/* ===== Quote selection toolbar + link preview (assistant-ui elements) ===== */`
  with `.quote-toolbar-in` + `@keyframes quote-toolbar-in` (static transform mirrors the
  keyframe end-state so reduced-motion still lands correctly); `.quote-toolbar-in` also
  appended to the global `prefers-reduced-motion` kill-by-class list (~line 1058).

## Integration notes for the wiring agent (Task 3 follow-ups)

- Message containers: add `data-quoteable="true"` to the message bubble/content wrappers
  (message-item.tsx — owned by another agent).
- Mount `<SelectionToolbar onQuote={(t) => useQuoteStore.getState().setQuote(t)} />` once in
  the chat container, and `<ComposerQuotePreview quote={q} onDismiss={clearQuote} />` above
  the composer input (`const q = useQuoteStore((s) => s.quote)`). Clear the quote on send.
- `LinkPreview` can be rendered from markdown/image-search flows via `extractFirstUrl` /
  `extractUrls`.

## Verification

- `bun run lint`: 0 errors, 32 warnings — ALL pre-existing; zero warnings from the new files
  (the two `<img>`s carry justified eslint-disable comments for
  `@next/next/no-img-element` — matching file-card.tsx's convention — plus one false-positive
  `jsx-a11y/no-noninteractive-element-interactions` on the preview img's onError).
- `bunx tsc --noEmit`: clean project-wide.
- Throwaway SSR smoke (run then deleted): extract helpers' punctuation/paren/uniqueness/max
  edge cases; safe link renders anchor + rel + sr-only label + host fallback; javascript:
  and garbage hrefs render inert with no anchor; compact layout + site initial;
  ComposerQuotePreview content/dismiss/null; SelectionToolbar renders nothing on the server;
  store setQuote/clearQuote round-trip. All passed ("SMOKE OK").

## Deviations from spec

- Store exported as `useQuoteStore` (not `quoteStore`) to match the repo's `useXStore`
  convention the task told me to follow from existing stores.
- Compact thumbnail uses the spec's alternative "rounded-l-xl flush left" option instead of
  `gap-3 + rounded-lg`.
- Left accent bar uses `border-l-2 border-l-primary` (left-only terracotta) instead of the
  literal `border-primary` (which would tint all four sides).
- Added `type LinkPreviewProps` to the index re-exports and an optional `className` on
  ComposerQuotePreview, matching sibling elements' conventions.

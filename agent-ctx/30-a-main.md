# Task 30-a — Generative UI (GenUI) streamed JSON spec system

**Agent:** main
**Status:** ✅ complete

## What was built

A full Generative UI pipeline where the AI emits `<<<genui>>>...<<</genui>>>`
blocks in its text stream, and the client parses + renders rich inline
components (image grids, comparison tables, charts, code blocks, etc.) in
real-time during streaming.

## Files created (35 new)

### Core library (`src/lib/genui/`)
- `types.ts` — `GenUINode` / `GenUISpec` interfaces, sentinel constants,
  `ProcessTextDeltaResult`.
- `stream-parser.ts` — sentinel scanner + tolerant incremental JSON parser.
  - `repairJson(input)` patches unterminated strings, missing brackets,
    trailing commas, truncated values (`: tru` → drop key).
  - `parseTolerant<T>(jsonish)` tries `JSON.parse` → `repairJson` → aggressive
    trim. Never throws.
  - `segmentText(full)` splits into `{ before, blocks, after, inGenUI }`.
  - `processTextDelta(accumulated, newChunk)` → `{ beforeText, genuiSpec, inGenUI }`.
- `validate.ts` — Zod-like validation (no zod dep).
  - Per-type prop allow-lists (`ALLOWED_PROPS_BY_TYPE`).
  - URL sanitization: only `https://`, `http://`, `data:image/`, relative paths.
  - Depth cap at 4.
  - Unknown types rewritten to `unknown_json` with raw payload in `props.__raw`.

### Hook
- `src/hooks/useGenUIStream.ts` — `useGenUIStream(messageId, enabled)`
  subscribes to chat store, re-parses on every text delta, returns
  `{ genuiSpec, textBefore, textAfter, inGenUI }`. Also exports
  `useGenUIFromText(text)` for parsing arbitrary text (used by TextBubble).

### Components (`src/components/genui/`)
- `helpers.tsx` — shared prop accessors (`str`, `num`, `bool`, `arr`, `obj`),
  `ShimmerPlaceholder`, `StreamingWrap`, `gridCols`.
- `GenUIBlock.tsx` — root renderer. Recursively renders the node tree via
  the registry. Wraps each node in `GenUIBlockErrorBoundary` (falls back to
  raw JSON on crash).
- `registry.tsx` — maps 30 type strings to lazy-loaded React components via
  `next/dynamic({ ssr: false })`. `getRenderer(type)` with fallback.
- `UnknownFallback.tsx` — fallback card showing raw JSON in `<pre>` + copy button.
- 30 P0 component files:
  `Header, Image, ImageGrid, ComparisonTable, CodeBlock, SourcesPanel, Card,
  CardGrid, Stat, StatsRow, Callout, List, Checklist, Timeline, Stepper,
  Divider, Columns, Tabs, Accordion, TextBlock, Quote, KeyValue, Badge,
  Progress, Sparkline, SuggestionChips, AgentCard, TerminalCard, WeatherCard,
  StockTicker`.

  Each:
  - Receives `props: Record<string, unknown>` + optional `children: GenUINode[]`.
  - Uses shadcn/ui where possible (Card, Badge, Alert, Tabs, Accordion, Table,
    Progress, Checkbox, Separator, Avatar).
  - Uses CSS variables for colors (`bg-card`, `text-foreground`, `text-primary`,
    etc.) — works with ALL color schemes.
  - Handles missing/invalid props gracefully (never crashes).
  - Shows a shimmer skeleton while `meta.streaming` is true.

## Files modified (3)

- `src/types/chat.ts` — added `genui?: GenUINode[]` to `ChatMessage` + import.
- `src/lib/agent/runtime.ts` — appended "Generative UI (GenUI)" section to
  `toolKnowledgeBase` with: available types list, spec format, when to use
  GenUI vs prose, 3 worked examples (comparison_table, image_grid, stats_row),
  rules (image meta.source required, URL schemes, unique IDs, depth cap).
- `src/components/chat/message-item.tsx`:
  - Imported GenUIBlock, useGenUIFromText, segmentText, validateSpec, GenUINode,
    useChatStore.
  - Added `extractGenUIFromMessage(message)` helper.
  - Rewrote `TextBubble` to accept `genuiNodes` + `isStreaming` props. Splits
    text via `useGenUIFromText`, renders `textBefore` (markdown) → `<GenUIBlock>`
    → `textAfter` (markdown). Live-parsed spec takes precedence; falls back to
    persisted `genuiNodes`.
  - Both TextBubble call sites now pass `genuiNodes` + `isStreaming`.
  - Added `useEffect` in `MessageItem` that persists `message.genui` when
    streaming completes (parses from content if sentinels present + genui unset).
  - Added `message.genui` to the React.memo comparator.

## Design highlights

- **Tolerant parser** never throws — always returns something renderable.
  Handles mid-string truncation, missing brackets, trailing commas, partial
  keywords (`tru`, `fals`, `nu`), partial numbers (`12.`, `1e`).
- **Lazy loading** via `next/dynamic` keeps heavy components out of the
  initial chat bundle. Loading placeholder is a shimmer to avoid layout shift.
- **Error boundary** catches renderer crashes → falls back to raw JSON `<pre>`.
- **URL sanitization** strips non-https/http/data:image schemes.
- **CSS variables** throughout — works with every theme (light/dark/branded).
- **Streaming UX**: each renderer shows a shape-matching shimmer skeleton
  (ImageGrid → N shimmer tiles, ComparisonTable → shimmer rows, etc.) until
  enough props arrive.
- **Persistence**: `message.genui` populated by useEffect on stream completion;
  sessionStorage saves it for the session; re-parsed from content on reload.

## Verification
- `bunx tsc --noEmit` passes (only pre-existing error in
  `src/app/api/chat-proxy/route.ts:232` unrelated to this task).
- Dev server compiles the chat route without errors.

## How to use
The AI emits:
```
Here's the plan comparison:

<<<genui>>>
{"nodes":[{"id":"cmp1","type":"comparison_table","props":{"title":"Plans","options":["Free","Pro"],"features":[{"feature":"Seats","values":[1,10]},{"feature":"SSO","values":[false,true]}]}}]}
<<</genui>>>
```
The text renders as markdown, then the comparison table renders inline as a
rich component. During streaming, the table shimmers in as JSON arrives
token-by-token.

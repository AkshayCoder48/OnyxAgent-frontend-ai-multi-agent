# IMAGE-SEARCH-DDG — Miklium image search → DuckDuckGo (image_search tool)

Task ID: IMAGE-SEARCH-DDG
Agent: main session (Z.ai Code)

## What changed
`image_search` now hits **DuckDuckGo first** via
`@mudbill/duckduckgo-images-api` (v2.0.1, latest on npm — the same API
surface as the v2.0.4 GitHub master the user quoted: `imageSearch({query,
safe, retries, iterations}) → DuckDuckGoImage[]`). No API key, no billing,
real DDG/Bing thumbnails + dimensions. **Miklium stays as the automatic
fallback** when DDG errors out or returns nothing. The tool-call payload
shape is byte-for-byte the same as the Miklium era — only `provider` flips
`"miklium"` → `"ddg"` — so the chat `ImageSearchResults` carousel renders
unchanged (its badge now reads the provider dynamically instead of the
hardcoded "miklium").

## Files CREATED
- `src/lib/search/ddg-images.ts` — the DDG integration module:
  `normalizeDDGImages` (PURE: DuckDuckGoImage → Miklium-compatible
  SearchResult shape; dedupe by binary URL, image-URL fallbacks for missing
  reference/thumbnail) + `searchDDGImages` (network: package call raced
  against an 8s ceiling — the package has no abort support and a
  dropped-SYN egress hangs ~2min in Node's TCP retransmission loop, which
  would blow the route's 30s maxDuration before the Miklium fallback runs).
- `src/lib/search/ddg-images.test.ts` — 9 vitest cases, network fully
  mocked (SERP page with the vqd token → i.js JSON): package flow makes
  exactly 2 HTTP calls, normalization shape/dedupe/fallbacks/limit, token
  failure propagation (route falls back), empty-array-as-down, 8s timeout
  race (fake timers).

## Files MODIFIED
- `src/app/api/ddg-search/route.ts` — `type=image` branch: DDG first
  (`searchDDGImages`), Miklium fallback on throw OR empty; provider union
  gains `"ddg"`; header comment rewritten. Web (LangSearch→Miklium) and
  video (Miklium) routing untouched.
- `src/lib/tools/ddg_search.ts` — `image_search` tool description updated;
  `provider` now taken from the proxy response (was hardcoded "miklium").
- `src/components/chat/tool-results.tsx` — `ImageSearchResults` badge is
  now `parsed?.output?.provider ?? "miklium"` (shows "ddg" for DDG
  results); comment updated. Video badge untouched (still Miklium).
- `cli/src/lib/tools.ts` — CLI `image_search`: DDG primary with the same
  8s race + Miklium fallback, same output shape + new `provider` field.
- `cli/package.json` + `cli/bun.lock`, `package.json` + `bun.lock` —
  `@mudbill/duckduckgo-images-api@^2.0.1` added to both packages.
- `Onyx.md`, `README_HF.md`, `src/lib/agent/onyx-md.ts` — tool-table /
  feature-list lines updated to say images = DuckDuckGo (Miklium fallback).

## Verification (test-first, as requested)
- **Live end-to-end against real duckduckgo.com**: the REAL route handler
  (`GET` imported and invoked) returned `provider: "ddg"`, 6 results in
  **674ms** (HTTP 200). The raw package alone: 77 results in 587ms. DDG
  serves the vqd token even to the package's default no-UA fetch, and the
  package's `/vqd=([\d-]+)&/` token regex matches the live SERP (verified
  against the real HTML; real tokens are digits+hyphens).
- **Live fallback path**: when the sandbox egress blocked DDG, the route
  logged `[image-search] DuckDuckGo failed, falling back to Miklium` and
  still returned HTTP 200 with correct shape — **8.8s total** after the
  timeout race (was 132s before the fix).
- **Format parity**: DDG payload vs live Miklium payload — identical
  top-level keys (`query,type,results,count,provider`), identical
  per-result key set, compatible field types. 10/10 assertions in the
  standalone rig (`/home/z/my-project/scripts/test-ddg-images.ts`), incl.
  URL-liveness 15/16 image/thumbnail URLs serving `image/*` (93.75%).
- **Visual preview**: `/home/z/my-project/download/ddg-image-search-preview.html`
  replicates the chat carousel pixel-faithfully and renders BOTH payloads
  side by side (BEFORE miklium / AFTER ddg); agent-browser verified 16
  images, 0 broken, next/prev/dots/counter all functional, badges read
  "miklium" and "ddg".
- **Repo gates**: `vitest run src/lib/search/ddg-images.test.ts` → 9/9;
  full tsc diff vs HEAD → **0 new errors** (205 pre-existing unchanged);
  eslint on every changed file → 0 errors; CLI `tsc --noEmit` → exit 0;
  request-scoping failures proven pre-existing on HEAD (7 failed before
  AND after).

## Notes
- Safe search is ON for DDG (`safe: true`) — responsible default for an
  end-user product; one-word change to disable.
- The sandbox's duckduckgo.com egress is intermittent; the test rig treats
  live success as a bonus and always also proves the code path via the
  mocked-fixture test (deployed environments are unaffected).
- Video search intentionally stays Miklium-only (neither LangSearch nor
  DDG support videos).

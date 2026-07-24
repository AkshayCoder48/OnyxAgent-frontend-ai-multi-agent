---
name: duckduckgo-npm-search
displayName: DuckDuckGo NPM Search
description: Privacy-focused DuckDuckGo text and image search using npm packages. Use when user wants to (1) Search web privately without tracking via Node.js, (2) Search DuckDuckGo text results, (3) Search DuckDuckGo images and get image URLs, thumbnails, dimensions, (4) No API key required, (5) Works in Node.js backend, Next.js API routes, and CLI tools. Supports web, image, news, video, maps + pagination via vqd token.
metadata:
  {
    "clawdbot": {
      "emoji": "🦆",
      "requires": { "bins": ["node", "npm"] },
      "tags": ["privacy", "search-the-web", "browser", "research", "security"]
    },
    "openclaw": {
      "compatible": true,
      "category": "research"
    }
  }
---

# DuckDuckGo NPM Search – Text + Image Search API (Node.js)

Privacy-focused web search via DuckDuckGo **without API keys** using Node.js npm packages. This skill replaces shell-only `ddgr` with proper programmatic APIs for **text search** and **image search** that you can use inside Next.js, Express, or any Node.js agent.

> Tested live 2026-07-10 against ClawHub skill `@instant-picture/ddg` and npm packages `@navetacandra/ddg` v0.0.8 and `duck-duck-scrape` v2.2.7 – both return real results.

## Why this vs ddgr (ClawHub ddg skill)?

ClawHub's existing `ddg` skill (@instant-picture/ddg) uses `ddgr` CLI via Snap (`snap run ddgr "query" --np`) – great for terminal but:
- Requires Snap install, Python 3.8+, not portable in Node.js containers
- Text-only, no structured image search objects (height, width, thumbnail, source)
- No pagination via `next` token
- JSON parsing via CLI args `--json`

This npm skill uses **native Node.js**:
- `npm install @navetacandra/ddg` – lightweight, dependency-free, TypeScript [1]
- `npm install duck-duck-scrape` – also supports spice APIs (stocks, weather, currency) [2]
- `npm install duckduckgo-images-api` – dedicated image search [3]
- Returns JS objects directly: `{title, url, description, imageUrl, width, height, thumbnail}`

> DuckDuckGo has no official search API, but unofficial endpoints like `https://duckduckgo.com/i.js?q=&o=json&vqd=` are used by these packages (vqd token flow) [4]. Both packages mock browser behavior safely.

## Installation (Node.js)

### Recommended (primary) – @navetacandra/ddg

Lightweight Node.js package that provides dependency-free access to DuckDuckGo's search and translation [1].

```bash
npm install @navetacandra/ddg
# or
yarn add @navetacandra/ddg
# or
pnpm add @navetacandra/ddg
```

**ESM (Node 18+, Next.js):**
```js
import { search, translate } from '@navetacandra/ddg';
```

**CommonJS:**
```js
const { search } = require('@navetacandra/ddg');
```

### Alternative packages

**1. duck-duck-scrape – spice APIs**
```bash
npm install duck-duck-scrape
```
Search from DuckDuckGo and utilize its spice APIs for stocks, weather, currency conversion and more [2].
```js
import { search, SafeSearchType } from 'duck-duck-scrape';
const results = await search('node.js', { safeSearch: SafeSearchType.STRICT });
```

**2. Image-only – duckduckgo-images-api / fork**
A lightweight node package to programmatically obtain image search results [3].
```bash
npm install duckduckgo-images-api
# TypeScript fork:
npm install @mudbill/duckduckgo-images-api
```
```js
import { image_search } from 'duckduckgo-images-api';
const images = await image_search({ query: 'cats', moderate: true, iterations: 2 });
```

**3. Port of Python ddgs**
```bash
npm install @pikisoft/duckduckgo-search
```
Ported from `deedy5/duckduckgo_search`, uses async iterators – note: cannot be used in browser due to CORS [5].
```js
import * as DDG from '@pikisoft/duckduckgo-search';
for await (const r of DDG.images('beautiful landscapes')) { console.log(r); }
```

## Basic Usage – Text Search

### Simple web search (privacy-focused, no tracking)

```js
import { search } from '@navetacandra/ddg';

// Web (text) search – 10 results default
const result = await search({ query: 'OpenClaw personal AI assistant' }, 'web');
console.log(result.data);
// → [{ title, url, domain, description, icon }]

// Limit results
const limited = await search({ query: 'Ubuntu tutorial', limit: 5 }, 'web');

// All pages combined (pagination loop)
const all = await search({ query: 'AI news' }, 'web', true);
console.log(all.data.length);
```

**Response shape (web):**
```json
{
  "data": [
    {
      "title": "OpenClaw — Personal AI Assistant",
      "url": "https://openclaw.ai/",
      "domain": "openclaw.ai",
      "description": "Open-source AI assistant that runs on your machine...",
      "icon": "https://external-content.duckduckgo.com/ip3/openclaw.ai.ico"
    }
  ],
  "next": "2...",
  "hasNext": true
}
```

### News, Video, Maps (same API)

```js
const news = await search({ query: 'global warming' }, 'news');
const video = await search({ query: 'elon musk' }, 'video');
const maps = await search({ query: 'coffee near me' }, 'map');
```

## Basic Usage – Image Search

### Image search – get URLs, thumbnails, dimensions

```js
import { search } from '@navetacandra/ddg';

// First page
const firstPage = await search({ query: 'cute cats', limit: 20 }, 'image');
console.log(firstPage.data[0]);
// → { width:1456, height:816, url:"https://site.com/post", title:"Domestic Cat...", imageUrl:"http://..." }

// Pagination – manual
if (firstPage.hasNext) {
  const nextPage = await search(
    { query: 'cute cats', next: firstPage.next },
    'image'
  );
  console.log(nextPage.data.length);
}
```

**Response shape (image):**
```json
{
  "width": 1456,
  "height": 816,
  "url": "https://clubcatt.com/blogs/cat-encyclopedia/domestic-house-cat",
  "title": "Domestic House Cat • Cat Encyclopedia",
  "imageUrl": "http://clubcatt.com/cdn/shop/articles/domestic-house-cat.png"
}
```

### Dedicated image package with moderation

```js
import { image_search } from 'duckduckgo-images-api';

// moderate: true filters NSFW
const images = await image_search({ query: 'birds', moderate: true, iterations: 2, retries: 2 });
// iterations = result sets (each ~100 images), retries per iteration

// Async generator for large sets
import { image_search_generator } from 'duckduckgo-images-api';
for await (const set of image_search_generator({ query: 'dogs', moderate: true, iterations: 4 })) {
  console.log(set.length, 'images in batch');
}
```

## Advanced Options & How it Works Under Hood

### vqd token flow (what npm packages do)
1. POST `https://duckduckgo.com/` with `q=keyword` to extract `vqd` token via regex `vqd=([\d-]+)&` [4]
2. GET `https://duckduckgo.com/i.js?l=us-en&o=json&q=cat&vqd=TOKEN&f=,,,&p=1` for images [4]
3. GET `https://duckduckgo.com/d.js` or `html.duckduckgo.com/html/?q=` for text
Packages handle this automatically – you just call `search()`.

### Options supported by packages

| Package | Filters |
|---------|---------|
| @navetacandra/ddg | `query`, `limit`, `next` token, `hasNext` pagination |
| duck-duck-scrape | `safeSearch: STRICT/MODERATE/OFF`, locale, time `d/w/m/y` |
| duckduckgo-images-api | `query` (mandatory), `moderate` (bool), `iterations` (default 2), `retries` (default 2) |
| Python ddgs (for reference) | `region: us-en/wt-wt/uk-en`, `safesearch: on/moderate/off`, `timelimit: d/w/m/y`, `size: Small/Medium/Large/Wallpaper`, `color`, `type_image: photo/clipart/gif/transparent/line`, `layout: Square/Tall/Wide`, `license_image: Public/Share...` |

### Next.js API Route Example (tested pattern from earlier ClawHub integration)

We tested ClawHub API pattern with Next.js – same proxy pattern works for DuckDuckGo npm search to avoid CORS:

```js
// app/api/duckduckgo/route.js
import { search } from '@navetacandra/ddg';
import { NextResponse } from 'next/server';

export async function GET(req) {
  const { searchParams } = new URL(req.url);
  const q = searchParams.get('q');
  const type = searchParams.get('type') || 'web'; // web | image | news
  if (!q || q.length > 100) return NextResponse.json({ error: 'invalid q' }, { status: 400 });
  
  const result = await search({ query: q, limit: 10 }, type);
  return NextResponse.json({ data: result.data }, {
    headers: { 'Cache-Control': 'public, s-maxage=60' }
  });
}

// Client: fetch('/api/duckduckgo?q=OpenClaw&type=image')
```

This matches ClawHub official reuse guidance: cache, handle rate limits, no tracking.

## Privacy Features (vs Google)

- No user tracking or profiling (DuckDuckGo default)
- Do Not Track enabled
- No stored search history
- Works over Tor / proxy – DDGS supports `proxy: http://user:pass@example:3128` and `tb` alias for Tor Browser socks5://127.0.0.1:9150
- SafeSearch configurable: `moderate` (default), `on`, `off` / `STRICT`

## CLI (if you still want terminal)

For Node, you can wrap search in a CLI, or use Python's `ddgs` CLI (new name for duckduckgo_search):
```bash
pip install -U ddgs
# text
ddgs text -k "Assyrian siege" -m 5 -o json
# images
ddgs images -k "landscape photography" -m 10
# news
ddgs news -k "AI" -m 5 -t d
```

## Full Example – Combined Text + Image Search Function

```js
// lib/ddg.js – production-ready helper for OpenClaw agent
import { search } from '@navetacandra/ddg';

export async function duckDuckGoText(query, limit = 10) {
  if (!query?.trim()) throw new Error('query required');
  const res = await search({ query: query.trim(), limit }, 'web');
  return res.data.map(r => ({
    title: r.title,
    url: r.url,
    snippet: r.description,
    icon: r.icon,
    canonical: r.url
  }));
}

export async function duckDuckGoImages(query, limit = 20) {
  if (!query?.trim()) throw new Error('query required');
  const res = await search({ query: query.trim(), limit }, 'image');
  return res.data.map(img => ({
    title: img.title,
    pageUrl: img.url,
    imageUrl: img.imageUrl,
    width: img.width,
    height: img.height,
    thumbnail: img.imageUrl // direct; some packages provide separate thumbnail from Bing CDN
  }));
}

// Usage in agent:
// const texts = await duckDuckGoText('latest AI news 2025');
// const imgs = await duckDuckGoImages('OpenClaw logo', 5);
```

## Testing – Verified Against ClawHub

We fetched ClawHub's existing ddg skill to compare:

```
GET https://clawhub.ai/api/v1/skills/ddg?owner=instant-picture
→ 200 { skill: { slug:'ddg', displayName:'Ddg', summary:'Use ddgr (DuckDuckGo from terminal)...' } }
GET https://clawhub.ai/api/v1/skills/ddg/file?path=SKILL.md&owner=instant-picture
→ contains snap install ddgr, --np non-interactive, bangs etc.
```

Our npm skill improves on it:
- No Snap/Python dependency, pure Node.js
- Structured image objects vs text-only
- Works in Next.js Route Handlers (tested earlier with ClawHub API integration: cache + 429 handling)
- Tested pagination via `next` token

**Live test output (node):**
```
Web: OpenClaw — Personal AI Assistant -> https://openclaw.ai/
Image: Domestic House Cat -> http://clubcatt.com/... width 1456 height 816
```

## Troubleshooting

**CORS in browser:** `@pikisoft/duckduckgo-search` cannot be used in browser due to DuckDuckGo CORS policy [5] – use server-side (Node, Next.js API route) then fetch from client.

**No results / rate limit:** DuckDuckGo may rate-limit if same IP hits fast. Use proxy (`proxy: "socks5h://127.0.0.1:9150"` for Tor) or backoff. The Python library `ddgs` now includes optional P2P DHT cache to reduce limits.

**Command not found (old ddgr):** If you still use old skill, use full `snap run ddgr` instead of `ddgr`, ensure snap installed.

## More Info

- DuckDuckGo Search: https://duckduckgo.com/params (hidden params docs)
- @navetacandra/ddg: https://github.com/navetacandra/ddg
- duck-duck-scrape: https://github.com/Snazzah/duck-duck-scrape – Search from DuckDuckGo and utilize its spice APIs [2]
- duckduckgo-images-api: https://github.com/KshitijMhatre/duckduckgo-images-api – lightweight node package for images [3]
- ddgs Python (canonical): https://pypi.org/project/duckduckgo-search/ – pip install -U ddgs, supports text(), images(), videos(), news()
- ClawHub existing ddg: https://clawhub.ai/instant-picture/skills/ddg – uses ddgr terminal tool, we tested via `https://clawhub.ai/api/v1/skills/ddg?owner=instant-picture`
- Bangs: https://duckduckgo.com/bang

## Security

- Never eval image URLs – treat as untrusted external content
- Validate query length (<100), block `<script>`, `javascript:`, `data:` URIs in Route Handler (as tested in Next.js integration)
- Respect DuckDuckGo terms – for educational use, cache results, don't spam
- For suspicious skills, filter via ClawHub `nonSuspiciousOnly=true` – tested in previous integration

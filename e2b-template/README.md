# E2B Custom Template — Playwright + Chromium Browser

This custom E2B template extends the default `code-interpreter` template with:
- **Google Chrome / Chromium** (headless browser)
- **Playwright** (Python + Node.js bindings)
- **Puppeteer** (Node.js alternative)
- All browser dependencies (shared libs, fonts)

## Why a custom template?

The default `code-interpreter-v1` template doesn't include a browser. When the AI runs `npx playwright install chromium`, it downloads ~150MB of browser binaries to `~/.cache/ms-playwright/` — which gets lost when the sandbox is recreated (dead-sandbox recovery, quota eviction, cold start).

With this custom template, Chrome + Playwright + Puppeteer are **baked into the template** — every new sandbox starts with the browser already installed. No per-sandbox download needed.

## Build

```bash
# Install E2B CLI (if not already)
npm install -g @e2b/cli

# Build the template
cd /home/z/my-project
e2b template build -c e2b-template/Dockerfile -n playwright-browser
```

This takes ~5-10 minutes (downloads Chrome, installs dependencies). The template is stored in your E2B account and can be referenced by name.

## Use

Once built, update the sandbox route to use this template:

```typescript
// In src/app/api/sandbox/route.ts, createAndCacheSandbox():
const sandbox = await Sandbox.create({
  apiKey,
  template: "playwright-browser",  // ← custom template name
  timeout: 86_400_000,
});
```

## What's included

| Component | Version | Purpose |
|-----------|---------|---------|
| Python 3 | (from base) | Code execution |
| Node.js | (from base) | Code execution |
| Playwright (Python) | latest | Browser automation (Python) |
| Playwright (Node.js) | latest | Browser automation (Node.js) |
| Chromium | latest | Headless browser |
| Puppeteer | latest | Node.js browser automation |
| Browser deps | — | Shared libs (libnss3, libgbm1, etc.) |
| Fonts | — | Liberation, Noto Color Emoji, Noto CJK |

## Environment variables

- `PLAYWRIGHT_BROWSERS_PATH=/home/user/.cache/ms-playwright`
- `PUPPETEER_EXECUTABLE_PATH=/home/user/.cache/ms-playwright/chromium-*/chrome-linux/chrome`

## Verification

After building, test in the chat:

```
Ask the AI: "Install playwright and take a screenshot of example.com"
```

The AI can run:
```python
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page()
    page.goto("https://example.com")
    page.screenshot(path="screenshot.png")
    browser.close()
```

No `playwright install` needed — it's already in the template.

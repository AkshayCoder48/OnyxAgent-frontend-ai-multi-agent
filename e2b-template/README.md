# E2B Custom Template — CloakBrowser + Playwright/Chromium Browser

This custom E2B template extends the default `code-interpreter` template with:

- **CloakBrowser 0.6.1** (pinned) — the stealth Chromium engine the `use_browser`
  tool drives with `launch_persistent_context(humanize=True)` (Playwright
  drop-in API). **This is the primary browser runtime of the app.**
- **The CloakBrowser stealth Chromium binary** — downloaded at BUILD time
  (`python3 -m cloakbrowser install`), so no ~200MB download on first use.
- **Playwright** (Python + Node.js) + stock **Chromium** — the fallback engine
  when CloakBrowser is unavailable (install/launch failure).
- **Puppeteer** (Node.js alternative)
- All browser dependencies (shared libs, fonts)

Without a `CLOAKBROWSER_LICENSE_KEY` the package uses the **free stealth
binary** — no license required. Set `CLOAKBROWSER_LICENSE_KEY` as a sandbox
env var to enable Pro (seat-limited).

## Why a custom template?

The default `code-interpreter-v1` template doesn't include a browser. Without
this template, the browser tool pip-installs `cloakbrowser + playwright` into
a fresh sandbox at runtime (~280s on first use) and downloads the stealth
Chromium binary on first launch. With this template everything is **baked
into the image** — every new sandbox starts browser-ready.

## Build

```bash
# Install E2B CLI (if not already)
npm install -g @e2b/cli

# Build the template (takes ~5-10 minutes — downloads Chromium twice)
cd /home/z/my-project
e2b template build -c e2b-template/Dockerfile -n onyx-cloakbrowser
```

The template is stored in your E2B account and referenced by name.

## Use

Set one environment variable where the Next.js app runs:

```
E2B_TEMPLATE_ID=onyx-cloakbrowser
```

The sandbox route (`src/app/api/sandbox/route.ts`, `createAndCacheSandbox`)
reads it and passes `template` to `Sandbox.create({ ... })`. **Unset** → the
default code-interpreter template is used and the browser runtime
self-installs at runtime (works, just slower on first use). A missing
template name never breaks sandbox creation — it is opt-in.

## What's included

| Component | Version | Purpose |
|-----------|---------|---------|
| Python 3 | (from base) | Code execution |
| Node.js | (from base) | Code execution |
| CloakBrowser (Python) | 0.6.1 (pinned) | **Primary** stealth browser engine (`use_browser`) |
| CloakBrowser stealth Chromium | latest free | The patched Chromium binary (baked in) |
| Playwright (Python) | latest | Fallback browser engine + CloakBrowser driver API |
| Playwright (Node.js) | latest | Browser automation (Node.js) |
| Chromium | latest | Fallback headless browser (baked in) |
| Puppeteer | latest | Node.js browser automation |
| Browser deps | — | Shared libs (libnss3, libgbm1, etc.) |
| Fonts | — | Liberation, Noto Color Emoji, Noto CJK |

## Environment variables

- `PLAYWRIGHT_BROWSERS_PATH=/home/user/.cache/ms-playwright`
- `PUPPETEER_EXECUTABLE_PATH=/home/user/.cache/ms-playwright/chromium-*/chrome-linux/chrome`
- `E2B_TEMPLATE_ID` (app side) — opt-in template selection
- `CLOAKBROWSER_LICENSE_KEY` (optional, sandbox env) — enables the Pro binary

## Verification

After building and setting `E2B_TEMPLATE_ID`, test in the chat:

```
Ask the AI: "Use the browser to open https://example.com and read the page"
```

The `use_browser` tool boots instantly (no pip install — packages are already
in the image) and returns `runtime: "cloakbrowser"` in its result payload.

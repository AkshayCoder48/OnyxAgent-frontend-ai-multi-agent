# E2B Custom Template — CloakBrowser + Playwright/Chromium + Python + Node.js
#
# This template extends the default code-interpreter with:
#   - CloakBrowser 0.6.1 (stealth Chromium, humanized input) — the PRIMARY
#     browser engine of the `use_browser` tool (browser-driver.ts boots it
#     with launch_persistent_context(humanize=True, headless=False))
#   - The CloakBrowser stealth Chromium BINARY (downloaded at build time via
#     `python3 -m cloakbrowser install` — no per-sandbox ~200MB download)
#   - Xvfb — the browser runs HEADED (headless=False) on a virtual display
#   - Playwright (Python + Node.js bindings) + stock Chromium (the fallback
#     engine when CloakBrowser is unavailable)
#   - Puppeteer (Node.js)
#   - All browser dependencies (libs, fonts)
#
# Build: e2b template build -c e2b-template/Dockerfile -n onyx-cloakbrowser
# Use:   set E2B_TEMPLATE_ID=onyx-cloakbrowser in the app's env — the sandbox
#        route (/api/sandbox createAndCacheSandbox) passes it to
#        Sandbox.create({ template }). Unset → default code-interpreter
#        template; the browser tool then pip-installs at runtime (first use
#        costs ~280s) — everything still works, just slower on first use.
#
# Based on e2b/code-interpreter:latest which already has Python 3, Node.js,
# and the code-interpreter envd. We add the browser stack on top.
#
# RUNTIME REQUIREMENTS (verified against the live PyPI package, cloakbrowser
# 0.6.1, requires-python >=3.9): `launch_persistent_context(user_data_dir,
# headless=, args=, viewport=, humanize=)` is a Playwright drop-in. Without a
# CLOAKBROWSER_LICENSE_KEY the package uses the FREE stealth binary — no
# license needed. Set CLOAKBROWSER_LICENSE_KEY as a sandbox env var to enable
# Pro (seat-limited).

FROM e2b/code-interpreter:latest

# Install browser dependencies (Chrome/Chromium needs these shared libs).
# Playwright's `playwright install-deps` handles this, but we install them
# here so they're baked into the template (no per-sandbox install needed).
# XVFB (headless=False): the browser driver launches Chromium HEADED on a
# virtual display (user directive 2026-10-21 — no headless-mode
# fingerprints for the stealth runtime, and the live view renders exactly
# like a desktop browser). The driver starts `Xvfb :99` itself when the
# binary is present and falls back to headless when it is not — baking it
# in means every sandbox of this template runs headed.
RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb \
    libnss3 \
    libnspr4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    libatspi2.0-0 \
    libxshmfence1 \
    fonts-liberation \
    fonts-noto-color-emoji \
    fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*

# Install the browser runtime, PINNED to the verified version.
# Keep in sync with PIP_PKGS in src/lib/e2b/browser-session.ts and the pip
# calls in src/lib/e2b/bg-agent-script.ts.
RUN pip install --no-cache-dir cloakbrowser==0.6.1 playwright

# Bake the CloakBrowser stealth Chromium binary (~200MB) into the image so
# the first `use_browser` call doesn't pay the download. The binary lands in
# the cloakbrowser cache dir; `ensure_binary()` finds it there at runtime.
RUN python3 -m cloakbrowser install || \
    echo "WARN: cloakbrowser binary pre-download failed — the driver will download it on first launch"

# Stock Chromium for the Playwright fallback path + system deps.
RUN npx playwright install chromium && \
    npx playwright install-deps chromium

# Install Puppeteer (Node.js alternative).
RUN npm install -g puppeteer

# Set environment variables so Playwright/Puppeteer find the browser.
ENV PLAYWRIGHT_BROWSERS_PATH=/home/user/.cache/ms-playwright
ENV PUPPETEER_EXECUTABLE_PATH=/home/user/.cache/ms-playwright/chromium-*/chrome-linux/chrome

# Verify the browser stack is importable in the image.
RUN python3 -c "import cloakbrowser, playwright; print('cloakbrowser + playwright OK')" && \
    ls -la /home/user/.cache/ms-playwright/

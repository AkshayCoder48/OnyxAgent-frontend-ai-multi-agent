# E2B Custom Template — Playwright + Chromium + Python + Node.js
#
# This template extends the default code-interpreter with:
#   - Google Chrome / Chromium (headless browser)
#   - Playwright (Python + Node.js bindings)
#   - Puppeteer (Node.js)
#   - All browser dependencies (libs, fonts)
#
# Build: e2b template build -c e2b-template/Dockerfile
# Use:   Sandbox.create({ apiKey, template: 'playwright-browser' })
#
# Based on e2b/code-interpreter:latest which already has Python 3, Node.js,
# and the code-interpreter envd. We just add the browser stack on top.

FROM e2b/code-interpreter:latest

# Install browser dependencies (Chrome/Chromium needs these shared libs).
# Playwright's `playwright install-deps` handles this, but we install them
# here so they're baked into the template (no per-sandbox install needed).
RUN apt-get update && apt-get install -y --no-install-recommends \
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

# Install Playwright (Python + Node.js) + browsers.
# Browsers are installed to ~/.cache/ms-playwright/ which persists via OPFS sync.
RUN pip install --no-cache-dir playwright && \
    npx playwright install chromium && \
    npx playwright install-deps chromium

# Install Puppeteer (Node.js alternative).
RUN npm install -g puppeteer

# Set environment variables so Playwright/Puppeteer find the browser.
ENV PLAYWRIGHT_BROWSERS_PATH=/home/user/.cache/ms-playwright
ENV PUPPETEER_EXECUTABLE_PATH=/home/user/.cache/ms-playwright/chromium-*/chrome-linux/chrome

# Verify Chrome is installed.
RUN ls -la /home/user/.cache/ms-playwright/

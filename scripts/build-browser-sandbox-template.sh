#!/usr/bin/env bash
# ============================================================================
# Build the OnyxAgent browser-ready E2B sandbox template.
#
# WHY (the browser_startup_failed fix): without this template every fresh
# sandbox pip-installs cloakbrowser + playwright (~minutes) AND downloads
# the ~200 MB stealth Chromium binary at first browser launch — all behind
# the boot-poll ceiling, which is exactly what produced
#   "browser_startup_failed — The sandbox browser runtime did not finish
#    booting in time. No boot output was captured."
# With the template baked in, `use_browser` boots in seconds.
#
# Prereqs: an E2B account (https://e2b.dev) + the CLI:
#   npm install -g @e2b/cli
#   e2b auth login
#
# Usage:
#   bash scripts/build-browser-sandbox-template.sh            # default name
#   TEMPLATE_NAME=my-template bash scripts/build-browser-sandbox-template.sh
#
# After it finishes, set this where the Next.js app runs (see .env.example)
# and restart, so /api/sandbox passes it to Sandbox.create({ template }):
#   E2B_TEMPLATE_ID=onyx-cloakbrowser
# ============================================================================
set -euo pipefail

TEMPLATE_NAME="${TEMPLATE_NAME:-onyx-cloakbrowser}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! command -v e2b >/dev/null 2>&1; then
  echo "ERROR: the e2b CLI is not installed. Run: npm install -g @e2b/cli && e2b auth login" >&2
  exit 1
fi

echo "==> Building template '${TEMPLATE_NAME}' from e2b-template/Dockerfile"
echo "    (takes ~5-10 minutes — downloads Chromium twice)"
e2b template build -c "${ROOT}/e2b-template/Dockerfile" -n "${TEMPLATE_NAME}"

cat <<'EOF'

==> Done. Enable it where the Next.js app runs (then restart the app):

      E2B_TEMPLATE_ID=TEMPLATE_NAME

    Unset, the app still works — the browser runtime then self-installs in
    the sandbox on first use (first run only, up to ~10 minutes, narrated
    live in the tool output).
EOF

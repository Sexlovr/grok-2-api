#!/usr/bin/env bash
# Run the proxy with a virtual X display so Chromium can launch headful
# (headful presents a more browser-like fingerprint to Cloudflare / anti-bot).
# Set HEADLESS=1 to skip Xvfb and run Chromium headless instead.
set -e

if [ "$HEADLESS" = "1" ]; then
  exec node index.js
else
  exec xvfb-run -a --server-args="-screen 0 1280x800x24" node index.js
fi

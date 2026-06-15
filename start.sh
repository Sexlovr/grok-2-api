#!/usr/bin/env bash
# Start the proxy. It binds the port immediately, loads the active account, and
# (unless ENABLE_BROWSER=0) launches the in-Space signer browser: a plain headed
# Chromium (no CDP) that opens grok.com already logged in and self-feeds fresh
# x-statsig-id values to /admin/sig. See lib/browser.js + extension/.
set -e

exec node index.js

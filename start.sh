#!/usr/bin/env bash
# Start the pure-Node proxy. It binds the port immediately and forwards to
# grok.com using a relayed x-statsig-id (fed by the refresher userscript) — no
# browser, no Xvfb. See lib/grokClient.js.
set -e

exec node index.js

#!/usr/bin/env bash
# Start the proxy directly. The Node process binds the port immediately, then
# launches a virtual X display (Xvfb) lazily from inside the app only when a
# headful Chromium is actually needed — see lib/grokClient.js. Wrapping the
# whole process in xvfb-run at the shell level could hang before node ever ran,
# leaving the platform stuck at "Starting".
set -e

exec node index.js

# Grok2API — browser-signed reverse proxy for grok.com

OpenAI-compatible proxy that bridges `/v1/chat/completions` to grok.com's internal web API.

## Why a browser?

grok.com gates its chat POST endpoints with an `x-statsig-id` anti-bot header. The
signer is heavily-obfuscated JS that folds a **DOM/animation fingerprint** (via
`element.animate()` + `MutationObserver` + `crypto.subtle`) into a SHA-256 — it only
produces a valid value inside a **real browser DOM**. So this proxy keeps a headful
Chromium (Playwright) logged in to grok.com and signs requests there.

The signer module is **auto-discovered** from grok.com's JS bundles on every load, so it
survives Grok's frequent chunk renames / re-obfuscation (no hardcoded ids).

## Key facts (from recon)

- **No continuation needed.** Grok accepts ~100k tokens (~400KB) in a single `/new`
  request, so the proxy runs **stateless**: every call dumps the full conversation into
  one prompt. The wall at ~480KB is a body-size anti-bot gate, not a model context cap.
- **Auth** is carried by the `sso` / `sso-rw` cookies. `cf_clearance` / `__cf_bm` are
  IP-bound Cloudflare tokens — the proxy's own browser regenerates them for its IP, so
  only `sso`/`sso-rw` must come from your captured cURL.

## Usage

1. `npm install` then `npx playwright install chromium`
2. `node index.js` (or `HEADLESS=1 node index.js` to skip Xvfb)
3. Open `http://localhost:3000`, log in (`ADMIN_PASSWORD`, default `admin`)
4. **Add account:** on grok.com, DevTools → Network → send a message → right-click
   `conversations/new` → *Copy as cURL* → paste. The parser extracts `sso`, `sso-rw`,
   `cf_clearance`, `grok_device_id`, `x-userid`, and the user-agent.
5. **Create an API key**, then point any OpenAI client at `http://localhost:3000/v1`.

### Models

`grok-4`, `grok-4-fast`, `grok-3`, `grok-3-fast`, `grok-3-reasoning` — mapped to Grok's
internal `modeId`. Reasoning/thinking tokens are emitted as `<think>…</think>` when the
model name implies reasoning or `include_reasoning:true` is passed.

## Deploy (HuggingFace Spaces / Docker)

The `Dockerfile` installs Chromium + Xvfb and runs headful via `start.sh`. Set
`ADMIN_PASSWORD` and a persistent `DATA_DIR` volume.

## Env

| var | default | meaning |
|---|---|---|
| `PORT` | 3000 | listen port |
| `ADMIN_PASSWORD` | admin | admin dashboard password |
| `JWT_SECRET` | random | admin JWT secret (set to persist logins across restarts) |
| `DATA_DIR` | ./data | SQLite location |
| `HEADLESS` | 0 | `1` = headless Chromium (no Xvfb) |

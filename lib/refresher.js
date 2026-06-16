// Builds the Tampermonkey/Violentmonkey userscript, templated with this Space's
// origin + REFRESH_TOKEN so install is one click from the admin page.
//
// It runs in the user's REAL grok.com tab — the one place grok renders the SVG
// canary and will mint a valid x-statsig-id. It skims that sig off the app's own
// requests (passive) and also nudges a fresh signed request on a timer (active),
// then POSTs the freshest sig to <proxy>/admin/sig every couple minutes.

export function buildRefresherUserscript({ proxyOrigin, refreshToken }) {
    // JSON.stringify keeps the injected values safely quoted inside the script.
    const PROXY = JSON.stringify(proxyOrigin);
    const TOKEN = JSON.stringify(refreshToken);
    // grok.com's CSP connect-src does NOT allow *.hf.space, so a plain page-context
    // fetch to the proxy is blocked ("Failed to fetch"). We POST via GM_xmlhttpRequest
    // (runs outside the page CSP) and declare the host with @connect.
    let host = '';
    try { host = new URL(proxyOrigin).host; } catch {}

    return `// ==UserScript==
// @name         Grok2API sig refresher
// @namespace    grok2api
// @version      2.1.0
// @description  Skims a fresh x-statsig-id from your grok.com tab and pushes it to your Grok2API proxy (~every 2 min; TTL is ~3-4 min).
// @match        https://grok.com/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @grant        unsafeWindow
// @connect      ${host}
// @connect      hf.space
// ==/UserScript==
(function () {
  'use strict';
  var PROXY = ${PROXY};
  var TOKEN = ${TOKEN};
  var PUSH_PATH = '/admin/sig';
  // Real page window — so our fetch/XHR hooks attach to grok's actual requests
  // even though @grant puts the script in a sandbox.
  var W = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
  // Cross-origin POST helper (Tampermonkey/Violentmonkey/GM4), CSP-exempt.
  var GMx = (typeof GM_xmlhttpRequest !== 'undefined') ? GM_xmlhttpRequest
          : (typeof GM !== 'undefined' && GM.xmlHttpRequest) ? GM.xmlHttpRequest
          : null;
  var KEEPALIVE_MS = 110 * 1000;   // refresh well inside the ~3-4 min TTL
  var MIN_PUSH_GAP_MS = 8 * 1000;  // debounce: don't spam the proxy

  var lastSig = null;
  var lastPushAt = 0;
  var lastPushOk = null;

  // ── Capture: any x-statsig-id the grok app sends on a real request is valid. ──
  function capture(sig, source) {
    if (!sig || typeof sig !== 'string' || sig.length < 20) return;
    lastSig = sig;
    pushSoon(source);
  }

  var pushTimer = null;
  function pushSoon(source) {
    var since = Date.now() - lastPushAt;
    if (since >= MIN_PUSH_GAP_MS) { push(source); return; }
    if (pushTimer) return;
    pushTimer = setTimeout(function () { pushTimer = null; push(source); }, MIN_PUSH_GAP_MS - since);
  }

  function push(source) {
    if (!lastSig) return;
    lastPushAt = Date.now();
    var url = PROXY + PUSH_PATH;
    var payload = JSON.stringify({ sig: lastSig });
    var hdrs = { 'content-type': 'application/json', 'x-refresh-token': TOKEN };

    // Preferred: GM_xmlhttpRequest — runs outside grok's page CSP (which does
    // NOT allow *.hf.space in connect-src), so the POST actually leaves.
    if (GMx) {
      try {
        GMx({
          method: 'POST', url: url, headers: hdrs, data: payload,
          onload: function (r) {
            lastPushOk = (r.status >= 200 && r.status < 300);
            badge(lastPushOk ? ('sig pushed ✓ (' + (source || '') + ')') : ('push failed: HTTP ' + r.status), lastPushOk);
          },
          onerror: function () { lastPushOk = false; badge('push error (GM net) — check @connect / proxy URL', false); },
        });
        return;
      } catch (e) { /* fall through to fetch */ }
    }

    // Fallback: page-context fetch. Works only if the page CSP allows the proxy
    // host (it usually won't on grok.com) — kept for non-GM environments.
    W.fetch(url, {
      method: 'POST', headers: hdrs, body: payload,
      mode: 'cors', credentials: 'omit', keepalive: true,
    }).then(function (r) {
      lastPushOk = r.ok;
      badge(r.ok ? ('sig pushed ✓ (' + (source || '') + ')') : ('push failed: HTTP ' + r.status), r.ok);
    }).catch(function (e) {
      lastPushOk = false;
      badge('push error: ' + e.message + ' (CSP blocked? install via Tampermonkey for GM_xmlhttpRequest)', false);
    });
  }

  // ── Hook fetch: read x-statsig-id off outgoing grok requests. ──
  var origFetch = W.fetch;
  W.fetch = function (input, init) {
    try {
      var h = (init && init.headers) || (input && input.headers);
      var sig = readHeader(h, 'x-statsig-id');
      if (sig) capture(sig, 'fetch');
    } catch (e) {}
    return origFetch.apply(this, arguments);
  };

  // ── Hook XHR: same, for any XMLHttpRequest path. ──
  var origSet = W.XMLHttpRequest.prototype.setRequestHeader;
  W.XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    try { if (String(name).toLowerCase() === 'x-statsig-id') capture(value, 'xhr'); } catch (e) {}
    return origSet.apply(this, arguments);
  };

  function readHeader(h, name) {
    if (!h) return null;
    name = name.toLowerCase();
    if (typeof Headers !== 'undefined' && h instanceof Headers) return h.get(name);
    if (Array.isArray(h)) { for (var i = 0; i < h.length; i++) if (String(h[i][0]).toLowerCase() === name) return h[i][1]; return null; }
    for (var k in h) if (Object.prototype.hasOwnProperty.call(h, k) && k.toLowerCase() === name) return h[k];
    return null;
  }

  // ── Active keepalive: while idle, nudge a cheap signed request so the app
  // produces a fresh sig even if you aren't typing. We hit a lightweight grok
  // endpoint the app itself calls; the page signs it, our fetch-hook skims it.
  // If grok rejects/changes it, the passive hook still covers active use. ──
  function keepalive() {
    var stale = !lastSig || (Date.now() - lastPushAt) > KEEPALIVE_MS;
    if (!stale) return;
    try {
      // A GET the app makes routinely; it gets signed like everything else.
      origFetch('/rest/app-chat/conversations?pageSize=1', {
        method: 'GET', credentials: 'include', headers: { 'accept': '*/*' },
      }).catch(function () {});
    } catch (e) {}
  }
  setInterval(keepalive, 30 * 1000);
  setTimeout(keepalive, 2000);

  // ── Tiny status badge so you can see it working. ──
  var el = null;
  function badge(text, ok) {
    try {
      if (!el) {
        el = document.createElement('div');
        el.style.cssText = 'position:fixed;z-index:2147483647;right:10px;bottom:10px;padding:6px 10px;border-radius:8px;font:12px/1.4 system-ui,sans-serif;color:#fff;background:#15181d;border:1px solid #333;box-shadow:0 2px 10px rgba(0,0,0,.4);max-width:280px;opacity:.92';
        (document.body || document.documentElement).appendChild(el);
      }
      el.style.borderColor = ok ? '#2fbf71' : '#ff5470';
      var t = new Date().toLocaleTimeString();
      el.textContent = 'Grok2API: ' + text + ' @ ' + t;
    } catch (e) {}
  }
  // Badge needs <body>; retry until it exists.
  var bi = setInterval(function () { if (document.body) { clearInterval(bi); badge('refresher armed — waiting for sig…', true); } }, 300);

  console.log('[Grok2API refresher] armed → ' + PROXY + PUSH_PATH);
})();
`;
}

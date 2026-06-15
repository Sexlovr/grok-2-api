// Runs in grok.com's MAIN world (same JS context as the page) at document_start.
// It hooks fetch + XHR to read the x-statsig-id the grok app stamps on its own
// requests — the only place a *valid* sig exists, because this is a real,
// non-automation browser where grok renders the SVG canary. It cannot talk to
// the extension directly from MAIN world, so it relays via window.postMessage to
// bridge.js (ISOLATED world), which forwards to the background service worker.
(function () {
  'use strict';
  var KEEPALIVE_MS = 110 * 1000; // nudge a fresh sig well inside the ~3-4 min TTL
  var lastSentAt = 0;

  function relay(sig, source) {
    if (!sig || typeof sig !== 'string' || sig.length < 20) return;
    try {
      window.postMessage({ __grok2api: true, type: 'sig', sig: sig, source: source }, '*');
    } catch (e) {}
  }

  function readHeader(h, name) {
    if (!h) return null;
    name = name.toLowerCase();
    if (typeof Headers !== 'undefined' && h instanceof Headers) return h.get(name);
    if (Array.isArray(h)) { for (var i = 0; i < h.length; i++) if (String(h[i][0]).toLowerCase() === name) return h[i][1]; return null; }
    for (var k in h) if (Object.prototype.hasOwnProperty.call(h, k) && k.toLowerCase() === name) return h[k];
    return null;
  }

  // ── Hook fetch ──
  var origFetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      var h = (init && init.headers) || (input && input.headers);
      var sig = readHeader(h, 'x-statsig-id');
      if (sig) relay(sig, 'fetch');
    } catch (e) {}
    return origFetch.apply(this, arguments);
  };

  // ── Hook XHR ──
  var origSet = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    try { if (String(name).toLowerCase() === 'x-statsig-id') relay(value, 'xhr'); } catch (e) {}
    return origSet.apply(this, arguments);
  };

  // ── Active keepalive: fire a cheap request the app routinely makes so the
  // page mints a fresh sig even when nobody is typing. Our fetch-hook skims it. ──
  function keepalive() {
    if (Date.now() - lastSentAt < KEEPALIVE_MS) return;
    lastSentAt = Date.now();
    try {
      origFetch('/rest/app-chat/conversations?pageSize=1', {
        method: 'GET', credentials: 'include', headers: { 'accept': '*/*' },
      }).catch(function () {});
    } catch (e) {}
  }
  setInterval(keepalive, 30 * 1000);
  setTimeout(keepalive, 3000);

  console.log('[Grok2API signer] MAIN hook armed');
})();

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
// @version      3.3.0
// @description  Phone-egress worker for Grok2API: skims x-statsig-id AND runs grok chat calls from your real grok.com tab (residential IP + live cf_clearance), relaying them to your proxy.
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
  //
  // CRITICAL: this MUST go through W.fetch (grok's CURRENT, signer-wrapped fetch)
  // — NOT origFetch (the native fetch we saved at document-start, which grok
  // never signs). Using origFetch sends an UNSIGNED request, so no x-statsig-id
  // is stamped, nothing is skimmed, and the sig goes stale → 403 anti-bot.
  // W.fetch at call time = grokWrapper → ourHook → native, so grok signs it and
  // our hook captures the fresh sig. ──
  function keepalive() {
    var stale = !lastSig || (Date.now() - lastPushAt) > KEEPALIVE_MS;
    if (!stale) return;
    try {
      // A GET the app makes routinely; grok's wrapper signs it, our hook skims.
      W.fetch('/rest/app-chat/conversations?pageSize=1', {
        method: 'GET', credentials: 'include', headers: { 'accept': '*/*' },
      }).catch(function () {});
    } catch (e) {}
  }
  setInterval(keepalive, 30 * 1000);
  setTimeout(keepalive, 2000);

  // ════════════════════════════════════════════════════════════════════════
  //  PHONE-EGRESS WORKER
  //  grok's cf_clearance is IP-bound, so the proxy (datacenter IP) can't call
  //  grok directly. Instead the proxy queues chat jobs; this worker — running
  //  in your REAL grok.com tab — long-polls for them, fires the grok /new call
  //  through grok's OWN signed fetch (so residential IP + live cf_clearance +
  //  fresh sig are all native + correct), and streams the raw NDJSON back to
  //  the proxy. The proxy never touches grok; the phone is the exit node.
  // ════════════════════════════════════════════════════════════════════════

  // CSP-exempt POST to the proxy, returns parsed JSON (or null). Uses GMx so it
  // works despite grok's connect-src not allowing *.hf.space.
  function proxyPost(path, bodyObj, cb) {
    var url = PROXY + path;
    var payload = JSON.stringify(bodyObj || {});
    var hdrs = { 'content-type': 'application/json', 'x-refresh-token': TOKEN };
    if (GMx) {
      try {
        GMx({
          method: 'POST', url: url, headers: hdrs, data: payload,
          onload: function (r) { var j = null; try { j = JSON.parse(r.responseText); } catch (e) {} cb && cb(j, r.status); },
          onerror: function () { cb && cb(null, 0); },
        });
        return;
      } catch (e) { /* fall through */ }
    }
    W.fetch(url, { method: 'POST', headers: hdrs, body: payload, mode: 'cors', credentials: 'omit' })
      .then(function (r) { return r.json().then(function (j) { cb && cb(j, r.status); }).catch(function () { cb && cb(null, r.status); }); })
      .catch(function () { cb && cb(null, 0); });
  }

  // Pipe a debug line into the HF server log so we can watch the phone's side of
  // things (which sign strategy grok accepted, error bodies) without the phone
  // console.
  function wlog(msg) { try { proxyPost('/relay/log', { msg: String(msg) }); } catch (e) {} }
  function uuid() { try { return W.crypto.randomUUID(); } catch (e) { return 'r-' + Date.now() + '-' + Math.round(Math.random() * 1e9); } }

  // Build the grok /new request body for a job. Mirrors the shape grok's web app
  // sends; modeId is the bare string grok expects (e.g. "fast", "auto").
  function buildGrokBody(job) {
    return JSON.stringify({
      temporary: true,
      message: job.prompt,
      modeId: job.modeId || 'fast',
      fileAttachments: [], imageAttachments: [],
      disableSearch: true, enableImageGeneration: false, returnImageBytes: false,
      returnRawGrokInXaiRequest: false, enableImageStreaming: false, imageGenerationCount: 0,
      forceConcise: false, enableSideBySide: false, sendFinalMetadata: true,
      disableTextFollowUps: true, responseMetadata: {}, disableMemory: true,
      forceSideBySide: false, isAsyncChat: false, disableSelfHarmShortCircuit: false,
      collectionIds: [], disabledConnectorIds: [],
      deviceEnvInfo: {
        darkModeEnabled: true, devicePixelRatio: (W.devicePixelRatio || 1),
        screenWidth: (W.screen && W.screen.width) || 360, screenHeight: (W.screen && W.screen.height) || 800,
        viewportWidth: W.innerWidth || 360, viewportHeight: W.innerHeight || 800,
      },
      linkQuery: false,
    });
  }

  // Run one job: call grok natively, stream NDJSON lines back to the proxy in
  // small batches, then signal finish (or error).
  function runJob(job) {
    var tag = job.id.slice(-6);
    workerBadge('job ' + tag + ' → calling grok…', true);
    var batch = [];
    var flushTimer = null;
    function flush() {
      if (!batch.length) return;
      var lines = batch; batch = [];
      proxyPost('/relay/chunk', { id: job.id, lines: lines });
    }
    function queueLine(ln) {
      batch.push(ln);
      if (batch.length >= 16) { if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; } flush(); }
      else if (!flushTimer) flushTimer = setTimeout(function () { flushTimer = null; flush(); }, 120);
    }

    // grok rotates x-statsig-id on EVERY request and binds it to that exact
    // request, so a sig skimmed off a different call (telemetry, suggestions,
    // the keepalive GET) is INVALID for this /new POST → 403. The only sig that
    // validates is the one grok mints for THIS request. So we try up to two ways
    // and log which grok accepts (visible in the HF server log via /relay/log):
    //   A 'native' — attach NO x-statsig-id and let grok's own fetch wrapper
    //                sign it. W.fetch at call time is grokWrapper→ourHook→native,
    //                so if grok signs outgoing /rest calls in a fetch interceptor
    //                it will mint a correct per-request sig for us.
    //   B 'skim'   — fall back to the freshest skimmed sig + a fresh request id
    //                (only meaningful if grok does NOT wrap fetch and the sig is
    //                loosely bound).
    var attempts = [{ name: 'native', headers: {
      'accept': '*/*', 'content-type': 'application/json', 'x-xai-request-id': uuid(),
    } }];
    if (lastSig) attempts.push({ name: 'skim', headers: {
      'accept': '*/*', 'content-type': 'application/json',
      'x-statsig-id': lastSig, 'x-xai-request-id': uuid(),
    } });

    var idx = 0;
    function attempt() {
      if (idx >= attempts.length) {
        flush();
        proxyPost('/relay/finish', { id: job.id, error: 'grok 403 on every sign strategy — the skimmed sig is request-bound and grok did not sign our injected fetch. DOM mode required.' });
        workerBadge('job ' + tag + ' 403 (all strategies)', false);
        return;
      }
      var a = attempts[idx++];
      wlog('job ' + tag + ' try sign=' + a.name + (a.headers['x-statsig-id'] ? ' sig=' + a.headers['x-statsig-id'].slice(0, 6) + '…' : ' (no sig; grok signs)'));
      W.fetch('/rest/app-chat/conversations/new', {
        method: 'POST', credentials: 'include', headers: a.headers, body: buildGrokBody(job),
      }).then(function (resp) {
        wlog('job ' + tag + ' sign=' + a.name + ' → HTTP ' + resp.status);
        if (!resp.ok) {
          return resp.text().then(function (t) {
            wlog('job ' + tag + ' sign=' + a.name + ' body: ' + String(t).slice(0, 180));
            if (resp.status === 403) { attempt(); return; }   // try the next strategy
            // non-403: a real upstream error, surface it and stop.
            proxyPost('/relay/chunk', { id: job.id, lines: [], httpStatus: resp.status });
            if (t) queueLine(t);
            flush();
            proxyPost('/relay/finish', { id: job.id, error: 'grok HTTP ' + resp.status });
            workerBadge('job ' + tag + ' grok HTTP ' + resp.status, false);
          });
        }
        // SUCCESS — stream this response's NDJSON body back to the proxy.
        proxyPost('/relay/chunk', { id: job.id, lines: [], httpStatus: resp.status });
        wlog('job ' + tag + ' ✓ ACCEPTED via sign=' + a.name + ' — streaming');
        workerBadge('job ' + tag + ' ✓ (' + a.name + ')', true);
        var reader = resp.body.getReader();
        var dec = new TextDecoder();
        var buf = '';
        function pump() {
          return reader.read().then(function (r) {
            if (r.done) {
              if (buf.trim()) queueLine(buf);
              flush();
              proxyPost('/relay/finish', { id: job.id });
              workerBadge('job ' + tag + ' done ✓', true);
              return;
            }
            buf += dec.decode(r.value, { stream: true });
            var parts = buf.split('\\n');
            buf = parts.pop();
            for (var i = 0; i < parts.length; i++) if (parts[i].trim()) queueLine(parts[i]);
            return pump();
          });
        }
        return pump();
      }).catch(function (e) {
        wlog('job ' + tag + ' sign=' + a.name + ' fetch threw: ' + (e && e.message));
        if (idx < attempts.length) { attempt(); return; }
        flush();
        proxyPost('/relay/finish', { id: job.id, error: 'phone fetch failed: ' + (e && e.message) });
        workerBadge('job ' + tag + ' failed: ' + (e && e.message), false);
      });
    }
    attempt();
  }

  // ── Anti-suspension keepalive (ported from the ernie bridge) ──────────────
  // On a phone, the instant you tab away from grok to JanitorAI, the mobile
  // browser FREEZES this tab's JS timers — pollLoop stops firing, queued jobs
  // sit unpicked, and the request stalls until the OS happens to wake the tab
  // (the "2 minutes then it answers" symptom). A near-silent looping
  // AudioContext + a held Web Lock both keep the tab classified as "playing
  // audio / busy", which most mobile browsers will NOT freeze.
  var _kaCtx = null;
  function startKeepAlive() {
    if (!_kaCtx) {
      try {
        var AC = W.AudioContext || W.webkitAudioContext;
        if (AC) {
          _kaCtx = new AC();
          var osc = _kaCtx.createOscillator();
          var gain = _kaCtx.createGain();
          gain.gain.value = 0.00001;     // inaudible
          osc.frequency.value = 1;
          osc.connect(gain); gain.connect(_kaCtx.destination);
          osc.start();
        }
      } catch (e) {}
    }
    if (_kaCtx && _kaCtx.state === 'suspended') _kaCtx.resume().catch(function () {});
    try {
      if (navigator.locks) {
        navigator.locks.request('grok2api-worker-keepalive', function () {
          return new Promise(function () {});   // never resolves: lock held for tab lifetime
        }).catch(function () {});
      }
    } catch (e) {}
  }
  // AudioContext can only start after a user gesture; resume on first tap/key.
  function _resumeKa() { if (_kaCtx && _kaCtx.state === 'suspended') _kaCtx.resume().catch(function () {}); }
  document.addEventListener('click', _resumeKa);
  document.addEventListener('keydown', _resumeKa);
  document.addEventListener('touchstart', _resumeKa, { passive: true });

  // Long-poll loop: ask the proxy for the next job; when one arrives, run it,
  // then immediately poll again. On any gap, back off briefly and retry so a
  // transient proxy hiccup never kills the worker.
  var workerStop = false;
  var _polling = false;
  var _lastPollAt = 0;
  function pollLoop() {
    if (workerStop) return;
    _polling = true;
    _lastPollAt = Date.now();
    proxyPost('/relay/poll', {}, function (j, status) {
      _lastPollAt = Date.now();
      if (status === 401) { _polling = false; workerBadge('worker: bad refresh token — reinstall script from the proxy', false); setTimeout(pollLoop, 15000); return; }
      if (j && j.job) { try { runJob(j.job); } catch (e) {} _polling = false; setTimeout(pollLoop, 50); return; }
      // No job (timed-out hold) or transient failure: poll again shortly.
      _polling = false;
      setTimeout(pollLoop, status === 0 ? 4000 : 250);
    });
  }

  // Wake instantly when the tab is foregrounded again, and resume keepalive
  // audio (mobile suspends the AudioContext on background). Without this the
  // worker waits out its full back-off before the next poll after you tab back.
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) {
      startKeepAlive();
      if (!_polling) pollLoop();
    }
  });

  // Watchdog: if timers were frozen (phone backgrounded) and then thawed, the
  // poll may be wedged. If we haven't polled in 60s and aren't mid-poll, kick it.
  setInterval(function () {
    if (workerStop) return;
    if (!_polling && _lastPollAt && (Date.now() - _lastPollAt > 60 * 1000)) pollLoop();
  }, 20 * 1000);

  startKeepAlive();
  setTimeout(pollLoop, 3000);

  // Second status line (above the sig badge) for worker activity.
  var wEl = null;
  function workerBadge(text, ok) {
    try {
      if (!wEl) {
        wEl = document.createElement('div');
        wEl.style.cssText = 'position:fixed;z-index:2147483647;right:10px;bottom:46px;padding:6px 10px;border-radius:8px;font:12px/1.4 system-ui,sans-serif;color:#fff;background:#15181d;border:1px solid #333;box-shadow:0 2px 10px rgba(0,0,0,.4);max-width:280px;opacity:.92';
        (document.body || document.documentElement).appendChild(wEl);
      }
      wEl.style.borderColor = ok ? '#2fbf71' : '#ff5470';
      wEl.textContent = 'Worker: ' + text + ' @ ' + new Date().toLocaleTimeString();
    } catch (e) {}
  }

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

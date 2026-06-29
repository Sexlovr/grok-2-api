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
// @version      4.1.3
// @description  Phone-egress worker for Grok2API: drives grok's own composer to send your prompt (grok signs the body-bound x-statsig-id itself) and tees grok's response stream back to your proxy.
// @match        https://grok.com/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM.getValue
// @grant        GM.setValue
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

  // ── Hive: this tab's own persistent identity. On first run we POST /register
  //    to mint a grok_<hex> key, store it FOREVER (GM_setValue → survives browser
  //    restarts), and reuse it every load. It's the user's API key AND the id
  //    their own worker tab serves. No cookie/curl, ever. ──
  function gmGet(k, d) {
    try { if (typeof GM_getValue !== 'undefined') return GM_getValue(k, d); } catch (e) {}
    try { if (typeof GM !== 'undefined' && GM.getValue) return GM.getValue(k, d); } catch (e) {}
    try { var v = W.localStorage.getItem('g2a_' + k); return v == null ? d : v; } catch (e) {}
    return d;
  }
  function gmSet(k, v) {
    try { if (typeof GM_setValue !== 'undefined') { GM_setValue(k, v); return; } } catch (e) {}
    try { if (typeof GM !== 'undefined' && GM.setValue) { GM.setValue(k, v); return; } } catch (e) {}
    try { W.localStorage.setItem('g2a_' + k, v); } catch (e) {}
  }
  var HIVE_KEY = gmGet('hiveKey', '') || '';
  var legacyMode = false;   // true if the server has no /register (old single-account build)

  var lastSig = null;
  var lastPushAt = 0;
  var lastPushOk = null;

  // DOM-drive + stream-tee: grok signs x-statsig-id over the request BODY, so we
  // can't sign an arbitrary prompt ourselves (proven: a sig is valid only for its
  // exact message). Instead we drive grok's OWN composer to send our prompt — grok
  // builds + signs + posts the request natively — and we tee its response stream.
  // pendingCapture holds the job whose grok /new (or /responses) reply we're
  // waiting to intercept in the fetch hook. busy serializes one UI send at a time.
  var pendingCapture = null;
  var busy = false;
  var _loggedComposer = false;
  var _lastModelPicked = null;   // avoid re-opening the model menu every job
  var _privateChatOn = false;    // private/temporary chat enabled once per session

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
    // In hive mode the server never uses a pushed sig (grok signs its own
    // DOM-driven request), so skip the push entirely — it only added log noise.
    if (HIVE_KEY) return;
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

  // ── Hook fetch: (a) skim x-statsig-id off outgoing grok requests, and
  //    (b) when we're driving a job, TEE the response of grok's own chat POST
  //    (the request grok signed for OUR prompt) back to the proxy. ──
  var origFetch = W.fetch;
  W.fetch = function (input, init) {
    var url = '';
    try { url = (typeof input === 'string') ? input : (input && input.url) || ''; } catch (e) {}
    try {
      var h = (init && init.headers) || (input && input.headers);
      var sig = readHeader(h, 'x-statsig-id');
      if (sig) capture(sig, 'fetch');
    } catch (e) {}
    var p = origFetch.apply(this, arguments);
    try {
      var method = ((init && init.method) || (input && input.method) || 'GET').toUpperCase();
      // grok's chat send hits /conversations/new (new chat) or .../responses
      // (existing chat). Either carries the streamed answer we want.
      if (pendingCapture && method === 'POST' && /\\/rest\\/app-chat\\/conversations\\/(new|[^/]+\\/responses)/.test(url)) {
        var cap = pendingCapture; pendingCapture = null;
        wlog('job ' + cap.job.id.slice(-6) + ' intercepted grok send → ' + url.replace(/^https?:\\/\\/[^/]+/, ''));
        p.then(function (resp) { teeResponse(resp.clone(), cap.job); })
         .catch(function (e) { endJob(cap.job, 'grok send threw: ' + (e && e.message)); });
      }
    } catch (e) {}
    return p;
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
    // Identify as THIS user's worker (x-hive-key); fall back to the shared
    // refresh token for the legacy sig endpoint / pre-registration calls.
    var hdrs = { 'content-type': 'application/json', 'x-refresh-token': TOKEN };
    if (HIVE_KEY) hdrs['x-hive-key'] = HIVE_KEY;
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

  // ── Tee grok's own streamed response back to the proxy. grok already signed
  //    and sent the request for our prompt; we just relay the NDJSON it returns. ──
  function teeResponse(resp, job) {
    var tag = job.id.slice(-6);
    proxyPost('/relay/chunk', { id: job.id, lines: [], httpStatus: resp.status });
    wlog('job ' + tag + ' grok responded HTTP ' + resp.status);

    // Transient upstream errors (429 rate-limit, 5xx) → re-drive the send a few
    // times with backoff instead of failing the whole chat.
    if (!resp.ok && (resp.status === 429 || resp.status >= 500)) {
      resp.text().then(function (t) { wlog('job ' + tag + ' transient ' + resp.status + ': ' + String(t).slice(0, 120)); }).catch(function () {});
      var n = job._retries || 0;
      if (n < 3) {
        job._retries = n + 1;
        var wait = 3000 + n * 3000;   // 3s, 6s, 9s
        wlog('job ' + tag + ' HTTP ' + resp.status + ' — retrying send ' + job._retries + '/3 in ' + (wait / 1000) + 's');
        workerBadge('job ' + tag + ' HTTP ' + resp.status + ' — retry ' + job._retries + '/3', false);
        setTimeout(function () { runJob(job); }, wait);   // busy stays true; fresh chat for the retry
        return;
      }
      endJob(job, 'grok HTTP ' + resp.status + ' after 3 retries — likely rate-limited, try again shortly.');
      return;
    }
    if (!resp.ok) {
      resp.text().then(function (t) {
        wlog('job ' + tag + ' grok error body: ' + String(t).slice(0, 180));
        endJob(job, 'grok HTTP ' + resp.status + (t ? ': ' + String(t).slice(0, 120) : ''));
      }).catch(function () { endJob(job, 'grok HTTP ' + resp.status); });
      return;
    }

    workerBadge('job ' + tag + ' ✓ streaming', true);
    var batch = [], flushTimer = null, finished = false, idleTimer = null;
    var STALL_MS = 45000;   // no data for this long → abort so the worker isn't wedged
    function flush() { if (!batch.length) return; var lines = batch; batch = []; proxyPost('/relay/chunk', { id: job.id, lines: lines }); }
    function queueLine(ln) {
      batch.push(ln);
      if (batch.length >= 16) { if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; } flush(); }
      else if (!flushTimer) flushTimer = setTimeout(function () { flushTimer = null; flush(); }, 120);
    }
    var reader = resp.body.getReader(), dec = new TextDecoder(), buf = '';
    function finishOk() {
      if (finished) return; finished = true;
      if (idleTimer) clearTimeout(idleTimer);
      if (buf.trim()) queueLine(buf);
      flush();
      proxyPost('/relay/finish', { id: job.id });
      servedCount++;
      busy = false;
      setStatus('served ' + servedCount + ' ✓ — ready', '');
    }
    function finishErr(msg) {
      if (finished) return; finished = true;
      if (idleTimer) clearTimeout(idleTimer);
      try { reader.cancel(); } catch (e) {}
      flush();
      endJob(job, msg);
    }
    function armStall() {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(function () {
        wlog('job ' + tag + ' stream stalled — no data for ' + (STALL_MS / 1000) + 's, aborting');
        finishErr('grok stream stalled (no data for ' + (STALL_MS / 1000) + 's)');
      }, STALL_MS);
    }
    function pump() {
      return reader.read().then(function (r) {
        if (finished) return;
        if (r.done) { finishOk(); return; }
        armStall();
        buf += dec.decode(r.value, { stream: true });
        var parts = buf.split('\\n'); buf = parts.pop();
        for (var i = 0; i < parts.length; i++) if (parts[i].trim()) queueLine(parts[i]);
        return pump();
      });
    }
    armStall();
    pump().catch(function (e) { finishErr('tee read failed: ' + (e && e.message)); });
  }

  // Finish a job that failed before/around the grok send (the happy path finishes
  // inside teeResponse). Always frees the worker for the next job.
  function endJob(job, errMsg) {
    busy = false;
    if (errMsg) {
      proxyPost('/relay/finish', { id: job.id, error: errMsg });
      workerBadge('job ' + job.id.slice(-6) + ' ' + errMsg, false);
    }
  }

  // ── DOM helpers to drive grok's composer ─────────────────────────────────
  function isVisible(e) { return !!(e && (e.offsetParent !== null || (e.getClientRects && e.getClientRects().length))); }

  function findInput() {
    var sels = ['textarea[placeholder]', 'textarea', 'div[contenteditable="true"]', '[role="textbox"]'];
    for (var i = 0; i < sels.length; i++) {
      var list = document.querySelectorAll(sels[i]);
      for (var j = 0; j < list.length; j++) if (isVisible(list[j])) return list[j];
    }
    return null;
  }

  function setNativeValue(el, val) {
    try {
      el.focus();
      if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
        var proto = (el.tagName === 'TEXTAREA') ? W.HTMLTextAreaElement.prototype : W.HTMLInputElement.prototype;
        var d = Object.getOwnPropertyDescriptor(proto, 'value');
        if (d && d.set) d.set.call(el, val); else el.value = val;
        el.dispatchEvent(new InputEvent('input', { bubbles: true, data: val, inputType: 'insertText' }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        // Some builds re-read on a REAL input event and ignore the programmatic
        // set (Send stays disabled). Fall back to execCommand if the value didn't
        // stick.
        if (el.value !== val) { try { el.select(); document.execCommand('insertText', false, val); } catch (e) {} }
      } else {
        // contenteditable (grok uses a Lexical editor on some builds). Setting
        // textContent does NOT update Lexical's model, so Send stays disabled.
        // execCommand('insertText') fires the beforeinput/input the editor reacts
        // to AND updates its internal state — the reliable way to fill it.
        try {
          var sel = W.getSelection && W.getSelection();
          if (sel) { var r = document.createRange(); r.selectNodeContents(el); sel.removeAllRanges(); sel.addRange(r); }
        } catch (e) {}
        var ok = false;
        try { ok = document.execCommand('insertText', false, val); } catch (e) {}
        if (!ok || !(el.textContent || '').length) {
          el.textContent = val;
          try { el.dispatchEvent(new InputEvent('input', { bubbles: true, data: val, inputType: 'insertText' })); }
          catch (e) { el.dispatchEvent(new Event('input', { bubbles: true })); }
        }
      }
    } catch (e) { wlog('setNativeValue err: ' + (e && e.message)); }
  }

  function describeBtn(b) {
    var al = (b.getAttribute && b.getAttribute('aria-label')) || '';
    var tid = (b.getAttribute && b.getAttribute('data-testid')) || '';
    var ty = (b.getAttribute && b.getAttribute('type')) || '';
    var tx = (b.textContent || '').trim().slice(0, 16);
    var svg = (b.querySelector && b.querySelector('svg')) ? '+svg' : '';
    return (ty ? 'type=' + ty : '') + (al ? ' al="' + al.slice(0, 22) + '"' : '') + (tid ? ' tid="' + tid.slice(0, 22) + '"' : '') + (tx ? ' tx="' + tx + '"' : '') + svg + (b.disabled ? ' DIS' : '');
  }

  // Candidate send controls, strongest signal first. Send is usually a submit
  // button, an aria-label Send/Submit, a data-testid *send*, or the rightmost
  // icon button in the composer toolbar.
  function sendButtonCandidates(input) {
    var out = [];
    function add(b) { if (b && b.tagName === 'BUTTON' && out.indexOf(b) < 0 && isVisible(b) && !(b.closest && b.closest('#g2a-float'))) out.push(b); }
    [].slice.call(document.querySelectorAll('button[type="submit"], button[aria-label*="Send" i], button[aria-label*="Submit" i], button[data-testid*="send" i]')).forEach(add);
    var form = input.closest && input.closest('form');
    if (form) [].slice.call(form.querySelectorAll('button')).forEach(add);
    // Climb a few levels from the input and gather composer-row buttons.
    var box = input.parentElement;
    for (var k = 0; k < 4 && box; k++) { [].slice.call(box.querySelectorAll('button')).forEach(add); box = box.parentElement; }
    return out;
  }

  function fireEnter(input) {
    try { input.focus(); } catch (e) {}
    var ev = ['keydown', 'keypress', 'keyup'];
    for (var i = 0; i < ev.length; i++) {
      try { input.dispatchEvent(new KeyboardEvent(ev[i], { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true })); } catch (e) {}
    }
  }

  // Pick the real submit control: data-testid="chat-submit" (confirmed), else an
  // aria/submit-typed button, preferring an enabled one.
  // The REAL grok send button — precise selectors only, and NEVER our own panel
  // (#g2a-float) or the desktop sidebar buttons. Returns it even if disabled so
  // the caller can distinguish "grok is refusing" from "button not found".
  function findSubmit() {
    var sels = ['button[data-testid="chat-submit"]', 'button[aria-label="Submit"]', 'form button[type="submit"]', 'button[aria-label="Send"]'];
    for (var i = 0; i < sels.length; i++) {
      var list = document.querySelectorAll(sels[i]);
      for (var j = 0; j < list.length; j++) {
        var b = list[j];
        if (b.closest && b.closest('#g2a-float')) continue;   // never our own panel
        if (isVisible(b)) return b;
      }
    }
    return null;
  }

  // One send attempt. We ONLY click grok's real send button (or submit the form /
  // press Enter) — never a guessed button, so desktop sidebars and our own panel
  // can't be mis-clicked. If the send button exists but is DISABLED, grok is
  // refusing the message (almost always: too long for its composer) — we don't
  // thrash; the watchdog reports the real reason.
  function doSend(input, tag, n) {
    var sb = findSubmit();
    if (sb && sb.disabled) { wlog('job ' + tag + ' send#' + n + ' submit is DISABLED — grok refuses (message too long?)'); return; }
    if (sb) { wlog('job ' + tag + ' send#' + n + ' click ' + describeBtn(sb)); try { sb.click(); return; } catch (e) {} }
    var form = input.closest && input.closest('form');
    if (form) { wlog('job ' + tag + ' send#' + n + ' form.requestSubmit'); try { if (form.requestSubmit) { form.requestSubmit(); return; } form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); return; } catch (e) {} }
    wlog('job ' + tag + ' send#' + n + ' Enter (fallback)');
    fireEnter(input);
  }

  function findNewChatControl() {
    var sels = ['a[href="/"]', 'a[href="/chat"]', '[aria-label*="New chat" i]', '[aria-label*="New conversation" i]', '[data-testid*="new-chat" i]', '[data-testid*="new_chat" i]'];
    for (var i = 0; i < sels.length; i++) { var e = document.querySelector(sels[i]); if (e && isVisible(e)) return e; }
    var btns = [].slice.call(document.querySelectorAll('button, a'));
    for (var j = 0; j < btns.length; j++) { var t = (btns[j].textContent || '').trim().toLowerCase(); if ((t === 'new chat' || t === 'new conversation') && isVisible(btns[j])) return btns[j]; }
    return null;
  }

  // ── Best-effort model switch via grok's "Model select" menu. modeId is the
  //    API's requested mode ("fast"/"auto"/"expert"/"heavy"); we open the menu
  //    and click the matching option. Free tier only has Fast, so a non-Fast
  //    pick silently no-ops (option absent) — that's fine. Returns ms to wait. ──
  var MODEL_LABELS = { fast: 'fast', auto: 'auto', expert: 'expert', heavy: 'heavy' };
  function selectModel(modeId, tag, done) {
    var want = MODEL_LABELS[(modeId || '').toLowerCase()];
    if (!want || want === _lastModelPicked) { done(0); return; }
    var btn = document.querySelector('[aria-label="Model select"], [data-testid*="model" i]');
    if (!btn) { done(0); return; }
    try { btn.click(); } catch (e) { done(0); return; }
    // Menu renders async. The options are rows whose FIRST text line is exactly
    // "Fast" / "Auto" / "Expert" / "Heavy" (second line is a description). Match
    // the first line exactly across a broad node set (rows may be plain divs, not
    // buttons), keep the row small to avoid matching a big container, then click
    // it (a synthetic click bubbles to the row's handler).
    setTimeout(function () {
      var nodes = [].slice.call(document.querySelectorAll(
        '[role="menuitem"],[role="menuitemradio"],[role="option"],button,a,li,div,span'));
      var hit = null;
      for (var i = 0; i < nodes.length; i++) {
        var n = nodes[i];
        if (!isVisible(n)) continue;
        var txt = (n.textContent || '').trim();
        if (txt.length > 80) continue;                       // skip big containers
        var first = txt.split('\\n')[0].trim().toLowerCase();
        if (first === want) { hit = n; break; }              // exact first-line match
      }
      if (hit) {
        _lastModelPicked = want;
        wlog('job ' + tag + ' selected model "' + want + '"');
        try { hit.click(); } catch (e) {}
        done(400);
      } else {
        wlog('job ' + tag + ' model "' + want + '" not found in menu (free tier locks it?) — using current');
        try { btn.click(); } catch (e) {}   // close the menu
        done(150);
      }
    }, 400);
  }

  // ── Best-effort: switch grok into Private/Temporary chat so relayed messages
  //    don't pile up in the user's history. Toggle confirmed: aria-label
  //    "Switch to Private Chat". One-time per session (it persists). ──
  function ensurePrivateChat(tag) {
    if (_privateChatOn) return;
    var t = document.querySelector('[aria-label*="Switch to Private Chat" i], [aria-label*="rivate" i]');
    if (t && isVisible(t)) {
      try { t.click(); _privateChatOn = true; wlog('job ' + tag + ' enabled Private Chat (history won\\'t be saved)'); } catch (e) {}
    }
  }

  // ── Run one job by driving grok's composer; the fetch hook tees the reply. ──
  function runJob(job) {
    var tag = job.id.slice(-6);
    busy = true;
    try {
      workerBadge('job ' + tag + ' → driving grok UI…', true);
      // Best-effort fresh chat (capture works either way — the hook also matches
      // the in-conversation /responses endpoint).
      var nc = findNewChatControl();
      if (nc) { wlog('job ' + tag + ' clicking new-chat (' + (nc.tagName || '').toLowerCase() + ')'); try { nc.click(); } catch (e) {} }
      setTimeout(function () {
        ensurePrivateChat(tag);
        selectModel(job.modeId, tag, function (extra) {
          setTimeout(function () { afterNewChat(job, tag); }, extra);
        });
      }, nc ? 700 : 0);
    } catch (e) { endJob(job, 'runJob threw: ' + (e && e.message)); }
  }

  function afterNewChat(job, tag) {
    var input = findInput();
    if (!input) { endJob(job, 'could not find grok input box (UI changed?)'); return; }
    setNativeValue(input, job.prompt);
    // Conclusive per-job diagnostic: did the box actually fill, and is there an
    // ENABLED submit button? filled=0 → typing didn't register (Lexical/CE issue);
    // submit=…DIS → button disabled; submit=NONE → selector miss.
    try {
      var filled = (input.value != null && input.value !== '') ? input.value.length : (input.textContent || '').length;
      var kind = input.isContentEditable ? 'contenteditable' : input.tagName.toLowerCase();
      var sb = findSubmit();
      wlog('job ' + tag + ' typed ' + job.prompt.length + 'ch into ' + kind + ' (box now=' + filled + 'ch); submit=' + (sb ? describeBtn(sb) : 'NONE'));
    } catch (e) { wlog('job ' + tag + ' typed prompt (diag err: ' + (e && e.message) + ')'); }
    // One-time-per-session diagnostics: composer buttons + which model the tab
    // has selected (DOM-drive answers with the TAB's model — the API modeId is
    // informational, not honored, in this mode).
    if (!_loggedComposer) {
      _loggedComposer = true;
      try {
        var cands = sendButtonCandidates(input);
        wlog('composer buttons[' + cands.length + ']: ' + (cands.slice(0, 6).map(describeBtn).join(' | ') || 'NONE'));
      } catch (e) {}
      try {
        var msel = document.querySelector('[aria-label="Model select"], [data-testid*="model" i]');
        wlog('grok model selector: ' + (msel ? '"' + (msel.textContent || '').trim().slice(0, 30) + '"' : 'not found') + ' — DOM-drive uses the TAB model; API modeId="' + (job.modeId || '?') + '" is informational');
      } catch (e) {}
      // Probe for a temporary/private-chat toggle so we can later stop saving
      // every relayed message into the user's grok history.
      try {
        var tmp = document.querySelector('[aria-label*="emporary" i], [aria-label*="rivate" i], [data-testid*="temporary" i], [data-testid*="private" i]');
        wlog('grok temporary-chat toggle: ' + (tmp ? (describeBtn(tmp)) : 'not found') + ' (relayed chats currently SAVE to your grok history)');
      } catch (e) {}
    }
    // Per-attempt token. A 429 retry re-enters the drive with the SAME job
    // object, so the watchdog/loop must key on THIS attempt (not on the job) —
    // else attempt #1's stale watchdog would abort attempt #2, and its stale
    // loop would keep firing sends (cross-attempt double-submit).
    var attempt = {};
    pendingCapture = { job: job, attempt: attempt, at: Date.now() };
    // Watchdog: if grok never fires a chat POST for THIS attempt, free the worker.
    setTimeout(function () {
      if (pendingCapture && pendingCapture.attempt === attempt) {
        pendingCapture = null;
        var sb2 = findSubmit();
        var reason;
        if (sb2 && sb2.disabled) reason = 'grok DISABLED its Send button — the message is too long for grok web composer (' + job.prompt.length + ' chars). Use a shorter conversation (fewer/shorter messages or a smaller context).';
        else if (!sb2) reason = 'could not find grok Send button (UI variant) after ' + sendTries + ' tries — send composer buttons log to the dev.';
        else reason = 'typed but grok did not accept the send after ' + sendTries + ' tries.';
        endJob(job, reason);
      }
    }, 15000);
    // Retry sending across the window: the strongest strategy (requestSubmit /
    // chat-submit click) goes first, so attempt #1 almost always lands. We wait
    // 2.5s between tries — long enough for a successful submit's request to fire
    // and clear pendingCapture BEFORE the next try, so we don't double-submit.
    var sendTries = 0;
    (function loop() {
      if (!pendingCapture || pendingCapture.attempt !== attempt) return;  // fired/captured/superseded → stop
      sendTries++;
      doSend(input, tag, sendTries);
      if (sendTries < 6) setTimeout(loop, 2500);
    })();
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
    if (!HIVE_KEY && !legacyMode) { _polling = false; return; }   // not registered yet — bootstrap will start us
    // One job at a time: a UI-driven send owns the composer until its stream ends.
    if (busy) { _polling = false; setTimeout(pollLoop, 500); return; }
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

  // ── Bootstrap: make sure we have our persistent key, then start polling. ──
  function ensureKeyThen(start) {
    if (HIVE_KEY) { badge('connected — your key is ready', true); start(); return; }
    badge('registering this tab…', true);
    proxyPost('/register', { label: '' }, function (j, status) {
      if (j && j.key) {
        HIVE_KEY = j.key;
        gmSet('hiveKey', HIVE_KEY);
        console.log('[Grok2API] registered hive key ' + HIVE_KEY.slice(0, 12) + '…');
        badge('registered ✓ — your key is ready', true);
        showKeyPanel();
        start();
      } else {
        // Older server without /register (legacy single-account): fall back to
        // the shared refresh-token worker so the script still works (polls with
        // the refresh token instead of a hive key).
        if (status === 403 || status === 404) { legacyMode = true; console.log('[Grok2API] no hive on server — legacy relay mode'); badge('legacy server (no hive) — relay mode', true); start(); return; }
        badge('register failed (HTTP ' + status + ') — retrying…', false);
        setTimeout(function () { ensureKeyThen(start); }, 5000);
      }
    });
  }

  startKeepAlive();
  setTimeout(function () { ensureKeyThen(function () { setTimeout(pollLoop, 800); }); }, 2000);

  // ════════════════════════════════════════════════════════════════════════
  //  On-page user panel — a floating "circle" (like ernie/arena) that taps open
  //  into a panel with YOUR API key + worker status. Drag the circle to move it.
  // ════════════════════════════════════════════════════════════════════════
  var ui = { ready: false, open: false, text: 'starting…', kind: '', lastErrAt: 0 };
  var servedCount = 0;
  var elFloat, elCircle, elPanel, elStatus, elKeyV, elServedV, elModelV, elWorkerV;

  // Drag the float by its circle handle; a tap (no movement) toggles the panel.
  function setupFloatDrag(floatEl, handle, onTap) {
    var dragging = false, moved = false, sx = 0, sy = 0, ox = 0, oy = 0;
    handle.addEventListener('pointerdown', function (e) {
      dragging = true; moved = false;
      var r = floatEl.getBoundingClientRect();
      floatEl.style.left = r.left + 'px'; floatEl.style.top = r.top + 'px';
      floatEl.style.right = 'auto'; floatEl.style.bottom = 'auto';
      sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
      try { handle.setPointerCapture(e.pointerId); } catch (x) {}
    });
    handle.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      var dx = e.clientX - sx, dy = e.clientY - sy;
      if (Math.abs(dx) + Math.abs(dy) > 6) moved = true;
      floatEl.style.left = (ox + dx) + 'px'; floatEl.style.top = (oy + dy) + 'px';
    });
    function up(e) {
      if (!dragging) return; dragging = false;
      try { handle.releasePointerCapture(e.pointerId); } catch (x) {}
      if (!moved && onTap) onTap();
    }
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  }

  function injectStyle() {
    if (document.getElementById('g2a-style')) return;
    var s = document.createElement('style');
    s.id = 'g2a-style';
    s.textContent =
      '#g2a-float{position:fixed;bottom:88px;right:14px;z-index:2147483647;font:13px/1.4 system-ui,-apple-system,sans-serif}' +
      '#g2a-circle{width:52px;height:52px;border-radius:50%;background:#238636;border:3px solid #3fb950;cursor:grab;display:flex;align-items:center;justify-content:center;font-size:24px;color:#fff;box-shadow:0 4px 14px rgba(0,0,0,.5);touch-action:none;user-select:none;transition:transform .15s,background .3s,border-color .3s}' +
      '#g2a-circle:active{transform:scale(.92);cursor:grabbing}' +
      '#g2a-panel{display:none;position:absolute;bottom:62px;right:0;width:286px;background:#161b22;border:1px solid #30363d;border-radius:14px;box-shadow:0 10px 30px rgba(0,0,0,.6);overflow:hidden;color:#e8eaed}' +
      '#g2a-panel.show{display:block}' +
      '#g2a-hd{background:#0d1117;padding:11px 14px;border-bottom:1px solid #30363d;font-weight:700;color:#3fb950}' +
      '#g2a-hd small{display:block;color:#8b949e;font-weight:400;font-size:10px;margin-top:2px}' +
      '#g2a-bd{padding:12px 14px}' +
      '#g2a-st{font-size:12px;padding:7px 10px;border-radius:8px;margin-bottom:11px;background:#0d2818;color:#3fb950;word-break:break-word}' +
      '#g2a-st.err{background:#2d1214;color:#f85149}#g2a-st.warn{background:#2d1f04;color:#e3b341}#g2a-st.busy{background:#0d1b2e;color:#58a6ff}' +
      '.g2a-lab{font-size:10px;color:#8b949e;margin-bottom:3px;text-transform:uppercase;letter-spacing:.04em}' +
      '#g2a-key{font:11px/1.35 ui-monospace,monospace;word-break:break-all;background:#0d1117;border:1px solid #30363d;padding:7px 9px;border-radius:8px;color:#c9d1d9;margin-bottom:9px}' +
      '.g2a-row{display:flex;gap:7px;margin-bottom:8px}' +
      '.g2a-b{flex:1;border:0;border-radius:8px;padding:8px 0;font-size:12px;font-weight:700;cursor:pointer;color:#fff}' +
      '.g2a-copy{background:#238636}.g2a-new{background:#6e40c9}.g2a-help{background:#1f6feb}.g2a-b:active{opacity:.8}' +
      '.g2a-stats{display:grid;grid-template-columns:1fr 1fr 1fr;gap:7px;margin-top:4px}' +
      '.g2a-s{background:#0d1117;border:1px solid #30363d;border-radius:8px;padding:6px 4px;text-align:center}' +
      '.g2a-s .v{font-size:14px;font-weight:700;color:#e8eaed}.g2a-s .l{font-size:9px;color:#8b949e}';
    (document.head || document.documentElement).appendChild(s);
  }

  function flashBtn(sel, on, off) { try { var b = elFloat.querySelector(sel); if (!b) return; b.textContent = on; setTimeout(function () { b.textContent = off; }, 1500); } catch (e) {} }

  function copyKey() {
    if (!HIVE_KEY) return;
    var done = function () { flashBtn('.g2a-copy', 'Copied ✓', 'Copy key'); };
    function fb() { try { var ta = document.createElement('textarea'); ta.value = HIVE_KEY; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); done(); } catch (y) {} }
    try { if (W.navigator.clipboard) { W.navigator.clipboard.writeText(HIVE_KEY).then(done).catch(fb); return; } } catch (e) {}
    fb();
  }

  function regenKey() {
    if (!W.confirm('Make a NEW key? Your current key stops working and you must update your API client.')) return;
    proxyPost('/register', { label: '' }, function (j) {
      if (j && j.key) { HIVE_KEY = j.key; gmSet('hiveKey', HIVE_KEY); renderUI(); flashBtn('.g2a-new', 'New ✓', 'New key'); }
      else flashBtn('.g2a-new', 'failed', 'New key');
    });
  }

  function buildUI() {
    if (ui.ready || !document.body) return;
    injectStyle();
    elFloat = document.createElement('div'); elFloat.id = 'g2a-float';
    elFloat.innerHTML =
      '<div id="g2a-panel">' +
        '<div id="g2a-hd">⚡ Grok2API · Hive<small>your grok = your API · keep this tab open</small></div>' +
        '<div id="g2a-bd">' +
          '<div id="g2a-st">starting…</div>' +
          '<div class="g2a-lab">Your API key (use as the OpenAI key)</div>' +
          '<div id="g2a-key">—</div>' +
          '<div class="g2a-row"><button class="g2a-b g2a-copy">Copy key</button><button class="g2a-b g2a-new">New key</button></div>' +
          '<div class="g2a-row"><button class="g2a-b g2a-help">How to use</button></div>' +
          '<div class="g2a-stats">' +
            '<div class="g2a-s"><div class="v" id="g2a-served">0</div><div class="l">served</div></div>' +
            '<div class="g2a-s"><div class="v" id="g2a-model">fast</div><div class="l">model</div></div>' +
            '<div class="g2a-s"><div class="v" id="g2a-worker">…</div><div class="l">worker</div></div>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div id="g2a-circle">⚡</div>';
    document.body.appendChild(elFloat);
    elCircle = elFloat.querySelector('#g2a-circle');
    elPanel = elFloat.querySelector('#g2a-panel');
    elStatus = elFloat.querySelector('#g2a-st');
    elKeyV = elFloat.querySelector('#g2a-key');
    elServedV = elFloat.querySelector('#g2a-served');
    elModelV = elFloat.querySelector('#g2a-model');
    elWorkerV = elFloat.querySelector('#g2a-worker');
    setupFloatDrag(elFloat, elCircle, function () { ui.open = !ui.open; elPanel.className = ui.open ? 'show' : ''; });
    elFloat.querySelector('.g2a-copy').addEventListener('click', function (e) { e.stopPropagation(); copyKey(); });
    elFloat.querySelector('.g2a-new').addEventListener('click', function (e) { e.stopPropagation(); regenKey(); });
    elFloat.querySelector('.g2a-help').addEventListener('click', function (e) { e.stopPropagation(); try { W.open(PROXY + '/connect', '_blank'); } catch (x) {} });
    ui.ready = true;
    renderUI();
  }

  function renderUI() {
    if (!ui.ready) return;
    try {
      elKeyV.textContent = HIVE_KEY || '(registering…)';
      elStatus.textContent = ui.text;
      elStatus.className = ui.kind || '';
      elServedV.textContent = String(servedCount);
      elModelV.textContent = _lastModelPicked || 'fast';
      var errRecent = Date.now() - ui.lastErrAt < 8000;
      var c = '#238636', bd = '#3fb950', wk = 'on';      // ready (green)
      if (!HIVE_KEY) { c = '#9a6700'; bd = '#d29922'; wk = '…'; }       // registering (amber)
      else if (errRecent) { c = '#8e1519'; bd = '#f85149'; wk = 'err'; } // error (red)
      else if (busy) { c = '#0d419d'; bd = '#58a6ff'; wk = 'busy'; }     // working (blue)
      elCircle.style.background = c; elCircle.style.borderColor = bd;
      elWorkerV.textContent = wk;
    } catch (e) {}
  }

  function setStatus(text, kind) {
    ui.text = text;
    ui.kind = (kind === 'err') ? 'err' : (kind === 'warn') ? 'warn' : (kind === 'busy') ? 'busy' : '';
    if (kind === 'err') ui.lastErrAt = Date.now();
    renderUI();
  }
  // Back-compat shims for the rest of the script.
  function badge(text, ok) { setStatus(text, ok === false ? 'err' : ''); }
  function workerBadge(text, ok) { setStatus(text, ok === false ? 'err' : 'busy'); }
  function showKeyPanel() { renderUI(); }

  // Build the panel once <body> exists; refresh the circle color on a ticker
  // (busy state changes without a status message).
  var bi = setInterval(function () {
    if (document.body) {
      clearInterval(bi);
      buildUI();
      badge(HIVE_KEY ? 'starting…' : 'first run — registering…', true);
    }
  }, 300);
  setInterval(function () { if (ui.ready) renderUI(); }, 1500);

  console.log('[Grok2API] worker booting → ' + PROXY + (HIVE_KEY ? ' (key ' + HIVE_KEY.slice(0, 12) + '…)' : ' (will register)'));
})();
`;
}

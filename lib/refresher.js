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
// @version      3.9.1
// @description  Phone-egress worker for Grok2API: drives grok's own composer to send your prompt (grok signs the body-bound x-statsig-id itself) and tees grok's response stream back to your proxy.
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
      workerBadge('job ' + tag + ' done ✓', true);
      busy = false;
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
      if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
        var proto = (el.tagName === 'TEXTAREA') ? W.HTMLTextAreaElement.prototype : W.HTMLInputElement.prototype;
        var d = Object.getOwnPropertyDescriptor(proto, 'value');
        el.focus();
        if (d && d.set) d.set.call(el, val); else el.value = val;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        el.focus();
        el.textContent = val;
        try { el.dispatchEvent(new InputEvent('input', { bubbles: true, data: val, inputType: 'insertText' })); }
        catch (e) { el.dispatchEvent(new Event('input', { bubbles: true })); }
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
    function add(b) { if (b && b.tagName === 'BUTTON' && out.indexOf(b) < 0 && isVisible(b)) out.push(b); }
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
  function pickSubmit(btns) {
    var fallback = null;
    for (var k = 0; k < btns.length; k++) {
      var b = btns[k];
      var tid = (b.getAttribute && b.getAttribute('data-testid')) || '';
      var al = (b.getAttribute && b.getAttribute('aria-label')) || '';
      if (tid === 'chat-submit' || /^submit$|^send/i.test(al) || b.type === 'submit') {
        if (!b.disabled) return b;
        if (!fallback) fallback = b;
      }
    }
    return fallback;
  }

  // One send method per call, strongest first (so the FIRST attempt cleanly
  // submits and we never inject a stray Enter newline): #1 form.requestSubmit,
  // #2/#3 click the submit button, then any candidate, Enter only as last resort.
  // afterNewChat calls this repeatedly until grok fires the request.
  function doSend(input, tag, n) {
    var form = input.closest && input.closest('form');
    if (n === 1 && form) {
      wlog('job ' + tag + ' send#1 form.requestSubmit');
      try { if (form.requestSubmit) { form.requestSubmit(); return; } form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); return; } catch (e) {}
    }
    if (n <= 4) {
      var btns = sendButtonCandidates(input);
      var b = pickSubmit(btns) || btns.filter(function (x) { return !x.disabled; })[0];
      if (b) { wlog('job ' + tag + ' send#' + n + ' click ' + describeBtn(b)); try { b.click(); return; } catch (e) {} }
    }
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
    wlog('job ' + tag + ' typed prompt (' + job.prompt.length + ' chars) into ' + input.tagName.toLowerCase());
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
        endJob(job, 'grok issued no chat request after ' + sendTries + ' send attempts — send control not triggered (see composer buttons logged above)');
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

  startKeepAlive();
  setTimeout(pollLoop, 3000);

  // Make a fixed-position overlay draggable by touch or mouse (pointer events).
  function makeDraggable(elm) {
    var dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
    elm.style.cursor = 'move';
    elm.style.touchAction = 'none';
    elm.style.userSelect = 'none';
    elm.addEventListener('pointerdown', function (e) {
      dragging = true;
      var r = elm.getBoundingClientRect();
      elm.style.left = r.left + 'px'; elm.style.top = r.top + 'px';
      elm.style.right = 'auto'; elm.style.bottom = 'auto'; elm.style.transform = 'none';
      sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
      try { elm.setPointerCapture(e.pointerId); } catch (x) {}
      e.preventDefault();
    });
    elm.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      elm.style.left = (ox + (e.clientX - sx)) + 'px';
      elm.style.top = (oy + (e.clientY - sy)) + 'px';
      e.preventDefault();
    });
    function up(e) { dragging = false; try { elm.releasePointerCapture(e.pointerId); } catch (x) {} }
    elm.addEventListener('pointerup', up);
    elm.addEventListener('pointercancel', up);
  }

  var BADGE_BASE = 'position:fixed;z-index:2147483647;left:50%;transform:translateX(-50%);padding:7px 11px;border-radius:8px;font:12px/1.4 system-ui,sans-serif;color:#fff;background:#15181d;border:1px solid #333;box-shadow:0 2px 12px rgba(0,0,0,.5);max-width:300px;opacity:.94';

  // Second status line (above the sig badge) for worker activity. Centered + draggable.
  var wEl = null;
  function workerBadge(text, ok) {
    try {
      if (!wEl) {
        wEl = document.createElement('div');
        wEl.style.cssText = BADGE_BASE + ';top:42%';
        (document.body || document.documentElement).appendChild(wEl);
        makeDraggable(wEl);
      }
      wEl.style.borderColor = ok ? '#2fbf71' : '#ff5470';
      wEl.textContent = '⠿ Worker: ' + text + ' @ ' + new Date().toLocaleTimeString();
    } catch (e) {}
  }

  // ── Tiny status badge so you can see it working. Centered + draggable. ──
  var el = null;
  function badge(text, ok) {
    try {
      if (!el) {
        el = document.createElement('div');
        el.style.cssText = BADGE_BASE + ';top:49%';
        (document.body || document.documentElement).appendChild(el);
        makeDraggable(el);
      }
      el.style.borderColor = ok ? '#2fbf71' : '#ff5470';
      var t = new Date().toLocaleTimeString();
      el.textContent = '⠿ Grok2API: ' + text + ' @ ' + t;
    } catch (e) {}
  }
  // Badge needs <body>; retry until it exists.
  var bi = setInterval(function () { if (document.body) { clearInterval(bi); badge('refresher armed — waiting for sig…', true); } }, 300);

  console.log('[Grok2API refresher] armed → ' + PROXY + PUSH_PATH);
})();
`;
}

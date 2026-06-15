// Background service worker (MV3). Two jobs:
//  1) On startup, seed the grok.com session cookies into THIS browser so the
//     tab opens already logged in — no manual password login, no screen needed.
//     Cookies are set via chrome.cookies.set (an allowed extension API), NOT by
//     driving the browser over CDP, so there's no automation fingerprint and
//     grok still renders the SVG canary that makes sigs valid.
//  2) Receive skimmed x-statsig-id values from bridge.js and POST them to the
//     local proxy (debounced). The proxy reuses each sig for its ~3-4 min TTL.
//
// Config (cookies, proxy URL, refresh token) is written by Node into
// runtime-config.json inside this extension dir before Chromium launches.

const MIN_PUSH_GAP_MS = 8 * 1000;
let CFG = null;
let lastSig = null;
let lastPushAt = 0;
let pushTimer = null;

async function loadConfig() {
  try {
    const res = await fetch(chrome.runtime.getURL('runtime-config.json'));
    CFG = await res.json();
    console.log('[Grok2API bg] config loaded; cookies:', (CFG.cookies || []).length, 'proxy:', CFG.proxyUrl);
  } catch (e) {
    console.error('[Grok2API bg] no runtime-config.json:', e.message);
    CFG = { cookies: [], proxyUrl: 'http://127.0.0.1:7860', refreshToken: '', startUrl: 'https://grok.com/' };
  }
}

// ── Seed cookies, then open the grok tab so the content scripts run. ──
async function seedCookiesAndOpen() {
  if (!CFG) await loadConfig();
  const jar = CFG.cookies || [];
  for (const c of jar) {
    try {
      await chrome.cookies.set({
        url: 'https://grok.com/',
        name: c.name,
        value: c.value,
        domain: c.domain || '.grok.com',
        path: '/',
        secure: true,
        httpOnly: false,          // chrome.cookies.set can't set httpOnly; fine for our use
        sameSite: 'no_restriction',
        expirationDate: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30,
      });
    } catch (e) {
      console.warn('[Grok2API bg] cookie set failed for', c.name, e.message);
    }
  }
  console.log('[Grok2API bg] seeded', jar.length, 'cookies');

  // Reuse an existing grok tab if one is already open, else create it.
  const startUrl = CFG.startUrl || 'https://grok.com/';
  try {
    const tabs = await chrome.tabs.query({ url: 'https://grok.com/*' });
    if (tabs && tabs.length) await chrome.tabs.reload(tabs[0].id);
    else await chrome.tabs.create({ url: startUrl, active: true });
  } catch (e) {
    console.warn('[Grok2API bg] open tab failed:', e.message);
  }
}

// ── Push a fresh sig to the proxy (debounced). ──
function pushSoon(sig, source) {
  if (!sig || sig.length < 20) return;
  lastSig = sig;
  const since = Date.now() - lastPushAt;
  if (since >= MIN_PUSH_GAP_MS) { push(source); return; }
  if (pushTimer) return;
  pushTimer = setTimeout(() => { pushTimer = null; push(source); }, MIN_PUSH_GAP_MS - since);
}

async function push(source) {
  if (!lastSig || !CFG) return;
  lastPushAt = Date.now();
  try {
    const r = await fetch((CFG.proxyUrl || 'http://127.0.0.1:7860') + '/admin/sig', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-refresh-token': CFG.refreshToken || '' },
      body: JSON.stringify({ sig: lastSig }),
    });
    console.log('[Grok2API bg] pushed sig (' + source + ') →', r.status);
  } catch (e) {
    console.warn('[Grok2API bg] push failed:', e.message);
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'sig') pushSoon(msg.sig, msg.source || 'page');
});

chrome.runtime.onInstalled.addListener(() => { loadConfig().then(seedCookiesAndOpen); });
chrome.runtime.onStartup.addListener(() => { loadConfig().then(seedCookiesAndOpen); });
// Service worker may spin up cold — seed on first load too.
loadConfig().then(seedCookiesAndOpen);

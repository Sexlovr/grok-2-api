// Runs in grok.com's ISOLATED world (extension context) at document_start.
// It can't read the page's fetch headers (different JS world from hook.js) but
// it CAN talk to the background service worker. So it just listens for the
// window.postMessage relays from hook.js and forwards each sig to background.js,
// which pushes it to the local proxy.
(function () {
  'use strict';
  window.addEventListener('message', function (ev) {
    if (ev.source !== window) return;
    var d = ev.data;
    if (!d || d.__grok2api !== true || d.type !== 'sig') return;
    try {
      chrome.runtime.sendMessage({ type: 'sig', sig: d.sig, source: d.source });
    } catch (e) {}
  });
  console.log('[Grok2API signer] bridge armed');
})();

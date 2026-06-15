import { chromium } from 'playwright';
import { spawn } from 'child_process';
import { discoverSignerSource } from './grokSigner.js';
import { cookieStringToPlaywright } from './curlParser.js';

const GROK_ORIGIN = 'https://grok.com';
const NEW_PATH = '/rest/app-chat/conversations/new';

// ── Lazy virtual framebuffer ──
// Headful Chromium needs an X display. We start Xvfb from inside Node (only
// when a headful browser is actually launched) instead of wrapping the whole
// process in xvfb-run at the shell level — that wrapper could hang before node
// ever ran, leaving the platform stuck at "Starting".
let _xvfbProcess = null;
function ensureXvfb() {
    if (_xvfbProcess || process.env.DISPLAY) return;
    console.log('[Xvfb] Starting virtual framebuffer on :99 ...');
    _xvfbProcess = spawn('Xvfb', [':99', '-screen', '0', '1280x800x24', '-ac'], { shell: true });
    _xvfbProcess.on('exit', () => { _xvfbProcess = null; });
    process.env.DISPLAY = ':99';
}

/**
 * Holds a single headful Chromium logged in to grok.com. The page-context fetch
 * is signed by the real Grok signer (injected as window.__grokSign), which only
 * works inside a real DOM — hence the browser. Runs stateless: every request is
 * a fresh /new conversation carrying the full dumped prompt.
 */
export class GrokBrowser {
    constructor(opts = {}) {
        this.headless = opts.headless ?? (process.env.HEADLESS === '1');
        this.browser = null;
        this.context = null;
        this.page = null;
        this.account = null;        // { cookie, userAgent }
        this.signerInfo = null;     // { moduleId, chunkFile }
        this._streams = new Map();  // streamId -> handler state
        this._seq = 0;
        this._starting = null;
    }

    async start() {
        if (this.browser) return;
        if (this._starting) return this._starting;
        this._starting = (async () => {
            // Headful needs an X display; start Xvfb lazily before launching.
            if (!this.headless) ensureXvfb();
            console.log(`[Grok] Launching Chromium (headless=${this.headless})...`);
            this.browser = await chromium.launch({
                headless: this.headless,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-blink-features=AutomationControlled',
                    '--disable-dev-shm-usage',
                ],
            });
        })();
        await this._starting;
    }

    /** Load (or reload) the Grok session from a parsed account and prime the signer. */
    async loadAccount(account) {
        await this.start();
        this.account = account;

        if (this.context) { await this.context.close().catch(() => {}); this.context = null; }

        this.context = await this.browser.newContext({
            userAgent: account.userAgent ||
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
            viewport: { width: 1280, height: 800 },
        });

        if (account.cookie) {
            await this.context.addCookies(cookieStringToPlaywright(account.cookie)).catch((e) =>
                console.warn('[Grok] addCookies warning:', e.message));
        }

        this.page = await this.context.newPage();

        // Bridge in-page stream events back to Node.
        await this.page.exposeFunction('__grokEmit', (streamId, type, data) => {
            const st = this._streams.get(streamId);
            if (!st) return;
            try { this._onEmit(st, type, data); } catch (e) { console.error('[Grok] emit handler error', e.message); }
        });

        console.log('[Grok] Navigating to grok.com to establish the session...');
        await this.page.goto(GROK_ORIGIN + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });

        // Let the SPA hydrate; the signer folds a live DOM fingerprint into the
        // signature, so the React tree must be mounted before we inject it.
        try { await this.page.waitForLoadState('networkidle', { timeout: 30000 }); }
        catch { /* networkidle can stall on long-poll connections; continue */ }
        await this.page.waitForTimeout(4000);

        // Diagnostics: what did this IP actually land on? (Cloudflare challenge,
        // block page, or real grok.com?) Logged once so we can see it in HF logs.
        try {
            const diag = await this.page.evaluate(() => ({
                url: location.href,
                title: document.title,
                bodyLen: document.body ? document.body.innerHTML.length : -1,
                bodyChildren: document.body ? document.body.childNodes.length : -1,
                hasNext: !!document.getElementById('__next') || document.documentElement.innerHTML.includes('__next'),
                cf: /challenge|cf-|cloudflare|verify you are human|attention required/i.test(
                    (document.title + ' ' + document.body?.innerText?.slice(0, 500)) || ''),
            }));
            console.log('[Grok][diag] page after load:', JSON.stringify(diag));
        } catch (e) {
            console.log('[Grok][diag] could not read page:', e.message);
        }

        await this.injectSigner();
        console.log('[Grok] Session ready. Signer module:', this.signerInfo?.moduleId);
    }

    /** Discover the current signer source and inject it as window.__grokSign. */
    async injectSigner() {
        const disc = await discoverSignerSource({
            cookie: this.account?.cookie,
            userAgent: this.account?.userAgent,
        });
        this.signerInfo = { moduleId: disc.moduleId, chunkFile: disc.chunkFile };

        await this.page.evaluate((modSrc) => {
            const W = { s: (arr) => { if (arr && arr[0] === 'default') W.__getter = arr[2]; } };
            // eslint-disable-next-line no-eval
            const fn = (0, eval)('(' + modSrc + ')'); // the module's W=>{...}
            fn(W);
            window.__grokState = { getter: W.__getter, def: null };
            window.__grokSign = async (path, method) => {
                const st = window.__grokState;
                if (!st.getter) throw new Error('signer getter missing');
                if (!st.def) st.def = st.getter();
                const def = st.def;
                if (typeof def !== 'function') return def;
                // def may be the signer (path,method)=>sid, or a factory ()=>signer.
                let out = await def(path, method);
                if (typeof out === 'function') out = await out(path, method);
                return out;
            };
            return true;
        }, disc.source);

        // Smoke-test the signer produces a string.
        const probe = await this.page.evaluate(async () => {
            try { const s = await window.__grokSign('/rest/app-chat/conversations/new', 'POST'); return { ok: typeof s === 'string' && s.length > 20, len: (s || '').length }; }
            catch (e) { return { ok: false, err: String(e) }; }
        });
        if (!probe.ok) throw new Error('signer self-test failed: ' + JSON.stringify(probe));
        console.log('[Grok] Signer self-test OK (sid len', probe.len + ')');
    }

    _onEmit(st, type, data) {
        if (type === 'line') {
            let j; try { j = JSON.parse(data); } catch { return; }
            const r = j.result || {};
            if (r.conversation?.conversationId) st.conversationId = r.conversation.conversationId;
            const rp = r.response;
            if (rp) {
                if (rp.responseId) st.lastResponseId = rp.responseId;
                if (rp.token !== undefined && rp.token !== null) {
                    if (rp.isThinking || rp.messageTag === 'header') {
                        st.onThink && st.onThink(rp.token);
                    } else if (rp.messageTag === 'final') {
                        st.content += rp.token;
                        st.onToken && st.onToken(rp.token);
                    }
                }
                if (rp.modelResponse?.message && !st.content) st.content = rp.modelResponse.message;
                if (rp.error) st.error = typeof rp.error === 'string' ? rp.error : JSON.stringify(rp.error);
            }
            if (r.error) st.error = typeof r.error === 'string' ? r.error : JSON.stringify(r.error);
        } else if (type === 'error') {
            st.error = data;
        } else if (type === 'done') {
            st.done = true;
        }
    }

    /**
     * Send one stateless turn. Returns { content, conversationId, responseId }.
     * onToken/onThink fire live as tokens stream.
     */
    async chat({ prompt, modeId = 'fast', disableSearch = true, onToken, onThink }) {
        if (!this.page) throw new Error('Grok session not loaded');
        const streamId = 'g' + (++this._seq);
        const st = { content: '', error: null, done: false, conversationId: null, lastResponseId: null, onToken, onThink };
        this._streams.set(streamId, st);

        const body = JSON.stringify({
            temporary: true,
            message: prompt,
            modeId,
            fileAttachments: [], imageAttachments: [],
            disableSearch, enableImageGeneration: false, returnImageBytes: false,
            returnRawGrokInXaiRequest: false, enableImageStreaming: false, imageGenerationCount: 0,
            forceConcise: false, enableSideBySide: false, sendFinalMetadata: true,
            disableTextFollowUps: true, responseMetadata: {}, disableMemory: true,
            forceSideBySide: false, isAsyncChat: false, disableSelfHarmShortCircuit: false,
            collectionIds: [], disabledConnectorIds: [],
            deviceEnvInfo: { darkModeEnabled: true, devicePixelRatio: 1, screenWidth: 1280, screenHeight: 800, viewportWidth: 1280, viewportHeight: 800 },
            linkQuery: false,
        });

        try {
            await this.page.evaluate(async ({ streamId, body, path }) => {
                const emit = (t, d) => window.__grokEmit(streamId, t, d);
                let sid;
                try { sid = await window.__grokSign(path, 'POST'); }
                catch (e) { emit('error', 'sign failed: ' + String(e)); emit('done', ''); return; }

                let res;
                try {
                    res = await fetch(path, {
                        method: 'POST',
                        headers: {
                            'content-type': 'application/json',
                            'x-statsig-id': sid,
                            'x-xai-request-id': (crypto.randomUUID && crypto.randomUUID()) || (Date.now() + ''),
                        },
                        body,
                    });
                } catch (e) { emit('error', 'fetch failed: ' + String(e)); emit('done', ''); return; }

                if (!res.ok) {
                    const t = await res.text().catch(() => '');
                    emit('error', 'HTTP ' + res.status + ': ' + t.slice(0, 300));
                    emit('done', '');
                    return;
                }
                const reader = res.body.getReader();
                const dec = new TextDecoder();
                let buf = '';
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    buf += dec.decode(value, { stream: true });
                    const lines = buf.split('\n');
                    buf = lines.pop();
                    for (const ln of lines) if (ln.trim()) emit('line', ln);
                }
                if (buf.trim()) emit('line', buf);
                emit('done', '');
            }, { streamId, body, path: NEW_PATH });
        } finally {
            this._streams.delete(streamId);
        }

        if (st.error) throw new Error('Grok: ' + st.error);
        return { content: st.content, conversationId: st.conversationId, responseId: st.lastResponseId };
    }

    async close() {
        try { await this.browser?.close(); } catch {}
        this.browser = this.context = this.page = null;
    }
}

// Module-level singleton (one browser per proxy process).
let _instance = null;
export function getGrokBrowser() {
    if (!_instance) _instance = new GrokBrowser();
    return _instance;
}

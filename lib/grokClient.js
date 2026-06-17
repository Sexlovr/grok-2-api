import crypto from 'crypto';

const GROK_ORIGIN = 'https://grok.com';
const NEW_PATH = '/rest/app-chat/conversations/new';

// A relayed x-statsig-id is good for only ~3-4 minutes (measured). We treat
// anything older than this as too risky to use and surface a clear 503 instead
// of letting grok reject it with an opaque anti-bot 403.
const SIG_MAX_AGE_MS = 3.5 * 60 * 1000;

const UA_DEFAULT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36';

// ── Shared NDJSON stream parser ──────────────────────────────────────────────
// grok streams one JSON object per line. Both the direct client (this file) and
// the phone-relay consumer (index.js) feed lines through the SAME functions so
// the two egress paths produce byte-identical output.

/** Fresh accumulator for one grok response stream. */
export function makeStreamState({ onToken, onThink } = {}) {
    return { content: '', conversationId: null, lastResponseId: null, error: null, onToken, onThink };
}

/** Parse one NDJSON line of grok's streaming response into `st`. */
export function feedGrokLine(st, line) {
    let j; try { j = JSON.parse(line); } catch { return; }
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
}

/**
 * Pure-Node forwarder to grok.com. NO browser.
 *
 * grok.com gates its chat API on an `x-statsig-id` request signature that can
 * only be produced inside a real, non-automation browser (it folds in an
 * animated SVG "canary" that grok refuses to render under CDP/WebDriver). The
 * signature is, however, reusable and not IP-bound for a short TTL (~3-4 min).
 *
 * So this client carries no signer at all. A userscript running in the user's
 * real grok.com tab captures fresh sigs and pushes them to the proxy
 * (POST /admin/sig); we stash the latest here and attach it to each upstream
 * request, alongside the session cookie. Every turn is a fresh, stateless
 * `/new` conversation carrying the whole dumped prompt.
 */
export class GrokClient {
    constructor() {
        this.account = null;     // { cookie, userAgent }
        this._sig = null;        // current x-statsig-id value
        this._sigAt = 0;         // epoch ms when it was received
    }

    /** Set the active account (cookie + UA). Optionally seed an initial sig. */
    loadAccount(account) {
        this.account = account || null;
        if (account?.statsigId) this.setSig(account.statsigId);
    }

    /** Receive a fresh x-statsig-id from the refresher userscript. */
    setSig(sig) {
        if (!sig || typeof sig !== 'string' || sig.length < 20) return false;
        this._sig = sig.trim();
        this._sigAt = Date.now();
        return true;
    }

    /** State for the admin UI / health checks. */
    getSigState() {
        const ageMs = this._sig ? Date.now() - this._sigAt : null;
        return {
            hasSig: !!this._sig,
            ageSeconds: ageMs == null ? null : Math.round(ageMs / 1000),
            stale: ageMs == null ? true : ageMs > SIG_MAX_AGE_MS,
            maxAgeSeconds: Math.round(SIG_MAX_AGE_MS / 1000),
        };
    }

    get hasAccount() { return !!this.account?.cookie; }

    /**
     * Send one stateless turn. Returns { content, conversationId, responseId }.
     * onToken/onThink fire live as tokens stream in.
     */
    async chat({ prompt, modeId = 'MODEL_MODE_AUTO', disableSearch = true, onToken, onThink }) {
        if (!this.account?.cookie) throw new Error('No Grok account loaded — add one in the admin panel.');
        const state = this.getSigState();
        if (!state.hasSig) throw new Error('No x-statsig-id available — is the refresher userscript running on a grok.com tab?');
        if (state.stale) throw new Error(`x-statsig-id is stale (${state.ageSeconds}s old, max ${state.maxAgeSeconds}s) — the refresher userscript may have stopped.`);

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

        const res = await fetch(GROK_ORIGIN + NEW_PATH, {
            method: 'POST',
            headers: {
                'accept': '*/*',
                'content-type': 'application/json',
                'origin': GROK_ORIGIN,
                'referer': GROK_ORIGIN + '/',
                'user-agent': this.account.userAgent || UA_DEFAULT,
                'cookie': this.account.cookie,
                'x-statsig-id': this._sig,
                'x-xai-request-id': crypto.randomUUID(),
            },
            body,
        });

        if (!res.ok) {
            const t = await res.text().catch(() => '');
            // A 403 here almost always means the relayed sig just expired.
            const hint = res.status === 403 ? ' (sig likely expired — refresher should push a new one within ~2 min)' : '';
            throw new Error(`HTTP ${res.status}${hint}: ${t.slice(0, 300)}`);
        }

        // grok streams NDJSON (one JSON object per line). Parse via the shared
        // feedGrokLine so direct + relay paths stay byte-identical.
        const st = makeStreamState({ onToken, onThink });
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            const lines = buf.split('\n');
            buf = lines.pop();
            for (const ln of lines) if (ln.trim()) feedGrokLine(st, ln);
        }
        if (buf.trim()) feedGrokLine(st, buf);

        if (st.error) throw new Error('Grok: ' + st.error);
        return { content: st.content, conversationId: st.conversationId, responseId: st.lastResponseId };
    }
}

// Module-level singleton (one client per proxy process).
let _instance = null;
export function getGrokClient() {
    if (!_instance) _instance = new GrokClient();
    return _instance;
}

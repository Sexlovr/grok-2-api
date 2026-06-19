import express from 'express';
import cors from 'cors';
import { config } from 'dotenv';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { getDB, initDB } from './lib/database.js';
import { parseGrokCurl } from './lib/curlParser.js';
import { getGrokClient, makeStreamState, feedGrokLine } from './lib/grokClient.js';
import {
    messagesToPrompt, generateId, hashApiKey,
    buildOpenAIChunk, buildOpenAIResponse,
} from './lib/translator.js';
import { buildAdminPage } from './lib/page.js';
import { buildRefresherUserscript } from './lib/refresher.js';
import { getRelayHub } from './lib/relay.js';
import { getHive } from './lib/hive.js';

config();

// Last-resort safety net: a stray async error must NEVER crash-loop the Space.
// Log and keep serving.
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e?.message || e));
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e?.message || e));

const app = express();
app.use(cors());
app.use(express.json({ limit: '25mb' }));

const PORT = process.env.PORT || 3000;

// ── Admin password. If unset, generate a random one (logged at boot). If it's
// explicitly set to "admin" we honor it but warn loudly — convenient for a
// throwaway Space, but anyone who logs in gets your grok session cookie. ──
let ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) {
    ADMIN_PASSWORD = crypto.randomBytes(9).toString('base64url');
    console.warn('[Auth] ADMIN_PASSWORD was unset; generated a random one for this run:');
    console.warn('       ADMIN_PASSWORD = ' + ADMIN_PASSWORD);
    console.warn('       Set it as a Space secret to keep it stable across restarts.');
} else if (ADMIN_PASSWORD === 'admin') {
    console.warn('[Auth] ADMIN_PASSWORD is "admin" — INSECURE. Anyone who logs in can read');
    console.warn('       your grok session cookie. Fine for a throwaway Space; set a strong');
    console.warn('       value (ideally a Space secret) for anything you care about.');
}

// ── Refresh token: the shared secret the refresher userscript uses to push sigs. ──
let REFRESH_TOKEN = process.env.REFRESH_TOKEN;
if (!REFRESH_TOKEN) {
    REFRESH_TOKEN = crypto.randomBytes(18).toString('hex');
    console.warn('[Auth] REFRESH_TOKEN unset; generated one for this run:');
    console.warn('       REFRESH_TOKEN = ' + REFRESH_TOKEN);
    console.warn('       Set it as a Space secret so the userscript keeps working across restarts.');
}

// ── JWT secret for admin login tokens. If not explicitly set, DERIVE it from the
// stable admin password + refresh token instead of a random per-boot value —
// otherwise every Space restart/rebuild rotates the secret and invalidates all
// existing login tokens, so the dashboard 401s until you log in again. Deriving
// keeps you logged in across restarts as long as those secrets are stable. ──
const JWT_SECRET = process.env.JWT_SECRET
    || crypto.createHash('sha256').update('grok2api|' + ADMIN_PASSWORD + '|' + REFRESH_TOKEN).digest('hex');

const grok = getGrokClient();
const relay = getRelayHub();
const hive = getHive();
let activeAccountId = null;

// Hive mode: multi-user self-service. Each user's userscript auto-registers a
// persistent grok_<hex> key (their API key AND their worker id) and serves from
// their OWN grok tab; if their tab is offline, the shared worker pool covers
// them. ON by default; legacy single-account relay still works underneath.
const HIVE_MODE = (process.env.HIVE_MODE || 'on').toLowerCase() !== 'off';

// Relay mode: when ON (default), the phone's grok tab is the egress — the Space
// hands prompts to the userscript worker and never calls grok.com itself. This
// is the only path that survives grok's IP-bound cf_clearance. Set
// RELAY_MODE=off to fall back to the direct datacenter forwarder (works only
// while the sig+clearance happen to pass from the Space's IP).
const RELAY_MODE = (process.env.RELAY_MODE || 'on').toLowerCase() !== 'off';

// ══════════════════════════════════════════
//  Helpers
// ══════════════════════════════════════════
function resolveMode(modelStr) {
    const row = getDB().prepare('SELECT mode_id FROM models WHERE model_id = ? AND active = 1').get(modelStr || '');
    if (row?.mode_id) return row.mode_id;
    // Heuristic fallback → grok.com's bare lowercase modeIds (confirmed from live
    // traffic: the payload field is "modeId":"fast", NOT "MODEL_MODE_FAST").
    // NOTE: only "fast" is verified working. Bare "auto" returned "Model is not
    // found", so other names here are best-guess until confirmed from devtools.
    // We default to "fast" (the one known-good value) rather than an unverified
    // string so a bad model name degrades to something that actually works.
    const m = (modelStr || '').toLowerCase();
    if (m.includes('expert')) return 'expert';
    if (m.includes('heavy')) return 'heavy';
    if (m.includes('think') || m.includes('reason')) return 'reasoning';
    return 'fast';
}

function loadActiveAccount() {
    const acc = getDB().prepare('SELECT * FROM accounts WHERE active = 1 ORDER BY last_used DESC, id DESC').get();
    if (!acc) { console.log('[Boot] No active Grok account yet — add one in the admin panel.'); return; }
    activeAccountId = acc.id;
    grok.loadAccount({ cookie: acc.cookie, userAgent: acc.user_agent });
    getDB().prepare("UPDATE accounts SET last_used = datetime('now') WHERE id = ?").run(acc.id);
    console.log('[Boot] Active account loaded:', acc.label || acc.user_id || acc.id);
}

// ══════════════════════════════════════════
//  Middleware
// ══════════════════════════════════════════
function adminAuth(req, res, next) {
    const h = req.headers.authorization;
    if (!h || !h.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const d = jwt.verify(h.split(' ')[1], JWT_SECRET);
        if (d.role !== 'admin') throw new Error();
        next();
    } catch { return res.status(401).json({ error: 'Invalid or expired token' }); }
}

function apiKeyAuth(req, res, next) {
    const h = req.headers.authorization;
    if (!h || !h.startsWith('Bearer ')) return res.status(401).json({ error: { message: 'Missing API key', type: 'auth_error' } });
    const key = h.split(' ')[1];

    // Hive key (grok_…): self-service per-user key. Routes to that user's own
    // worker, with shared-pool fallback. req.hiveKey marks the request.
    if (HIVE_MODE && key.startsWith('grok_')) {
        const hu = lookupHiveKey(key);
        if (!hu) return res.status(401).json({ error: { message: 'Invalid API key', type: 'auth_error' } });
        getDB().prepare('UPDATE hive_users SET request_count = request_count + 1, last_seen = CURRENT_TIMESTAMP WHERE id = ?').run(hu.id);
        req.hiveKey = key;
        req.apiKeyHash = hashApiKey(key);
        return next();
    }

    // Legacy global key (sk-grok-…): single shared account.
    const row = getDB().prepare('SELECT * FROM api_keys WHERE key = ? AND active = 1').get(key);
    if (!row) return res.status(401).json({ error: { message: 'Invalid API key', type: 'auth_error' } });
    getDB().prepare('UPDATE api_keys SET request_count = request_count + 1 WHERE id = ?').run(row.id);
    req.apiKeyHash = hashApiKey(key);
    next();
}

// ══════════════════════════════════════════
//  Admin routes
// ══════════════════════════════════════════
app.post('/admin/login', (req, res) => {
    if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Wrong password' });
    res.json({ token: jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '24h' }) });
});

app.get('/admin/accounts', adminAuth, (req, res) => {
    res.json(getDB().prepare('SELECT id, label, user_id, active, request_count, last_used, created_at FROM accounts').all());
});

app.post('/admin/accounts', adminAuth, (req, res) => {
    const { curl, label } = req.body;
    if (!curl) return res.status(400).json({ error: 'cURL string required' });
    const parsed = parseGrokCurl(curl);
    if (parsed.error) {
        console.log(`[Account] curl parse FAILED — ${parsed.error}`);
        return res.status(400).json({ error: parsed.error });
    }
    console.log(`[Account] curl parsed — sso=${!!parsed.sso} cf_clearance=${!!parsed.cfClearance} x-statsig-id=${parsed.statsigId ? `present(len=${parsed.statsigId.length})` : 'MISSING — paste a curl from a request that carries x-statsig-id (e.g. a /rest/app-chat call), dashboard will say "not captured" until the refresher feeds one'}`);

    const db = getDB();
    let id;
    const existing = parsed.userId ? db.prepare('SELECT id FROM accounts WHERE user_id = ?').get(parsed.userId) : null;
    if (existing) {
        db.prepare('UPDATE accounts SET cookie = ?, user_agent = ?, label = ?, active = 1 WHERE id = ?')
            .run(parsed.cookie, parsed.userAgent, label || '', existing.id);
        id = existing.id;
    } else {
        const r = db.prepare('INSERT INTO accounts (label, cookie, user_agent, user_id) VALUES (?, ?, ?, ?)')
            .run(label || '', parsed.cookie, parsed.userAgent, parsed.userId);
        id = r.lastInsertRowid;
    }

    // Single-active invariant: the newly added/updated account becomes THE active
    // one; every other account is deactivated. Without this, multiple rows stay
    // active=1 and loadActiveAccount() can pick a stale one on the next restart.
    db.prepare('UPDATE accounts SET active = 0 WHERE id != ?').run(id);

    activeAccountId = id;
    grok.loadAccount({ cookie: parsed.cookie, userAgent: parsed.userAgent, statsigId: parsed.statsigId });
    res.json({
        message: parsed.statsigId
            ? 'Account saved + initial sig seeded (good ~3-4 min). Install the refresher to keep it fed.'
            : 'Account saved. Now run the refresher userscript on a grok.com tab to feed it a sig.',
        id, found: parsed.summary, sig: grok.getSigState(),
    });
});

app.delete('/admin/accounts/:id', adminAuth, (req, res) => {
    const delId = parseInt(req.params.id, 10);
    getDB().prepare('DELETE FROM accounts WHERE id = ?').run(delId);

    // If we just deleted the account that's loaded in memory, drop it and stop
    // serving its cookie — otherwise the proxy keeps using a deleted account.
    if (activeAccountId === delId) {
        activeAccountId = null;
        grok.loadAccount(null);
        // Promote any surviving account (most recent) and make it active.
        const next = getDB().prepare('SELECT * FROM accounts ORDER BY last_used DESC, id DESC').get();
        if (next) {
            getDB().prepare('UPDATE accounts SET active = 1 WHERE id = ?').run(next.id);
            activeAccountId = next.id;
            grok.loadAccount({ cookie: next.cookie, userAgent: next.user_agent });
        }
    }
    res.json({ message: 'Deleted', activeAccountId });
});

app.patch('/admin/accounts/:id', adminAuth, (req, res) => {
    const tgt = parseInt(req.params.id, 10);
    if (req.body.active !== undefined) {
        const db = getDB();
        if (req.body.active) {
            // Activating one account deactivates the rest (single-active invariant)
            // and makes it the live one in memory.
            db.prepare('UPDATE accounts SET active = 0').run();
            db.prepare('UPDATE accounts SET active = 1 WHERE id = ?').run(tgt);
            const acc = db.prepare('SELECT * FROM accounts WHERE id = ?').get(tgt);
            if (acc) {
                activeAccountId = acc.id;
                grok.loadAccount({ cookie: acc.cookie, userAgent: acc.user_agent });
            }
        } else {
            db.prepare('UPDATE accounts SET active = 0 WHERE id = ?').run(tgt);
            if (activeAccountId === tgt) { activeAccountId = null; grok.loadAccount(null); }
        }
    }
    res.json({ message: 'Updated', activeAccountId });
});

// ── Sig relay: the refresher userscript POSTs fresh x-statsig-id here. ──
// Auth is the shared REFRESH_TOKEN (header), NOT the admin JWT — so the
// userscript never carries the admin password.
app.post('/admin/sig', (req, res) => {
    const tok = req.headers['x-refresh-token'] || req.body?.token;
    const sig = req.body?.sig;
    console.log(`[Sig] POST /admin/sig — tokenOk=${tok === REFRESH_TOKEN} sigLen=${sig ? String(sig).length : 0}`);
    if (tok !== REFRESH_TOKEN) {
        console.log('[Sig] push REJECTED — bad refresh token (check userscript TOKEN matches REFRESH_TOKEN)');
        return res.status(401).json({ error: 'bad refresh token' });
    }
    const ok = grok.setSig(sig);
    if (!ok) return res.status(400).json({ error: 'invalid sig' });
    res.json({ ok: true, sig: grok.getSigState() });
});

// ══════════════════════════════════════════
//  Relay: "phone is the egress" job pickup/return.
//  The userscript worker on the phone's grok tab uses these. Auth is the shared
//  REFRESH_TOKEN header (same as /admin/sig) — never the admin JWT.
// ══════════════════════════════════════════
// Dual-mode worker auth. A HIVE worker authenticates with its own grok_ key
// (header x-hive-key or body.hiveKey) → req.hiveKey set, routed to the hive.
// The LEGACY single-account worker uses the shared REFRESH_TOKEN → routed to the
// relay hub. ANY authenticated worker request marks the worker alive (so a busy
// worker mid-UI-drive isn't declared offline).
function workerAuth(req, res, next) {
    const hk = req.headers['x-hive-key'] || req.body?.hiveKey;
    if (HIVE_MODE && hk && hk.startsWith('grok_')) {
        if (!lookupHiveKey(hk)) return res.status(401).json({ error: 'invalid hive key' });
        req.hiveKey = hk;
        hive.markWorker(hk);
        return next();
    }
    const tok = req.headers['x-refresh-token'] || req.body?.token;
    if (tok !== REFRESH_TOKEN) return res.status(401).json({ error: 'bad refresh token' });
    relay.markWorker();
    next();
}

// Worker long-polls for the next job. Returns {job} or {job:null} after a hold.
app.post('/relay/poll', workerAuth, async (req, res) => {
    try {
        const job = req.hiveKey ? await hive.poll(req.hiveKey) : await relay.poll();
        res.json({ job: job || null });
    } catch (e) { res.json({ job: null }); }
});

// Worker streams raw grok NDJSON lines back for a running job.
app.post('/relay/chunk', workerAuth, (req, res) => {
    const { id, lines, httpStatus } = req.body || {};
    const ok = req.hiveKey ? hive.pushChunk(req.hiveKey, id, lines, httpStatus) : relay.pushChunk(id, lines, httpStatus);
    res.json({ ok });
});

// Worker signals the job is finished (or failed).
app.post('/relay/finish', workerAuth, (req, res) => {
    const { id, error } = req.body || {};
    const ok = req.hiveKey ? hive.finish(req.hiveKey, id, { error }) : relay.finish(id, { error });
    res.json({ ok });
});

// Worker pipes a debug line straight into the HF server log. Lets us see what
// the phone is doing (which sign strategy grok accepted, response bodies, etc.)
// without access to the phone's own console.
app.post('/relay/log', workerAuth, (req, res) => {
    const msg = String(req.body?.msg || '').slice(0, 400);
    if (msg) console.log(`[Worker${req.hiveKey ? ' ' + req.hiveKey.slice(0, 9) + '…' : ''}] ` + msg);
    res.json({ ok: true });
});

// Admin-facing freshness readout for the dashboard widget.
app.get('/admin/sig-status', adminAuth, (req, res) => {
    res.json({ ...grok.getSigState(), hasAccount: grok.hasAccount, activeAccountId, worker: relay.workerState(), hive: { workersOnline: hive.onlineCount() } });
});

// Hive overview: registered users + how many of their worker tabs are online.
app.get('/admin/hive', adminAuth, (req, res) => {
    const users = getDB().prepare('SELECT key, label, request_count, last_seen, created_at FROM hive_users ORDER BY id DESC').all();
    res.json({
        workersOnline: hive.onlineCount(),
        users: users.map(u => ({
            key: u.key.slice(0, 9) + '…' + u.key.slice(-4),
            label: u.label, requests: u.request_count,
            workerOnline: hive.workerOnline(u.key),
            lastSeen: u.last_seen, createdAt: u.created_at,
        })),
    });
});

app.post('/admin/reload', adminAuth, (req, res) => {
    try { loadActiveAccount(); res.json({ message: 'Reloaded', sig: grok.getSigState() }); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/admin/status', adminAuth, (req, res) => {
    res.json({
        hasAccount: grok.hasAccount,
        activeAccountId,
        sig: grok.getSigState(),
        worker: relay.workerState(),
        refreshTokenHint: REFRESH_TOKEN.slice(0, 4) + '…' + REFRESH_TOKEN.slice(-4),
    });
});

// API keys
app.get('/admin/keys', adminAuth, (req, res) => res.json(getDB().prepare('SELECT * FROM api_keys').all()));
app.post('/admin/keys', adminAuth, (req, res) => {
    const key = 'sk-grok-' + crypto.randomBytes(24).toString('hex');
    const r = getDB().prepare('INSERT INTO api_keys (name, key) VALUES (?, ?)').run(req.body.name || '', key);
    res.json({ message: 'Key created', id: r.lastInsertRowid, key });
});
app.delete('/admin/keys/:id', adminAuth, (req, res) => { getDB().prepare('DELETE FROM api_keys WHERE id = ?').run(req.params.id); res.json({ message: 'Deleted' }); });
app.patch('/admin/keys/:id', adminAuth, (req, res) => {
    if (req.body.active !== undefined) getDB().prepare('UPDATE api_keys SET active = ? WHERE id = ?').run(req.body.active ? 1 : 0, req.params.id);
    res.json({ message: 'Updated' });
});

app.get('/admin/models', adminAuth, (req, res) => res.json(getDB().prepare('SELECT * FROM models').all()));

// ── Serve the refresher userscript, templated with this Space's origin + token. ──
app.get('/grok-refresher.user.js', (req, res) => {
    const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0];
    const origin = `${proto}://${req.headers.host}`;
    // text/plain (NOT application/javascript): Chromium-based browsers force-download
    // a JS content-type; as text/plain the browser renders inline and Tampermonkey's
    // *.user.js interceptor catches it and offers to install.
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send(buildRefresherUserscript({ proxyOrigin: origin, refreshToken: REFRESH_TOKEN }));
});

// ══════════════════════════════════════════
//  Hive: self-service multi-user keys
// ══════════════════════════════════════════
// The userscript calls this once on first load (no auth) to mint a persistent
// key it then stores forever in GM_setValue. The key is BOTH the user's API key
// and their worker id. Re-registering is harmless (a returning user reuses its
// stored key and never calls this again).
app.post('/register', (req, res) => {
    if (!HIVE_MODE) return res.status(403).json({ error: 'hive mode is off' });
    const key = 'grok_' + crypto.randomBytes(20).toString('hex');
    const label = (req.body?.label || '').toString().slice(0, 40);
    getDB().prepare('INSERT INTO hive_users (key, label, last_seen) VALUES (?, ?, CURRENT_TIMESTAMP)').run(key, label);
    console.log(`[Hive] registered new user key=${key.slice(0, 9)}… label=${label || '(none)'}`);
    res.json({ key, message: 'Save this key — it is your API key. Keep this grok.com tab open to serve your own requests.' });
});

// Validate a hive key (worker-auth for the key-scoped relay endpoints + API auth).
function lookupHiveKey(key) {
    if (!key || !key.startsWith('grok_')) return null;
    return getDB().prepare('SELECT * FROM hive_users WHERE key = ? AND active = 1').get(key);
}

// Dead-simple public onboarding page. Three steps, no jargon.
app.get('/connect', (req, res) => {
    const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0];
    const origin = `${proto}://${req.headers.host}`;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!doctype html><html><head><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1">
<title>Connect to Grok2API</title>
<style>
 body{margin:0;background:#0c0e12;color:#e8eaed;font:16px/1.6 system-ui,sans-serif}
 .wrap{max-width:620px;margin:0 auto;padding:28px 20px 60px}
 h1{font-size:22px;margin:0 0 4px} .sub{color:#9aa0a6;margin:0 0 24px}
 .step{background:#15181d;border:1px solid #2a2f37;border-radius:12px;padding:16px 18px;margin:14px 0}
 .n{display:inline-block;width:24px;height:24px;border-radius:50%;background:#2fbf71;color:#06210f;font-weight:800;text-align:center;line-height:24px;margin-right:8px}
 a.btn{display:inline-block;margin-top:8px;background:#2fbf71;color:#06210f;font-weight:700;text-decoration:none;padding:9px 16px;border-radius:8px}
 code{background:#0c0e12;padding:2px 6px;border-radius:5px;font-size:13px}
 .muted{color:#9aa0a6;font-size:14px}
</style></head><body><div class=wrap>
<h1>Grok2API — connect your grok</h1>
<p class=sub>Use your own grok.com account as an OpenAI-compatible API. No cookies, no setup.</p>
<div class=step><span class=n>1</span><b>Install a userscript manager</b><br>
<span class=muted>Tampermonkey (Chrome/Edge/Kiwi/Quetta) or Violentmonkey (Firefox). One-time.</span></div>
<div class=step><span class=n>2</span><b>Install the worker script</b><br>
<a class=btn href="${origin}/grok-refresher.user.js">Install Grok2API worker</a>
<div class=muted style="margin-top:8px">Your manager will pop up — click Install.</div></div>
<div class=step><span class=n>3</span><b>Open grok.com (logged in) and copy your key</b><br>
<a class=btn href="https://grok.com/" target=_blank rel=noopener>Open grok.com</a>
<div class=muted style="margin-top:8px">A green box shows <b>Your Grok2API key</b> — tap <b>Copy key</b>.
Keep this tab open; it serves your own requests.</div></div>
<div class=step><span class=n>✓</span><b>Use it</b><br>
<span class=muted>Base URL <code>${origin}/v1</code> · API key = the <code>grok_…</code> from step 3 · model <code>grok-fast</code>.
If your tab is closed, the shared pool covers you when someone else is online.</span></div>
</div></body></html>`);
});

// ══════════════════════════════════════════
//  OpenAI-compatible routes
// ══════════════════════════════════════════
app.get('/v1/models', apiKeyAuth, (req, res) => {
    const rows = getDB().prepare('SELECT * FROM models WHERE active = 1').all();
    res.json({ object: 'list', data: rows.map(r => ({ id: r.model_id, object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'xai' })) });
});

// Worker-egress chat: hand the prompt to a worker tab (hive: the user's own /
// pool; relay: the legacy single account), drain the NDJSON it streams back, and
// parse it through the SAME feedGrokLine as the direct path so the OpenAI
// translation is identical. `hub` is the hive or relay hub (same job contract).
// Returns { content, conversationId, responseId }; throws on upstream error.
async function runWorkerChat({ hub, ownerKey, prompt, modeId, onToken, onThink }) {
    const job = hub === hive
        ? hive.submit({ ownerKey, prompt, modeId })
        : relay.submit({ prompt, modeId });
    const st = makeStreamState({ onToken, onThink });
    try {
        let cursor = 0;
        while (true) {
            const { lines, done } = await hub.waitForLines(job, cursor);
            cursor += lines.length;
            for (const ln of lines) if (ln && ln.trim()) feedGrokLine(st, ln);
            if (st.error) throw new Error('Grok: ' + st.error);
            if (done) break;
        }
        // Worker-reported failure (network / non-2xx from grok in the tab).
        if (job.status === 'error') {
            const hint = job.httpStatus === 403
                ? ' (grok 403 in the worker tab — sig/clearance issue on that tab itself)'
                : (job.httpStatus ? ` (grok HTTP ${job.httpStatus})` : '');
            throw new Error((job.error || 'relay error') + hint);
        }
        return { content: st.content, conversationId: st.conversationId, responseId: st.lastResponseId };
    } finally {
        hub.drop(job.id);
    }
}

app.post('/v1/chat/completions', apiKeyAuth, async (req, res) => {
    try {
        const messages = req.body.messages;
        const model = req.body.model || 'grok-auto';
        const stream = req.body.stream;
        const includeReasoning = req.body.include_reasoning === true || /think|reason/i.test(model);

        if (!Array.isArray(messages) || messages.length === 0)
            return res.status(400).json({ error: { message: 'messages array required', type: 'invalid_request' } });
        if (!messages.some(m => m.role === 'user'))
            return res.status(400).json({ error: { message: 'At least one user message required', type: 'invalid_request' } });

        const prompt = messagesToPrompt(messages);
        // Stateless: the whole conversation is re-dumped each turn, so the prompt
        // grows with history. Guard against a runaway prompt that grok would 413
        // or that would choke the composer textarea — fail with a clear message.
        const MAX_PROMPT_CHARS = 240000;
        if (prompt.length > MAX_PROMPT_CHARS) {
            console.log(`[Chat] REJECTED — prompt ${prompt.length} chars > ${MAX_PROMPT_CHARS} cap`);
            return res.status(400).json({ error: { message: `Conversation too long (${prompt.length} chars > ${MAX_PROMPT_CHARS}). Trim earlier messages.`, type: 'invalid_request' } });
        }
        const modeId = resolveMode(model);
        const completionId = generateId();

        // ── Egress selection ────────────────────────────────────────────────
        //  1. HIVE: if the request used a grok_ key, route to the hive — the
        //     user's OWN worker tab if online, else the shared worker pool. The
        //     grok call leaves from a real residential grok tab (the only path
        //     that survives grok's IP-bound Cloudflare clearance).
        //  2. RELAY: legacy single-account phone worker.
        //  3. DIRECT: datacenter forwarder (needs a fresh relayed sig); last resort.
        const useHive = HIVE_MODE && !!req.hiveKey &&
            (hive.workerOnline(req.hiveKey) || hive.anyWorkerOnline());
        const useRelay = !useHive && RELAY_MODE && relay.workerOnline;

        if (useHive) {
            // nothing to pre-check: hive.submit picks own-worker→pool, and the
            // sweep fast-fails with a clear message if truly no worker is online.
        } else if (req.hiveKey) {
            // A hive key but no worker anywhere to serve it.
            console.log(`[Chat] BLOCKED 503 (hive) — key=${req.hiveKey.slice(0, 9)}… no worker online (own or pool)`);
            return res.status(503).json({ error: { message: 'No grok worker online. Open your grok.com tab with the userscript installed (and keep it foregrounded).', type: 'server_error' } });
        } else if (!useRelay) {
            // Direct path: needs a loaded account + a fresh relayed sig.
            if (!grok.hasAccount) {
                try { loadActiveAccount(); } catch {}
                if (!grok.hasAccount) return res.status(503).json({ error: { message: 'No Grok account loaded, and no phone relay worker online. Add an account or open a grok.com tab with the userscript.', type: 'server_error' } });
            }
            const sigState = grok.getSigState();
            if (!sigState.hasSig || sigState.stale) {
                console.log(`[Chat] BLOCKED 503 (direct path) — hasSig=${sigState.hasSig} stale=${sigState.stale} age=${sigState.ageSeconds}s. No phone worker online; need a fresh sig.`);
                return res.status(503).json({ error: {
                    message: sigState.hasSig
                        ? `x-statsig-id is stale (${sigState.ageSeconds}s old) and no phone relay worker is online. Open a grok.com tab with the userscript.`
                        : 'No x-statsig-id, and no phone relay worker online. Open a grok.com tab with the userscript (see admin panel).',
                    type: 'server_error',
                } });
            }
        }

        const via = useHive ? `hive(${req.hiveKey.slice(0, 9)}…${hive.workerOnline(req.hiveKey) ? ',own' : ',pool'})` : useRelay ? 'relay(phone)' : 'direct';
        console.log(`[Chat] via=${via} msgs=${messages.length} model=${model} mode=${modeId} promptChars=${prompt.length}`);

        // Picks the right egress and pumps tokens through onThink/onToken.
        // Throws on upstream error (same contract as grok.chat).
        async function runChat(handlers) {
            if (useHive) return await runWorkerChat({ hub: hive, ownerKey: req.hiveKey, prompt, modeId, ...handlers });
            if (useRelay) return await runWorkerChat({ hub: relay, ownerKey: null, prompt, modeId, ...handlers });
            return await grok.chat({ prompt, modeId, ...handlers });
        }

        if (stream) {
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            res.setHeader('X-Accel-Buffering', 'no');
            res.write(buildOpenAIChunk(completionId, model, { role: 'assistant', content: '' }, null, null));

            let thinkOpen = false;
            try {
                await runChat({
                    onThink: (t) => {
                        if (!includeReasoning) return;
                        if (!thinkOpen) { res.write(buildOpenAIChunk(completionId, model, { content: '<think>\n' }, null, null)); thinkOpen = true; }
                        res.write(buildOpenAIChunk(completionId, model, { content: t }, null, null));
                    },
                    onToken: (t) => {
                        if (thinkOpen) { res.write(buildOpenAIChunk(completionId, model, { content: '\n</think>\n\n' }, null, null)); thinkOpen = false; }
                        res.write(buildOpenAIChunk(completionId, model, { content: t }, null, null));
                    },
                });
            } catch (e) {
                res.write(buildOpenAIChunk(completionId, model, { content: `\n\n⚠️ **[PROXY ERROR]** ${e.message}` }, null, null));
            }
            res.write(buildOpenAIChunk(completionId, model, {}, 'stop', null));
            res.write('data: [DONE]\n\n');
            res.end();
        } else {
            try {
                const out = await runChat({});
                res.json(buildOpenAIResponse(completionId, model, out.content));
            } catch (e) {
                res.status(502).json({ error: { message: e.message, type: 'upstream_error' } });
            }
        }
    } catch (err) {
        console.error('[/v1/chat/completions]', err);
        if (!res.headersSent) res.status(502).json({ error: { message: 'Upstream error: ' + err.message, type: 'upstream_error' } });
        else res.end();
    }
});

// Admin page
app.get('/', (req, res) => { res.setHeader('Content-Type', 'text/html'); res.send(buildAdminPage()); });

// ══════════════════════════════════════════
//  Boot
// ══════════════════════════════════════════
async function boot() {
    await initDB();
    console.log('[Boot] Database ready');
    app.listen(PORT, '0.0.0.0', () => {
        console.log('');
        console.log('  ╔══════════════════════════════════════╗');
        console.log('  ║      Grok2API Reverse Proxy (v2)     ║');
        console.log('  ╠══════════════════════════════════════╣');
        console.log('  ║  Admin : http://localhost:' + PORT + '         ║');
        console.log('  ║  API   : http://localhost:' + PORT + '/v1      ║');
        console.log('  ╚══════════════════════════════════════╝');
        console.log('');
        try { loadActiveAccount(); } catch (e) { console.error('[Boot] account load:', e.message); }
    });

    // Heartbeat: print live state once a minute so the HF log shows, at a glance,
    // whether the phone worker is connected and whether the sig is fresh — without
    // having to make a request. Only logs when something is worth noting.
    let _lastBeat = '';
    setInterval(() => {
        const s = grok.getSigState();
        const w = relay.workerState();
        const beat = `worker=${w.online ? 'ONLINE' : 'offline'}(${w.lastSeenSeconds == null ? 'never' : w.lastSeenSeconds + 's'}) sig=${s.hasSig ? (s.stale ? `stale(${s.ageSeconds}s)` : `fresh(${s.ageSeconds}s)`) : 'NONE'} account=${grok.hasAccount ? 'loaded' : 'none'}`;
        if (beat !== _lastBeat) { console.log(`[Heartbeat] ${beat}`); _lastBeat = beat; }
    }, 60 * 1000).unref?.();
}

boot().catch(e => { console.error('[FATAL]', e); process.exit(1); });

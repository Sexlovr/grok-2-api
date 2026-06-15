import express from 'express';
import cors from 'cors';
import { config } from 'dotenv';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { getDB, initDB } from './lib/database.js';
import { parseGrokCurl } from './lib/curlParser.js';
import { getGrokClient } from './lib/grokClient.js';
import {
    messagesToPrompt, generateId, hashApiKey,
    buildOpenAIChunk, buildOpenAIResponse,
} from './lib/translator.js';
import { buildAdminPage } from './lib/page.js';
import { buildRefresherUserscript } from './lib/refresher.js';

config();

// Last-resort safety net: a stray async error must NEVER crash-loop the Space.
// Log and keep serving.
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e?.message || e));
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e?.message || e));

const app = express();
app.use(cors());
app.use(express.json({ limit: '25mb' }));

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');

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

const grok = getGrokClient();
let activeAccountId = null;

// ══════════════════════════════════════════
//  Helpers
// ══════════════════════════════════════════
function resolveMode(modelStr) {
    const row = getDB().prepare('SELECT mode_id FROM models WHERE model_id = ? AND active = 1').get(modelStr || '');
    if (row?.mode_id) return row.mode_id;
    // Heuristic fallback from the model string → current grok.com modeIds.
    const m = (modelStr || '').toLowerCase();
    if (m.includes('think') || m.includes('reason')) return 'MODEL_MODE_GROK_4_1_THINKING';
    if (m.includes('heavy')) return 'MODEL_MODE_HEAVY';
    if (m.includes('fast') || m.includes('flash') || m.includes('instant')) return 'MODEL_MODE_FAST';
    if (m.includes('expert')) return 'MODEL_MODE_EXPERT';
    if (m.includes('4.3') || m.includes('43')) return 'MODEL_MODE_GROK43';
    if (m.includes('4.1') || m.includes('41')) return 'MODEL_MODE_GROK_4_1';
    return 'MODEL_MODE_AUTO';
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
    if (parsed.error) return res.status(400).json({ error: parsed.error });

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
    if (tok !== REFRESH_TOKEN) return res.status(401).json({ error: 'bad refresh token' });
    const ok = grok.setSig(req.body?.sig);
    if (!ok) return res.status(400).json({ error: 'invalid sig' });
    res.json({ ok: true, sig: grok.getSigState() });
});

// Admin-facing freshness readout for the dashboard widget.
app.get('/admin/sig-status', adminAuth, (req, res) => {
    res.json({ ...grok.getSigState(), hasAccount: grok.hasAccount, activeAccountId });
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
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.send(buildRefresherUserscript({ proxyOrigin: origin, refreshToken: REFRESH_TOKEN }));
});

// ══════════════════════════════════════════
//  OpenAI-compatible routes
// ══════════════════════════════════════════
app.get('/v1/models', apiKeyAuth, (req, res) => {
    const rows = getDB().prepare('SELECT * FROM models WHERE active = 1').all();
    res.json({ object: 'list', data: rows.map(r => ({ id: r.model_id, object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'xai' })) });
});

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

        if (!grok.hasAccount) {
            try { loadActiveAccount(); } catch {}
            if (!grok.hasAccount) return res.status(503).json({ error: { message: 'No Grok account loaded. Add one in the admin panel.', type: 'server_error' } });
        }

        const sigState = grok.getSigState();
        if (!sigState.hasSig || sigState.stale) {
            return res.status(503).json({ error: {
                message: sigState.hasSig
                    ? `x-statsig-id is stale (${sigState.ageSeconds}s old). Is the refresher userscript running on a grok.com tab?`
                    : 'No x-statsig-id yet. Install the refresher userscript on a grok.com tab (see admin panel).',
                type: 'server_error',
            } });
        }

        const prompt = messagesToPrompt(messages);
        const modeId = resolveMode(model);
        const completionId = generateId();

        console.log(`[Chat] msgs=${messages.length} model=${model} mode=${modeId} sigAge=${sigState.ageSeconds}s promptChars=${prompt.length}`);

        if (stream) {
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            res.setHeader('X-Accel-Buffering', 'no');
            res.write(buildOpenAIChunk(completionId, model, { role: 'assistant', content: '' }, null, null));

            let thinkOpen = false;
            try {
                await grok.chat({
                    prompt, modeId,
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
                const out = await grok.chat({ prompt, modeId });
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
}

boot().catch(e => { console.error('[FATAL]', e); process.exit(1); });

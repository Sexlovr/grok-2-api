import express from 'express';
import cors from 'cors';
import { config } from 'dotenv';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { getDB, initDB } from './lib/database.js';
import { parseGrokCurl } from './lib/curlParser.js';
import { getGrokBrowser } from './lib/grokClient.js';
import {
    messagesToPrompt, generateId, hashApiKey,
    buildOpenAIChunk, buildOpenAIResponse,
} from './lib/translator.js';
import { buildAdminPage } from './lib/page.js';

config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '25mb' }));

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');

const grok = getGrokBrowser();
let activeAccountId = null;

// ══════════════════════════════════════════
//  Helpers
// ══════════════════════════════════════════
function resolveMode(modelStr) {
    const row = getDB().prepare('SELECT mode_id FROM models WHERE model_id = ? AND active = 1').get(modelStr || '');
    if (row?.mode_id) return row.mode_id;
    // Heuristic fallback from the model string.
    const m = (modelStr || '').toLowerCase();
    if (m.includes('reason') || m.includes('think')) return 'MODEL_MODE_REASONING';
    if (m.includes('fast') || m.includes('flash') || m.includes('instant')) return 'fast';
    if (m.includes('grok-4')) return 'MODEL_MODE_GROK_4';
    if (m.includes('expert') || m.includes('grok-3')) return 'MODEL_MODE_EXPERT';
    return 'fast';
}

async function loadActiveAccountIntoBrowser() {
    const acc = getDB().prepare('SELECT * FROM accounts WHERE active = 1 ORDER BY last_used DESC, id DESC').get();
    if (!acc) { console.log('[Boot] No active Grok account yet — add one in the admin panel.'); return; }
    activeAccountId = acc.id;
    await grok.loadAccount({ cookie: acc.cookie, userAgent: acc.user_agent });
    getDB().prepare("UPDATE accounts SET last_used = datetime('now') WHERE id = ?").run(acc.id);
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

app.post('/admin/accounts', adminAuth, async (req, res) => {
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

    // Hot-load the new session into the browser.
    try {
        activeAccountId = id;
        await grok.loadAccount({ cookie: parsed.cookie, userAgent: parsed.userAgent });
        res.json({ message: 'Account saved and session loaded', id, found: parsed.summary, signer: grok.signerInfo });
    } catch (e) {
        res.status(200).json({ message: 'Account saved, but session load failed: ' + e.message, id, found: parsed.summary });
    }
});

app.delete('/admin/accounts/:id', adminAuth, (req, res) => {
    getDB().prepare('DELETE FROM accounts WHERE id = ?').run(req.params.id);
    res.json({ message: 'Deleted' });
});

app.patch('/admin/accounts/:id', adminAuth, (req, res) => {
    if (req.body.active !== undefined)
        getDB().prepare('UPDATE accounts SET active = ? WHERE id = ?').run(req.body.active ? 1 : 0, req.params.id);
    res.json({ message: 'Updated' });
});

// Reload the active account / re-discover the signer (e.g. after a Grok deploy).
app.post('/admin/reload', adminAuth, async (req, res) => {
    try { await loadActiveAccountIntoBrowser(); res.json({ message: 'Reloaded', signer: grok.signerInfo }); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/admin/status', adminAuth, (req, res) => {
    res.json({
        browserUp: !!grok.browser,
        sessionLoaded: !!grok.page,
        activeAccountId,
        signer: grok.signerInfo,
        headless: grok.headless,
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
        const model = req.body.model || 'grok-3';
        const stream = req.body.stream;
        const includeReasoning = req.body.include_reasoning === true || /think|reason/i.test(model);

        if (!Array.isArray(messages) || messages.length === 0)
            return res.status(400).json({ error: { message: 'messages array required', type: 'invalid_request' } });
        if (!messages.some(m => m.role === 'user'))
            return res.status(400).json({ error: { message: 'At least one user message required', type: 'invalid_request' } });

        if (!grok.page) {
            try { await loadActiveAccountIntoBrowser(); } catch {}
            if (!grok.page) return res.status(503).json({ error: { message: 'No Grok session loaded. Add an account in the admin panel.', type: 'server_error' } });
        }

        const prompt = messagesToPrompt(messages);
        const modeId = resolveMode(model);
        const completionId = generateId();

        console.log(`[Chat] msgs=${messages.length} model=${model} mode=${modeId} promptChars=${prompt.length}`);

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
    try { await loadActiveAccountIntoBrowser(); } catch (e) { console.error('[Boot] account load:', e.message); }

    app.listen(PORT, '0.0.0.0', () => {
        console.log('');
        console.log('  ╔══════════════════════════════════════╗');
        console.log('  ║         Grok2API Reverse Proxy       ║');
        console.log('  ╠══════════════════════════════════════╣');
        console.log('  ║  Admin : http://localhost:' + PORT + '         ║');
        console.log('  ║  API   : http://localhost:' + PORT + '/v1      ║');
        console.log('  ╚══════════════════════════════════════╝');
        console.log('');
    });
}

boot().catch(e => { console.error('[FATAL]', e); process.exit(1); });

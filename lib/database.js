import path from 'path';
import fs from 'fs';
import initSqlJs from 'sql.js';

// Prefer DATA_DIR (on HF, point this at the persistent volume mount /data so the
// accounts/keys/sig survive factory rebuilds). If it isn't writable — e.g. HF
// persistent storage is disabled — fall back to ./data with a loud warning
// rather than crashing the boot.
function resolveDataDir() {
    const want = (process.env.DATA_DIR || path.join(process.cwd(), 'data')).trim();
    try {
        fs.mkdirSync(want, { recursive: true });
        fs.accessSync(want, fs.constants.W_OK);
        return want;
    } catch (e) {
        const fallback = path.join(process.cwd(), 'data');
        console.warn(`[DB] DATA_DIR "${want}" not writable (${e.code || e.message}); falling back to ${fallback}. ` +
            `Data will NOT persist across rebuilds — enable persistent storage and set DATA_DIR=/data.`);
        fs.mkdirSync(fallback, { recursive: true });
        return fallback;
    }
}

const dataDir = resolveDataDir();

const dbPath = path.join(dataDir, 'grok.db');

let db = null;
let SQL = null;

export async function initDB() {
    SQL = await initSqlJs();
    if (fs.existsSync(dbPath)) {
        db = new SQL.Database(fs.readFileSync(dbPath));
    } else {
        db = new SQL.Database();
    }

    db.run(`
        CREATE TABLE IF NOT EXISTS accounts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            label TEXT DEFAULT '',
            cookie TEXT NOT NULL,
            user_agent TEXT DEFAULT '',
            user_id TEXT DEFAULT '',
            active INTEGER DEFAULT 1,
            request_count INTEGER DEFAULT 0,
            last_used DATETIME DEFAULT CURRENT_TIMESTAMP,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS api_keys (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT DEFAULT '',
            key TEXT NOT NULL UNIQUE,
            active INTEGER DEFAULT 1,
            request_count INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS models (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            model_id TEXT NOT NULL UNIQUE,
            display_name TEXT,
            mode_id TEXT DEFAULT 'fast',
            active INTEGER DEFAULT 1
        );
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT
        );
    `);

    // Seed/refresh the Grok model catalogue. Bump MODEL_VERSION to force a
    // wipe+reseed (e.g. when grok.com renames its modeIds, as it did from the
    // grok-4/grok-3 era to grok-4.x/4.3). The version lives in `settings`.
    const MODEL_VERSION = 2;
    const models = [
        // openai-facing id, display, grok modeId (current grok.com catalogue)
        ['grok-4.3', 'Grok 4.3', 'MODEL_MODE_GROK43'],
        ['grok-4.1', 'Grok 4.1', 'MODEL_MODE_GROK_4_1'],
        ['grok-4.1-thinking', 'Grok 4.1 (Thinking)', 'MODEL_MODE_GROK_4_1_THINKING'],
        ['grok-auto', 'Grok (Auto)', 'MODEL_MODE_AUTO'],
        ['grok-heavy', 'Grok Heavy', 'MODEL_MODE_HEAVY'],
        ['grok-fast', 'Grok Fast', 'MODEL_MODE_FAST'],
        ['grok-expert', 'Grok Expert', 'MODEL_MODE_EXPERT'],
    ];
    const verRow = db.exec("SELECT value FROM settings WHERE key='model_version'");
    const curVer = verRow.length && verRow[0].values.length ? parseInt(verRow[0].values[0][0], 10) : 0;
    const check = db.exec("SELECT COUNT(*) c FROM models");
    const count = check.length ? check[0].values[0][0] : 0;
    if (count === 0 || curVer !== MODEL_VERSION) {
        db.run('DELETE FROM models');
        for (const [mid, name, mode] of models) {
            db.run('INSERT INTO models (model_id, display_name, mode_id) VALUES (?, ?, ?)', [mid, name, mode]);
        }
        db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('model_version', ?)", [String(MODEL_VERSION)]);
        console.log(`[DB] Model catalogue seeded/upgraded to v${MODEL_VERSION} (${models.length} models)`);
    }

    saveDB();
    console.log('[DB] SQLite initialized at', dbPath);
}

function saveDB() {
    if (!db) return;
    fs.writeFileSync(dbPath, Buffer.from(db.export()));
}

setInterval(() => { try { saveDB(); } catch {} }, 30000);

// ── better-sqlite3-like wrapper over sql.js ──
function runStmt(sql, params) {
    db.run(sql, params);
    saveDB();
    const r = db.exec("SELECT last_insert_rowid() id");
    const lastId = r.length ? r[0].values[0][0] : 0;
    const c = db.exec("SELECT changes() c");
    const changes = c.length ? c[0].values[0][0] : 0;
    return { lastInsertRowid: lastId, changes };
}

function getStmt(sql, params) {
    const stmt = db.prepare(sql);
    if (params) stmt.bind(params);
    let row = null;
    if (stmt.step()) row = stmt.getAsObject();
    stmt.free();
    return row;
}

function allStmt(sql, params) {
    const rows = [];
    const stmt = db.prepare(sql);
    if (params) stmt.bind(params);
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
}

export function getDB() {
    return {
        prepare: (sql) => ({
            run: (...a) => runStmt(sql, a.length ? a : undefined),
            get: (...a) => getStmt(sql, a.length ? a : undefined),
            all: (...a) => allStmt(sql, a.length ? a : undefined),
        }),
        exec: (sql) => db.run(sql),
    };
}

export default { getDB, initDB };

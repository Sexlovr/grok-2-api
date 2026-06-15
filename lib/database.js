import path from 'path';
import fs from 'fs';
import initSqlJs from 'sql.js';

const dataDir = (process.env.DATA_DIR || path.join(process.cwd(), 'data')).trim();
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

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
    `);

    // Seed the Grok model catalogue. Bump MODEL_VERSION to re-seed.
    const MODEL_VERSION = 1;
    const check = db.exec("SELECT COUNT(*) c FROM models");
    const count = check.length ? check[0].values[0][0] : 0;
    if (count === 0) {
        const models = [
            // openai-facing id, display, grok modeId
            ['grok-4', 'Grok 4', 'MODEL_MODE_GROK_4'],
            ['grok-4-fast', 'Grok 4 Fast', 'fast'],
            ['grok-3', 'Grok 3', 'MODEL_MODE_EXPERT'],
            ['grok-3-fast', 'Grok 3 Fast', 'fast'],
            ['grok-3-reasoning', 'Grok 3 (Reasoning)', 'MODEL_MODE_REASONING'],
        ];
        for (const [mid, name, mode] of models) {
            db.run('INSERT INTO models (model_id, display_name, mode_id) VALUES (?, ?, ?)', [mid, name, mode]);
        }
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

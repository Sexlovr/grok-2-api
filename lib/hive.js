// ══════════════════════════════════════════════════════════════════════════
//  Hive — multi-user "your own grok tab is the egress" job hub.
//
//  Generalises the single-account RelayHub to MANY users. Each user installs
//  the userscript in their OWN logged-in grok.com tab; that tab auto-registers
//  and gets a persistent key `grok_<hex>` which is BOTH:
//    • their OpenAI API key (Authorization: Bearer grok_…), and
//    • the id their own worker tab serves.
//
//  ROUTING (per the product decision "their own stuff, else server-side"):
//    1. A chat for key K is offered to K's OWN worker first (their tab, their
//       account, their model access — e.g. a paid user gets expert/heavy).
//    2. If K has no worker online, the job falls back to the SHARED POOL — any
//       other online worker tab (incl. the legacy single-account relay worker)
//       can take it, so a user whose tab is closed still gets answers.
//
//  Pure in-memory, single process. Keys persist in SQLite (see database.js
//  hive_users); worker presence + jobs are ephemeral, like an HTTP request.
//
//  The job lifecycle + NDJSON line buffering is identical to RelayHub, so the
//  index.js consumer (waitForLines + feedGrokLine) is reused unchanged.
// ══════════════════════════════════════════════════════════════════════════

import crypto from 'crypto';

const JOB_TTL_MS = 4 * 60 * 1000;       // a job that never completes is reaped
const PICKUP_TIMEOUT_MS = 20 * 1000;    // queued-but-never-taken (no worker) → fail fast
const WORKER_FRESH_MS = 60 * 1000;      // a worker seen within this window is "online".
                                        // Must exceed the userscript's 45s stream-stall
                                        // abort + slack so a busy/near-stalled worker
                                        // isn't declared offline mid-job.
const POLL_HOLD_MS = 25 * 1000;         // how long a worker's /poll holds open with no work

export class Hive {
    constructor() {
        this.jobs = new Map();          // jobId -> job
        this.workers = new Map();       // key -> { lastSeen, pollWaiters: [] }
        this.pending = new Map();       // key -> [jobId, …]  (jobs targeted at that key)
        this.pool = [];                 // [jobId, …]  fallback jobs any worker may take
    }

    // ── Worker presence (per key) ──────────────────────────────────────────
    _worker(key) {
        let w = this.workers.get(key);
        if (!w) { w = { lastSeen: 0, pollWaiters: [] }; this.workers.set(key, w); }
        return w;
    }
    markWorker(key) {
        const w = this._worker(key);
        const wasOnline = Date.now() - w.lastSeen < WORKER_FRESH_MS;
        w.lastSeen = Date.now();
        if (!wasOnline) console.log(`[Hive] worker CONNECTED key=${shortKey(key)} — ${this.onlineCount()} online`);
    }
    workerOnline(key) {
        const w = this.workers.get(key);
        return !!w && Date.now() - w.lastSeen < WORKER_FRESH_MS;
    }
    onlineCount() {
        let n = 0;
        for (const w of this.workers.values()) if (Date.now() - w.lastSeen < WORKER_FRESH_MS) n++;
        return n;
    }
    // Any worker online at all (for the pool-fallback decision).
    anyWorkerOnline() { return this.onlineCount() > 0; }

    workerState(key) {
        const w = this.workers.get(key);
        const ageMs = w && w.lastSeen ? Date.now() - w.lastSeen : null;
        return {
            online: this.workerOnline(key),
            lastSeenSeconds: ageMs == null ? null : Math.round(ageMs / 1000),
            onlineWorkers: this.onlineCount(),
        };
    }

    // ── Client side: submit a job for a given key ───────────────────────────
    //  ownerKey  = the API key the request authenticated as (its own worker is
    //              preferred). May be null for the legacy global path.
    submit({ ownerKey, prompt, modeId, deviceEnvInfo }) {
        const id = 'job-' + crypto.randomBytes(10).toString('hex');
        const job = {
            id, ownerKey: ownerKey || null, prompt, modeId, deviceEnvInfo,
            createdAt: Date.now(),
            takenAt: null,
            takenBy: null,             // which worker key actually ran it
            status: 'queued',          // queued -> running -> done | error
            lines: [],
            error: null,
            httpStatus: null,
            waiters: [],
        };
        this.jobs.set(id, job);

        // Prefer the owner's own worker if it's online; else drop into the pool.
        if (ownerKey && this.workerOnline(ownerKey)) {
            this._queueFor(ownerKey).push(id);
            this._wakeOnePoller(ownerKey);
        } else {
            this.pool.push(id);
            this._wakeAnyPoller();
        }
        return job;
    }

    _queueFor(key) {
        let q = this.pending.get(key);
        if (!q) { q = []; this.pending.set(key, q); }
        return q;
    }

    get(id) { return this.jobs.get(id); }
    drop(id) { this.jobs.delete(id); }

    // Async iterator over a job's NDJSON lines (identical contract to RelayHub).
    async waitForLines(job, cursor) {
        if (job.lines.length > cursor) return { lines: job.lines.slice(cursor), done: job.status === 'done' || job.status === 'error' };
        if (job.status === 'done' || job.status === 'error') return { lines: [], done: true };
        await new Promise((resolve) => {
            const w = { resolve };
            job.waiters.push(w);
            setTimeout(() => {
                const i = job.waiters.indexOf(w);
                if (i >= 0) job.waiters.splice(i, 1);
                resolve();
            }, 1500);
        });
        return { lines: job.lines.slice(cursor), done: job.status === 'done' || job.status === 'error' };
    }

    // ── Worker side: long-poll for the next job for THIS worker's key ───────
    //  A worker takes (a) jobs addressed to its own key first, then (b) any pool
    //  job (serving someone whose own tab is offline).
    async poll(key) {
        this.markWorker(key);
        const next = this._takeFor(key);
        if (next) return next;
        return await new Promise((resolve) => {
            const w = this._worker(key);
            const waiter = { resolve };
            w.pollWaiters.push(waiter);
            setTimeout(() => {
                const i = w.pollWaiters.indexOf(waiter);
                if (i >= 0) w.pollWaiters.splice(i, 1);
                resolve(null);
            }, POLL_HOLD_MS);
        });
    }

    // Pop the next runnable job for this worker: own queue first, then pool.
    _takeFor(key) {
        const own = this.pending.get(key) || [];
        while (own.length) {
            const job = this.jobs.get(own.shift());
            if (job && job.status === 'queued') return this._activate(job, key);
        }
        while (this.pool.length) {
            const job = this.jobs.get(this.pool.shift());
            if (job && job.status === 'queued') return this._activate(job, key);
        }
        return null;
    }

    _activate(job, workerKey) {
        job.status = 'running';
        job.takenAt = Date.now();
        job.takenBy = workerKey;
        const via = job.ownerKey === workerKey ? 'own' : 'pool';
        console.log(`[Hive] job ${job.id.slice(-6)} TAKEN by ${shortKey(workerKey)} (${via}, waited ${Math.round((job.takenAt - job.createdAt) / 1000)}s)`);
        return { id: job.id, prompt: job.prompt, modeId: job.modeId, deviceEnvInfo: job.deviceEnvInfo };
    }

    // Wake one of THIS key's parked pollers (a new own-job arrived).
    _wakeOnePoller(key) {
        const w = this.workers.get(key);
        if (!w) return;
        const waiter = w.pollWaiters.shift();
        if (!waiter) return;
        const next = this._takeFor(key);
        waiter.resolve(next);   // may be null if the job was already taken; worker re-polls
    }

    // Wake ANY online worker (a pool job arrived). Round-robin over online keys.
    _wakeAnyPoller() {
        for (const [key, w] of this.workers) {
            if (Date.now() - w.lastSeen >= WORKER_FRESH_MS) continue;
            if (!w.pollWaiters.length) continue;
            const waiter = w.pollWaiters.shift();
            const next = this._takeFor(key);
            waiter.resolve(next);
            if (next) return;     // delivered; stop. else keep trying other workers
        }
    }

    // ── Worker side: push NDJSON lines / finish (identical to RelayHub) ──────
    pushChunk(key, id, lines, httpStatus) {
        if (key) this.markWorker(key);
        const job = this.jobs.get(id);
        if (!job) return false;
        if (httpStatus != null && httpStatus !== job.httpStatus) {
            job.httpStatus = httpStatus;
            console.log(`[Hive] job ${id.slice(-6)} grok HTTP ${httpStatus}${httpStatus === 403 ? ' — anti-bot/stale-sig' : httpStatus === 200 ? ' — streaming OK' : ''}`);
        }
        if (Array.isArray(lines)) for (const ln of lines) if (ln) job.lines.push(ln);
        this._wakeConsumers(job);
        return true;
    }

    finish(key, id, { error } = {}) {
        if (key) this.markWorker(key);
        const job = this.jobs.get(id);
        if (!job) return false;
        job.status = error ? 'error' : 'done';
        if (error) job.error = error;
        console.log(`[Hive] job ${id.slice(-6)} ${error ? 'ERROR — ' + error : `DONE (${job.lines.length} lines)`}`);
        this._wakeConsumers(job);
        return true;
    }

    _wakeConsumers(job) {
        const waiters = job.waiters.splice(0);
        for (const w of waiters) w.resolve();
    }

    // ── Housekeeping ────────────────────────────────────────────────────────
    sweep() {
        const now = Date.now();
        for (const [id, job] of this.jobs) {
            // Fail fast only when NO worker can serve it: the owner's tab is
            // offline AND the pool is empty. (A busy worker streaming a long
            // reply keeps itself "online" via chunk posts, so its own queued
            // 2nd job is safe.)
            const servable = (job.ownerKey && this.workerOnline(job.ownerKey)) || this.anyWorkerOnline();
            if (job.status === 'queued' && !servable && now - job.createdAt > PICKUP_TIMEOUT_MS) {
                job.status = 'error';
                job.error = 'no grok worker online — open your grok.com tab with the userscript (foreground it; backgrounded mobile tabs freeze).';
                this._wakeConsumers(job);
                continue;
            }
            if (now - job.createdAt > JOB_TTL_MS) {
                if (job.status === 'queued' || job.status === 'running') {
                    job.status = 'error';
                    job.error = job.error || 'hive timeout — worker did not complete the job in time';
                    this._wakeConsumers(job);
                }
                if (now - job.createdAt > JOB_TTL_MS * 2) this.jobs.delete(id);
            }
        }
        // Forget workers gone for a long time (keeps the map from growing).
        for (const [key, w] of this.workers) {
            if (w.lastSeen && now - w.lastSeen > 10 * 60 * 1000 && !w.pollWaiters.length) this.workers.delete(key);
        }
    }
}

function shortKey(k) { return k ? String(k).slice(0, 9) + '…' : '(none)'; }

let _hive = null;
export function getHive() {
    if (!_hive) {
        _hive = new Hive();
        setInterval(() => _hive.sweep(), 5 * 1000).unref?.();
    }
    return _hive;
}

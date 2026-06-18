// ══════════════════════════════════════════════════════════════════════════
//  Relay hub — "phone is the egress" job queue.
//
//  WHY THIS EXISTS:
//  grok.com's Cloudflare `cf_clearance` cookie is IP-bound. A sig relayed to a
//  datacenter (HF) IP still 403s ("anti-bot rules") because the clearance token
//  was minted on the user's phone IP. So the actual grok call must LEAVE FROM
//  the phone. This hub lets the Space orchestrate without ever egressing to grok
//  itself:
//
//    1. an OpenAI client hits /v1/chat/completions on the Space
//    2. the Space enqueues a job here and waits (does NOT call grok)
//    3. the userscript on the phone's grok tab long-polls /relay/poll, takes
//       the job, calls grok /new natively (residential IP + live cf_clearance +
//       freshly-signed sig — all real), and streams the raw NDJSON lines back
//       via /relay/chunk
//    4. this hub buffers those lines; the waiting request drains them and the
//       Space translates them to OpenAI SSE for the client
//
//  Pure in-memory, single process. No persistence — a job lives only for the
//  duration of one request. Survives restarts the same way an HTTP request does:
//  it doesn't, and the client just retries.
// ══════════════════════════════════════════════════════════════════════════

import crypto from 'crypto';

const JOB_TTL_MS = 4 * 60 * 1000;       // a job that never completes is reaped
const PICKUP_TIMEOUT_MS = 20 * 1000;    // queued-but-never-taken (worker frozen) → fail fast
const WORKER_FRESH_MS = 40 * 1000;      // a worker seen within this window is "online"
const POLL_HOLD_MS = 25 * 1000;         // how long /relay/poll holds open with no work

export class RelayHub {
    constructor() {
        this.jobs = new Map();          // id -> job
        this.pending = [];              // ids waiting to be picked up by a worker
        this.pollWaiters = [];          // { resolve } for workers parked on /poll
        this.lastWorkerAt = 0;          // epoch ms of the most recent worker contact
    }

    // ── Worker presence ───────────────────────────────────────────────────
    markWorker() {
        const wasOnline = this.workerOnline;
        this.lastWorkerAt = Date.now();
        if (!wasOnline) console.log('[Relay] phone worker CONNECTED (long-poll seen) — relay path now active');
    }
    get workerOnline() { return Date.now() - this.lastWorkerAt < WORKER_FRESH_MS; }
    workerState() {
        const ageMs = this.lastWorkerAt ? Date.now() - this.lastWorkerAt : null;
        return {
            online: this.workerOnline,
            lastSeenSeconds: ageMs == null ? null : Math.round(ageMs / 1000),
        };
    }

    // ── Client side: submit a job and consume its output ────────────────────
    submit({ prompt, modeId, deviceEnvInfo }) {
        const id = 'job-' + crypto.randomBytes(10).toString('hex');
        const job = {
            id, prompt, modeId, deviceEnvInfo,
            createdAt: Date.now(),
            takenAt: null,             // set when a worker actually picks it up
            status: 'queued',          // queued -> running -> done | error
            lines: [],                 // raw NDJSON lines pushed by the worker
            error: null,
            httpStatus: null,          // upstream grok HTTP status, set by worker
            waiters: [],               // { resolve } parked in consume()
        };
        this.jobs.set(id, job);
        this.pending.push(id);
        this._wakeOnePoller();
        return job;
    }

    get(id) { return this.jobs.get(id); }
    drop(id) { this.jobs.delete(id); }

    // Async iterator over the job's NDJSON lines as they arrive. Resolves done
    // when the worker finishes/errors. Caller passes a cursor it owns.
    async waitForLines(job, cursor) {
        if (job.lines.length > cursor) return { lines: job.lines.slice(cursor), done: job.status === 'done' || job.status === 'error' };
        if (job.status === 'done' || job.status === 'error') return { lines: [], done: true };
        // Park until a chunk arrives, the job finishes, or a short timeout.
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

    // ── Worker side: long-poll for the next job ─────────────────────────────
    async poll() {
        this.markWorker();
        const next = this._takePending();
        if (next) return next;
        // No work right now — hold the connection a bit so the worker isn't
        // hammering us, then return null (worker re-polls).
        return await new Promise((resolve) => {
            const w = { resolve };
            this.pollWaiters.push(w);
            setTimeout(() => {
                const i = this.pollWaiters.indexOf(w);
                if (i >= 0) this.pollWaiters.splice(i, 1);
                resolve(null);
            }, POLL_HOLD_MS);
        });
    }

    _takePending() {
        while (this.pending.length) {
            const id = this.pending.shift();
            const job = this.jobs.get(id);
            if (!job) continue;
            if (job.status !== 'queued') continue;
            job.status = 'running';
            job.takenAt = Date.now();
            console.log(`[Relay] job ${job.id.slice(-6)} TAKEN by worker (waited ${Math.round((job.takenAt - job.createdAt) / 1000)}s in queue)`);
            return { id: job.id, prompt: job.prompt, modeId: job.modeId, deviceEnvInfo: job.deviceEnvInfo };
        }
        return null;
    }

    _wakeOnePoller() {
        const w = this.pollWaiters.shift();
        if (!w) return;
        const next = this._takePending();
        w.resolve(next);
    }

    // ── Worker side: push a batch of raw NDJSON lines for a running job ──────
    pushChunk(id, lines, httpStatus) {
        this.markWorker();
        const job = this.jobs.get(id);
        if (!job) return false;
        if (httpStatus != null && httpStatus !== job.httpStatus) {
            job.httpStatus = httpStatus;
            console.log(`[Relay] job ${id.slice(-6)} grok HTTP ${httpStatus}${httpStatus === 403 ? ' — anti-bot/stale-sig rejection (sig invalid or cf_clearance IP-bound)' : httpStatus === 200 ? ' — streaming OK' : ''}`);
        }
        if (Array.isArray(lines)) for (const ln of lines) if (ln) job.lines.push(ln);
        this._wakeConsumers(job);
        return true;
    }

    // ── Worker side: mark a job finished (or failed) ────────────────────────
    finish(id, { error } = {}) {
        this.markWorker();
        const job = this.jobs.get(id);
        if (!job) return false;
        job.status = error ? 'error' : 'done';
        if (error) job.error = error;
        console.log(`[Relay] job ${id.slice(-6)} ${error ? 'ERROR — ' + error : `DONE (${job.lines.length} lines streamed)`}`);
        this._wakeConsumers(job);
        return true;
    }

    _wakeConsumers(job) {
        const waiters = job.waiters.splice(0);
        for (const w of waiters) w.resolve();
    }

    // ── Housekeeping: reap jobs that never completed ────────────────────────
    sweep() {
        const now = Date.now();
        for (const [id, job] of this.jobs) {
            // Fail fast ONLY when the worker is actually absent. A worker that's
            // ONLINE but busy streaming a long response can't poll for the next
            // job until it's free — those queued jobs must NOT be killed at 20s
            // (they wait for the worker, backed by the 4-min TTL). We only fast-
            // fail when no worker has checked in recently (tab closed/frozen).
            if (job.status === 'queued' && !this.workerOnline && now - job.createdAt > PICKUP_TIMEOUT_MS) {
                job.status = 'error';
                job.error = 'no phone worker is online — open the grok.com tab with the userscript (and bring it to the foreground; backgrounded mobile tabs freeze).';
                this._wakeConsumers(job);
                continue;
            }
            if (now - job.createdAt > JOB_TTL_MS) {
                if (job.status === 'queued' || job.status === 'running') {
                    job.status = 'error';
                    job.error = job.error || 'relay timeout — phone worker did not complete the job in time';
                    this._wakeConsumers(job);
                }
                // give consumers a moment to read the error, then drop next sweep
                if (now - job.createdAt > JOB_TTL_MS * 2) this.jobs.delete(id);
            }
        }
    }
}

let _hub = null;
export function getRelayHub() {
    if (!_hub) {
        _hub = new RelayHub();
        setInterval(() => _hub.sweep(), 5 * 1000).unref?.();
    }
    return _hub;
}

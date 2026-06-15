/**
 * Auto-discover the Grok `x-statsig-id` signer module source from grok.com's
 * static JS bundles (served by the CDN, no auth needed).
 *
 * Grok renames its chunk files and shuffles module ids on every deploy, so we
 * re-trace the reference chain at runtime instead of hardcoding:
 *
 *   homepage  ->  chunk that sets "x-statsig-id"  -> e.A(N1)   (lazy module id)
 *             ->  TURBOPACK map entry for N1       -> static/chunks/<file>.js + t(N2)
 *             ->  signer chunk                      -> module N2 = `W=>{...}` source
 *
 * The returned source is a self-contained arrow function `W=>{...}` that, given a
 * turbopack-style module context `W` with a `.s()` export hook, registers a
 * `default` export whose value is the signer `(pathname, method) => Promise<sid>`.
 * It only runs correctly inside a real browser DOM (it folds an animation/DOM
 * fingerprint into the signature), so we inject it into the Playwright page.
 */

const UA_DEFAULT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36';

function braceMatchArrow(src, arrowStart) {
    // arrowStart points at the start of "W=>{...}"; return the whole arrow fn.
    const open = src.indexOf('{', arrowStart);
    if (open < 0) return null;
    let depth = 0;
    for (let j = open; j < src.length; j++) {
        const c = src[j];
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) return src.slice(arrowStart, j + 1); }
    }
    return null;
}

export async function discoverSignerSource(opts = {}) {
    const ua = opts.userAgent || UA_DEFAULT;
    const cookie = opts.cookie || '';
    const headers = { 'user-agent': ua, accept: 'text/html' };
    if (cookie) headers.cookie = cookie;

    const homeRes = await fetch('https://grok.com/', { headers });
    if (!homeRes.ok) throw new Error(`homepage fetch failed: HTTP ${homeRes.status}`);
    const home = await homeRes.text();

    const chunkUrls = [...new Set(
        [...home.matchAll(/(https:\/\/cdn\.grok\.com\/_next\/static\/chunks\/[^"']+\.js)/g)].map(m => m[1])
    )];
    if (chunkUrls.length === 0) throw new Error('no cdn chunks found on homepage');

    const chunks = {};
    await Promise.all(chunkUrls.map(async (u) => {
        try { chunks[u] = await (await fetch(u, { headers: { 'user-agent': ua } })).text(); } catch {}
    }));

    // 1. chunk that sets "x-statsig-id" -> nearby e.A(N1)
    let N1 = null;
    for (const s of Object.values(chunks)) {
        const i = s.indexOf('x-statsig-id');
        if (i < 0) continue;
        const around = s.slice(Math.max(0, i - 4000), i + 1000);
        const m = around.match(/\.A\((\d{5,})\)/);
        if (m) { N1 = m[1]; break; }
    }
    if (!N1) throw new Error('could not locate signer module id (N1) near x-statsig-id');

    // 2. TURBOPACK map: ,N1,...Promise.all(["static/chunks/X.js"])...(()=>t(N2))
    let chunkFile = null, N2 = null;
    const reEntry = new RegExp(
        ',' + N1 + ',\\w+=>\\{[^}]*?Promise\\.all\\(\\["(static/chunks/[^"]+\\.js)"\\][^}]*?\\(\\)=>\\w+\\((\\d+(?:e\\d+)?)\\)',
        's'
    );
    for (const s of Object.values(chunks)) {
        const m = s.match(reEntry);
        if (m) { chunkFile = m[1]; N2 = m[2]; break; }
    }
    if (!chunkFile) throw new Error(`could not resolve signer chunk for module ${N1}`);

    // 3. download signer chunk, extract module N2 ("1645000" or "1645e3" forms)
    const signerUrl = 'https://cdn.grok.com/_next/' + chunkFile;
    const sChunk = await (await fetch(signerUrl, { headers: { 'user-agent': ua } })).text();
    const forms = [N2];
    if (/^\d+$/.test(N2)) { const n = Number(N2); if (n % 1000 === 0) forms.push((n / 1000) + 'e3'); }

    // The module is "<id>,<param>=>{...}". Grok renames the arrow's parameter
    // between deploys (was `W`, now `n`, …), so we capture whatever the param is
    // instead of hardcoding it, then validate the module exports a `default` via
    // "<param>.s([\"default\", …])". The injection side passes our context object
    // positionally, so the internal name doesn't matter downstream.
    let modSrc = null;
    for (const form of forms) {
        const reMod = new RegExp(
            form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ',([A-Za-z_$][\\w$]*)=>\\{'
        );
        const m = sChunk.match(reMod);
        if (!m) continue;
        const param = m[1];
        const src = braceMatchArrow(sChunk, m.index + form.length + 1);
        if (src && src.includes(param + '.s(["default"')) { modSrc = src; break; }
    }
    if (!modSrc) throw new Error(`could not extract signer module ${N2} from ${chunkFile}`);

    return { moduleId: String(N2), chunkFile, source: modSrc };
}

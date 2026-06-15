/**
 * Parse a Grok (grok.com) cURL copied from the browser ("Copy as cURL").
 * Extracts the cookie jar Grok needs to authenticate the browser session.
 *
 * The session is carried by `sso` / `sso-rw` (JWTs). `cf_clearance` / `__cf_bm`
 * are Cloudflare tokens bound to the original IP+UA — the proxy's own headful
 * browser will regenerate those for its own IP, so they're carried opportunistically
 * but not required.
 */
export function parseGrokCurl(curlString) {
    try {
        const str = (curlString || '').replace(/\\\r?\n/g, ' ').trim();

        // ── Pull the cookie string from -b / --cookie / -H 'cookie: ...' ──
        let cookie = null;
        let m =
            str.match(/(?:-b|--cookie)\s+'([^']*)'/) ||
            str.match(/(?:-b|--cookie)\s+"([^"]*)"/) ||
            str.match(/-H\s+'cookie:\s*([^']*)'/i) ||
            str.match(/-H\s+"cookie:\s*([^"]*)"/i);
        if (m) cookie = m[1].trim();

        // Fallback: maybe the user pasted just the raw cookie header value
        if (!cookie && /(?:^|;\s*)sso=/.test(str)) cookie = str;

        if (!cookie) {
            return { error: "Couldn't find a cookie in the cURL. Copy the request from grok.com as 'Copy as cURL (bash)'." };
        }

        const pick = (name) => {
            const mm = cookie.match(new RegExp('(?:^|;\\s*)' + name.replace(/[-_]/g, '[-_]') + '=([^;]+)'));
            return mm ? mm[1].trim() : null;
        };

        const sso = pick('sso');
        const ssoRw = pick('sso-rw');
        const cfClearance = pick('cf_clearance');
        const cfBm = pick('__cf_bm');
        const deviceId = pick('grok_device_id');
        const userId = pick('x-userid');

        if (!sso && !ssoRw) {
            return { error: "Couldn't find the `sso` session cookie. Make sure you're logged in to grok.com and copied a request that includes cookies." };
        }

        // ── user-agent (so the browser context matches the captured session) ──
        let userAgent = null;
        const ua =
            str.match(/-H\s+'user-agent:\s*([^']*)'/i) ||
            str.match(/-H\s+"user-agent:\s*([^"]*)"/i);
        if (ua) userAgent = ua[1].trim();

        return {
            cookie,
            sso,
            ssoRw,
            cfClearance,
            cfBm,
            deviceId,
            userId: userId || '',
            userAgent: userAgent || '',
            // human-readable summary of what we found
            summary: {
                sso: !!sso,
                'sso-rw': !!ssoRw,
                cf_clearance: !!cfClearance,
                __cf_bm: !!cfBm,
                grok_device_id: !!deviceId,
                'x-userid': userId || null,
            },
        };
    } catch (e) {
        return { error: `Parse error: ${e.message}` };
    }
}

/**
 * Turn a cookie header string ("a=1; b=2") into Playwright addCookies() objects
 * for the grok.com domain.
 */
export function cookieStringToPlaywright(cookieStr, domain = '.grok.com') {
    const out = [];
    for (const part of (cookieStr || '').split(';')) {
        const eq = part.indexOf('=');
        if (eq < 0) continue;
        const name = part.slice(0, eq).trim();
        const value = part.slice(eq + 1).trim();
        if (!name) continue;
        out.push({ name, value, domain, path: '/', secure: true, sameSite: 'Lax' });
    }
    return out;
}

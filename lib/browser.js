import { spawn, execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_DIR = path.resolve(__dirname, '..', 'extension');
const DISPLAY = process.env.GROK_DISPLAY || ':99';
// Mobile-compatible by default: a phone portrait viewport so grok.com renders
// its mobile layout and the recovery console looks right on a phone screen.
// Override with GROK_SCREEN_W / GROK_SCREEN_H (e.g. 1280 / 800 for desktop).
const SCREEN_W = parseInt(process.env.GROK_SCREEN_W, 10) || 412;
const SCREEN_H = parseInt(process.env.GROK_SCREEN_H, 10) || 915;
const SCREEN = `${SCREEN_W}x${SCREEN_H}x24`;

// Resolve a chromium binary across distros.
function findChromium() {
  if (process.env.CHROMIUM_BIN) return process.env.CHROMIUM_BIN;
  for (const p of ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable']) {
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch {}
  }
  return 'chromium';
}

/**
 * Manages an in-Space, human-equivalent browser:
 *  - Xvfb virtual display (light: framebuffer only, no desktop/VNC).
 *  - Plain HEADED Chromium (no --headless, no --remote-debugging, no CDP) so
 *    grok.com sees an ordinary browser and renders the SVG canary → valid sigs.
 *  - Our extension seeds the session cookie + skims sigs to the proxy.
 *  - Screenshot (ffmpeg/scrot) + input (xdotool) for an on-demand recovery
 *    console — used only if Cloudflare throws a visual challenge.
 */
export class BrowserManager {
  constructor() {
    this.xvfb = null;
    this.chrome = null;
    this.profileDir = path.join(process.env.DATA_DIR || path.join(process.cwd(), 'data'), 'chrome');
    this.running = false;
    this.lastError = null;
    this.startedAt = 0;
  }

  status() {
    return {
      enabled: true,
      running: this.running,
      xvfbUp: !!this.xvfb && this.xvfb.exitCode === null,
      chromeUp: !!this.chrome && this.chrome.exitCode === null,
      uptimeSeconds: this.startedAt ? Math.round((Date.now() - this.startedAt) / 1000) : 0,
      lastError: this.lastError,
      display: DISPLAY,
    };
  }

  // Write the config the extension reads at launch (cookies + proxy + token).
  writeRuntimeConfig({ cookieString, proxyUrl, refreshToken }) {
    const cookies = (cookieString || '')
      .split(';')
      .map(s => s.trim())
      .filter(Boolean)
      .map(pair => {
        const i = pair.indexOf('=');
        if (i < 0) return null;
        return { name: pair.slice(0, i).trim(), value: pair.slice(i + 1).trim(), domain: '.grok.com' };
      })
      .filter(Boolean);
    const cfg = { cookies, proxyUrl, refreshToken, startUrl: 'https://grok.com/' };
    fs.writeFileSync(path.join(EXT_DIR, 'runtime-config.json'), JSON.stringify(cfg, null, 2));
    return cookies.length;
  }

  async start({ cookieString, userAgent, proxyUrl, refreshToken }) {
    if (this.running) await this.stop();
    this.lastError = null;

    try { fs.mkdirSync(this.profileDir, { recursive: true }); } catch {}
    const nCookies = this.writeRuntimeConfig({ cookieString, proxyUrl, refreshToken });
    console.log(`[Browser] runtime config: ${nCookies} cookies, proxy ${proxyUrl}`);

    // 1) Xvfb. A missing binary fires an async 'error' event — we MUST listen
    // for it, or Node throws it as an unhandled error and crashes the process.
    try {
      this.xvfb = spawn('Xvfb', [DISPLAY, '-screen', '0', SCREEN, '-nolisten', 'tcp', '-ac'], { stdio: 'ignore' });
    } catch (e) {
      this.lastError = 'Xvfb spawn failed: ' + e.message;
      console.error('[Browser]', this.lastError);
      this.running = false;
      return this.status();
    }
    this.xvfb.on('error', (e) => {
      this.lastError = 'Xvfb not available: ' + e.message + ' (is xvfb installed in the image?)';
      console.error('[Browser]', this.lastError);
      this.running = false;
    });
    this.xvfb.on('exit', (code) => { console.warn('[Browser] Xvfb exited', code); this.running = false; });
    await new Promise(r => setTimeout(r, 1500));
    if (this.lastError) return this.status(); // Xvfb already failed — don't launch chromium

    // 2) Chromium — plain, headed. NO automation flags.
    const bin = findChromium();
    const args = [
      '--no-sandbox', '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run', '--no-default-browser-check',
      '--disable-features=Translate,site-per-process',
      '--password-store=basic',
      '--window-position=0,0', `--window-size=${SCREEN_W},${SCREEN_H}`, '--start-maximized',
      `--user-data-dir=${this.profileDir}`,
      `--disable-extensions-except=${EXT_DIR}`,
      `--load-extension=${EXT_DIR}`,
    ];
    if (userAgent) args.push(`--user-agent=${userAgent}`);
    args.push('about:blank'); // extension opens grok.com once cookies are seeded

    try {
      this.chrome = spawn(bin, args, { env: { ...process.env, DISPLAY }, stdio: 'ignore' });
    } catch (e) {
      this.lastError = 'Chromium spawn failed: ' + e.message;
      console.error('[Browser]', this.lastError);
      await this.stop();
      return this.status();
    }
    this.chrome.on('error', (e) => {
      this.lastError = 'Chromium not available: ' + e.message + ' (is chromium installed in the image?)';
      console.error('[Browser]', this.lastError);
      this.running = false;
    });
    this.chrome.on('exit', (code) => { console.warn('[Browser] chromium exited', code); this.running = false; });

    this.running = true;
    this.startedAt = Date.now();
    console.log(`[Browser] started ${bin} on ${DISPLAY}`);
    return this.status();
  }

  async stop() {
    this.running = false;
    for (const p of [this.chrome, this.xvfb]) {
      if (p && p.exitCode === null) { try { p.kill('SIGTERM'); } catch {} }
    }
    await new Promise(r => setTimeout(r, 500));
    for (const p of [this.chrome, this.xvfb]) {
      if (p && p.exitCode === null) { try { p.kill('SIGKILL'); } catch {} }
    }
    this.chrome = null; this.xvfb = null;
  }

  // ── Recovery console: single-frame JPEG of the virtual display. ──
  screenshot() {
    return new Promise((resolve, reject) => {
      // scrot is simplest; ffmpeg x11grab is the fallback.
      execFile('scrot', ['-o', '/tmp/grok_screen.png'], { env: { ...process.env, DISPLAY } }, (err) => {
        if (!err) {
          try { return resolve({ buf: fs.readFileSync('/tmp/grok_screen.png'), mime: 'image/png' }); }
          catch (e) { return reject(e); }
        }
        // fallback → ffmpeg single frame
        execFile('ffmpeg', ['-y', '-f', 'x11grab', '-video_size', `${SCREEN_W}x${SCREEN_H}`, '-i', DISPLAY, '-frames:v', '1', '/tmp/grok_screen.jpg'],
          { env: { ...process.env, DISPLAY } }, (e2) => {
            if (e2) return reject(new Error('no scrot/ffmpeg: ' + e2.message));
            try { resolve({ buf: fs.readFileSync('/tmp/grok_screen.jpg'), mime: 'image/jpeg' }); }
            catch (e3) { reject(e3); }
          });
      });
    });
  }

  // ── Recovery console: relay a click or text to xdotool. ──
  input(action) {
    return new Promise((resolve, reject) => {
      let args;
      if (action.type === 'click') {
        args = ['mousemove', String(action.x | 0), String(action.y | 0), 'click', '1'];
      } else if (action.type === 'text') {
        args = ['type', '--delay', '40', String(action.text || '')];
      } else if (action.type === 'key') {
        args = ['key', String(action.key || 'Return')];
      } else {
        return reject(new Error('unknown action'));
      }
      execFile('xdotool', args, { env: { ...process.env, DISPLAY } }, (err) => {
        if (err) return reject(err);
        resolve({ ok: true });
      });
    });
  }
}

let _instance = null;
export function getBrowserManager() {
  if (!_instance) _instance = new BrowserManager();
  return _instance;
}

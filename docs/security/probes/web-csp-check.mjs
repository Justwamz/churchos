import { existsSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import puppeteer from 'puppeteer-core';
const API = 'http://localhost:4000';
const ROOT = 'C:/Users/kenneth.wamunyu/Desktop/Wawesh/ChurchOS/apps';
const base = (extra = {}) => ({
  'default-src': ["'self'"], 'script-src': ["'self'"], 'style-src': ["'self'", "'unsafe-inline'"],
  'img-src': ["'self'", 'data:', 'blob:', API], 'font-src': ["'self'", 'data:'], 'connect-src': ["'self'", API],
  'manifest-src': ["'self'", 'blob:'], 'worker-src': ["'self'"], 'frame-src': ["'none'"], 'object-src': ["'none'"],
  'base-uri': ["'self'"], 'form-action': ["'self'"], 'frame-ancestors': ["'none'"], ...extra,
});
const cspStr = (o) => Object.entries(o).map(([k, v]) => `${k} ${v.join(' ')}`).join('; ');
const APPS = {
  giving: { port: 3001, phone: null, key: 'churchos:giving:token', csp: base(), paths: ['/', '/DEMO', '/statement', '/tickets/x', '/t/x', '/here/x', '/live/x', '/verify/x', '/checkout/x'] },
  member: { port: 3002, phone: '0711000001', key: 'churchos:member-token', csp: base({ 'object-src': ["'self'", 'blob:'] }), paths: ['/'] },
  staff: { port: 3003, phone: '0700000001', key: 'churchos:staff-token', csp: base({ 'frame-src': ['blob:'], 'object-src': ["'self'", 'blob:'] }), paths: ['/'] },
  admin: { port: 3004, phone: '0700000099', key: 'churchos:admin-token', csp: base({ 'frame-src': ["'none'"] }), paths: ['/'] },
};
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };
const chrome = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
const only = process.argv[2];
const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox'] });
for (const [name, cfg] of Object.entries(APPS)) {
  if (only && only !== name) continue;
  const dist = join(ROOT, name, 'dist');
  const origin = `http://localhost:${cfg.port}`;
  const csp = process.env.NOCSP ? "default-src * 'unsafe-inline' data: blob:" : cspStr(cfg.csp);
  let token = null;
  if (cfg.phone) token = (await (await fetch(API + '/auth/otp/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone: cfg.phone, code: '123456' }) })).json()).token;
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  const viol = new Set(); const errs = new Set();
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const u = new URL(req.url());
    if (u.origin !== origin) return req.continue();
    let f = join(dist, decodeURIComponent(u.pathname));
    if (!existsSync(f) || !extname(f)) f = join(dist, 'index.html');
    const ext = extname(f);
    req.respond({ status: 200, headers: { 'content-type': MIME[ext] ?? 'application/octet-stream', 'content-security-policy': csp, 'cache-control': 'no-store' }, body: readFileSync(f) });
  });
  page.on('console', (m) => { const t = m.text(); if (/Content Security Policy|Refused to/i.test(t)) viol.add(t.slice(0, 220)); else if (m.type() === 'error') errs.add(t.slice(0, 160)); });
  page.on('pageerror', (e) => errs.add(String(e).slice(0, 160)));
  if (token) await page.evaluateOnNewDocument((k, t) => { try { localStorage.setItem(k, t); } catch {} }, cfg.key, token);
  for (const p of cfg.paths) {
    await page.goto(origin + p, { waitUntil: 'networkidle2' }).catch((e) => errs.add('goto ' + p + ' ' + e.message));
    await new Promise((r) => setTimeout(r, 800));
    if (token) {
      const n = await page.evaluate(() => document.querySelectorAll('nav button, nav a, aside button, aside a, [role=tab], .tabbar button, .tabbar a, header button').length);
      for (let i = 0; i < Math.min(n, 40); i++) {
        await page.evaluate((i) => { const els = [...document.querySelectorAll('nav button, nav a, aside button, aside a, [role=tab], .tabbar button, .tabbar a, header button')]; els[i]?.click(); }, i).catch(() => {});
        await new Promise((r) => setTimeout(r, 450));
      }
    }
  }
  // canary: inline script must be blocked
  await page.evaluate(() => { const s = document.createElement('script'); s.textContent = 'window.__x=1'; document.head.appendChild(s); });
  const ran = await page.evaluate(() => window.__x === 1);
  if(name==='admin'){await page.evaluate(()=>{const f=document.createElement('iframe');f.setAttribute('sandbox','');f.srcdoc='<p style="color:red">hi</p><img src="https://tracker.invalid/p.png">';document.body.appendChild(f);});await new Promise(r=>setTimeout(r,1000));}
  // also check blob manifest + svg-bearing branding path
  console.log(`\n=== ${name}  (canary inline script ${ran ? 'RAN - CSP NOT ENFORCED' : 'blocked, ok'})\nCSP: ${csp}`);
  console.log('violations:', viol.size ? '\n  ' + [...viol].join('\n  ') : 'none');
  console.log('other errors:', errs.size ? '\n  ' + [...errs].join('\n  ') : 'none');
  await ctx.close();
}
await browser.close();

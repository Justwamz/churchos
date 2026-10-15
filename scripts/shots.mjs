// Takes screenshots of the running apps so the screens can be reviewed by eye.
// Usage: node scripts/shots.mjs <app> <phone> <outDir> [path ...]   (optional: SHOTS_SIZE=820x1180)
//   app: member | staff | admin | giving   phone: a seeded number, for example 0711000001 (member), 0700000001 (staff), 0700000099 (admin)
// The apps and API must be running (node scripts/dev.mjs). Needs Chrome or Edge installed.
import { existsSync, mkdirSync } from 'node:fs';
import puppeteer from 'puppeteer-core';

const APPS = {
  member: { url: 'http://localhost:3002', key: 'churchos:member-token', title: 'ChurchOS Member', w: 390, h: 844 },
  staff: { url: 'http://localhost:3003', key: 'churchos:staff-token', title: 'ChurchOS Staff', w: 1280, h: 800 },
  admin: { url: 'http://localhost:3004', key: 'churchos:admin-token', title: 'Platform Admin', w: 1280, h: 800 },
  giving: { url: 'http://localhost:3001', key: 'churchos:giving:token', w: 390, h: 844 },
};
const [app, phone, out, ...paths] = process.argv.slice(2);
const cfg = { ...APPS[app] };
// SHOTS_SIZE=820x1180 overrides the window size, for example a tablet in portrait (820x1180) or landscape (1180x820).
if (process.env.SHOTS_SIZE) { const [w, h] = process.env.SHOTS_SIZE.split('x').map(Number); if (w && h) { cfg.w = w; cfg.h = h; } }
if (!cfg || !out) { console.error('usage: node scripts/shots.mjs <member|staff|admin|giving> <phone|-> <outDir> [path ...]'); process.exit(1); }
const chrome = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
if (!chrome) { console.error('No Chrome or Edge found'); process.exit(1); }
mkdirSync(out, { recursive: true });

let token = null;
let user = null;
if (phone && phone !== '-') {
  const r = await fetch('http://localhost:4000/auth/otp/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone, code: '123456' }) });
  const body = await r.json();
  token = body.token;
  user = body.user;
  if (!token) { console.error('login failed for', phone); process.exit(1); }
}
const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: cfg.w, height: cfg.h, deviceScaleFactor: 2, isMobile: cfg.w < 600, hasTouch: cfg.w < 600 });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
if (token) {
  await page.evaluateOnNewDocument((k, t, uk, u) => { try { localStorage.setItem(k, t); if (uk) localStorage.setItem(uk, JSON.stringify(u)); } catch {} }, cfg.key, token, cfg.title ? `${cfg.title}:user` : null, user);
}
let n = 0;
for (const p of paths.length ? paths : ['/']) {
  const [route, click] = p.split('@'); // "/path@Text to click" clicks the first element with that text before the shot
  await page.goto(cfg.url + route, { waitUntil: 'networkidle2' });
  await new Promise((r) => setTimeout(r, 700));
  // several clicks in a row are separated by ">" for example "/@Groups>Youth Fellowship"
  for (const step of click ? click.split('>') : []) {
    const hit = await page.evaluate((txt) => {
      const el = [...document.querySelectorAll('button,a,[role=tab],[role=button]')].find((x) => (x.textContent || '').trim().includes(txt) || x.getAttribute('aria-label') === txt);
      if (el) { el.click(); return true; }
      return false;
    }, step);
    if (!hit) errors.push(`could not find "${step}" to click`);
    await new Promise((r) => setTimeout(r, 900));
  }
  const file = `${out}/${String(++n).padStart(2, '0')}-${(route + (click ? '-' + click : '')).replace(/[^a-z0-9]+/gi, '_').slice(0, 50)}.png`;
  await page.screenshot({ path: file, fullPage: false });
  console.log(file);
}
if (errors.length) console.log('page errors:\n' + [...new Set(errors)].slice(0, 10).join('\n'));
await browser.close();

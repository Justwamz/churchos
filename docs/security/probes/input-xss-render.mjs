// Input probe 3b: render the React apps (headless Chrome via puppeteer-core already in node_modules) AFTER input-xss.mjs stored payloads,
// click through every navigation item and every tab, and detect execution through window.__xss and alert/confirm dialogs.
// LOCAL STACK ONLY (apps on 3001-3004, API on 4000). Usage: node docs/security/probes/input-xss.mjs && node docs/security/probes/input-xss-render.mjs
import { existsSync } from 'node:fs';
import puppeteer from 'puppeteer-core';
const APPS = [
  { app: 'staff', url: 'http://localhost:3003', key: 'churchos:staff-token', title: 'ChurchOS Staff', phone: '0700000001' },
  { app: 'staff-treasurer', url: 'http://localhost:3003', key: 'churchos:staff-token', title: 'ChurchOS Staff', phone: '0700000002' },
  { app: 'member', url: 'http://localhost:3002', key: 'churchos:member-token', title: 'ChurchOS Member', phone: '0711000002' },
  { app: 'admin', url: 'http://localhost:3004', key: 'churchos:admin-token', title: 'Platform Admin', phone: '0700000099' },
  { app: 'giving', url: 'http://localhost:3001', key: 'churchos:giving:token', title: null, phone: null, paths: ['/', '/?event=PRAISE', '/?church=GRC001'] },
];
const chrome = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
if (!chrome) { console.log('no Chrome/Edge found'); process.exit(2); }
const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox'] });
let totalFlag = 0;
for (const cfg of APPS) {
  let token = null, user = null;
  if (cfg.phone) { const r = await fetch('http://localhost:4000/auth/otp/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone: cfg.phone, code: '123456' }) }); const b = await r.json(); token = b.token; user = b.user; }
  const page = await browser.newPage();
  await page.setViewport({ width: cfg.app === 'member' || cfg.app === 'giving' ? 420 : 1280, height: 900 });
  const dialogs = [];
  page.on('dialog', async (d) => { dialogs.push(d.message()); await d.dismiss(); });
  if (token) await page.evaluateOnNewDocument((k, t, uk, u) => { try { localStorage.setItem(k, t); if (uk) localStorage.setItem(uk, JSON.stringify(u)); } catch {} }, cfg.key, token, cfg.title ? `${cfg.title}:user` : null, user);
  let visited = 0, seenPayload = 0; const fired = [];
  const SKIP = /sign out|log out|logout|delete|remove|cancel|reject|decline|approve|send|pay|submit|save|confirm|reset|clear|revers|refund|suspend|publish|post|install/i;
  let seed = 12345; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const check = async (where) => {
    visited++;
    const st = await page.evaluate(() => ({ x: window.__xss ?? 0, has: document.body.innerText.includes('XSSMARK'), nodes: document.querySelectorAll('img[src="x"]').length, scripts: [...document.querySelectorAll('script')].filter((e) => /__xss/.test(e.textContent || '')).length })).catch(() => ({ x: 0, has: false, nodes: 0, scripts: 0 }));
    if (st.has) seenPayload++;
    if (st.x || st.nodes || st.scripts) fired.push(`${where} __xss=${st.x} img[src=x]=${st.nodes} script=${st.scripts}`);
  };
  const clickables = 'button, a[href], [role=tab], [role=button], summary';
  const clickNth = (sel, idx) => page.evaluate((s, i, skip) => { const els = [...document.querySelectorAll(s)].filter((e) => e.offsetParent !== null && !new RegExp(skip, 'i').test(e.textContent || '')); const e = els[i]; if (!e) return false; if (e.tagName === 'A' && e.target === '_blank') return false; e.click(); return true; }, sel, idx, SKIP.source).catch(() => false);
  for (const path of cfg.paths ?? ['/']) {
    await page.goto(cfg.url + path, { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
    await check(path);
    // Phase A: structured navigation (rail then side links), staff/admin style
    const rails = await page.$$eval('.rail button, .rail-item', (e) => e.length).catch(() => 0);
    for (let r = 0; r < Math.max(rails, 1); r++) {
      if (rails) { await clickNth('.rail button, .rail-item', r); await new Promise((x) => setTimeout(x, 300)); }
      const links = await page.$$eval('.sn-link', (e) => e.length).catch(() => 0);
      for (let l = 0; l < links; l++) { if (await clickNth('.sn-link', l)) { await new Promise((x) => setTimeout(x, 450)); await check(`${path} rail${r}/link${l}`); } }
    }
    // Phase B: seeded random walk over buttons, tabs and links, restarting from the entry page now and then
    for (let step = 0; step < 90; step++) {
      if (step % 12 === 0) { await page.goto(cfg.url + path, { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {}); }
      const n = await page.$$eval(clickables, (e) => e.filter((x) => x.offsetParent !== null).length).catch(() => 0);
      if (!n) { await page.goto(cfg.url + path, { waitUntil: 'networkidle2' }).catch(() => {}); continue; }
      await clickNth(clickables, Math.floor(rnd() * n)); await new Promise((x) => setTimeout(x, 250));
      if (!page.url().startsWith(cfg.url)) { await page.goto(cfg.url + path, { waitUntil: 'networkidle2' }).catch(() => {}); }
      await check(`${path} walk#${step}`);
    }
  }
  const bad = fired.length + dialogs.length; totalFlag += bad;
  console.log(`${bad ? 'FLAG' : 'OK  '} ${cfg.app.padEnd(16)} screens visited ${visited}, screens that displayed the payload as text ${seenPayload}, executions ${fired.length}, dialogs ${dialogs.length}${fired.length ? ' ' + fired.slice(0, 3).join('; ') : ''}`);
  await page.close();
}
await browser.close();
console.log(`${totalFlag} executions detected`);

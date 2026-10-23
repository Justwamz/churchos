// Guard for the member app's navigation. No browser and no server needed. Run: node scripts/check-member-links.mjs
// 1. every `churchos:open-*` window event that anything in apps/member/src dispatches has a listener in the shell (App.tsx);
// 2. every `member:<page>` link the API writes into a notification resolves to a real place (tab, section) in the member app, for a linked and an unlinked member,
//    and that place survives the round trip through the address bar hash;
// 3. the old hash routes (#me, #church, #help, #groups, #history ...) still land somewhere sensible, and there is no Me tab any more.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const walk = (d, re) => readdirSync(d).flatMap((f) => {
  if (f === 'node_modules' || f === 'dist') return [];
  const p = join(d, f);
  return statSync(p).isDirectory() ? walk(p, re) : re.test(f) ? [p] : [];
});
const problems = [];
const fail = (m) => problems.push(m);
const read = (f) => readFileSync(f, 'utf8');
const rel = (f) => f.replace(root, '');

const memberSrc = join(root, 'apps/member/src');
const files = walk(memberSrc, /\.(tsx?|ts)$/);
const app = read(join(memberSrc, 'App.tsx'));

// 1. window events
const dispatched = new Map();
for (const f of files) for (const m of read(f).matchAll(/new Event\(\s*['"`](churchos:open-[a-z-]+)['"`]\s*\)/g)) dispatched.set(m[1], rel(f));
const listened = new Set([...app.matchAll(/['"`](churchos:open-[a-z-]+)['"`]\s*:/g)].map((m) => m[1]));
for (const m of app.matchAll(/addEventListener\(\s*['"`](churchos:open-[a-z-]+)['"`]/g)) listened.add(m[1]);
for (const [name, where] of dispatched) if (!listened.has(name)) fail(`${name} is dispatched (${where}) but App.tsx has no listener for it`);
// A listener nothing dispatches yet is fine: open-prayer and open-suggestions stay for older code and other screens. It is only reported.
const idle = [...listened].filter((n) => !dispatched.has(n));

// 2. link kinds the API emits
const apiFiles = walk(join(root, 'apps/api/src'), /\.ts$/).filter((f) => !/\.test\.ts$/.test(f));
const emitted = new Map(); // page -> Set(params)
for (const f of apiFiles) {
  const text = read(f);
  for (const m of text.matchAll(/member:([a-z-]+)(\?[a-z]+=[a-z-]+)?(?=['"`])/g)) {
    const set = emitted.get(m[1]) ?? new Set();
    if (m[2]) set.add(m[2].slice(1));
    emitted.set(m[1], set);
  }
  if (/member:\$\{/.test(text)) fail(`${rel(f)} builds a member: link from a variable; this script cannot check it. Use literal links.`);
}
if (emitted.size < 5) fail(`found only ${emitted.size} member: link kinds in apps/api/src; the search pattern may be out of date`);

// the real routing code, transpiled and run
const ts = createRequire(join(root, 'package.json'))('typescript');
const src = ts.transpileModule(read(join(memberSrc, 'links.ts')), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const TABS_SRC = [...app.matchAll(/\{ key: '([a-z]+)', label: '[^']+', ico: '[a-z]+' \}/g)].map((m) => m[1]);
const KNOWN_TABS = new Set([...TABS_SRC, 'profile']);
const sections = { services: new Set(mod.SERVICES_SECTIONS), community: new Set(mod.COMMUNITY_SECTIONS) };
const checkPlace = (p, label) => {
  if (!p) return fail(`${label}: no place`);
  if (!KNOWN_TABS.has(p.tab)) fail(`${label}: tab "${p.tab}" is not a tab of the app (${[...KNOWN_TABS].join(', ')})`);
  if (p.section && sections[p.tab] && !sections[p.tab].has(p.section)) fail(`${label}: section "${p.section}" is not a section of ${p.tab}`);
  if (p.esub && !mod.EVENTS_SUBS.includes(p.esub)) fail(`${label}: events view "${p.esub}" does not exist`);
  const back = mod.placeForHash(mod.hashFor(p));
  if (back.tab !== p.tab || (p.section && back.section !== p.section) || (p.psub && p.psub !== 'main' && back.psub !== p.psub)) fail(`${label}: hash ${mod.hashFor(p)} does not lead back to the same place (${JSON.stringify(back)})`);
};
const log = [];
for (const [page, params] of emitted) {
  const variants = params.size ? [...params].map((p) => `member:${page}?${p}`) : [`member:${page}`];
  for (const link of variants) {
    for (const unlinked of [false, true]) {
      const p = mod.placeForLink(link, { unlinked, hasKids: true });
      checkPlace(p, `${link} (${unlinked ? 'no church' : 'linked'})`);
      if (!unlinked) log.push(`${link} -> ${mod.hashFor(p)}`);
    }
  }
  if (!(page in mod.LINK_PAGES) && page !== 'give') fail(`member:${page} is emitted by the API but links.ts has no route for it`);
}
// every route links.ts knows must be reachable from some CTA label too (Inbox shows a button only for these)
const inbox = read(join(memberSrc, 'Inbox.tsx'));
for (const page of Object.keys(mod.LINK_PAGES).filter((p) => p !== 'give')) if (!new RegExp(`\\b${page}:\\s*'`).test(inbox)) fail(`Inbox.tsx has no call-to-action label for member:${page}`);
if (mod.placeForLink('member:kids', { unlinked: false, hasKids: false }).tab !== 'home') fail('member:kids without children should land on Home');
if (mod.placeForLink('staff:something', { unlinked: false, hasKids: false }) !== null) fail('a non-member link must give no place');

// 3. old hash routes and the missing Me tab
const old = { '#me': 'profile', '#church': 'profile', '#help': 'profile', '#profile': 'profile', '#profile/data': 'profile', '#profile/security': 'profile', '#groups': 'community', '#history': 'give', '#inbox': 'inbox', '#give': 'give', '#services': 'services', '#home': 'home', '': 'home', '#unknown': 'home', '#tickets': 'services', '#shop': 'services', '#prayer': 'community' };
for (const [h, tab] of Object.entries(old)) { const p = mod.placeForHash(h); if (p.tab !== tab) fail(`hash "${h}" lands on ${p.tab}, expected ${tab}`); checkPlace(p, `hash "${h}"`); }
if (mod.placeForHash('#profile/data').psub !== 'data' || mod.placeForHash('#profile/security').psub !== 'security') fail('#profile/data and #profile/security must open their own screens');
if (TABS_SRC.includes('me')) fail("App.tsx still has a 'me' tab");
if (TABS_SRC.length > 6) fail(`App.tsx has ${TABS_SRC.length} tabs; six at most`);
for (const f of files) read(f).split(/\r?\n/).forEach((l, i) => { if (/\bgo\(\s*'(me|groups)'/.test(l)) fail(`${rel(f)}:${i + 1} calls go('${/go\(\s*'(\w+)'/.exec(l)[1]}'), which is not a tab any more`); });

if (problems.length) {
  console.error(`check-member-links: ${problems.length} problem(s)\n` + problems.map((p) => '  - ' + p).join('\n'));
  process.exit(1);
}
console.log(`check-member-links: ok (${dispatched.size} open-* events${idle.length ? ', idle listeners: ' + idle.join(' ') : ''}, ${emitted.size} API link kinds, ${TABS_SRC.length} tabs)`);
if (process.argv.includes('-v')) console.log(log.join('\n'));

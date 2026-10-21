// STATIC SCAN of the database schema (no network): which tables carry org_id, which are covered by a row-level-security policy,
// and which request paths use the RLS-scoped helper `db.asOrg`. Read-only.
//   node docs/security/probes/authz-rls-scan.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const files = ['packages/ledger/src/schema.ts', 'apps/api/src/schema.ts'].map((f) => path.join(root, f));
const tables = new Map();
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  for (const m of src.matchAll(/CREATE TABLE IF NOT EXISTS\s+([a-z_0-9]+)\s*\(([\s\S]*?)\n\);/g)) tables.set(m[1], { cols: m[2], src: path.basename(path.dirname(path.dirname(f))) });
  for (const m of src.matchAll(/ALTER TABLE\s+([a-z_0-9]+)\s+ADD COLUMN IF NOT EXISTS\s+org_id\b/g)) if (tables.has(m[1])) tables.get(m[1]).cols += '\norg_id text';
}
const rlsTables = new Set();
const ledgerSrc = fs.readFileSync(files[0], 'utf8');
for (const m of ledgerSrc.matchAll(/ENABLE ROW LEVEL SECURITY/g)) void m;
for (const m of ledgerSrc.matchAll(/ARRAY\[([^\]]+)\]/g)) for (const t of m[1].split(',')) rlsTables.add(t.replace(/['\s]/g, ''));
const appSrc = fs.readFileSync(files[1], 'utf8');
for (const m of appSrc.matchAll(/FOREACH t IN ARRAY ARRAY\[([^\]]+)\]/g)) for (const t of m[1].split(',')) rlsTables.add(t.replace(/['\s]/g, ''));
const out = { withOrgAndRls: [], withOrgNoRls: [], noOrgColumn: [] };
for (const [t, v] of [...tables.entries()].sort()) {
  const hasOrg = /\borg_id\b/.test(v.cols);
  if (hasOrg && rlsTables.has(t)) out.withOrgAndRls.push(t);
  else if (hasOrg) out.withOrgNoRls.push(t);
  else out.noOrgColumn.push(t);
}
console.log(`tables found: ${tables.size}`);
console.log(`org_id + RLS policy (${out.withOrgAndRls.length}):`, out.withOrgAndRls.join(' '));
console.log(`org_id but NO RLS policy (${out.withOrgNoRls.length}):`, out.withOrgNoRls.join(' '));
console.log(`no org_id column (${out.noOrgColumn.length}):`, out.noOrgColumn.join(' '));
// where is asOrg used?
const usage = [];
function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); } else if (/\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name)) { const s = fs.readFileSync(p, 'utf8'); const n = (s.match(/\.asOrg\(/g) ?? []).length; const q = (s.match(/ctx\.db\.query/g) ?? []).length; if (n || q) usage.push({ file: path.relative(root, p).split(path.sep).join('/'), asOrg: n, ctxDbQuery: q }); } } }
walk(path.join(root, 'apps/api/src')); walk(path.join(root, 'packages/ledger/src'));
const tot = usage.reduce((a, u) => ({ asOrg: a.asOrg + u.asOrg, q: a.q + u.ctxDbQuery }), { asOrg: 0, q: 0 });
console.log(`\nasOrg( call sites: ${tot.asOrg}; ctx.db.query call sites (unscoped, runs as the database owner): ${tot.q}`);
for (const u of usage.filter((x) => x.asOrg)) console.log(`  ${u.file}: asOrg x${u.asOrg}, ctx.db.query x${u.ctxDbQuery}`);
fs.writeFileSync(path.join(here, 'authz-rls-scan.results.json'), JSON.stringify({ ...out, asOrgCallSites: tot.asOrg, unscopedQueryCallSites: tot.q, usage }, null, 1));

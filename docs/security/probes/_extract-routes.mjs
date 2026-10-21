// Helper used to build docs/security/route-inventory.md. Static read of apps/api/src/routes (no network).
// node docs/security/probes/_extract-routes.mjs [--json]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.resolve(here, '../../../apps/api/src/routes');
export function extract() {
  const rows = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.ts'))) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    const re = /app\.(get|post|put|patch|delete)\(\s*(['"`])([^'"`]+)\2\s*,\s*(\w+|\{[^}]*\})?/g;
    let m;
    const hits = [];
    while ((m = re.exec(src))) hits.push({ i: m.index, method: m[1].toUpperCase(), path: m[3], opt: m[4] ?? '', line: src.slice(0, m.index).split('\n').length });
    hits.forEach((h, k) => {
      const body = src.slice(h.i, hits[k + 1] ? hits[k + 1].i : src.length);
      let auth = 'public';
      if (h.opt === 'adm' || h.opt === 'devAdm' || /requireAdmin/.test(h.opt)) auth = 'admin';
      else if (h.opt === 'auth' || /requireSession/.test(h.opt)) auth = 'session';
      else if (h.opt.startsWith('{')) auth = 'config:' + h.opt;
      const perms = [...new Set([...body.matchAll(/(?:grantsFor|staffScope|inStaffScope|branchesFor|staffWith)\([^)]*?'([a-z]+\.[a-z]+)'/g)].map((x) => x[1]))];
      const checks = [];
      if (/inStaffScope/.test(body)) checks.push('inStaffScope');
      if (/grantsFor/.test(body)) checks.push('grantsFor');
      if (/staffScope/.test(body)) checks.push('staffScope');
      if (/audienceOf/.test(body)) checks.push('audienceOf');
      if (/asOrg/.test(body)) checks.push('RLS');
      if (/user_id\s*=\s*\$\d|req\.session!?\.uid/.test(body)) checks.push('owner(uid)');
      if (/org_id\s*=\s*\$\d/.test(body)) checks.push('org_id');
      rows.push({ file: f, line: h.line, method: h.method, path: h.path, auth, perms: perms.join(','), checks: checks.join(',') });
    });
  }
  const EXPAND = { '${verb}': ['pause', 'resume', 'end'], '${kind}': ['view', 'tap', 'stk', 'c2b'] };
  const out = [];
  for (const r of rows) {
    const m = r.path.match(/\$\{(\w+)\}/);
    if (!m) { out.push(r); continue; }
    const opts = r.path.startsWith('/me/adverts') ? ['view', 'tap'] : r.path.startsWith('/webhooks') ? ['stk', 'c2b'] : EXPAND['${' + m[1] + '}'];
    for (const o of opts) out.push({ ...r, path: r.path.replace(m[0], o), templated: true });
  }
  return out;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const rows = extract();
  if (process.argv.includes('--json')) console.log(JSON.stringify(rows, null, 1));
  else {
    const by = (a) => rows.filter((r) => r.auth === a).length;
    console.log(`total ${rows.length} public ${by('public')} session ${by('session')} admin ${by('admin')} other ${rows.length - by('public') - by('session') - by('admin')}`);
    for (const r of rows.filter((x) => x.auth !== 'session' && x.auth !== 'admin')) console.log(`${r.file}:${r.line} ${r.method} ${r.path} [${r.auth}]`);
  }
}

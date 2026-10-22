// Regression guard for the "button sits too low next to a select" class of bug. No browser needed. Run: node scripts/check-form-rows.mjs
// A <Field> has a bottom margin (and optional hint/error under the control). Putting it in a row with align-items:end/flex-end therefore lines
// the neighbour up with the margin box, not with the control. The fix is the shared `.form-row` class (packages/ui/src/styles.css), which removes
// that margin and hangs hints below the control. This script fails when a CSS rule with align-items:end|flex-end targets a class that the TSX
// uses on a container holding a <Field>, unless the same element also carries `form-row`.
// Exemption: put `form-row-exempt` in a comment inside the rule (for example a chart or a page header that has no Field).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const walk = (d, re) => readdirSync(d).flatMap((f) => {
  if (f === 'node_modules' || f === 'dist') return [];
  const p = join(d, f);
  return statSync(p).isDirectory() ? walk(p, re) : re.test(f) ? [p] : [];
});
const roots = ['apps', 'packages/ui/src'].map((r) => join(root, r));
const css = roots.flatMap((r) => walk(r, /\.css$/));
const tsx = roots.flatMap((r) => walk(r, /\.tsx$/));

const base = readFileSync(join(root, 'packages/ui/src/styles.css'), 'utf8');
const problems = [];
if (!/\.form-row\s*\{[^}]*align-items:\s*flex-end/.test(base)) problems.push('packages/ui/src/styles.css must define .form-row with align-items: flex-end');

const sources = tsx.map((f) => ({ f, lines: readFileSync(f, 'utf8').split(/\r?\n/) }));
const classUses = (cls) => {
  const uses = [];
  const re = new RegExp(`class(?:Name)?=(?:"[^"]*|\\{\`[^\`]*|\\{'[^']*)(?<![\\w-])${cls.replace(/-/g, '\\-')}(?![\\w-])`);
  for (const { f, lines } of sources) lines.forEach((l, i) => { if (re.test(l)) uses.push({ f, i, l, window: lines.slice(i, i + 14).join('\n') }); });
  return uses;
};

for (const file of css) {
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(/([^{}@]+)\{([^{}]*)\}/g)) {
    const [, sel, body] = m;
    if (!/align-items:\s*(?:end|flex-end)\b/.test(body) || /form-row-exempt/.test(body + sel)) continue;
    for (const one of sel.split(',')) {
      if (/\.form-row\b/.test(one)) continue;
      const last = one.trim().split(/[\s>+~]+/).pop() ?? '';
      for (const c of [...last.matchAll(/\.([\w-]+)/g)].map((x) => x[1])) {
        for (const u of classUses(c)) {
          if (!/<Field\b|className="field"|class="field"/.test(u.window)) continue;
          if (/form-row/.test(u.l)) continue;
          problems.push(`${file.replace(root, '')}: .${c} uses align-items:end and holds a <Field> (${u.f.replace(root, '')}:${u.i + 1}) without the form-row class. Add "form-row" to that element, or mark the rule form-row-exempt.`);
        }
      }
    }
  }
}

if (problems.length) {
  console.error(`check-form-rows: ${problems.length} problem(s)\n` + [...new Set(problems)].map((p) => '  - ' + p).join('\n'));
  process.exit(1);
}
console.log(`check-form-rows: ok (${css.length} stylesheets, ${tsx.length} components scanned)`);

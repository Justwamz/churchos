// Release gate for the legal documents. Run: node scripts/check-legal.mjs
// Fails (exit 1) when an operator detail is empty (packages/shared/src/operator.ts), when any document contains an unfinished marker
// ('[', 'TODO', 'XXX', 'placeholder', 'lorem', '{{'), or when the operator's details are written into a document instead of read from OPERATOR.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tsImport } from 'tsx/esm/api';

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const shared = await tsImport('../packages/shared/src/index.ts', import.meta.url);
const { OPERATOR, missingOperatorFields, DOC_SLUGS, buildDoc, docText, unfinishedMarkers, LEGAL_VERSION } = shared;

const problems = [];
const missing = missingOperatorFields(OPERATOR);
if (missing.length) problems.push(`operator.ts is not complete: ${missing.join(', ')}`);
if (OPERATOR.odpcStatus === 'not_registered' && OPERATOR.odpcNumber) problems.push('odpcStatus is not_registered but an odpcNumber is set');

for (const slug of DOC_SLUGS) {
  for (const church of [null, { name: 'Grace Chapel', contact: 'office@example.org', officer: 'Jane Doe' }]) {
    const d = buildDoc(slug, church);
    const text = docText(d);
    const bad = unfinishedMarkers(text);
    if (bad.length) problems.push(`${slug}${church ? ' (with church)' : ''}: contains ${bad.map((b) => JSON.stringify(b)).join(', ')}`);
    if (!d.summary.length || d.sections.length < 3) problems.push(`${slug}: missing summary or sections`);
    if (OPERATOR.name && !text.includes(OPERATOR.name)) problems.push(`${slug}: does not name the operator`);
    if (/bis registered with the Office/.test(text) && OPERATOR.odpcStatus !== 'registered') problems.push(`${slug}: claims ODPC registration but odpcStatus is ${OPERATOR.odpcStatus}`);
  }
}

// The operator's details must come from OPERATOR, never from the text of a document.
const dir = join(root, 'packages/shared/src/legal');
for (const f of readdirSync(dir).filter((x) => x.endsWith('.ts'))) {
  const src = readFileSync(join(dir, f), 'utf8');
  for (const v of [OPERATOR.name, OPERATOR.email, OPERATOR.address, OPERATOR.postalAddress].filter(Boolean)) {
    if (src.includes(v)) problems.push(`legal/${f} writes an operator detail into the text (${JSON.stringify(v)}). Read it from OPERATOR.`);
  }
}

if (problems.length) {
  console.error(`check-legal FAILED (legal version ${LEGAL_VERSION}):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`check-legal OK: ${DOC_SLUGS.length} documents, version ${LEGAL_VERSION}, operator ${OPERATOR.name}, ODPC ${OPERATOR.odpcStatus}.`);

import { describe, expect, it } from 'vitest';
import { DOC_SLUGS, LEGAL_VERSION, OPERATOR, buildDoc, docText, missingOperatorFields, unfinishedMarkers } from './index';

/**
 * Renders every document and fails when operator-dependent text is empty or unfinished. While the operator details are still empty and
 * LEGAL_ALLOW_EMPTY=1 these checks are skipped with a message; `node scripts/check-legal.mjs` is the hard release gate.
 */
const empty = missingOperatorFields(OPERATOR).length > 0;
const skip = empty && process.env.LEGAL_ALLOW_EMPTY === '1';
if (skip) console.warn(`legal.test: skipped, operator details are empty (${missingOperatorFields(OPERATOR).join(', ')}) and LEGAL_ALLOW_EMPTY=1`);

describe.skipIf(skip)('legal documents', () => {
  it('the operator details are filled in', () => { expect(missingOperatorFields(OPERATOR)).toEqual([]); });
  for (const slug of DOC_SLUGS) {
    it(`${slug}: complete, names the operator and has no unfinished text`, () => {
      for (const church of [null, { name: 'Grace Chapel', contact: 'office@example.org', officer: 'Jane Doe' }]) {
        const d = buildDoc(slug, church);
        const text = docText(d);
        expect(unfinishedMarkers(text)).toEqual([]);
        expect(text).toContain(OPERATOR.name);
        expect(text).toContain(OPERATOR.email);
        expect(text).not.toMatch(/undefined|null|\[object/);
        expect(d.summary.length).toBeGreaterThan(2);
        expect(d.sections.length).toBeGreaterThan(3);
        if (church) expect(text).toMatch(slug === 'dpa' || slug === 'children' || slug === 'privacy' ? /Grace Chapel/ : /./);
      }
    });
  }
  it('never claims registration unless the operator is registered', () => {
    for (const slug of DOC_SLUGS) {
      const text = docText(buildDoc(slug));
      if (OPERATOR.odpcStatus === 'registered') expect(text).toContain(OPERATOR.odpcNumber);
      else expect(text).not.toMatch(/\bis registered with the Office/);
    }
  });
  it('the version is a date', () => { expect(LEGAL_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/); });
});

/**
 * The one place that names who runs ChurchOS. Every legal document, the consent screens and the legal API routes read from here:
 * never write these details into the text of a document. `node scripts/check-legal.mjs` fails when a field the documents need is empty,
 * and the production build of every app fails too (see legalBuildGuard in each vite.config.ts) unless LEGAL_ALLOW_EMPTY=1.
 */
export interface Operator {
  /** Legal name of the company that runs ChurchOS. */
  name: string;
  /** Where people send privacy requests and complaints. */
  email: string;
  /** Physical address. */
  address: string;
  /** Postal address. */
  postalAddress: string;
  /** Whether the operator is registered with the Office of the Data Protection Commissioner. */
  odpcStatus: 'registered' | 'not_registered';
  /** The registration number. Required when odpcStatus is 'registered', empty otherwise. */
  odpcNumber: string;
}

export const OPERATOR: Operator = {
  name: 'Kappanetics Limited',
  email: 'privacy@kappanetics.com',
  address: 'Sclater House, 1st Floor, Westlands, Nairobi, Kenya',
  postalAddress: 'P.O. Box 70744-00400, Nairobi, Kenya',
  odpcStatus: 'not_registered',
  odpcNumber: '',
};

/** The fields that must be filled in before release. The registration number is needed only once the operator is registered. */
export function missingOperatorFields(op: Operator = OPERATOR): string[] {
  const missing = (['name', 'email', 'address', 'postalAddress'] as const).filter((k) => !String(op[k] ?? '').trim());
  if (op.odpcStatus !== 'registered' && op.odpcStatus !== 'not_registered') missing.push('odpcStatus' as never);
  if (op.odpcStatus === 'registered' && !String(op.odpcNumber ?? '').trim()) missing.push('odpcNumber' as never);
  return missing;
}

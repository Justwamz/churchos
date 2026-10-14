import { useEffect, useState } from 'react';
import { Button } from '@churchos/ui';

export interface KycSummary {
  /** Items the church must provide: 3 organisation documents plus one payout proof per branch. */
  total: number;
  approved: number;
  waiting: number;
  rejected: number;
  missing: number;
  verified: boolean;
  tone: 'action' | 'fix' | 'review' | 'done';
  rejectedReasons: string[];
}

/** Turns the /kyc/status response into one plain summary the banner and dialog can show. */
export function summarize(k: any): KycSummary | null {
  if (!k) return null;
  const items: any[] = [...(k.required ?? []).map((r: any) => r.latest), ...(k.branches ?? []).map((b: any) => b.payoutProof?.latest)];
  const total = (k.required?.length ?? 0) + (k.branches?.length ?? 0);
  const approved = items.filter((d) => d?.status === 'approved').length;
  const waiting = items.filter((d) => d?.status === 'submitted').length;
  const rejectedDocs = items.filter((d) => d?.status === 'rejected');
  const missing = total - items.filter(Boolean).length;
  const verified = (k.branches ?? []).length > 0 && (k.branches ?? []).every((b: any) => b.verified);
  const tone: KycSummary['tone'] = verified ? 'done' : rejectedDocs.length ? 'fix' : missing > 0 ? 'action' : waiting > 0 ? 'review' : 'action';
  return { total, approved, waiting, rejected: rejectedDocs.length, missing, verified, tone, rejectedReasons: rejectedDocs.map((d) => d.reason).filter(Boolean) };
}

const COPY: Record<'action' | 'fix' | 'review', { title: string; cta: string; icon: string }> = {
  action: { title: 'Complete verification to receive payouts', cta: 'Complete verification now', icon: '✚' },
  fix: { title: 'Action needed: a document was rejected', cta: 'Fix and resubmit now', icon: '!' },
  review: { title: 'Verification is under review', cta: 'View verification status', icon: '…' },
};

/** Shown on every page until the church is fully verified (L81). */
export function VerificationBanner({ s, onGo }: { s: KycSummary; onGo: () => void }) {
  if (s.tone === 'done') return null;
  const c = COPY[s.tone];
  const pct = s.total ? Math.round((s.approved / s.total) * 100) : 0;
  return (
    <div className={`banner ${s.tone}`} role="region" aria-label="Verification status">
      <div className="banner-icon" aria-hidden>{c.icon}</div>
      <div className="banner-main">
        <div className="banner-title">{c.title}</div>
        <div className="banner-text">
          {s.tone === 'review'
            ? 'Everything has been uploaded. A ChurchOS reviewer will approve it soon, and payouts start as soon as they do.'
            : s.tone === 'fix'
              ? `${s.rejectedReasons[0] ? `Reviewer's note: “${s.rejectedReasons[0]}”. ` : ''}Upload a corrected file and it will be reviewed again.`
              : 'You can keep collecting gifts. The money is held safely and is paid out to your bank account once you are verified.'}
        </div>
        <div className="banner-progress" aria-label={`${s.approved} of ${s.total} items approved`}>
          <div className="progress"><i style={{ width: `${pct}%` }} /></div>
          <span className="tiny">{s.approved} of {s.total} approved{s.missing > 0 ? ` · ${s.missing} still to upload` : ''}{s.waiting > 0 ? ` · ${s.waiting} waiting for review` : ''}</span>
        </div>
      </div>
      <div className="banner-cta"><Button onClick={onGo}>{c.cta}</Button></div>
    </div>
  );
}

/** A one-time welcome dialog per browser session, so a new church cannot miss the next step. */
export function VerificationDialog({ s, onGo, userKey }: { s: KycSummary; onGo: () => void; userKey: string }) {
  const key = `churchos:kyc-welcome:${userKey}`;
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (s.tone !== 'action' && s.tone !== 'fix') return;
    try {
      if (sessionStorage.getItem(key)) return;
    } catch { /* storage blocked: show it once per page load */ }
    setOpen(true);
  }, [s.tone, key]);
  if (!open) return null;
  const close = () => {
    try { sessionStorage.setItem(key, '1'); } catch { /* ignore */ }
    setOpen(false);
  };
  return (
    <div className="modal-scrim" role="dialog" aria-modal="true" aria-label="Complete verification">
      <div className="modal">
        <div className="brand">ChurchOS</div>
        <h2>{s.tone === 'fix' ? 'A document needs your attention' : 'One more step before you can be paid'}</h2>
        <p className="muted">
          {s.tone === 'fix'
            ? 'A reviewer could not approve one of your documents. Open verification to see why and upload a corrected file.'
            : 'To protect your church and your members, ChurchOS verifies every church before paying out. It takes about five minutes:'}
        </p>
        {s.tone !== 'fix' && (
          <ul className="modal-list">
            <li>Registration certificate</li>
            <li>KRA PIN certificate</li>
            <li>ID of an authorised signatory</li>
            <li>Proof of your payout account (a bank letter or statement)</li>
          </ul>
        )}
        <p className="tiny">You can keep collecting gifts in the meantime. The money is held safely until you are verified.</p>
        <div className="row" style={{ marginTop: 12 }}>
          <Button onClick={() => { close(); onGo(); }}>Complete verification now</Button>
          <Button kind="ghost" onClick={close}>Remind me later</Button>
        </div>
      </div>
    </div>
  );
}

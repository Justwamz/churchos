import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { BrandInfo } from '@churchos/ui';
import { usePageBranding } from './brand';
import { BrandMark, Button, Card, Field, Spinner, createApi, kes } from '@churchos/ui';

const api = createApi('churchos:giving:statement');

type Result = { valid: false } | { valid: true; church: string; year: number; total: number; issued: string; memberInitials: string; branding?: BrandInfo | null };

const longDate = (iso: string) => new Date(`${iso}T12:00:00+03:00`).toLocaleDateString('en-KE', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Africa/Nairobi' });

/** Public page: check that a giving statement number is real. */
export function StatementPage() {
  const { number = '' } = useParams();
  const nav = useNavigate();
  const [text, setText] = useState(number);
  const [res, setRes] = useState<Result | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const check = async (raw: string) => {
    const n = raw.trim().toUpperCase().replace(/\s+/g, '');
    if (!n) return;
    setBusy(true); setFailed(false); setRes(undefined);
    try { setRes(await api.get<Result>(`/public/statement/${encodeURIComponent(n)}`)); }
    catch { setFailed(true); }
    setBusy(false);
  };

  useEffect(() => {
    setText(number);
    if (number) void check(number);
    else { setRes(undefined); setFailed(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [number]);

  const branding = res && res.valid ? res.branding : null;
  usePageBranding(branding, res && res.valid ? res.church : null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const n = text.trim().toUpperCase().replace(/\s+/g, '');
    if (!n) return;
    if (n === number.toUpperCase()) void check(n);
    else nav(`/statement/${encodeURIComponent(n)}`);
  };

  return (
    <div className="mobile giving">
      <style>{`
        .giving .st-head { padding: 22px 4px 18px; border-bottom: 1px solid var(--line); margin-bottom: 18px; }
        .giving .st-head h1 { font-size: 2rem; margin: 6px 0 0; }
        .giving .st-ok, .giving .st-bad { border-radius: 12px; padding: 14px 16px; line-height: 1.45; overflow-wrap: anywhere; }
        .giving .st-ok { background: var(--good-tint); color: var(--good); border: 1px solid var(--good); }
        .giving .st-bad { background: var(--bad-tint, #fdecea); color: var(--bad, #b3322d); border: 1px solid var(--bad, #b3322d); }
        .giving .btn { width: 100%; min-height: 50px; font-size: 1.05rem; }
      `}</style>
      <header className="st-head">
        {branding?.hasLogo && res && res.valid ? <div style={{ marginBottom: 8 }}><BrandMark brand={{ ...branding, name: res.church }} size={44} /></div> : null}
        <div className="brand">Giving</div>
        <h1>Check a statement</h1>
      </header>
      <div className="stack">
        <Card>
          <form onSubmit={submit} className="stack" aria-label="Check a giving statement">
            <Field label="Statement number" hint="It is printed on the statement, like GS-2026-ABC123.">
              <input value={text} onChange={(e) => setText(e.target.value)} placeholder="GS-2026-ABC123" autoCapitalize="characters" autoComplete="off" spellCheck={false} autoFocus={!number} />
            </Field>
            <Button type="submit" disabled={busy || !text.trim()}>{busy ? 'Checking...' : 'Check'}</Button>
          </form>
        </Card>
        <div aria-live="polite" className="stack">
          {busy && <Spinner />}
          {failed && <div className="st-bad" role="alert">We could not check right now. Please try again.</div>}
          {res && res.valid && (
            <div className="st-ok" role="status">
              <b>This statement is real.</b> Issued by {res.church} on {longDate(res.issued)} for {res.year}: total {kes(res.total)}, for {res.memberInitials}{res.memberInitials.endsWith('.') ? '' : '.'}
            </div>
          )}
          {res && !res.valid && <div className="st-bad" role="alert">We could not find that statement. Check the number.</div>}
        </div>
      </div>
    </div>
  );
}

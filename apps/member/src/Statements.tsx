import { useEffect, useState } from 'react';
import { API_URL, Button, Card, Empty, ErrorNote, Note, useAsync } from '@churchos/ui';
import { api, errText } from './api';
import { Skeleton } from './ui';

const TZ = 'Africa/Nairobi';
const kesC = (c: number | null | undefined) => {
  const v = Number(c ?? 0) / 100;
  return `KES ${v.toLocaleString('en-KE', { minimumFractionDigits: Number.isInteger(v) ? 0 : 2, maximumFractionDigits: 2 })}`;
};
const dayOnly = (iso: string) => new Date(iso).toLocaleDateString('en-KE', { day: 'numeric', month: 'short', year: 'numeric', timeZone: TZ });

type PdfLink = { url: string; name: string };

/** Fetches a statement PDF with the session token and opens it in a tab (or offers a link if the browser blocks the tab). */
async function fetchPdf(s: { id: string; number: string; year: number }, pre?: Window | null): Promise<{ link: PdfLink; opened: boolean }> {
  // open the tab straight away so the browser does not block it, then point it at the PDF
  const w = pre !== undefined ? pre : window.open('', '_blank');
  try {
    let token: string | null = null;
    try { token = localStorage.getItem('churchos:member-token'); } catch { /* ignore */ }
    let res: Response;
    try {
      res = await fetch(`${API_URL}/me/statements/${encodeURIComponent(s.id)}/pdf`, { headers: { 'x-churchos-app': 'member', ...(token ? { authorization: `Bearer ${token}` } : {}) } });
    } catch { throw new Error('Cannot reach the server. Check your connection and try again.'); }
    if (!res.ok) {
      let msg = 'We could not open the statement. Please try again.';
      try { const j = await res.json(); if (j?.error) msg = j.error; } catch { /* ignore */ }
      throw new Error(msg);
    }
    const blob = new Blob([await res.arrayBuffer()], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const link = { url, name: `giving-statement-${s.year}-${s.number}.pdf` };
    if (w) { try { w.opener = null; } catch { /* ignore */ } w.location.href = url; return { link, opened: true }; }
    return { link, opened: false };
  } catch (e) {
    if (w) w.close();
    throw e;
  }
}

export function Statements() {
  const q = useAsync<any>(() => api.get('/me/statements'));
  const [pick, setPick] = useState<{ orgId: string; year: number } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const [link, setLink] = useState<PdfLink | null>(null);
  const [linkNote, setLinkNote] = useState('');
  const d = q.data;
  const churches: any[] = d?.churches ?? [];
  const issued: any[] = d?.issued ?? [];
  const thisYear = Number(d?.thisYear ?? new Date().getFullYear());

  // rows per church: every year with gifts, plus this year even when empty
  const rows = churches.map((c) => {
    const ys: any[] = [...(c.years ?? [])];
    if (!ys.some((y) => y.year === thisYear)) ys.push({ year: thisYear, gifts: 0, total: 0 });
    ys.sort((a, b) => b.year - a.year);
    return { ...c, years: ys };
  });

  useEffect(() => {
    if (pick || !rows.length) return;
    for (const c of rows) { const y = c.years.find((x: any) => x.gifts > 0); if (y) { setPick({ orgId: c.orgId, year: y.year }); return; } }
  }, [d]); // eslint-disable-line react-hooks/exhaustive-deps

  const show = async (s: any, key: string, pre?: Window | null) => {
    setBusy(key); setErr(''); setLink(null);
    try {
      const r = await fetchPdf(s, pre);
      setLink(r.link);
      setLinkNote(r.opened ? 'Your statement should have opened in a new tab. If it did not, use the link below.' : 'Your browser did not open the statement by itself. Use the link below.');
    } catch (e: any) { setErr(errText(e)); }
    setBusy(null);
  };

  const make = async () => {
    if (!pick) return;
    // open the tab inside the click, before waiting for the server
    const w = window.open('', '_blank');
    setBusy('make'); setErr(''); setLink(null);
    try {
      const s = await api.post('/me/statements', { orgId: pick.orgId, year: pick.year });
      q.reload();
      setBusy(null);
      await show(s, 'make', w);
    } catch (e: any) { if (w) w.close(); setErr(errText(e)); setBusy(null); }
  };

  return (
    <div className="stack stmt-wrap">
      <Card title="Giving statement">
        <div className="stack">
          <p className="muted" style={{ margin: 0 }}>Ask for a statement of your giving for a year. It is made only when you ask, and it lists every gift the church can link to you. Anonymous gifts are not on it.</p>
          {d?.note && <p className="tiny muted" style={{ margin: 0 }}>{d.note}</p>}
          {q.loading && !d ? <Skeleton lines={3} /> : q.error && !d ? <><ErrorNote>{q.error}</ErrorNote><Button kind="ghost" onClick={q.reload}>Try again</Button></> : (
            <>
              {!rows.length && <Empty>You are not linked to a church yet, so there is no statement to make.</Empty>}
              {rows.map((c) => (
                <fieldset className="stmt-church" key={c.orgId}>
                  <legend className="field-label">{c.church}</legend>
                  <div className="stmt-years" role="radiogroup" aria-label={`Year for ${c.church}`}>
                    {c.years.map((y: any) => {
                      const none = !y.gifts;
                      const on = !!pick && pick.orgId === c.orgId && pick.year === y.year;
                      return (
                        <button type="button" role="radio" aria-checked={on} disabled={none} key={y.year} className={`stmt-year ${on ? 'on' : ''}`} onClick={() => setPick({ orgId: c.orgId, year: y.year })}>
                          <strong>{y.year}</strong>
                          <span className="tiny">{none ? 'No gifts recorded' : `${y.gifts} ${y.gifts === 1 ? 'gift' : 'gifts'} · ${kesC(y.total)}`}</span>
                        </button>
                      );
                    })}
                  </div>
                </fieldset>
              ))}
              {err && <ErrorNote>{err}</ErrorNote>}
              {rows.length > 0 && <Button disabled={!pick || !!busy} onClick={make}>{busy === 'make' ? 'Making your statement…' : 'Get my statement (PDF)'}</Button>}
              {link && (
                <div className="stmt-link" role="status">
                  <span>{linkNote}</span>
                  <div className="stmt-link-row">
                    <a className="btn ghost" href={link.url} target="_blank" rel="noopener noreferrer">Open the PDF</a>
                    <a className="btn ghost" href={link.url} download={link.name}>Save to my phone</a>
                  </div>
                </div>
              )}
              <p className="tiny muted" style={{ margin: 0 }}>Keep the statement number: anyone can check it is real on the church's giving page.</p>
            </>
          )}
        </div>
      </Card>

      <Card title="Statements I have asked for or the church made for you">
        {q.loading && !d ? <Skeleton lines={2} /> : !issued.length ? <Empty>You have not asked for a statement yet.</Empty> : (
          <ul className="list">
            {issued.map((s) => (
              <li key={s.id} className="stmt-item">
                <div className="row"><strong>{s.year} · {s.number}</strong><span className="amt">{kesC(s.total)}</span></div>
                <div className="tiny">{s.church} · {s.gifts} {s.gifts === 1 ? 'gift' : 'gifts'} · {dayOnly(s.at)}</div>
                <div className="row">
                  <span className="tiny">{s.by === 'You' ? 'Made by you' : `Made by the church (${s.by})`}</span>
                  <Button kind="ghost" small disabled={!!busy} onClick={() => show(s, s.id)}>{busy === s.id ? 'Opening…' : 'Open PDF'}</Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Note tone="info">A statement is a copy of your record on the day it was made. Gifts made later are on the next one you ask for.</Note>
    </div>
  );
}

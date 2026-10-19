import { useCallback, useEffect, useState } from 'react';
import { Button, ErrorNote, Spinner } from '@churchos/ui';
import { api, friendly, useSession } from './session';
import { InstallBanner, useOnline } from './Install';

type TodayData = {
  name: string;
  cards: { key: string; title: string; count: number; hint: string; page: string }[];
  services: { id: string; name: string; branch?: string; startsAt: string; state: 'before' | 'open' | 'closed'; inPerson: number }[];
  kids: { id: string; className: string; branch?: string; present: number }[];
  at: string;
};

const STATE: Record<string, { label: string; tone: string }> = {
  before: { label: 'Opens soon', tone: 'info' },
  open: { label: 'Check-in open', tone: 'good' },
  closed: { label: 'Closed', tone: 'muted' },
};

function greeting(name: string): string {
  const h = new Date().getHours();
  const part = h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening';
  const first = (name || '').trim().split(/\s+/)[0];
  return `Good ${part}${first ? ', ' + first : ''}`;
}

const time = (iso: string) => new Date(iso).toLocaleTimeString('en-KE', { hour: 'numeric', minute: '2-digit' });

export function TodayPage() {
  const s = useSession();
  const online = useOnline();
  const [d, setD] = useState<TodayData | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    try { setD(await api.get('/staff/today' + s.qs())); setError(''); } catch (e: any) { setError(friendly(e.message)); }
    setBusy(false);
  }, [s]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const t = setInterval(() => { if (document.visibilityState === 'visible' && navigator.onLine) load(); }, 60000);
    const vis = () => { if (document.visibilityState === 'visible' && navigator.onLine) load(); };
    document.addEventListener('visibilitychange', vis);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', vis); };
  }, [load]);

  const name = d?.name || s.user.name || '';
  const nothing = d && d.cards.length === 0 && d.services.length === 0 && d.kids.length === 0;

  return (
    <div className="today">
      <div className="page-head">
        <div>
          <h1>{greeting(name)}</h1>
          <p>{new Date().toLocaleDateString('en-KE', { weekday: 'long', day: 'numeric', month: 'long' })}</p>
        </div>
        <Button kind="ghost" small onClick={load} disabled={busy}>{busy ? 'Refreshing...' : 'Refresh'}</Button>
      </div>
      {!online && <div className="note warn today-offline" role="status">You are offline. Showing nothing stored: staff screens always need a connection.</div>}
      <InstallBanner />
      {error && <div className="today-error"><ErrorNote>{error}</ErrorNote><Button kind="ghost" small onClick={load}>Try again</Button></div>}
      {!d && !error && <Spinner />}
      {d && (
        <>
          {nothing && <div className="empty today-empty">Nothing is waiting for you.</div>}
          {d.cards.length > 0 && (
            <div className="today-grid">
              {d.cards.map((c) => (
                <button key={c.key} type="button" className={`today-card ${c.count > 0 ? 'on' : 'calm'}`} onClick={() => s.go(c.page)}>
                  <span className="today-count">{c.count > 0 ? c.count : <span aria-hidden="true">✓</span>}</span>
                  <span className="today-title">{c.title}</span>
                  <span className="today-hint">{c.count > 0 ? c.hint : 'All clear'}</span>
                </button>
              ))}
            </div>
          )}
          {(d.services.length > 0 || d.kids.length > 0) && (
            <>
              <h2 className="today-h">Happening today</h2>
              <div className="today-list">
                {d.services.map((v) => (
                  <button key={v.id} type="button" className="today-row" onClick={() => s.go('usher')}>
                    <span className="today-row-main">
                      <b>{v.name}</b>
                      <span className="tiny">{time(v.startsAt)}{v.branch ? ` · ${v.branch}` : ''} · {v.inPerson} in so far</span>
                    </span>
                    <span className={`badge ${STATE[v.state]?.tone ?? 'muted'}`}>{STATE[v.state]?.label ?? v.state}</span>
                  </button>
                ))}
                {d.kids.map((k) => (
                  <button key={k.id} type="button" className="today-row" onClick={() => s.go('children')}>
                    <span className="today-row-main">
                      <b>{k.className}</b>
                      <span className="tiny">Children&apos;s class{k.branch ? ` · ${k.branch}` : ''}</span>
                    </span>
                    <span className="badge good">{k.present} present</span>
                  </button>
                ))}
              </div>
            </>
          )}
          <p className="tiny today-at">Updated {time(d.at)}</p>
        </>
      )}
    </div>
  );
}

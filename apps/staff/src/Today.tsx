import { useCallback, useEffect, useState } from 'react';
import { Button, ErrorNote } from '@churchos/ui';
import { api, friendly, useSession } from './session';
import { InstallBanner, useOnline } from './Install';
import { useWords } from './words';
import { QUICK_ACTIONS } from './navmap';
import { openAction } from './prefill';
import { parseLink, ctaLabel, useOpenLink } from './links';
import { Icon } from './icons';
import { Card, EmptyState, Section, Skeleton, StatusChip } from './ui';

type TodayData = {
  name: string;
  cards: { key: string; title: string; count: number; hint: string; page: string }[];
  services: { id: string; name: string; branch?: string; startsAt: string; state: 'before' | 'open' | 'closed'; inPerson: number }[];
  kids: { id: string; className: string; branch?: string; present: number }[];
  at: string;
};
type Note = { id: string; kind?: string; title: string; body?: string; link?: string | null; read: boolean; created_at: string };

const STATE: Record<string, { label: string; tone: 'info' | 'done' | 'off' }> = {
  before: { label: 'Opens soon', tone: 'info' },
  open: { label: 'Check-in open', tone: 'done' },
  closed: { label: 'Closed', tone: 'off' },
};

function greeting(name: string): string {
  const h = new Date().getHours();
  const part = h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening';
  const first = (name || '').trim().split(/\s+/)[0];
  return `Good ${part}${first ? ', ' + first : ''}`;
}

const time = (iso: string) => new Date(iso).toLocaleTimeString('en-KE', { hour: 'numeric', minute: '2-digit' });
function ago(iso: string): string {
  const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.round(h / 24);
  return d < 7 ? `${d} day${d === 1 ? '' : 's'} ago` : new Date(iso).toLocaleDateString('en-KE', { day: 'numeric', month: 'short' });
}

/** The landing page for everyone: what needs you, what is on now, quick actions, and what happened lately. */
export function TodayPage() {
  const s = useSession();
  const w = useWords();
  const online = useOnline();
  const [d, setD] = useState<TodayData | null>(null);
  const [recent, setRecent] = useState<Note[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const openLink = useOpenLink();

  const load = useCallback(async () => {
    setBusy(true);
    try { setD(await api.get('/staff/today' + s.qs())); setError(''); } catch (e: any) { setError(friendly(e.message)); }
    // The recent list is a nicety: the same staff notifications as the bell, newest first. If it fails the page simply has no list.
    try { const n = await api.get('/me/notifications?app=staff'); setRecent((n.rows ?? []).slice(0, 8)); } catch { setRecent([]); }
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
  const actions = QUICK_ACTIONS.filter((a) => s.can(a.right));
  const cards = d ? [...d.cards].sort((a, b) => Number(b.count > 0) - Number(a.count > 0)) : [];
  const waiting = cards.filter((c) => c.count > 0).length;
  const happening = d ? d.services.length + d.kids.length : 0;

  return (
    <div className="today">
      <div className="u-ph-row today-head">
        <div className="u-ph-text">
          <h1>{greeting(name)}</h1>
          <p className="u-ph-sub">{new Date().toLocaleDateString('en-KE', { weekday: 'long', day: 'numeric', month: 'long' })}{d ? (waiting ? ` · ${waiting} thing${waiting === 1 ? '' : 's'} need${waiting === 1 ? 's' : ''} you` : ' · All calm') : ''}</p>
        </div>
        <Button kind="ghost" small onClick={load} disabled={busy}>{busy ? 'Refreshing...' : 'Refresh'}</Button>
      </div>
      {!online && <div className="note warn today-offline" role="status">You are offline. Showing nothing stored: staff screens always need a connection.</div>}
      <InstallBanner />
      {error && <div className="today-error"><ErrorNote>{error}</ErrorNote><Button kind="ghost" small onClick={load}>Try again</Button></div>}
      {!d && !error && (
        <div className="today-grid"><Skeleton height={120} /><Skeleton height={120} /><Skeleton height={120} /><Skeleton height={120} /></div>
      )}
      {d && (
        <>
          <Section title="Needs you">
            {cards.length === 0 ? (
              <Card><EmptyState icon="check" title="Nothing is waiting for you" text="When someone needs a decision from you, it shows up here." /></Card>
            ) : (
              <div className="today-grid">
                {cards.map((c) => (
                  <button key={c.key} type="button" className={`today-card ${c.count > 0 ? 'on' : 'calm'}`} onClick={() => (c.key === 'joins' ? openLink('staff:members?tab=requests') : s.go(c.page))}>
                    <span className="today-count">{c.count > 0 ? c.count : <Icon name="check" size={22} />}</span>
                    <span className="today-title">{c.title}</span>
                    <span className="today-hint">{c.count > 0 ? c.hint : 'All clear'}</span>
                  </button>
                ))}
              </div>
            )}
          </Section>

          {actions.length > 0 && (
            <Section title="Quick actions">
              <div className="qa-row">
                {actions.map((a) => (
                  <button key={a.id} type="button" className="qa" onClick={() => { openAction(a.page, a.action); s.go(a.page); }}>
                    <span className="qa-ico"><Icon name={a.icon} size={20} /></span>{a.label}
                  </button>
                ))}
              </div>
            </Section>
          )}

          <div className="today-cols">
            <Section title="Happening now" hint={happening ? undefined : `No ${w.manyLower} or classes today.`}>
              {happening > 0 && (
                <Card pad={false}>
                  <div className="today-list">
                    {d.services.map((v) => (
                      <button key={v.id} type="button" className="today-row" onClick={() => s.go('usher')}>
                        <span className="today-row-main">
                          <b>{v.name}</b>
                          <span className="tiny">{time(v.startsAt)}{v.branch ? ` · ${v.branch}` : ''} · {v.inPerson} in so far</span>
                        </span>
                        <StatusChip tone={STATE[v.state]?.tone ?? 'off'}>{STATE[v.state]?.label ?? v.state}</StatusChip>
                      </button>
                    ))}
                    {d.kids.map((k) => (
                      <button key={k.id} type="button" className="today-row" onClick={() => s.go('children')}>
                        <span className="today-row-main">
                          <b>{k.className}</b>
                          <span className="tiny">Children&apos;s class{k.branch ? ` · ${k.branch}` : ''}</span>
                        </span>
                        <StatusChip tone="done">{k.present} present</StatusChip>
                      </button>
                    ))}
                  </div>
                </Card>
              )}
            </Section>

            {recent.length > 0 && (
              <Section title="Recent">
                <Card pad={false}>
                  <ul className="feed">
                    {recent.map((n) => (
                      <li key={n.id} className={`${n.read ? '' : 'unread'} ${parseLink(n.link) ? 'feed-link' : ''}`}>
                        <span className="feed-dot" aria-hidden="true" />
                        {parseLink(n.link)
                          ? <button type="button" className="feed-btn" onClick={() => openLink(n.link)}><b>{n.title}</b>{n.body && <p>{n.body}</p>}<span className="tiny">{ago(n.created_at)} · <span className="feed-cta">{ctaLabel(n.link, n.kind)}</span></span></button>
                          : <div><b>{n.title}</b>{n.body && <p>{n.body}</p>}<span className="tiny">{ago(n.created_at)}</span></div>}
                      </li>
                    ))}
                  </ul>
                </Card>
              </Section>
            )}
          </div>
          <p className="tiny today-at">Updated {time(d.at)}</p>
        </>
      )}
    </div>
  );
}

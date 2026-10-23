import { useCallback, useEffect, useState } from 'react';
import { Button, Failed } from '@churchos/ui';
import { api, friendly, useSession } from './session';
import { openAction } from './prefill';
import { useOpenLink } from './links';
import { Icon, type IconName } from './icons';
import { Card, Section, Skeleton, StatusChip } from './ui';

type TodayData = {
  name: string;
  cards: { key: string; title: string; count: number; hint: string; page: string }[];
  services: { id: string; name: string; branch?: string; startsAt: string; state: 'before' | 'open' | 'closed'; inPerson: number }[];
  kids: { id: string; className: string; branch?: string; present: number }[];
  at: string;
};

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

/** The main things people do from here, in this order, each offered only to someone who may do it. At most four are shown. */
type Primary = { id: string; label: string; page: string; right: string; icon: IconName; action?: string };
const PRIMARY: Primary[] = [
  { id: 'add-member', label: 'Add member', page: 'members', right: 'members.edit', icon: 'people', action: 'add' },
  { id: 'send-message', label: 'Send message', page: 'messages', right: 'messages.send', icon: 'message', action: 'compose' },
  { id: 'record-cash', label: 'Record cash', page: 'cash', right: 'cash.count', icon: 'money' },
  { id: 'approve-expenses', label: 'Approve expenses', page: 'expenses', right: 'expenses.approve', icon: 'check' },
  { id: 'record-expense', label: 'Record an expense', page: 'expenses', right: 'expenses.record', icon: 'receipt', action: 'record' },
  { id: 'claim-expense', label: 'Claim an expense', page: 'my-claims', right: 'expenses.claim', icon: 'receipt', action: 'new' },
  { id: 'new-event', label: 'Create an event', page: 'events', right: 'events.manage', icon: 'worship', action: 'new' },
  { id: 'new-notice', label: 'Post a notice', page: 'notices', right: 'notices.manage', icon: 'communicate', action: 'new' },
];

/** The landing page for everyone: a greeting, only what needs you (or one calm line), the main actions, and what is on now. */
export function TodayPage() {
  const s = useSession();
  const [d, setD] = useState<TodayData | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const openLink = useOpenLink();

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
  const actions = PRIMARY.filter((a) => s.can(a.right)).slice(0, 4);
  const waiting = d ? d.cards.filter((c) => c.count > 0).sort((a, b) => b.count - a.count) : [];
  const happening = d ? d.services.length + d.kids.length : 0;

  return (
    <div className="today">
      <div className="u-ph-row today-head">
        <div className="u-ph-text">
          <h1>{greeting(name)}</h1>
          <p className="u-ph-sub">{new Date().toLocaleDateString('en-KE', { weekday: 'long', day: 'numeric', month: 'long' })}{d && waiting.length ? ` · ${waiting.length} thing${waiting.length === 1 ? '' : 's'} need${waiting.length === 1 ? 's' : ''} you` : ''}</p>
        </div>
        <Button kind="ghost" small onClick={load} disabled={busy}>{busy ? 'Refreshing...' : 'Refresh'}</Button>
      </div>
      {error && <div className="today-error"><Failed onRetry={load}>{error}</Failed></div>}
      {!d && !error && (
        <div className="today-grid"><Skeleton height={96} /><Skeleton height={96} /></div>
      )}
      {d && (
        <>
          {waiting.length === 0 ? (
            <div className="today-clear" role="status"><Icon name="check" size={20} /><span><b>All clear:</b> nothing needs you.</span></div>
          ) : (
            <Section title="Needs you">
              <div className="today-grid">
                {waiting.map((c) => (
                  <button key={c.key} type="button" className="today-card on" onClick={() => (c.key === 'joins' ? openLink('staff:members?tab=requests') : s.go(c.page))}>
                    <span className="today-count">{c.count}</span>
                    <span className="today-title">{c.title}</span>
                    <span className="today-hint">{c.hint}</span>
                  </button>
                ))}
              </div>
            </Section>
          )}

          {actions.length > 0 && (
            <div className="qa-row" role="group" aria-label="Main actions">
              {actions.map((a) => (
                <button key={a.id} type="button" className="qa" onClick={() => { if (a.action) openAction(a.page, a.action); s.go(a.page); }}>
                  <span className="qa-ico"><Icon name={a.icon} size={20} /></span>{a.label}
                </button>
              ))}
            </div>
          )}

          {happening > 0 && (
            <Section title="Happening now">
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
            </Section>
          )}
          <p className="tiny today-at">Updated {time(d.at)}</p>
        </>
      )}
    </div>
  );
}

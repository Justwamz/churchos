import { useState } from 'react';
import { Button, Card, ErrorNote, Note, kes, shortDate, useAsync } from '@churchos/ui';
import { api, useSession } from './session';
import { Load } from './bits';
import { CHANNEL_NAME, describeAudience } from './audience';
import { MessageStatus } from './MessageStatus';

const STATUS_TEXT: Record<string, string> = {
  sent: 'Delivered', skipped_no_balance: 'Not sent, wallet was short', skipped_opted_out: 'Chose not to get SMS',
  skipped_not_opted_in: 'Has not agreed to WhatsApp', skipped_no_phone: 'No phone on file', skipped_no_account: 'No app account', failed: 'The provider could not deliver',
};
const plural = (n: number) => `${n.toLocaleString()} ${n === 1 ? 'person' : 'people'}`;

/** Result summary straight after sending (from the send response summary). */
export function DeliveryResult({ summary }: { summary: any }) {
  if (!summary) return null;
  const c = summary.channels ?? {};
  const line = (name: string, x: any) => `${name}: ${plural(x.sent)} delivered${x.failed > 0 ? `, ${x.failed} could not be delivered` : ''}${x.noBalance > 0 ? `, ${x.noBalance} not sent because the wallet was short` : ''}.`;
  return (
    <div className="stack" style={{ gap: 6 }}>
      {c.inapp && <div>In-app: {plural(c.inapp.sent)} will see it{c.inapp.noAccount > 0 && ` (${c.inapp.noAccount} have no app account)`}.</div>}
      {c.sms && <div>{line('SMS', c.sms)}</div>}
      {c.whatsapp && <div>{line('WhatsApp', c.whatsapp)}</div>}
      <div><b>Cost: {kes(summary.cost ?? 0)}</b></div>
      <ShortWallets list={summary.shortWallets} />
    </div>
  );
}

export function ShortWallets({ list }: { list?: any[] }) {
  if (!list?.length) return null;
  return <>{list.map((w, i) => <Note key={i} tone="warn">{w.label} {CHANNEL_NAME[w.channel] ?? w.channel} wallet was short for {w.short} {w.short === 1 ? 'person' : 'people'}.</Note>)}</>;
}

export function CancelButton({ id, onDone, small }: { id: string; onDone: () => void; small?: boolean }) {
  const s = useSession();
  const [ask, setAsk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  if (!s.can('messages.send')) return null;
  const go = async () => {
    setBusy(true); setErr('');
    try { await api.post(`/messages/${id}/cancel` + s.qs({ branch: undefined }), {}); onDone(); }
    catch (e: any) { setErr(e.message || 'This message can no longer be cancelled'); }
    setBusy(false);
  };
  if (!ask) return <span onClick={(e) => e.stopPropagation()}><Button small={small} kind="ghost" onClick={() => setAsk(true)}>Cancel</Button></span>;
  return (
    <div className="stack" style={{ gap: 6 }} onClick={(e) => e.stopPropagation()}>
      <span className="tiny">Cancel this scheduled message? It will not be sent.</span>
      {err && <ErrorNote>{err}</ErrorNote>}
      <div className="row"><Button small kind="danger" disabled={busy} onClick={go}>{busy ? 'Cancelling...' : 'Yes, cancel it'}</Button><Button small kind="ghost" disabled={busy} onClick={() => { setAsk(false); setErr(''); }}>Keep it</Button></div>
    </div>
  );
}

export function MessageDetail({ id, onBack, onChanged }: { id: string; onBack: () => void; onChanged: () => void }) {
  const s = useSession();
  const d = useAsync<any>(() => api.get(`/messages/${id}` + s.qs({ branch: undefined })), [id]);
  const m = d.data;
  const byChannel: Record<string, any[]> = {};
  for (const r of m?.delivery ?? []) (byChannel[r.channel] ??= []).push(r);
  return (
    <div className="stack">
      <div><Button kind="ghost" small onClick={onBack}>Back to messages</Button></div>
      <Load loading={d.loading} error={d.error} hasData={!!m}>
        {m && (
          <>
            <Card title={m.title} action={<MessageStatus m={m} />}>
              <div className="stack">
                <p style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{m.body}</p>
                <div className="tiny">{describeAudience(m.audience, s.branches, m.group_name)}</div>
                <div className="tiny">{m.source === 'group_leader' ? 'Sent by a group leader' : `Sent by ${m.sender_name}`}{m.sent_at ? ` on ${shortDate(m.sent_at)}` : ''}</div>
                {m.status === 'scheduled' && <CancelButton id={m.id} onDone={() => { onChanged(); d.reload(); }} />}
              </div>
            </Card>
            {m.status === 'sent' && (
              <Card title="What happened">
                <div className="stack">
                  {m.summary?.people != null && <div><b>{plural(m.summary.people)}</b> in the audience. Cost: <b>{kes(m.summary.cost ?? 0)}</b>.</div>}
                  <ShortWallets list={m.summary?.shortWallets} />
                  {Object.entries(byChannel).map(([ch, rows]) => (
                    <div key={ch}>
                      <b>{CHANNEL_NAME[ch] ?? ch}</b>
                      {rows.map((r) => <div key={r.status} className="row between" style={{ fontSize: 14 }}><span>{STATUS_TEXT[r.status] ?? r.status}</span><span>{plural(r.people)}{r.cost > 0 && `, ${kes(r.cost)}`}</span></div>)}
                    </div>
                  ))}
                </div>
              </Card>
            )}
          </>
        )}
      </Load>
    </div>
  );
}

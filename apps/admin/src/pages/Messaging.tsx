import { useState } from 'react';
import { Badge, Button, Note, Table, kes, useAsync } from '@churchos/ui';
import { Card, EmptyState, PageHeader, Section, Stat, StatTiles, Toolbar } from '../ui';
import { Load, RefreshButton, ShowMore, api, num, usePaged, usePhone, type PageProps } from '../common';

const WSTATE: Record<string, { label: string; tone: any }> = { ok: { label: 'Healthy', tone: 'good' }, low: { label: 'Low', tone: 'warn' }, empty: { label: 'Empty', tone: 'bad' } };
const CHANNEL_LABEL: Record<string, string> = { sms: 'SMS', whatsapp: 'WhatsApp' };

export function Messaging(_: PageProps) {
  const s = useAsync(() => api.get<any>('/admin/messaging'));
  const [attention, setAttention] = useState(false);
  const phone = usePhone();
  const allOrgs: any[] = s.data?.organisations ?? [];
  const shownOrgs = allOrgs.filter((o) => !attention || (o.wallets ?? []).some((w: any) => w.state !== 'ok'));
  const paged = usePaged(shownOrgs, phone ? 4 : 10, String(attention));
  return (
    <>
      <PageHeader title="Messaging" subtitle="Church SMS and WhatsApp wallets, and what messaging earns the platform." actions={<RefreshButton onClick={s.reload} />} />
      <Load s={s} rows={3}>
        {(v: any) => {
          const orgs: any[] = paged.shown;
          const all: any[] = (v.organisations ?? []).flatMap((o: any) => o.wallets ?? []);
          const empty = all.filter((w) => w.state === 'empty').length;
          const low = all.filter((w) => w.state === 'low').length;
          const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
          const summary = empty + low === 0 ? 'All wallets are healthy.'
            : [empty ? `${empty} ${plural(empty, 'wallet is', 'wallets are')} empty` : '', low ? `${low} ${plural(low, 'is', 'are')} running low` : ''].filter(Boolean).join(', ') + '.';
          const rev = v.revenue ?? {};
          return (<>
            <Note tone={empty ? 'warn' : 'info'}>{summary} Church wallets are read-only here. Churches top up their own wallets.</Note>
            <div style={{ height: 16 }} />
            <StatTiles>
              <Stat label="SMS price per message" value={kes(v.rates?.sms)} hint="Default tariff, first band. See Tariffs." />
              <Stat label="WhatsApp price per message" value={kes(v.rates?.whatsapp)} hint="Default tariff, first band. See Tariffs." />
              <Stat label="SMS revenue to date" value={kes(rev.sms)} tone="good" />
              <Stat label="WhatsApp revenue to date" value={kes(rev.whatsapp)} tone="good" hint={`Total ${kes(num(rev.sms) + num(rev.whatsapp))}`} />
            </StatTiles>
            <Section title="Wallets">
              <Toolbar>
                <div className="chips">
                  <button type="button" className={`chip ${!attention ? 'on' : ''}`} onClick={() => setAttention(false)}>All wallets</button>
                  <button type="button" className={`chip ${attention ? 'on' : ''}`} onClick={() => setAttention(true)}>Low or empty ({empty + low})</button>
                </div>
              </Toolbar>
              {(v.organisations ?? []).length === 0 ? <Card><EmptyState icon="communicate" title="No churches yet" text="Wallets appear once a church signs up." /></Card> : (
                <div className="pa-stack">
                  {orgs.map((o) => {
                    const wallets: any[] = (o.wallets ?? []).filter((w: any) => !attention || w.state !== 'ok');
                    if (attention && wallets.length === 0) return null;
                    return (
                      <Card key={o.id} pad={false}>
                        <div className="pa-card-head">
                          <div className="pa-card-title"><h3>{o.name}</h3><Badge tone="info">{o.mode === 'per_branch' ? 'Per-branch wallets' : 'Shared wallets'}</Badge></div>
                          <span className="tiny">{num(o.messagesSent).toLocaleString()} messages sent</span>
                        </div>
                        {(o.wallets ?? []).length === 0 ? <EmptyState icon="wallet" title="No wallets yet" text="This church has not set up messaging." /> : phone ? (
                          <ul className="pa-wlist">
                            {wallets.map((w: any) => {
                              const st = WSTATE[w.state] ?? { label: String(w.state), tone: 'muted' };
                              return (
                                <li key={w.id} className={w.state === 'empty' ? 'row-bad' : w.state === 'low' ? 'row-warn' : undefined}>
                                  <div className="pa-w-top"><b>{w.label}</b><Badge tone={st.tone}>{st.label}</Badge></div>
                                  <div>{CHANNEL_LABEL[w.channel] ?? w.channel} · {kes(w.balance)} · {num(w.messagesLeft).toLocaleString()} left</div>
                                  <div className="tiny">Warns below {kes(w.threshold)} · Paybill reference <code>{w.paybillReference}</code></div>
                                </li>
                              );
                            })}
                          </ul>
                        ) : (
                          <Table head={['Wallet', 'Channel', 'Balance', 'Messages left', 'State', 'Warns below', 'Paybill reference']}>
                            {wallets.map((w: any) => {
                              const st = WSTATE[w.state] ?? { label: String(w.state), tone: 'muted' };
                              return (
                                <tr key={w.id} className={w.state === 'empty' ? 'row-bad' : w.state === 'low' ? 'row-warn' : undefined}>
                                  <td><b>{w.label}</b></td>
                                  <td>{CHANNEL_LABEL[w.channel] ?? w.channel}</td>
                                  <td className="num">{kes(w.balance)}</td>
                                  <td className="num">{num(w.messagesLeft).toLocaleString()}</td>
                                  <td><Badge tone={st.tone}>{st.label}</Badge></td>
                                  <td className="num">{kes(w.threshold)}</td>
                                  <td><code>{w.paybillReference}</code></td>
                                </tr>
                              );
                            })}
                          </Table>
                        )}
                      </Card>
                    );
                  })}
                  <ShowMore paged={paged} noun="churches" />
                </div>
              )}
            </Section>
          </>);
        }}
      </Load>
    </>
  );
}

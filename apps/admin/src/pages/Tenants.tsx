import { useState } from 'react';
import { computeFee, DEFAULT_FEE_SCHEDULE, type FeeSchedule, type PaymentMethod } from '@churchos/shared';
import { Badge, Button, ErrorNote, Field, HistoryButton, Note, Table, kes, useAsync } from '@churchos/ui';
import { Card, EmptyState, PageHeader, Section, SidePanel } from '../ui';
import { Load, METHOD_LABEL, api, errText, num, type PageProps, type Toast } from '../common';
import { MessagingPlan } from '../MessagingAdmin';

const METHODS: PaymentMethod[] = ['mpesa', 'airtel', 'tkash', 'card', 'cash'];
const centsOf = (kesStr: string) => Math.round(Number(kesStr || 0) * 100);

export function Tenants({ toast }: PageProps) {
  const t = useAsync(() => api.get<any[]>('/admin/tenants'));
  const tariffs = useAsync(() => api.get<any[]>('/admin/tariffs'));
  const [tab, setTab] = useState('churches');
  const [feeOrg, setFeeOrg] = useState('');
  const [plan, setPlan] = useState<any>();
  const editFees = (id: string) => { setFeeOrg(id); setTab('fees'); window.scrollTo(0, 0); };

  return (
    <>
      <PageHeader title="Tenants and fees" subtitle="Churches on the platform, their balances, and what each one is charged."
        actions={<Button kind="ghost" onClick={() => { t.reload(); tariffs.reload(); }}>Refresh</Button>}
        tabs={[{ id: 'churches', label: 'Churches' }, { id: 'fees', label: 'Fees' }]} tab={tab} onTab={setTab} />
      <Load s={t} rows={3}>
        {(orgs) => orgs.length === 0 ? <Card><EmptyState icon="building" title="No organisations yet" text="Churches appear here once they sign up." /></Card> : tab === 'churches' ? (
          <div className="pa-stack">
            {orgs.map((o) => (
              <Card key={o.id} pad={false}>
                <div className="pa-card-head">
                  <div className="pa-card-title"><h3>{o.name}</h3><Badge tone="info">{o.feeBearer === 'member' ? 'Member pays on top' : 'Church absorbs'}</Badge></div>
                  <div className="pa-card-actions">
                    <HistoryButton api={api} base="/admin/audit" entity="fee_schedule" entityId={o.id} title={`${o.name} fees`} label="Fee history" />
                    {(tariffs.data ?? []).length > 0 && <Button kind="ghost" small onClick={() => setPlan(o)}>Messaging plan</Button>}
                    <Button small onClick={() => editFees(o.id)}>Edit fees</Button>
                  </div>
                </div>
                <Table head={['Branch', 'Code', 'In 48h hold', 'Ready to pay out', 'Owed to us', 'Payouts']}>
                  {o.branches.map((b: any) => (
                    <tr key={b.id}>
                      <td>{b.name}<div className="tiny">{b.region}</div></td><td>{b.code}</td>
                      <td className="num">{kes(b.pending)}</td><td className="num">{kes(b.available)}</td><td className="num">{kes(b.receivable)}</td>
                      <td>{b.payout_paused ? <Badge tone="bad">Paused</Badge> : <Badge tone="good">Active</Badge>}</td>
                    </tr>
                  ))}
                </Table>
              </Card>
            ))}
          </div>
        ) : (
          <>
            <Note>Percentages are in basis points: 100 bps = 1%, so 150 = 1.5%. Fixed amounts and tier limits are entered in KES.</Note>
            <div style={{ height: 16 }} />
            <Toolbar2 orgs={orgs} value={feeOrg || orgs[0].id} onChange={setFeeOrg} />
            {(() => { const org = orgs.find((o) => o.id === (feeOrg || orgs[0].id)) ?? orgs[0]; return <FeeEditor key={org.id} org={org} toast={toast} onSaved={t.reload} />; })()}
          </>
        )}
      </Load>
      {plan && (
        <SidePanel title="Messaging plan" subtitle={plan.name} onClose={() => setPlan(undefined)}>
          <MessagingPlan org={plan} tariffs={tariffs.data ?? []} toast={toast} onSaved={() => { t.reload(); }} />
        </SidePanel>
      )}
    </>
  );
}

function Toolbar2({ orgs, value, onChange }: { orgs: any[]; value: string; onChange: (id: string) => void }) {
  return (
    <div className="pa-picker">
      <label className="field-label" htmlFor="fee-org">Church</label>
      <select id="fee-org" value={value} onChange={(e) => onChange(e.target.value)}>
        {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
      </select>
    </div>
  );
}

function FeeEditor({ org, toast, onSaved }: { org: any; toast: Toast; onSaved: () => void }) {
  const init: FeeSchedule = org.feeSchedule ?? DEFAULT_FEE_SCHEDULE;
  const [bearer, setBearer] = useState<'church' | 'member'>(org.feeBearer ?? 'church');
  const [kind, setKind] = useState<'flat' | 'tiered'>(init.platform.type);
  const [flat, setFlat] = useState(String(init.platform.type === 'flat' ? init.platform.bps : 150));
  const [tiers, setTiers] = useState<{ upTo: string; bps: string }[]>(
    init.platform.type === 'tiered'
      ? init.platform.tiers.map((x) => ({ upTo: x.upTo === null ? '' : String(num(x.upTo) / 100), bps: String(x.bps) }))
      : [{ upTo: '10000', bps: '200' }, { upTo: '', bps: '150' }],
  );
  const [psp, setPsp] = useState<Record<string, { bps: string; fixed: string }>>(
    Object.fromEntries(METHODS.map((m) => [m, { bps: String(init.psp?.[m]?.bps ?? 0), fixed: String((num(init.psp?.[m]?.fixed)) / 100) }])),
  );
  const [feeReason, setFeeReason] = useState('');
  const [err, setErr] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [pv, setPv] = useState<string>('mpesa');

  const schedule: FeeSchedule = {
    platform: kind === 'flat'
      ? { type: 'flat', bps: Number(flat) }
      : { type: 'tiered', tiers: tiers.map((x, i) => ({ upTo: i === tiers.length - 1 ? null : centsOf(x.upTo), bps: Number(x.bps) })) },
    psp: Object.fromEntries(METHODS.map((m) => [m, { bps: Number(psp[m].bps), fixed: centsOf(psp[m].fixed) }])) as FeeSchedule['psp'],
  };

  const save = async () => {
    setBusy(true); setErr(undefined);
    try {
      await api.put(`/admin/tenants/${org.id}/fees`, { feeBearer: bearer, feeSchedule: schedule, reason: feeReason.trim() || undefined });
      toast(`Fees saved for ${org.name}`);
      onSaved();
    } catch (e: any) { setErr(errText(e)); }
    setBusy(false);
  };

  const preview = (m: PaymentMethod, amountKes: number) => {
    try { return computeFee(schedule, m, amountKes * 100, bearer); } catch { return null; }
  };

  return (
    <div className="pa-stack">
      <div className="pa-two">
        <Card>
          <h3 className="pa-h">Who pays the fee?</h3>
          <div className="pa-choices">
            <label><input type="radio" checked={bearer === 'church'} onChange={() => setBearer('church')} /> Church absorbs (member pays the gift amount, church receives less)</label>
            <label><input type="radio" checked={bearer === 'member'} onChange={() => setBearer('member')} /> Member pays on top (church receives the full gift)</label>
          </div>
          <h3 className="pa-h">Platform fee (what ChurchOS earns)</h3>
          <div className="pa-choices inline">
            <label><input type="radio" checked={kind === 'flat'} onChange={() => setKind('flat')} /> Flat</label>
            <label><input type="radio" checked={kind === 'tiered'} onChange={() => setKind('tiered')} /> Tiered by amount</label>
          </div>
          {kind === 'flat' ? (
            <Field label="Platform fee (bps)" hint={`${(Number(flat) / 100).toFixed(2)}% of each gift`}><input inputMode="numeric" value={flat} onChange={(e) => setFlat(e.target.value)} /></Field>
          ) : (
            <div className="pa-tiers">
              {tiers.map((x, i) => {
                const last = i === tiers.length - 1;
                return (
                  <div key={i} className="pa-tier">
                    <div>
                      {last ? <input disabled value="and above" aria-label="Last tier covers everything above" /> : <input inputMode="decimal" placeholder="Up to (KES)" aria-label={`Tier ${i + 1} up to (KES)`} value={x.upTo} onChange={(e) => setTiers(tiers.map((y, j) => j === i ? { ...y, upTo: e.target.value } : y))} />}
                    </div>
                    <div><input inputMode="numeric" placeholder="bps" aria-label={`Tier ${i + 1} bps`} value={x.bps} onChange={(e) => setTiers(tiers.map((y, j) => j === i ? { ...y, bps: e.target.value } : y))} /></div>
                    {tiers.length > 1 ? <Button kind="ghost" small onClick={() => setTiers(tiers.filter((_, j) => j !== i))}>Remove</Button> : <span />}
                  </div>
                );
              })}
              <div><Button kind="ghost" small onClick={() => setTiers([...tiers.slice(0, -1), { upTo: '', bps: '150' }, tiers[tiers.length - 1]])}>Add a tier</Button></div>
              <div className="tiny">Each row applies to gifts up to that amount. The last row covers everything above.</div>
            </div>
          )}
        </Card>
        <Card pad={false}>
          <h3 className="pa-h pad">Provider cost (what the payment provider charges)</h3>
          <Table head={['Method', 'bps', 'Fixed (KES)']}>
            {METHODS.map((m) => (
              <tr key={m}>
                <td>{METHOD_LABEL[m]}</td>
                <td><input inputMode="numeric" aria-label={`${METHOD_LABEL[m]} bps`} value={psp[m].bps} onChange={(e) => setPsp({ ...psp, [m]: { ...psp[m], bps: e.target.value } })} /></td>
                <td><input inputMode="decimal" aria-label={`${METHOD_LABEL[m]} fixed fee in KES`} value={psp[m].fixed} onChange={(e) => setPsp({ ...psp, [m]: { ...psp[m], fixed: e.target.value } })} /></td>
              </tr>
            ))}
          </Table>
        </Card>
      </div>

      <Section title="Live preview" action={
        <select value={pv} onChange={(e) => setPv(e.target.value)} aria-label="Preview method">
          <option value="all">All methods</option>
          {METHODS.map((m) => <option key={m} value={m}>{METHOD_LABEL[m]}</option>)}
        </select>}>
        <Card pad={false}>
          <Table head={['Method', 'Gift', 'Member pays', 'Platform fee', 'Provider cost', 'Church receives']}>
            {METHODS.filter((m) => pv === 'all' || m === pv).flatMap((m) => [100, 1000, 10000].map((a) => {
              const r = preview(m, a);
              return (
                <tr key={m + a}>
                  <td>{METHOD_LABEL[m]}</td><td className="num">{kes(a * 100)}</td>
                  {r ? (<><td className="num">{kes(r.amountPaid)}</td><td className="num">{kes(r.platformFee)}</td><td className="num">{kes(r.pspCost)}</td><td className="num"><b>{kes(r.netToChurch)}</b></td></>)
                    : <td colSpan={4} className="tiny">Enter valid numbers to preview</td>}
                </tr>
              );
            }))}
          </Table>
        </Card>
      </Section>

      <Card>
        <div className="pa-reason"><Field label="Fee change reason (optional)" hint="Recorded in the audit log with this change."><input value={feeReason} onChange={(e) => setFeeReason(e.target.value)} /></Field></div>
        {err && <ErrorNote>{err}</ErrorNote>}
        <div className="pa-actions start">
          <Button onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save fees'}</Button>
          <span className="tiny">Applies to new payments only.</span>
        </div>
      </Card>
    </div>
  );
}

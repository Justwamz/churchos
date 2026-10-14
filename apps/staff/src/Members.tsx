import { useEffect, useState } from 'react';
import { Badge, Button, Card, Empty, Note, StatusBadge, Table, phonePretty, shortDate, useAsync, useToast } from '@churchos/ui';
import { api, friendly, useSession } from './session';
import { Load, PageHead } from './bits';
import { HouseholdModal, MemberFormModal, useDebounced } from './MemberForm';
import { MemberRecords } from './Records';
import { MemberNumberSettings, type NumberSettings } from './MemberNumberSettings';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** 'MM-DD' to '14 Jun'. */
export const birthdayText = (b: string | null | undefined) => {
  const m = /^(\d{2})-(\d{2})$/.exec(b ?? '');
  return m ? `${Number(m[2])} ${MONTHS[Number(m[1]) - 1] ?? ''}` : '-';
};

function Insights({ onEdit }: { onEdit: (id: string) => void }) {
  const s = useSession();
  const d = useAsync<any>(() => api.get('/members/insights' + s.qs()), [s.qs()]);
  const x = d.data;
  const empty = x && !x.birthdays.length && !x.turningEighteen.length && !x.needsOwnPhone.length;
  return (
    <Card title="Insights">
      <Load loading={d.loading} error={d.error} hasData={!!x}>
        {x && (empty ? <Empty>All calm. No birthdays this week and nothing needs attention.</Empty> : (
          <div className="grid cols-3">
            {x.birthdays.length > 0 && (
              <div><h4 style={{ margin: '0 0 6px' }}>Birthdays this week</h4>
                {x.birthdays.map((b: any) => (
                  <div key={b.id} className="row between" style={{ fontSize: 14 }}><span>{b.full_name}</span>
                    <span>{b.days_away === 0 ? <Badge tone="good">Today!</Badge> : birthdayText(b.birthday)}</span></div>
                ))}</div>
            )}
            {x.turningEighteen.length > 0 && (
              <div><h4 style={{ margin: '0 0 6px' }}>Turning 18 soon</h4>
                {x.turningEighteen.map((c: any) => (
                  <div key={c.id} className="row between" style={{ fontSize: 14 }}><span>{c.full_name}</span>
                    <span className="tiny">{c.days_until_18 <= 0 ? 'today' : `in ${c.days_until_18} day${c.days_until_18 === 1 ? '' : 's'}`}</span></div>
                ))}</div>
            )}
            {x.needsOwnPhone.length > 0 && (
              <div><h4 style={{ margin: '0 0 6px' }}>Needs their own phone number</h4>
                {x.needsOwnPhone.map((a: any) => (
                  <div key={a.id} className="row between" style={{ fontSize: 14 }}>
                    <span>{a.full_name}<br /><span className="tiny">{a.guardians?.length ? `Guardians: ${a.guardians.map((g: any) => g.full_name).join(', ')}` : ''}</span></span>
                    {s.can('members.edit') && <Button small kind="ghost" onClick={() => onEdit(a.id)}>Edit</Button>}
                  </div>
                ))}</div>
            )}
          </div>
        ))}
      </Load>
    </Card>
  );
}

function MemberRows({ members, household, canEdit, canRecords, onRecords, onEdit, onHousehold, onPrimary }: {
  members: any[]; household?: any; canEdit: boolean; canRecords: boolean; onRecords: (m: any) => void; onEdit: (m: any) => void; onHousehold: (m: any) => void; onPrimary: (h: any, m: any) => void;
}) {
  return (
    <Table head={['Name', 'Type', 'Age', 'Birthday', 'Sex', 'Member no.', 'Branch', 'Contact', ...(canEdit || canRecords ? [''] : [])]}>
      {members.map((m) => (
        <tr key={m.id}>
          <td><b>{m.full_name}</b>{m.is_primary_contact && <> <Badge tone="info">Primary contact</Badge></>}</td>
          <td><Badge tone={m.category === 'child' ? 'warn' : 'muted'}>{m.category === 'child' ? 'Child' : 'Adult'}</Badge></td>
          <td>{m.age_band ?? '-'}{m.age != null && <span className="tiny"> ({m.age})</span>}</td>
          <td>{birthdayText(m.birthday)}</td>
          <td>{m.sex === 'male' ? 'Male' : m.sex === 'female' ? 'Female' : '-'}</td>
          <td className="mono">{m.member_number}</td>
          <td>{m.branch_name}</td>
          <td>
            {m.category === 'child' ? (
              <>
                <div>Guardians: {m.guardians?.length ? m.guardians.map((g: any) => g.full_name).join(', ') : '-'}</div>
                <div className="tiny">Contact: {m.contact_phones?.length ? m.contact_phones.map(phonePretty).join(', ') : '-'}</div>
              </>
            ) : m.phone ? phonePretty(m.phone) : <Badge tone="warn">Needs own phone</Badge>}
          </td>
          {(canEdit || canRecords) && (
            <td><div className="row" style={{ flexWrap: 'nowrap', gap: 6 }}>
              {canEdit && <Button small kind="ghost" onClick={() => onEdit(m)}>Edit</Button>}
              {canEdit && <Button small kind="ghost" onClick={() => onHousehold(m)}>Household</Button>}
              {canRecords && <Button small kind="ghost" onClick={() => onRecords(m)}>Records</Button>}
              {canEdit && household && m.category === 'adult' && !m.is_primary_contact && <Button small kind="ghost" onClick={() => onPrimary(household, m)}>Set primary contact</Button>}
            </div></td>
          )}
        </tr>
      ))}
    </Table>
  );
}

export function Members() {
  const s = useSession();
  const toast = useToast();
  const [q, setQ] = useState('');
  const dq = useDebounced(q.trim());
  const d = useAsync<any>(() => api.get('/members/grouped' + s.qs({ q: dq || undefined })), [s.qs(), dq]);
  const settings = useAsync<NumberSettings>(() => api.get('/members/settings' + s.qs({ branch: undefined })), [s.qs()]);
  const canEdit = s.can('members.edit');
  const [form, setForm] = useState<{ member?: any } | null>(null);
  const [hhFor, setHhFor] = useState<any>(null);
  const [recFor, setRecFor] = useState<any>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [insightsKey, setInsightsKey] = useState(0);

  const refresh = () => { d.reload(); settings.reload(); setInsightsKey((k) => k + 1); };
  const all: any[] = (d.data?.households ?? []).flatMap((h: any) => h.members).concat(d.data?.individuals ?? []);
  const isOpen = (id: string) => open[id] ?? !!dq;
  useEffect(() => { setOpen({}); }, [dq]);

  const editById = (id: string) => {
    const m = all.find((x: any) => x.id === id);
    if (m) setForm({ member: m });
    else api.get('/members' + s.qs()).then((r: any[]) => { const f = r.find((x) => x.id === id); if (f) setForm({ member: f }); }).catch((e) => toast.show(friendly(e.message), 'bad'));
  };
  const setPrimary = async (h: any, m: any) => {
    try { await api.put(`/households/${h.id}/primary-contact` + s.qs({ branch: undefined }), { membershipId: m.id }); toast.show(`${m.full_name} is now the primary contact.`); refresh(); }
    catch (e: any) { toast.show(friendly(e.message), 'bad'); }
  };
  const setAll = (v: boolean) => setOpen(Object.fromEntries((d.data?.households ?? []).map((h: any) => [h.id, v])));

  const rowProps = { canEdit, canRecords: s.can('records.view'), onRecords: setRecFor, onEdit: (m: any) => setForm({ member: m }), onHousehold: setHhFor, onPrimary: setPrimary };
  const t = d.data?.totals;

  return (
    <>
      <PageHead title="Members" sub="Your church family." action={canEdit && <Button onClick={() => setForm({})}>Add member</Button>} />
      <div className="stack">
        <Insights key={insightsKey} onEdit={editById} />
        <Card>
          <input style={{ width: '100%' }} aria-label="Search members" placeholder="Search by name, member number or phone" value={q} onChange={(e) => setQ(e.target.value)} />
          {t && <div className="tiny" style={{ marginTop: 8 }}>{dq ? 'Found ' : ''}{t.households} household{t.households === 1 ? '' : 's'} and {t.members} {t.members === 1 ? 'person' : 'people'}{dq ? ' matching your search' : ''}.</div>}
        </Card>
        <Load loading={d.loading} error={d.error} hasData={!!d.data}>
          {d.data && (
            <>
              <Card title="Households" action={d.data.households.length > 0 && <div className="row"><Button small kind="ghost" onClick={() => setAll(true)}>Expand all</Button><Button small kind="ghost" onClick={() => setAll(false)}>Collapse all</Button></div>}>
                {d.data.households.length === 0 ? <Empty>{dq ? 'No households match your search.' : 'No households yet.'}</Empty> : (
                  <div className="stack" style={{ gap: 8 }}>
                    {d.data.households.map((h: any) => (
                      <details key={h.id} open={isOpen(h.id)} onToggle={(e) => { const o = (e.currentTarget as HTMLDetailsElement).open; if (o !== isOpen(h.id)) setOpen((p) => ({ ...p, [h.id]: o })); }} style={{ border: '1px solid var(--line)', borderRadius: 12, padding: '4px 12px' }}>
                        <summary style={{ cursor: 'pointer', padding: '8px 0', display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                          <b>{h.label}</b>
                          <span className="tiny">{h.members.length} member{h.members.length === 1 ? '' : 's'}</span>
                          <span className="chips" style={{ gap: 4 }}>
                            {h.members.slice(0, 3).map((m: any) => <Badge key={m.id}>{m.full_name}</Badge>)}
                            {h.members.length > 3 && <Badge>+{h.members.length - 3}</Badge>}
                          </span>
                        </summary>
                        {isOpen(h.id) && <div style={{ paddingBottom: 8 }}><MemberRows members={h.members} household={h} {...rowProps} /></div>}
                      </details>
                    ))}
                  </div>
                )}
              </Card>
              {d.data.individuals.length > 0 && (
                <Card title="Not in a household"><MemberRows members={d.data.individuals} {...rowProps} /></Card>
              )}
            </>
          )}
        </Load>
        <MemberNumberSettings settings={settings} reload={refresh} />
      </div>
      {form && <MemberFormModal member={form.member} nextPreview={settings.data?.preview} onClose={() => setForm(null)} onDone={refresh} />}
      {hhFor && <HouseholdModal member={hhFor} onClose={() => setHhFor(null)} onDone={(msg) => { toast.show(msg); refresh(); }} />}
      {recFor && <MemberRecords member={recFor} onClose={() => setRecFor(null)} />}
      {toast.node}
    </>
  );
}

export function Transfers() {
  const d = useAsync<any[]>(() => api.get('/transfers'), []);
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const decide = async (id: string, approve: boolean) => {
    setBusy(id);
    try {
      await api.post(`/transfers/${id}/decide`, { approve });
      toast.show(approve ? 'Transfer approved.' : 'Transfer rejected.');
      d.reload();
    } catch (e: any) { toast.show(friendly(e.message), 'bad'); }
    setBusy(null);
  };
  return (
    <>
      <PageHead title="Transfers" sub="Members asking to join your branches." />
      <Note tone="info">Moving between branches of the same church keeps the member number. Moving to a different church gives the member a new number there, and the old membership is closed, not deleted.</Note>
      <Load loading={d.loading} error={d.error} hasData={!!d.data}>
        <div style={{ marginTop: 12 }}>
          <Card>
            {!d.data || d.data.length === 0 ? <Empty>No transfer requests.</Empty> : (
              <Table head={['Requested', 'Member', 'From', 'To', 'Status', '']}>
                {d.data.map((t) => (
                  <tr key={t.id}>
                    <td>{shortDate(t.created_at)}</td>
                    <td><b>{t.full_name}</b> <span className="tiny">{t.member_number}</span></td>
                    <td>{t.from_name}</td><td>{t.to_name}</td>
                    <td><StatusBadge status={t.status} />{t.to_org_id && t.org_id && t.to_org_id !== t.org_id && <> <Badge tone="info">Other church</Badge></>}</td>
                    <td>{t.status === 'requested' && (
                      <div className="row" style={{ flexWrap: 'nowrap' }}>
                        <Button small disabled={busy === t.id} onClick={() => decide(t.id, true)}>Approve</Button>
                        <Button small kind="ghost" disabled={busy === t.id} onClick={() => decide(t.id, false)}>Reject</Button>
                      </div>
                    )}</td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>
        </div>
      </Load>
      {toast.node}
    </>
  );
}

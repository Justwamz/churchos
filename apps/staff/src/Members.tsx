import { useEffect, useState } from 'react';
import { Button, ErrorNote, Note, shortDate, useAsync, useToast } from '@churchos/ui';
import { api, friendly, useSession } from './session';
import { Hist } from './bits';
import { MemberPhone } from './Reveal';
import { Gate, HouseholdModal, MemberFormModal, initials, useDebounced } from './MemberForm';
import { MemberRecords } from './Records';
import { GivingRecordModal } from './GivingRecord';
import { ConsentDialog } from './ConsentDialog';
import { usePrefill } from './prefill';
import { useLinkParams } from './links';
import { JoinRequests } from './JoinRequests';
import { MemberNumberSettings, type NumberSettings } from './MemberNumberSettings';
import { Icon } from './icons';
import { Card, EmptyState, PageHeader, SidePanel, Skeleton, Stat, StatTiles, StatusChip, Toolbar } from './ui';
import './people.css';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** 'MM-DD' to '14 Jun'. */
export const birthdayText = (b: string | null | undefined) => {
  const m = /^(\d{2})-(\d{2})$/.exec(b ?? '');
  return m ? `${Number(m[2])} ${MONTHS[Number(m[1]) - 1] ?? ''}` : '-';
};

type Tab = 'all' | 'households' | 'birthdays' | 'attention' | 'requests' | 'numbers';

function Avatar({ m, sm }: { m: any; sm?: boolean }) {
  return <span className={`pp-avatar ${m.category === 'child' ? 'child' : ''} ${sm ? 'sm' : ''}`} aria-hidden="true">{initials(m.full_name)}</span>;
}

function Chips({ m }: { m: any }) {
  return (
    <>
      {m.is_primary_contact && <StatusChip tone="info">Primary contact</StatusChip>}
      {m.category === 'child' && <StatusChip tone="wait">Child</StatusChip>}
      {m.category !== 'child' && !m.phone && <StatusChip tone="wait">Needs own phone</StatusChip>}
    </>
  );
}

const subline = (m: any) => [m.member_number, m.branch_name, m.age != null ? `${m.age} yrs` : m.age_band].filter(Boolean).join(' · ');

function Detail({ m, household, canEdit, canRecords, canGiving, onClose, onOpen, onAct, onPrimary }: {
  m: any; household?: any; canEdit: boolean; canRecords: boolean; canGiving: boolean; onClose: () => void; onOpen: (m: any) => void;
  onAct: (kind: 'edit' | 'household' | 'consent' | 'records' | 'giving', m: any) => void; onPrimary: (h: any, m: any) => void;
}) {
  const others = (household?.members ?? []).filter((x: any) => x.id !== m.id);
  return (
    <SidePanel title={m.full_name} subtitle={subline(m)} onClose={onClose}
      footer={canEdit ? <><Button onClick={() => onAct('edit', m)}>Edit details</Button><Button kind="ghost" onClick={() => onAct('consent', m)}>Message choices</Button></> : undefined}>
      <div className="pp-psec">
        <div className="pp-row-flex"><Chips m={m} />{m.category !== 'child' && m.phone && <StatusChip tone="off">Adult</StatusChip>}</div>
      </div>
      <div className="pp-psec">
        <h3>Contact</h3>
        <dl className="pp-dl">
          <div><dt>Phone</dt><dd>{m.category === 'child' || m.phone ? <MemberPhone member={m} /> : <StatusChip tone="wait">Needs own phone</StatusChip>}</dd></div>
          <div><dt>Branch</dt><dd>{m.branch_name || '-'}</dd></div>
          <div><dt>Birthday</dt><dd>{birthdayText(m.birthday)}{m.age != null && <span className="pp-tiny"> ({m.age} yrs)</span>}</dd></div>
          <div><dt>Sex</dt><dd>{m.sex === 'male' ? 'Male' : m.sex === 'female' ? 'Female' : '-'}</dd></div>
          <div><dt>Member no.</dt><dd className="pp-mono">{m.member_number}</dd></div>
        </dl>
      </div>
      <div className="pp-psec">
        <h3>Household</h3>
        {household ? (
          <>
            <b>{household.label}</b>
            {others.length === 0 ? <p className="pp-note">No one else is in this household.</p> : (
              <div className="pp-stack tight">
                {others.map((x: any) => (
                  <button type="button" key={x.id} className="pp-pick" onClick={() => onOpen(x)}>
                    <b>{x.full_name}</b><span className="pp-tiny">{x.category === 'child' ? 'Child' : 'Adult'}{x.is_primary_contact ? ' · Primary contact' : ''}</span>
                  </button>
                ))}
              </div>
            )}
          </>
        ) : <p className="pp-note">Not in a household.</p>}
        {canEdit && (
          <div className="pp-actions">
            <Button small kind="ghost" onClick={() => onAct('household', m)}>{household ? 'Change household' : 'Add to a household'}</Button>
            {household && m.category === 'adult' && !m.is_primary_contact && <Button small kind="ghost" onClick={() => onPrimary(household, m)}>Set primary contact</Button>}
          </div>
        )}
      </div>
      {(canGiving && m.category !== 'child') || canRecords ? (
        <div className="pp-psec">
          <h3>Giving and records</h3>
          <div className="pp-actions">
            {canGiving && m.category !== 'child' && <Button small kind="ghost" onClick={() => onAct('giving', m)}>Giving record</Button>}
            {canRecords && <Button small kind="ghost" onClick={() => onAct('records', m)}>Baptism and marriage records</Button>}
          </div>
        </div>
      ) : null}
      <div className="pp-psec">
        <h3>History</h3>
        <div className="pp-hist"><span className="pp-note">Who changed this member's details, and when.</span><Hist entity="membership" entityId={m.id} title={m.full_name} /></div>
      </div>
    </SidePanel>
  );
}

function HouseCard({ h, open, onToggle, onPick }: { h: any; open: boolean; onToggle: () => void; onPick: (m: any) => void }) {
  return (
    <div className={`pp-home ${open ? 'open' : ''}`}>
      <button type="button" className="pp-home-head" aria-expanded={open} onClick={onToggle}>
        <span className="pp-avatar home" aria-hidden="true"><Icon name="building" size={20} /></span>
        <div><div className="pp-name">{h.label}</div><div className="pp-sub">{h.members.length} {h.members.length === 1 ? 'person' : 'people'}{!open && ` · ${h.members.slice(0, 3).map((m: any) => m.full_name.split(' ')[0]).join(', ')}${h.members.length > 3 ? '…' : ''}`}</div></div>
        <span className="pp-side">{h.members.some((m: any) => m.category === 'child') && <StatusChip tone="wait">Has children</StatusChip>}</span>
        <Icon name="chevron" size={18} className="pp-chev" />
      </button>
      {open && (
        <div className="pp-kids">
          {h.members.map((m: any) => (
            <button type="button" key={m.id} className="pp-kid" onClick={() => onPick(m)}>
              <Avatar m={m} sm />
              <div><div className="pp-name">{m.full_name}</div><div className="pp-sub">{m.category === 'child' ? 'Child' : 'Adult'} · {m.member_number}</div></div>
              <span className="pp-side">{m.is_primary_contact && <StatusChip tone="info">Primary contact</StatusChip>}{m.category !== 'child' && !m.phone && <StatusChip tone="wait">Needs own phone</StatusChip>}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function Members() {
  const s = useSession();
  const toast = useToast();
  const [q, setQ] = useState('');
  usePrefill('members', setQ);
  const dq = useDebounced(q.trim());
  const d = useAsync<any>(() => api.get('/members/grouped' + s.qs({ q: dq || undefined })), [s.qs(), dq]);
  const insights = useAsync<any>(() => api.get('/members/insights' + s.qs()), [s.qs()]);
  const settings = useAsync<NumberSettings>(() => api.get('/members/settings' + s.qs({ branch: undefined })), [s.qs()]);
  const canEdit = s.can('members.edit');
  const [tab, setTab] = useState<Tab>('all');
  const link = useLinkParams('members');
  useEffect(() => { if (link?.tab === 'requests') setTab('requests'); }, [link]);
  const joins = useAsync<{ pending: number }>(() => api.get('/members/join-requests' + s.qs({ status: 'pending' })), [s.qs()]);
  const pendingJoins = joins.data?.pending ?? 0;
  const [sel, setSel] = useState<any>(null);
  const [modal, setModal] = useState<{ kind: 'form' | 'household' | 'consent' | 'records' | 'giving'; member?: any } | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});

  const refresh = () => { d.reload(); settings.reload(); insights.reload(); };
  const households: any[] = d.data?.households ?? [];
  const individuals: any[] = d.data?.individuals ?? [];
  const all: any[] = households.flatMap((h) => h.members).concat(individuals);
  const sorted = [...all].sort((a, b) => a.full_name.localeCompare(b.full_name));
  const isOpen = (id: string) => open[id] ?? true;
  useEffect(() => { setOpen({}); }, [dq]);

  const x = insights.data;
  const attention: any[] = x?.needsOwnPhone ?? [];
  const bdays: any[] = x?.birthdays ?? [];
  const eighteen: any[] = x?.turningEighteen ?? [];
  const t = d.data?.totals;

  const selM = sel ? all.find((m) => m.id === sel.id) ?? sel : null;
  const selHouse = selM?.household_id ? households.find((h) => h.id === selM.household_id) : undefined;
  const openById = (id: string) => {
    const m = all.find((z) => z.id === id);
    if (m) setSel(m);
    else api.get('/members' + s.qs()).then((r: any[]) => { const f = r.find((z) => z.id === id); if (f) setSel(f); }).catch((e) => toast.show(friendly(e.message), 'bad'));
  };
  const setPrimary = async (h: any, m: any) => {
    try { await api.put(`/households/${h.id}/primary-contact` + s.qs({ branch: undefined }), { membershipId: m.id }); toast.show(`${m.full_name} is now the primary contact.`); refresh(); }
    catch (e: any) { toast.show(friendly(e.message), 'bad'); }
  };
  const act = (kind: 'edit' | 'household' | 'consent' | 'records' | 'giving', m: any) => setModal({ kind: kind === 'edit' ? 'form' : kind, member: m });
  const setAll = (v: boolean) => setOpen(Object.fromEntries(households.map((h) => [h.id, v])));
  const showSearch = tab === 'all' || tab === 'households';

  return (
    <>
      <PageHeader title="Members" subtitle="Your church family, by person and by household."
        actions={canEdit && <Button onClick={() => setModal({ kind: 'form' })}>Add member</Button>}
        tabs={[{ id: 'all', label: 'All' }, { id: 'households', label: 'Households' }, { id: 'birthdays', label: 'Birthdays', badge: bdays.length + eighteen.length }, { id: 'attention', label: 'Needs attention', badge: attention.length }, { id: 'requests', label: 'Join requests', badge: pendingJoins }, { id: 'numbers', label: 'Member numbers' }]}
        tab={tab} onTab={(v) => setTab(v as Tab)} />

      {tab !== 'numbers' && tab !== 'requests' && (
        <StatTiles>
          <Stat label="People" value={t ? t.members : '-'} onClick={() => setTab('all')} />
          <Stat label="Households" value={t ? t.households : '-'} onClick={() => setTab('households')} />
          <Stat label="Birthdays this week" value={x ? bdays.length : '-'} tone="info" onClick={() => setTab('birthdays')} />
          <Stat label="Need attention" value={x ? attention.length : '-'} tone={attention.length ? 'wait' : undefined} onClick={() => setTab('attention')} />
        </StatTiles>
      )}

      <div style={{ height: 24 }} />

      {showSearch && (
        <Toolbar end={tab === 'households' && households.length > 0 ? <div className="pp-all-actions"><Button small kind="ghost" onClick={() => setAll(true)}>Open all</Button><Button small kind="ghost" onClick={() => setAll(false)}>Close all</Button></div> : undefined}>
          <input aria-label="Search members" placeholder="Search by name, member number or phone" value={q} onChange={(e) => setQ(e.target.value)} />
          {t && <span className="pp-tiny">{dq ? 'Found ' : ''}{t.households} household{t.households === 1 ? '' : 's'}, {t.members} {t.members === 1 ? 'person' : 'people'}</span>}
        </Toolbar>
      )}

      {(tab === 'all' || tab === 'households') && (
        <Gate loading={d.loading} error={d.error} hasData={!!d.data} rows={6}>
          {d.data && (tab === 'all' ? (
            sorted.length === 0 ? <EmptyState icon="people" title={dq ? 'No one matches your search' : 'No members yet'} text={dq ? 'Try a different name, number or phone.' : 'Add your first member to get started.'} action={!dq && canEdit ? <Button onClick={() => setModal({ kind: 'form' })}>Add member</Button> : undefined} /> : (
              <div className="pp-list">
                {sorted.map((m) => (
                  <button type="button" key={m.id} className="pp-item" onClick={() => setSel(m)}>
                    <Avatar m={m} />
                    <div><div className="pp-name">{m.full_name}</div><div className="pp-sub">{subline(m)}</div></div>
                    <span className="pp-side"><Chips m={m} /></span>
                    <Icon name="chevron" size={18} className="pp-chev" />
                  </button>
                ))}
              </div>
            )
          ) : (
            <div className="pp-stack">
              {households.length === 0 && individuals.length === 0 ? <EmptyState icon="people" title={dq ? 'No households match your search' : 'No households yet'} text="Households group a family together." /> : (
                <div className="pp-homes">
                  {households.map((h) => <HouseCard key={h.id} h={h} open={isOpen(h.id)} onToggle={() => setOpen((p) => ({ ...p, [h.id]: !isOpen(h.id) }))} onPick={setSel} />)}
                </div>
              )}
              {individuals.length > 0 && (
                <>
                  <h2 style={{ fontSize: 17 }}>Not in a household</h2>
                  <div className="pp-list">
                    {individuals.map((m) => (
                      <button type="button" key={m.id} className="pp-item" onClick={() => setSel(m)}>
                        <Avatar m={m} /><div><div className="pp-name">{m.full_name}</div><div className="pp-sub">{subline(m)}</div></div>
                        <span className="pp-side"><Chips m={m} /></span><Icon name="chevron" size={18} className="pp-chev" />
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          ))}
        </Gate>
      )}

      {tab === 'birthdays' && (
        <Gate loading={insights.loading} error={insights.error} hasData={!!x}>
          {x && (bdays.length === 0 && eighteen.length === 0 ? <EmptyState icon="sparkle" title="No birthdays this week" text="Birthdays and children about to turn 18 show up here." /> : (
            <div className="pp-two">
              <div className="pp-stack tight">
                <h2 style={{ fontSize: 17 }}>Birthdays this week</h2>
                {bdays.length === 0 ? <p className="pp-note">None this week.</p> : (
                  <div className="pp-list">{bdays.map((b) => (
                    <button type="button" key={b.id} className="pp-item" onClick={() => openById(b.id)}>
                      <span className="pp-avatar" aria-hidden="true">{initials(b.full_name)}</span><div><div className="pp-name">{b.full_name}</div><div className="pp-sub">{birthdayText(b.birthday)}</div></div>
                      <span className="pp-side">{b.days_away === 0 ? <StatusChip tone="done">Today</StatusChip> : null}</span><Icon name="chevron" size={18} className="pp-chev" />
                    </button>))}</div>
                )}
              </div>
              <div className="pp-stack tight">
                <h2 style={{ fontSize: 17 }}>Turning 18 soon</h2>
                {eighteen.length === 0 ? <p className="pp-note">No one soon.</p> : (
                  <div className="pp-list">{eighteen.map((c) => (
                    <button type="button" key={c.id} className="pp-item" onClick={() => openById(c.id)}>
                      <span className="pp-avatar child" aria-hidden="true">{initials(c.full_name)}</span><div><div className="pp-name">{c.full_name}</div><div className="pp-sub">{c.days_until_18 <= 0 ? 'today' : `in ${c.days_until_18} day${c.days_until_18 === 1 ? '' : 's'}`}</div></div>
                      <span className="pp-side" /><Icon name="chevron" size={18} className="pp-chev" />
                    </button>))}</div>
                )}
              </div>
            </div>
          ))}
        </Gate>
      )}

      {tab === 'attention' && (
        <Gate loading={insights.loading} error={insights.error} hasData={!!x}>
          {x && (attention.length === 0 ? <EmptyState icon="check" title="All calm" text="Nothing needs attention right now." /> : (
            <div className="pp-stack tight">
              <p className="pp-note">These young adults need their own phone number.</p>
              <div className="pp-list">{attention.map((a) => (
                <div key={a.id} className="pp-item static">
                  <span className="pp-avatar" aria-hidden="true">{initials(a.full_name)}</span>
                  <div><div className="pp-name">{a.full_name}</div><div className="pp-sub">{a.guardians?.length ? `Guardians: ${a.guardians.map((g: any) => g.full_name).join(', ')}` : 'Needs their own phone number'}</div></div>
                  <span className="pp-side">{canEdit && <Button small kind="ghost" onClick={() => { const m = all.find((z) => z.id === a.id); if (m) setModal({ kind: 'form', member: m }); else openById(a.id); }}>Edit</Button>}</span>
                </div>))}</div>
            </div>
          ))}
        </Gate>
      )}

      {tab === 'requests' && <JoinRequests onChanged={() => { joins.reload(); d.reload(); insights.reload(); }} onOpenMember={(name) => { setQ(name); setTab('all'); }} />}

      {tab === 'numbers' && <MemberNumberSettings settings={settings} reload={refresh} />}

      {selM && !modal && (
        <Detail m={selM} household={selHouse} canEdit={canEdit} canRecords={s.can('records.view')} canGiving={s.can('giving.ledger')}
          onClose={() => setSel(null)} onOpen={setSel} onAct={act} onPrimary={setPrimary} />
      )}
      {modal?.kind === 'form' && <MemberFormModal member={modal.member} nextPreview={settings.data?.preview} onClose={() => setModal(null)} onDone={refresh} />}
      {modal?.kind === 'household' && <HouseholdModal member={modal.member} onClose={() => setModal(null)} onDone={(msg) => { toast.show(msg); refresh(); }} />}
      {modal?.kind === 'records' && <MemberRecords member={modal.member} onClose={() => setModal(null)} />}
      {modal?.kind === 'giving' && <GivingRecordModal member={modal.member} onClose={() => setModal(null)} />}
      {modal?.kind === 'consent' && <ConsentDialog member={modal.member} onClose={() => setModal(null)} onDone={(msg) => { setModal(null); toast.show(msg); }} />}
      {toast.node}
    </>
  );
}

export function Transfers() {
  const d = useAsync<any[]>(() => api.get('/transfers'), []);
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [tab, setTab] = useState('wait');
  const decide = async (id: string, approve: boolean) => {
    setBusy(id);
    try {
      await api.post(`/transfers/${id}/decide`, { approve });
      toast.show(approve ? 'Transfer approved.' : 'Transfer rejected.');
      d.reload();
    } catch (e: any) { toast.show(friendly(e.message), 'bad'); }
    setBusy(null);
  };
  const rows = d.data ?? [];
  const waiting = rows.filter((r) => r.status === 'requested');
  const shown = tab === 'wait' ? waiting : rows.filter((r) => r.status !== 'requested');
  const tone = (st: string) => (st === 'approved' || st === 'completed' ? 'done' : st === 'requested' ? 'wait' : st === 'rejected' ? 'bad' : 'off') as 'done' | 'wait' | 'bad' | 'off';
  return (
    <>
      <PageHeader title="Transfers" subtitle="Members asking to join your branches."
        tabs={[{ id: 'wait', label: 'Waiting', badge: waiting.length }, { id: 'done', label: 'Decided' }]} tab={tab} onTab={setTab} />
      <Note tone="info">Moving between branches of the same church keeps the member number. Moving to a different church gives the member a new number there, and the old membership is closed, not deleted.</Note>
      <div style={{ height: 16 }} />
      <Gate loading={d.loading} error={d.error} hasData={!!d.data}>
        {shown.length === 0 ? <EmptyState icon="people" title={tab === 'wait' ? 'Nothing waiting' : 'No decided transfers yet'} text={tab === 'wait' ? 'New transfer requests will show up here.' : undefined} /> : (
          <div className="pp-cards">
            {shown.map((t) => (
              <Card key={t.id}>
                <div className="pp-req">
                  <div className="pp-req-head">
                    <div><div className="pp-name">{t.full_name}</div><div className="pp-sub">{t.member_number} · requested {shortDate(t.created_at)}</div></div>
                    <div className="pp-row-flex"><StatusChip tone={tone(t.status)}>{String(t.status).replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())}</StatusChip>{t.to_org_id && t.org_id && t.to_org_id !== t.org_id && <StatusChip tone="info">Other church</StatusChip>}</div>
                  </div>
                  <div className="pp-flow"><span>{t.from_name}</span><Icon name="chevron" size={16} /><b>{t.to_name}</b></div>
                  {t.status === 'requested' && (
                    <div className="pp-row-flex"><Button disabled={busy === t.id} onClick={() => decide(t.id, true)}>Approve</Button><Button kind="ghost" disabled={busy === t.id} onClick={() => decide(t.id, false)}>Reject</Button></div>
                  )}
                </div>
              </Card>
            ))}
          </div>
        )}
      </Gate>
      {toast.node}
    </>
  );
}

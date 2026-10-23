import { useEffect, useState, type ReactNode } from 'react';
import { Button, ErrorNote, Field, Note, phonePretty, useToast, Failed } from '@churchos/ui';
import { LEGAL_VERSION } from '@churchos/shared';
import { api, friendly, useSession } from './session';
import { maskedPretty, useReveal } from './Reveal';
import { Skeleton, StatusChip } from './ui';
import './people.css';

/** Loading and error wrapper for the People pages: a shimmer while the first data loads, a clear error if it fails. */
export function Gate({ loading, error, hasData, children, rows = 4 }: { loading: boolean; error?: string; hasData: boolean; children: ReactNode; rows?: number }) {
  if (error && !hasData) return <Failed>{friendly(error)}</Failed>;
  if (loading && !hasData) return <Skeleton rows={rows} height={64} />;
  return <>{error && <Failed>{friendly(error)}</Failed>}{children}</>;
}

export const initials = (name: string) => name.split(' ').filter(Boolean).slice(0, 2).map((x) => x[0]?.toUpperCase()).join('');

export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  return (
    <div className="modal-scrim" role="presentation">
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} style={{ width: 'min(640px, 100%)', maxHeight: '92vh', overflowY: 'auto' }}>
        <div className="row between modal-head"><h2>{title}</h2><button type="button" className="modal-x" aria-label="Close" onClick={onClose}>×</button></div>
        {children}
      </div>
    </div>
  );
}

type Guardian = { id: string; full_name: string; member_number?: string; phone?: string | null };

function GuardianPicker({ value, onChange, excludeId }: { value: Guardian[]; onChange: (g: Guardian[]) => void; excludeId?: string }) {
  const s = useSession();
  const [q, setQ] = useState('');
  const dq = useDebounced(q.trim());
  const [res, setRes] = useState<any[] | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    if (!dq) { setRes(null); return; }
    let alive = true;
    api.get<any[]>('/members' + s.qs({ q: dq, category: 'adult', branch: undefined }))
      .then((r) => alive && (setRes(r), setErr('')))
      .catch((e) => alive && setErr(friendly(e.message)));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dq]);
  const shown = (res ?? []).filter((m) => m.id !== excludeId && !value.some((g) => g.id === m.id)).slice(0, 8);
  return (
    <div className="stack" style={{ gap: 8 }}>
      {value.length > 0 && (
        <div className="chips">
          {value.map((g) => (
            <button type="button" key={g.id} className="chip on" aria-label={`Remove ${g.full_name}`} onClick={() => onChange(value.filter((x) => x.id !== g.id))}>{g.full_name} ×</button>
          ))}
        </div>
      )}
      <input placeholder="Search adult members by name, number or phone" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search guardians" />
      {err && <ErrorNote>{err}</ErrorNote>}
      {dq && res && shown.length === 0 && <div className="tiny">No adult members found.</div>}
      {shown.length > 0 && (
        <div className="stack" style={{ gap: 4 }}>
          {shown.map((m) => (
            <button type="button" key={m.id} className="pp-pick" onClick={() => { onChange([...value, { id: m.id, full_name: m.full_name, member_number: m.member_number, phone: m.phone }]); setQ(''); }}>
              {m.full_name} · {m.member_number}{m.phone ? ` · ${phonePretty(m.phone)}` : ''}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function HouseholdPicker({ value, onChange }: { value: { id: string; label: string } | null; onChange: (h: { id: string; label: string } | null) => void }) {
  const s = useSession();
  const [q, setQ] = useState('');
  const dq = useDebounced(q.trim());
  const [res, setRes] = useState<any | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    let alive = true;
    api.get<any>('/members/grouped' + s.qs({ q: dq || undefined, branch: undefined }))
      .then((r) => alive && (setRes(r), setErr('')))
      .catch((e) => alive && setErr(friendly(e.message)));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dq]);
  return (
    <div className="stack" style={{ gap: 8 }}>
      {value && <div className="chips"><button type="button" className="chip on" onClick={() => onChange(null)} aria-label="Clear household">{value.label} ×</button></div>}
      <input placeholder="Search households by a member's name, number or phone" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search households" />
      {err && <ErrorNote>{err}</ErrorNote>}
      {!res && !err && <Skeleton lines={2} />}
      {res && res.households.length === 0 && <div className="tiny">No households found.</div>}
      {res && res.households.slice(0, 8).map((h: any) => (
        <button type="button" key={h.id} className="pp-pick" onClick={() => onChange({ id: h.id, label: h.label })}>
          <b>{h.label}</b><span className="pp-tiny">{h.members.map((m: any) => m.full_name).join(', ')}</span>
        </button>
      ))}
    </div>
  );
}

const isoDate = (d: string | null | undefined) => (d ? d.slice(0, 10) : '');

/** Add a new member (mode 'add') or edit an existing one (mode 'edit'). */
export function MemberFormModal({ member, onClose, onDone, nextPreview }: { member?: any; onClose: () => void; onDone: () => void; nextPreview?: string }) {
  const s = useSession();
  const toast = useToast();
  const editing = !!member;
  const defaultBranch = s.scope !== 'all' ? s.scope : s.branches[0]?.id ?? '';
  const [category, setCategory] = useState<'adult' | 'child'>(member?.category ?? 'adult');
  const [fullName, setFullName] = useState<string>(member?.full_name ?? '');
  const [branchId, setBranchId] = useState<string>(member?.branch_id ?? defaultBranch);
  const [sex, setSex] = useState<string>(member?.sex ?? '');
  const [dob, setDob] = useState<string>(isoDate(member?.dob));
  const [phone, setPhone] = useState<string>('');
  const reveal = useReveal(member?.id ?? '');
  const [number, setNumber] = useState('');
  const [guardians, setGuardians] = useState<Guardian[]>(member?.guardians ?? []);
  const [hhMode, setHhMode] = useState<'default' | 'new' | 'existing' | 'none'>('default');
  const [hh, setHh] = useState<{ id: string; label: string } | null>(null);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const child = category === 'child';

  const submit = async () => {
    setError('');
    if (fullName.trim().length < 2) return setError('Enter the member’s full name.');
    if (!editing && !branchId) return setError('Choose a branch.');
    if (!editing && !child && !phone.trim()) return setError('An adult needs their own phone number, for example 0712 345 678.');
    if (child && !dob && !(editing && member?.age_band)) return setError('A child needs a date of birth so they can become an adult at 18.');
    if (child && guardians.length === 0) return setError('Choose at least one guardian for a child.');
    if (!editing && hhMode === 'existing' && !hh) return setError('Choose which household to join, or pick another option.');
    if (!editing && !consent) return setError(child ? 'Please confirm that a guardian agreed to the church keeping these details.' : 'Please confirm that the member agreed to the church keeping these details.');
    setBusy(true);
    try {
      if (editing) {
        const body: any = { fullName, sex };
        if (dob) body.dob = dob;
        if (!child && phone.trim()) body.phone = phone.trim();
        if (child) { body.guardianIds = guardians.map((g) => g.id); body.guardianNoticeVersion = LEGAL_VERSION; }
        await api.put(`/members/${member.id}` + s.qs({ branch: undefined }), body);
        toast.show('Changes saved.');
      } else {
        const body: any = { branchId, category, fullName, sex: sex || undefined, dob: dob || undefined, memberNumber: number.trim() || undefined, consent: true };
        if (!child) body.phone = phone.trim();
        if (child) body.guardianIds = guardians.map((g) => g.id);
        if (hhMode === 'new') body.householdId = 'new';
        else if (hhMode === 'existing' && hh) body.householdId = hh.id;
        const r = await api.post('/members' + s.qs({ branch: undefined }), body);
        toast.show(`Added. Member number ${r.memberNumber}.`);
      }
      onDone();
      setTimeout(onClose, 0);
    } catch (e: any) { setError(friendly(e.message)); }
    setBusy(false);
  };

  return (
    <Modal title={editing ? `Edit ${member.full_name}` : 'Add a member'} onClose={onClose}>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        {!editing && (
          <div className="chips" role="radiogroup" aria-label="Adult or child">
            <button type="button" role="radio" aria-checked={!child} className={`chip ${!child ? 'on' : ''}`} onClick={() => setCategory('adult')}>Adult</button>
            <button type="button" role="radio" aria-checked={child} className={`chip ${child ? 'on' : ''}`} onClick={() => setCategory('child')}>Child</button>
          </div>
        )}
        {editing && <div><StatusChip tone={child ? 'info' : 'off'}>{child ? 'Child' : 'Adult'}</StatusChip></div>}
        <Field label="Full name"><input value={fullName} onChange={(e) => setFullName(e.target.value)} autoFocus /></Field>
        {!editing && (
          <Field label="Branch">
            <select value={branchId} onChange={(e) => setBranchId(e.target.value)}>{s.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select>
          </Field>
        )}
        <div className="grid cols-2">
          <Field label="Sex (optional)">
            <select value={sex} onChange={(e) => setSex(e.target.value)}><option value="">Not stated</option><option value="male">Male</option><option value="female">Female</option></select>
          </Field>
          <Field label={child ? 'Date of birth' : 'Date of birth (optional)'} hint={editing && !member?.dob && member?.age_band ? 'Leave blank to keep the current date.' : undefined}>
            <input type="date" value={dob} onChange={(e) => setDob(e.target.value)} max={new Date().toISOString().slice(0, 10)} />
          </Field>
        </div>
        {!child && (
          <Field label="Phone number" hint={editing ? `Current number: ${maskedPretty(member.phone) || 'none'}` : 'Their own number, for example 0712 345 678'}>
            <input inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder={editing ? 'Leave blank to keep the current number' : '0712 345 678'} />
            {editing && reveal.canReveal && (
              <div style={{ marginTop: 6 }}>
                {reveal.data
                  ? <span>Current number: <b>{phonePretty(reveal.data.phone)}</b> <Button small kind="ghost" onClick={reveal.hide}>Hide</Button></span>
                  : <Button small kind="ghost" onClick={reveal.ask}>Show number</Button>}
              </div>
            )}
          </Field>
        )}
        {child && editing && <div className="tiny">Contact numbers come from the guardians{member.contact_phones?.length ? `: ${member.contact_phones.map((c: any) => maskedPretty(typeof c === 'string' ? c : c.phone)).join(', ')}` : ''}.</div>}
        {!editing && (
          <Field label="Member number (optional)" hint="Leave blank to use your church's numbering, or type an existing number">
            <input value={number} onChange={(e) => setNumber(e.target.value)} placeholder={nextPreview ? `Next: ${nextPreview}` : 'Generated for you'} />
          </Field>
        )}
        {child && (
          <div>
            <div className="field-label">Guardians</div>
            <div className="tiny" style={{ marginBottom: 6 }}>Choose one or more adult members. Their phone numbers become the child's contact numbers.</div>
            <GuardianPicker value={guardians} onChange={setGuardians} excludeId={member?.id} />
          </div>
        )}
        {!editing && (
          <div className="pp-group">
            <h3>Household</h3>
            <div className="pp-choices">
              {([
                ['default', child ? "Join the guardian's household (default for a child)" : 'No household for now (default)'],
                ['new', 'Start a new household'],
                ['existing', 'Join an existing household'],
                ['none', 'No household'],
              ] as const).filter(([k]) => child || k !== 'none').map(([k, l]) => (
                <label key={k} className={`pp-choice ${hhMode === k ? 'on' : ''}`}>
                  <input type="radio" name="hh" checked={hhMode === k} onChange={() => setHhMode(k)} /> <span>{l}</span>
                </label>
              ))}
              {hhMode === 'existing' && <HouseholdPicker value={hh} onChange={setHh} />}
              {child && hhMode === 'none' && <div className="tiny">The child will not be placed in a household.</div>}
            </div>
          </div>
        )}
        {!editing && (
          <label className="pp-switch pp-group">
            <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
            <span>{child ? "A parent or guardian agreed to the church keeping this child's details, and has been shown the Children's Data Notice" : 'The member agreed to the church keeping these details'}</span>
          </label>
        )}
        {!editing && child && (
          <p className="tiny">ChurchOS records who ticked this, when, and the notice version. <a href="/legal/children" target="_blank" rel="noopener">Read the Children's Data Notice</a> (opens in a new tab).</p>
        )}
        {error && <ErrorNote>{error}</ErrorNote>}
        <div className="pp-form-foot"><Button type="submit" disabled={busy}>{busy ? 'Saving…' : editing ? 'Save changes' : 'Add member'}</Button><Button kind="ghost" onClick={onClose}>Cancel</Button></div>
      </form>
      {reveal.dialog}
      {toast.node}
    </Modal>
  );
}

/** Move a member between households, start a new one, or remove them from their household. */
export function HouseholdModal({ member, onClose, onDone }: { member: any; onClose: () => void; onDone: (msg: string) => void }) {
  const s = useSession();
  const [mode, setMode] = useState<'move' | 'new' | 'remove'>('move');
  const [hh, setHh] = useState<{ id: string; label: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirm, setConfirm] = useState<string | null>(null);

  const run = async (move = false) => {
    setError('');
    if (mode === 'move' && !hh) return setError('Choose the household to move them into.');
    setBusy(true);
    try {
      const householdId = mode === 'new' ? 'new' : mode === 'remove' ? null : hh!.id;
      await api.put(`/members/${member.id}/household` + s.qs({ branch: undefined }), { householdId, ...(move ? { move: true } : {}) });
      onDone(mode === 'remove' ? `${member.full_name} is no longer in a household.` : mode === 'new' ? `${member.full_name} now has a new household.` : `${member.full_name} moved household.`);
      setTimeout(onClose, 0);
    } catch (e: any) {
      if (e.code === 'already_in_household' || e.status === 409) setConfirm(e.message);
      else setError(friendly(e.message));
    }
    setBusy(false);
  };

  return (
    <Modal title={`Household for ${member.full_name}`} onClose={onClose}>
      {confirm ? (
        <div className="stack">
          <Note tone="warn">{confirm}</Note>
          <div className="row"><Button disabled={busy} onClick={() => run(true)}>{busy ? 'Moving…' : 'Yes, move them'}</Button><Button kind="ghost" onClick={() => setConfirm(null)}>No, go back</Button></div>
        </div>
      ) : (
        <form className="stack" onSubmit={(e) => { e.preventDefault(); run(); }}>
          <div className="pp-choices">
            {([['move', 'Move to another household'], ['new', 'Start a new household'], ['remove', 'Remove from household']] as const)
              .filter(([k]) => member.household_id || k !== 'remove')
              .map(([k, l]) => (
                <label key={k} className={`pp-choice ${mode === k ? 'on' : ''}`}><input type="radio" name="hhact" checked={mode === k} onChange={() => setMode(k)} /> <span>{l}</span></label>
              ))}
          </div>
          {mode === 'move' && <HouseholdPicker value={hh} onChange={setHh} />}
          {error && <ErrorNote>{error}</ErrorNote>}
          <div className="row"><Button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save'}</Button><Button kind="ghost" onClick={onClose}>Cancel</Button></div>
        </form>
      )}
    </Modal>
  );
}


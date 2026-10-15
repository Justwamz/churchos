import { useState } from 'react';
import { Button, ErrorNote, Field, Note } from '@churchos/ui';
import { api, friendly, useSession } from './session';
import { Modal } from './MemberForm';

export function ConsentDialog({ member, onClose, onDone }: { member: { id: string; full_name: string; category: string }; onClose: () => void; onDone: (msg: string) => void }) {
  const s = useSession();
  const [channel, setChannel] = useState<'whatsapp' | 'sms'>('whatsapp');
  const [optIn, setOptIn] = useState(true);
  const [source, setSource] = useState('in_person');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const isChild = member.category === 'child';
  const save = async () => {
    setBusy(true); setErr('');
    try {
      await api.post(`/members/${member.id}/consent` + s.qs({ branch: undefined }), { channel, optIn, source, confirmed });
      onDone(`Recorded ${member.full_name}'s ${channel === 'whatsapp' ? 'WhatsApp' : 'SMS'} choice.`);
    } catch (e: any) { setErr(e.code === 'not_adult' ? 'Children are reached through their guardians.' : friendly(e.message)); setBusy(false); }
  };
  return (
    <Modal title={`Message choices: ${member.full_name}`} onClose={onClose}>
      {isChild ? (
        <div className="stack"><Note tone="info">Children are reached through their guardians. Record message choices on a guardian instead.</Note><div><Button onClick={onClose}>Close</Button></div></div>
      ) : (
        <div className="stack">
          <p className="tiny" style={{ margin: 0 }}>Record a choice this person gave in person, on a form or by phone. This is recorded in the audit log.</p>
          <Field label="Which messages?">
            <div className="chips">{([['whatsapp', 'WhatsApp'], ['sms', 'SMS']] as const).map(([v, t]) => <button key={v} type="button" className={`chip ${channel === v ? 'on' : ''}`} onClick={() => setChannel(v)}>{t}</button>)}</div>
          </Field>
          <Field label="Their choice">
            <div className="chips"><button type="button" className={`chip ${optIn ? 'on' : ''}`} onClick={() => setOptIn(true)}>Agreed</button><button type="button" className={`chip ${!optIn ? 'on' : ''}`} onClick={() => setOptIn(false)}>Declined</button></div>
          </Field>
          <Field label="How did they tell you?">
            <select value={source} onChange={(e) => setSource(e.target.value)}>
              <option value="in_person">In person</option><option value="form">On a form</option><option value="phone_call">By phone call</option>
            </select>
          </Field>
          <label className="row" style={{ gap: 8, flexWrap: 'nowrap' }}><input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} /> <span>The person gave this choice themselves</span></label>
          {err && <ErrorNote>{err}</ErrorNote>}
          <div className="row"><Button disabled={busy || !confirmed} onClick={save}>{busy ? 'Saving...' : 'Save choice'}</Button><Button kind="ghost" onClick={onClose}>Cancel</Button></div>
        </div>
      )}
    </Modal>
  );
}

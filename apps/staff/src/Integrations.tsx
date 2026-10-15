import { useState } from 'react';
import { Badge, Button, Card, ErrorNote, Field, Note, Table, kes, useAsync, useToast } from '@churchos/ui';
import { api, friendly, useSession } from './session';
import { Hist, Load, PageHead } from './bits';
import { orgQs } from './Wallets';

const ERR: Record<string, string> = {
  bad_sender: 'An SMS sender name is 3 to 11 letters and numbers, starting with a letter.',
  bad_whatsapp: 'Enter the WhatsApp number with its country code, for example 254700123456.',
  bad_email: 'One of the alert emails is not a valid email address.',
  too_many: 'You can add up to 5 extra alert emails.',
  bad_mode: 'Choose who pays for messages.',
};
const explain = (e: any) => ERR[e?.code] ?? friendly(e?.message);

type Mode = 'shared' | 'per_branch';

/** The newest request for a sender field, if it is still waiting or was turned down. */
function latest(requests: any[], kind: string, branchId: string | null) {
  const q = requests.filter((x) => x.kind === kind && (x.branchId ?? null) === branchId).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
  return q && (q.status === 'pending' || q.status === 'rejected') ? q : null;
}

/** Shows what is in use now, and any change that is waiting for or was refused by ChurchOS. */
function Status({ active, req }: { active: string | null | undefined; req: any }) {
  return (
    <div style={{ marginBottom: 6, fontSize: 13 }}>
      <span className="muted">Active: <b>{active || 'None yet'}</b></span>
      {req?.status === 'pending' && <> <Badge tone="warn">Waiting for approval: {req.value}</Badge></>}
      {req?.status === 'rejected' && <> <Badge tone="bad">Not approved: {req.value}</Badge>{req.reason && <div className="tiny" style={{ color: 'var(--bad)' }}>Reason: {req.reason}</div>}</>}
    </div>
  );
}

function Choice({ on, onClick, title, text, disabled }: { on: boolean; onClick: () => void; title: string; text: string; disabled?: boolean }) {
  return (
    <button type="button" disabled={disabled} aria-pressed={on} onClick={onClick}
      style={{ textAlign: 'left', padding: 16, borderRadius: 12, border: `2px solid ${on ? 'var(--brand)' : 'var(--line)'}`, background: on ? 'var(--brand-tint)' : 'var(--surface)', color: 'var(--ink)', font: 'inherit', cursor: disabled ? 'default' : 'pointer' }}>
      <b style={{ fontSize: 16 }}>{on ? '● ' : '○ '}{title}</b>
      <div className="muted" style={{ fontSize: 14, marginTop: 4 }}>{text}</div>
    </button>
  );
}

function Editor({ data, reload }: { data: any; reload: () => void }) {
  const s = useSession();
  const toast = useToast();
  const edit: boolean = data.canEdit;
  const [mode, setMode] = useState<Mode>(data.walletMode);
  const [sms, setSms] = useState<string>(data.smsSenderId ?? '');
  const [waName, setWaName] = useState<string>(data.whatsappDisplayName ?? '');
  const [waNum, setWaNum] = useState<string>(data.whatsappNumber ?? '');
  const [emails, setEmails] = useState<string[]>(data.alertEmails ?? []);
  const [newEmail, setNewEmail] = useState('');
  const [br, setBr] = useState<Record<string, { sms: string; wa: string }>>(
    Object.fromEntries((data.branches ?? []).map((b: any) => [b.id, { sms: b.smsSenderId ?? '', wa: b.whatsappNumber ?? '' }])),
  );
  const requests: any[] = data.requests ?? [];
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [testing, setTesting] = useState('');
  const [result, setResult] = useState<{ tone: 'good' | 'bad' | 'warn'; text: string; optIn?: boolean } | null>(null);

  const addEmail = () => {
    const v = newEmail.trim().toLowerCase();
    if (!v) return;
    if (emails.includes(v)) { setNewEmail(''); return; }
    if (emails.length >= 5) { setError(ERR.too_many); return; }
    setEmails([...emails, v]); setNewEmail(''); setError('');
  };

  const save = async () => {
    setBusy(true); setError('');
    const pending = newEmail.trim().toLowerCase();
    const list = pending && !emails.includes(pending) ? [...emails, pending] : emails;
    try {
      const r: any = await api.put('/integrations' + orgQs(s), {
        walletMode: mode, smsSenderId: sms, whatsappDisplayName: waName, whatsappNumber: waNum, alertEmails: list,
        branches: (data.branches ?? []).map((b: any) => ({ branchId: b.id, smsSenderId: br[b.id]?.sms ?? '', whatsappNumber: br[b.id]?.wa ?? '' })),
      });
      setNewEmail('');
      toast.show(r?.requested > 0 ? `Saved. ${r.requested} ${r.requested === 1 ? 'change is' : 'changes are'} waiting for ChurchOS to approve.` : 'Settings saved'); reload();
    } catch (e: any) { setError(explain(e)); }
    setBusy(false);
  };

  const test = async (channel: 'sms' | 'whatsapp') => {
    setTesting(channel); setResult(null);
    try {
      const r: any = await api.post('/integrations/test', { channel });
      setResult({ tone: 'good', text: `Test ${channel === 'sms' ? 'SMS' : 'WhatsApp message'} sent to your phone. It cost ${kes(r.cost)}.` });
    } catch (e: any) {
      setResult({ tone: e.code === 'not_opted_in' ? 'warn' : 'bad', text: friendly(e.message), optIn: e.code === 'not_opted_in' });
    }
    setTesting('');
  };

  const rates = data.rates ?? { sms: 100, whatsapp: 300 };
  const branches: any[] = data.branches ?? [];

  return (
    <div className="stack">
      <Note>ChurchOS approves sender names and numbers before they are used. This usually takes one working day. Until then your current ones keep working. Prices are set by ChurchOS.</Note>
      {!edit && <Note>You can see these settings but only a church administrator can change them.</Note>}

      <Card title="Who pays for messages" action={<Button kind="ghost" small onClick={() => s.go('wallets')}>See the wallets</Button>}>
        <div className="grid cols-2">
          <Choice disabled={!edit} on={mode === 'shared'} onClick={() => setMode('shared')} title="Shared by the whole church" text="One SMS wallet and one WhatsApp wallet for everyone. Top up once and every branch sends from it." />
          <Choice disabled={!edit} on={mode === 'per_branch'} onClick={() => setMode('per_branch')} title="Each branch pays for its own" text="Every branch is its own cost centre with its own wallets and does not depend on headquarters." />
        </div>
        {mode === 'per_branch' && data.walletMode !== 'per_branch' && (
          <Note>Each branch gets its own empty SMS and WhatsApp wallets. Headquarters can move credit to them. Nothing is removed if you switch back.</Note>
        )}
      </Card>

      <Card title="SMS">
        <Status active={data.smsSenderId} req={latest(requests, 'sms_sender', null)} />
        <Field label="Sender name" hint="The name members see on their phone. 3 to 11 letters and numbers, starting with a letter.">
          <input disabled={!edit} maxLength={11} placeholder="e.g. GRACECHURCH" value={sms} onChange={(e) => setSms(e.target.value)} />
        </Field>
        <p className="tiny">SMS costs {kes(rates.sms)} per message part right now, taken from the SMS wallet. Prices are set by ChurchOS.</p>
      </Card>

      <Card title="WhatsApp">
        <div className="grid cols-2">
          <div><Status active={data.whatsappDisplayName} req={latest(requests, 'whatsapp_display', null)} />
          <Field label="Display name"><input disabled={!edit} maxLength={60} value={waName} onChange={(e) => setWaName(e.target.value)} /></Field></div>
          <div><Status active={data.whatsappNumber} req={latest(requests, 'whatsapp_number', null)} />
          <Field label="Business number" hint="With country code, for example 254700123456"><input disabled={!edit} inputMode="tel" value={waNum} onChange={(e) => setWaNum(e.target.value)} /></Field></div>
        </div>
        <p className="tiny">WhatsApp costs {kes(rates.whatsapp)} per message right now. It is only sent to people who agreed to receive it.</p>
      </Card>

      <Card title="Low-balance alerts">
        <p className="muted">Everyone who can see a wallet is also alerted automatically, in the app and by email if they have added an email to My profile.</p>
        <p className="muted">You can also add up to 5 extra email addresses.</p>
        {emails.length === 0 && <p className="tiny">No extra emails yet.</p>}
        {emails.map((e) => (
          <div key={e} className="row between" style={{ padding: '6px 0', borderTop: '1px solid var(--line)' }}>
            <span style={{ overflowWrap: 'anywhere' }}>{e}</span>
            {edit && <Button kind="ghost" small onClick={() => setEmails(emails.filter((x) => x !== e))}>Remove</Button>}
          </div>
        ))}
        {edit && emails.length < 5 && (
          <div className="row" style={{ marginTop: 8, alignItems: 'flex-end' }}>
            <div style={{ flex: 1, minWidth: 200 }}><Field label="Add an email"><input type="email" placeholder="treasurer@example.com" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addEmail(); } }} /></Field></div>
            <div style={{ marginBottom: 12 }}><Button kind="ghost" onClick={addEmail}>Add</Button></div>
          </div>
        )}
      </Card>

      <Card title="Branches">
        <p className="muted">Leave these blank to use the church's own sender name and WhatsApp number.</p>
        {branches.length === 0 ? <p className="tiny">There are no branches yet.</p> : (
          <Table head={['Branch', 'Own SMS sender name', 'Own WhatsApp number']}>
            {branches.map((b) => (
              <tr key={b.id}>
                <td><b>{b.name}</b></td>
                <td><Status active={b.smsSenderId} req={latest(requests, 'sms_sender', b.id)} /><input disabled={!edit} aria-label={`SMS sender name for ${b.name}`} maxLength={11} value={br[b.id]?.sms ?? ''} onChange={(e) => setBr({ ...br, [b.id]: { ...br[b.id], sms: e.target.value } })} /></td>
                <td><Status active={b.whatsappNumber} req={latest(requests, 'whatsapp_number', b.id)} /><input disabled={!edit} aria-label={`WhatsApp number for ${b.name}`} inputMode="tel" value={br[b.id]?.wa ?? ''} onChange={(e) => setBr({ ...br, [b.id]: { ...br[b.id], wa: e.target.value } })} /></td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      {edit && (
        <div>
          {error && <ErrorNote>{error}</ErrorNote>}
          <div className="row">
            <Button disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save settings'}</Button>
            <Hist entity="integration" entityId={data.organisation.id} title="Messaging settings" label="History" />
          </div>
        </div>
      )}
      {!edit && <div><Hist entity="integration" entityId={data.organisation.id} title="Messaging settings" label="History" /></div>}

      {edit && (
        <Card title="Send a test">
          <p className="muted">Sends one message to your own phone so you can see that the connection works. It is paid for from the wallet, so it costs one message ({kes(rates.sms)} for SMS, {kes(rates.whatsapp)} for WhatsApp). Save your changes first.</p>
          <div className="row">
            <Button kind="ghost" disabled={!!testing} onClick={() => test('sms')}>{testing === 'sms' ? 'Sending…' : 'Send me a test SMS'}</Button>
            <Button kind="ghost" disabled={!!testing} onClick={() => test('whatsapp')}>{testing === 'whatsapp' ? 'Sending…' : 'Send me a test WhatsApp message'}</Button>
          </div>
          {result && (
            <Note tone={result.tone}>
              {result.optIn ? 'WhatsApp only goes to numbers that have agreed to it. Turn on WhatsApp for your own number on My profile first.' : result.text}
              {result.optIn && <div style={{ marginTop: 8 }}><Button small onClick={() => s.go('profile')}>Open My profile</Button></div>}
            </Note>
          )}
        </Card>
      )}
      {toast.node}
    </div>
  );
}

export function Integrations() {
  const s = useSession();
  const { data, error, loading, reload } = useAsync<any>(() => api.get('/integrations' + orgQs(s)), [s.grant.org.id]);
  return (
    <div>
      <PageHead title="Messaging settings" sub="Who pays for messages, your sender name and WhatsApp number, and who gets alerts." />
      <Load loading={loading} error={error} hasData={!!data}>
        {data && <Editor data={data} reload={reload} />}
      </Load>
    </div>
  );
}

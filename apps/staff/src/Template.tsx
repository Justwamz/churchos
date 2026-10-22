import { useEffect, useRef, useState } from 'react';
import { Button, ErrorNote, Field, Note, useAsync, useToast, type CertificatePayload } from '@churchos/ui';
import { api, friendly, useSession } from './session';
import { Hist } from './bits';
import { Gate } from './MemberForm';
import { Card, PageHeader, Section } from './ui';
import './people.css';
import { ScaledCard } from './Records';

const MAX_LOGO = 500 * 1024;
const LOGO_TYPES = ['image/png', 'image/jpeg'];
const CHIPS = ['name', 'date', 'place', 'officiant', 'church', 'parents', 'sponsors'];

type Sig = { name: string; title: string };
type Cfg = { churchName: string; tagline: string; baptismTitle: string; baptismBody: string; signatories: Sig[]; accent: string; footer: string; showQr: boolean; price: string };
type Logo = undefined | null | { mime: string; data: string; url: string };
type BranchForm = { id: string; name: string; address: string; town: string; phone: string; email: string };

function readDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error('We could not read that file. Please try again.'));
    r.readAsDataURL(file);
  });
}

function TemplateEditor({ data, reload }: { data: any; reload: () => void }) {
  const toast = useToast();
  const canEdit: boolean = data.canEdit;
  const c = data.config;
  const [cfg, setCfg] = useState<Cfg>({
    churchName: c.churchName ?? '', tagline: c.tagline ?? '', baptismTitle: c.baptismTitle ?? '', baptismBody: c.baptismBody ?? '',
    signatories: (c.signatories ?? []).map((s: Sig) => ({ ...s })), accent: c.accent ?? '#0e5a52', footer: c.footer ?? '', showQr: c.showQr !== false,
    price: c.copyPriceCents ? String(c.copyPriceCents / 100) : '0',
  });
  const [logo, setLogo] = useState<Logo>(undefined);
  const [branches, setBranches] = useState<BranchForm[]>((data.branches ?? []).map((b: any) => ({ id: b.id, name: b.name, address: b.address ?? '', town: b.town ?? '', phone: b.phone ?? '', email: b.email ?? '' })));
  const [sel, setSel] = useState<string>(branches[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [bBusy, setBBusy] = useState('');
  const [bError, setBError] = useState('');
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const logoInput = useRef<HTMLInputElement>(null);
  const set = <K extends keyof Cfg>(k: K, v: Cfg[K]) => setCfg((p) => ({ ...p, [k]: v }));

  const insert = (key: string) => {
    const el = bodyRef.current;
    const tok = `{${key}}`;
    const a = el?.selectionStart ?? cfg.baptismBody.length;
    const b = el?.selectionEnd ?? a;
    set('baptismBody', cfg.baptismBody.slice(0, a) + tok + cfg.baptismBody.slice(b));
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(a + tok.length, a + tok.length); });
  };

  const pickLogo = async (f?: File) => {
    setError('');
    if (!f) return;
    if (!LOGO_TYPES.includes(f.type)) { setError('Please use a PNG or JPG logo.'); return; }
    if (f.size > MAX_LOGO) { setError('That logo is larger than 500 KB. Please choose a smaller one.'); return; }
    try {
      const url = await readDataUrl(f);
      setLogo({ mime: f.type, data: url.replace(/^data:[^,]*,/, ''), url });
    } catch (e: any) { setError(friendly(e.message)); }
    if (logoInput.current) logoInput.current.value = '';
  };

  const priceNum = Number(cfg.price || 0);
  const save = async () => {
    setError('');
    if (!Number.isFinite(priceNum) || priceNum < 0 || (priceNum > 0 && (priceNum < 10 || priceNum > 5000))) { setError('A copy can be free (0), or cost between KES 10 and KES 5,000.'); return; }
    setBusy(true);
    try {
      const body: any = {
        config: {
          churchName: cfg.churchName, tagline: cfg.tagline, baptismTitle: cfg.baptismTitle, baptismBody: cfg.baptismBody,
          signatories: cfg.signatories, accent: cfg.accent, footer: cfg.footer, showQr: cfg.showQr, copyPriceCents: Math.round(priceNum * 100),
        },
      };
      if (logo === null) body.logo = null;
      else if (logo) body.logo = { mime: logo.mime, data: logo.data };
      await api.put('/certificates/template', body);
      toast.show('Certificate design saved.');
      setLogo(undefined);
      reload();
    } catch (e: any) { setError(friendly(e.message)); }
    setBusy(false);
  };

  const setBranch = (id: string, k: keyof BranchForm, v: string) => setBranches((p) => p.map((b) => (b.id === id ? { ...b, [k]: v } : b)));
  const saveBranch = async (b: BranchForm) => {
    setBError(''); setBBusy(b.id);
    try { await api.put(`/certificates/branch-profile/${b.id}`, { address: b.address, town: b.town, phone: b.phone, email: b.email }); toast.show(`Saved details for ${b.name}.`); }
    catch (e: any) { setBError(friendly(e.message)); }
    setBBusy('');
  };

  // Live preview
  const br = branches.find((b) => b.id === sel) ?? branches[0];
  const shownLogo = logo === undefined ? data.logo ?? null : logo === null ? null : logo.url;
  const sample: Record<string, string> = {
    name: 'Ruth Wanjiku', date: '12 March 2026', place: br?.name || 'Grace Community Church', officiant: 'Rev. Daniel Mwangi',
    church: cfg.churchName, parents: 'David and Jane Wanjiku', sponsors: 'Mary Achieng',
  };
  const body = cfg.baptismBody.replace(/\{(\w+)\}/g, (m, k) => sample[k] ?? m).replace(/\s+,/g, ',').replace(/\s{2,}/g, ' ').trim();
  const payload: CertificatePayload = {
    kind: 'baptism', preview: true, title: cfg.baptismTitle, body, subject: 'Ruth Wanjiku', eventDate: '12 March 2026', place: sample.place, officiant: sample.officiant,
    registerNumber: null, serial: 'SAMPLE-0001', version: 1, verifyPath: '/verify/SAMPLE-0001?k=SAMPLE',
    template: { churchName: cfg.churchName, tagline: cfg.tagline, accent: cfg.accent, footer: cfg.footer, showQr: cfg.showQr, logo: shownLogo, signatories: cfg.signatories.filter((s) => s.name || s.title) },
    branch: { name: br?.name, address: br?.address || null, town: br?.town || null, phone: br?.phone || null, email: br?.email || null },
  };

  const ro = !canEdit;
  return (
    <>
      {ro && <><Note tone="info">You can see the certificate design, but only people who manage templates can change it.</Note><div style={{ height: 16 }} /></>}
      <div className="pp-two-col">
        <div className="pp-sticky pp-stack pp-col2">
          <Section title="Preview" hint="This is a sample. Real cards use each person's own details.">
            <Card>
              {branches.length > 1 && (
                <Field label="Show details for branch"><select value={sel} onChange={(e) => setSel(e.target.value)}>{branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></Field>
              )}
              <div className="pp-preview"><ScaledCard c={payload} /></div>
            </Card>
          </Section>
        </div>
        <div className="pp-stack pp-col1">
          <Section title="1. Wording" hint="What the card says.">
            <Card>
              <Field label="Church name"><input disabled={ro} value={cfg.churchName} onChange={(e) => set('churchName', e.target.value)} /></Field>
              <Field label="Tagline (optional)"><input disabled={ro} value={cfg.tagline} onChange={(e) => set('tagline', e.target.value)} /></Field>
              <Field label="Certificate title"><input disabled={ro} value={cfg.baptismTitle} onChange={(e) => set('baptismTitle', e.target.value)} /></Field>
              <Field label="Wording" hint="Tap a word below to place it where your cursor is. When a card is made, each one is replaced with the real details.">
                <textarea ref={bodyRef} disabled={ro} rows={5} value={cfg.baptismBody} onChange={(e) => set('baptismBody', e.target.value)} />
              </Field>
              {!ro && <div className="chips" style={{ marginBottom: 12 }}>{CHIPS.map((k) => <button type="button" key={k} className="chip" onClick={() => insert(k)}>{`{${k}}`}</button>)}</div>}
              <p className="pp-note" style={{ marginBottom: 16 }}>{'{name}'} is the person baptised, {'{date}'} and {'{place}'} the baptism, {'{officiant}'} the minister, {'{church}'} your church name, {'{parents}'} the father and mother, and {'{sponsors}'} the sponsors.</p>
              <Field label="Footer note (optional)"><input disabled={ro} value={cfg.footer} onChange={(e) => set('footer', e.target.value)} /></Field>
            </Card>
          </Section>
          <Section title="2. Look" hint="Colour, logo and the verification code.">
            <Card>
              <Field label="Accent colour"><input className="pp-swatch" type="color" disabled={ro} value={cfg.accent} onChange={(e) => set('accent', e.target.value)} /></Field>
              <div className="pp-row-flex" style={{ marginBottom: 6 }}>
                {shownLogo ? <img src={shownLogo} alt="Current logo" style={{ maxHeight: 64, maxWidth: 160 }} /> : <span className="pp-tiny">No logo yet.</span>}
                {!ro && (
                  <>
                    <input ref={logoInput} type="file" accept=".png,.jpg,.jpeg" style={{ display: 'none' }} onChange={(e) => pickLogo(e.target.files?.[0])} />
                    <Button small kind="ghost" onClick={() => logoInput.current?.click()}>{shownLogo ? 'Replace logo' : 'Upload logo'}</Button>
                    {shownLogo && <Button small kind="ghost" onClick={() => setLogo(null)}>Remove</Button>}
                  </>
                )}
              </div>
              <p className="pp-note" style={{ marginBottom: 16 }}>PNG or JPG, up to 500 KB.</p>
              <label className={`pp-choice ${cfg.showQr ? 'on' : ''}`}>
                <input type="checkbox" disabled={ro} checked={cfg.showQr} onChange={(e) => set('showQr', e.target.checked)} /> <span>Show a QR code to verify the card</span>
              </label>
            </Card>
          </Section>
          <Section title="3. Signatures" hint="Up to three people who sign the card.">
            <Card>
              {cfg.signatories.length === 0 && <p className="pp-note">No signatories. The card will have no signature lines.</p>}
              {cfg.signatories.map((s, i) => (
                <div key={i} className="grid cols-2 form-row">
                  <Field label="Name"><input disabled={ro} value={s.name} onChange={(e) => set('signatories', cfg.signatories.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} /></Field>
                  <Field label="Title"><input disabled={ro} value={s.title} onChange={(e) => set('signatories', cfg.signatories.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)))} /></Field>
                  {!ro && <Button small kind="ghost" onClick={() => set('signatories', cfg.signatories.filter((_, j) => j !== i))}>Remove</Button>}
                </div>
              ))}
              {!ro && cfg.signatories.length < 3 && <div><Button small kind="ghost" onClick={() => set('signatories', [...cfg.signatories, { name: '', title: '' }])}>Add a signatory</Button></div>}
            </Card>
          </Section>
          <Section title="4. Price of a copy">
            <Card>
              <Field label="Price of a copy (KES)" hint="The first card is always free. Enter 0 to keep copies free, or an amount from KES 10 to KES 5,000.">
                <input type="number" min={0} max={5000} step={1} inputMode="numeric" disabled={ro} value={cfg.price} onChange={(e) => set('price', e.target.value)} />
              </Field>
            </Card>
          </Section>
        </div>
      </div>
      {error && <><div style={{ height: 16 }} /><ErrorNote>{error}</ErrorNote></>}
      {!ro && (
        <div className="pp-bar">
          <span className="pp-note">Wording, look, signatures and price are saved together.</span>
          <Button disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save certificate design'}</Button>
        </div>
      )}
      <details className="pp-disc" style={{ marginTop: 24 }}>
        <summary><span>Branch details on the card<small>Each card shows the address and contact details of the branch that issued it.</small></span></summary>
        <div className="pp-disc-body">
          {branches.map((b) => (
            <div key={b.id} className="pp-psec" style={{ borderBottom: 0, padding: 0 }}>
              <div className="pp-hist"><b>{b.name}</b><Hist entity="branch_profile" entityId={b.id} title={`${b.name} address`} label="Address history" /></div>
              <div className="grid cols-2">
                <Field label="Address"><input disabled={ro} value={b.address} onChange={(e) => setBranch(b.id, 'address', e.target.value)} /></Field>
                <Field label="Town"><input disabled={ro} value={b.town} onChange={(e) => setBranch(b.id, 'town', e.target.value)} /></Field>
                <Field label="Phone"><input disabled={ro} value={b.phone} onChange={(e) => setBranch(b.id, 'phone', e.target.value)} /></Field>
                <Field label="Email"><input disabled={ro} type="email" value={b.email} onChange={(e) => setBranch(b.id, 'email', e.target.value)} /></Field>
              </div>
              {!ro && <div><Button small disabled={bBusy === b.id} onClick={() => saveBranch(b)}>{bBusy === b.id ? 'Saving…' : 'Save branch details'}</Button></div>}
            </div>
          ))}
          {bError && <ErrorNote>{bError}</ErrorNote>}
        </div>
      </details>
      {toast.node}
    </>
  );
}

export function Template() {
  const s = useSession();
  const d = useAsync<any>(() => api.get('/certificates/template' + s.qs()), [s.qs()]);
  const [v, setV] = useState(0);
  useEffect(() => { setV((x) => x + 1); }, [d.data]);
  return (
    <>
      <PageHeader title="Certificate design" subtitle="How your baptism cards look. Change the words and watch the card update." actions={<Hist entity="template" entityId={s.grant.org.id} title="Certificate design" label="Design history" />} />
      <Gate loading={d.loading} error={d.error} hasData={!!d.data}>
        {d.data && <TemplateEditor key={v} data={d.data} reload={d.reload} />}
      </Gate>
    </>
  );
}

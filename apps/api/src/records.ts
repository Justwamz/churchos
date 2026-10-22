import { randomBytes } from 'node:crypto';
import type { Db } from '@churchos/ledger';
import { HttpError, type Ctx } from './ctx';
import { todayEat } from './members';
import { checkUpload, cleanFileName } from './uploads';

// ---------- the church's card template (L99) ----------

export interface Signatory {
  name: string;
  title: string;
}
export interface TemplateConfig {
  churchName: string;
  tagline: string;
  baptismTitle: string;
  baptismBody: string;
  signatories: Signatory[];
  accent: string;
  footer: string;
  showQr: boolean;
  /** Price of a copy in cents, 0 for free (L102). */
  copyPriceCents: number;
}

export const DEFAULT_BAPTISM_BODY =
  'This is to certify that {name} was baptised on {date} at {place} by {officiant}, in the name of the Father, and of the Son, and of the Holy Spirit.';

export function defaultTemplate(churchName: string): TemplateConfig {
  return {
    churchName,
    tagline: '',
    baptismTitle: 'Certificate of Baptism',
    baptismBody: DEFAULT_BAPTISM_BODY,
    signatories: [{ name: '', title: 'Officiating Minister' }],
    accent: '#0e5a52',
    footer: '',
    showQr: true,
    copyPriceCents: 0,
  };
}

const PLACEHOLDERS = ['name', 'date', 'place', 'officiant', 'church', 'parents', 'sponsors'];
const LOGO_MIMES = new Set(['image/png', 'image/jpeg']);
const MAX_LOGO = 500 * 1024;

const text = (v: unknown, max: number, field: string, required = false): string => {
  const s = String(v ?? '').trim().replace(/\s+/g, ' ');
  if (required && !s) throw new HttpError(400, `Enter the ${field}`, 'bad_template');
  if (s.length > max) throw new HttpError(400, `The ${field} is too long (up to ${max} characters)`, 'bad_template');
  return s;
};

export function validateTemplate(raw: any): TemplateConfig {
  const c = raw ?? {};
  const body = String(c.baptismBody ?? DEFAULT_BAPTISM_BODY).trim();
  if (!body || body.length > 600) throw new HttpError(400, 'The wording must be between 1 and 600 characters', 'bad_template');
  for (const m of body.matchAll(/\{([^}]*)\}/g)) {
    if (!PLACEHOLDERS.includes(m[1])) throw new HttpError(400, `Unknown placeholder {${m[1]}}. You can use {${PLACEHOLDERS.join('}, {')}}`, 'bad_template');
  }
  if (!/^#[0-9a-fA-F]{6}$/.test(String(c.accent ?? ''))) throw new HttpError(400, 'Choose the accent colour from the colour picker', 'bad_template');
  const signatories = (Array.isArray(c.signatories) ? c.signatories : []).slice(0, 3).map((s: any) => ({ name: text(s?.name, 60, 'signatory name'), title: text(s?.title, 60, 'signatory title') }));
  const price = Number(c.copyPriceCents ?? 0);
  if (!Number.isInteger(price) || price < 0 || price > 500_000 || (price > 0 && price < 1000)) throw new HttpError(400, 'A copy is free, or costs between KES 10 and KES 5,000', 'bad_template');
  return {
    churchName: text(c.churchName, 80, 'church name', true),
    tagline: text(c.tagline, 100, 'tagline'),
    baptismTitle: text(c.baptismTitle, 60, 'certificate title', true),
    baptismBody: body,
    signatories,
    accent: String(c.accent),
    footer: text(c.footer, 160, 'footer note'),
    showQr: c.showQr !== false,
    copyPriceCents: price,
  };
}

export function validateLogo(logo: any): { mime: string; data: string } {
  if (!logo || !LOGO_MIMES.has(logo.mime)) throw new HttpError(400, 'Use a PNG or JPG logo', 'bad_logo');
  const bytes = Buffer.from(String(logo.data ?? ''), 'base64');
  if (bytes.length === 0) throw new HttpError(400, 'That logo file is empty', 'bad_logo');
  if (bytes.length > MAX_LOGO) throw new HttpError(413, 'The logo is larger than 500 KB', 'logo_too_large');
  const checked = checkUpload(bytes, logo.mime, { kinds: ['image'], code: 'bad_logo', label: 'logo' });
  return { mime: checked.mime, data: String(logo.data) };
}

export async function loadTemplate(q: Db, orgId: string): Promise<{ config: TemplateConfig; logo: string | null }> {
  const t = (await q.query<any>(`SELECT config, logo_mime, logo_data FROM certificate_templates WHERE org_id=$1`, [orgId]))[0];
  if (t) return { config: { ...defaultTemplate(''), ...t.config }, logo: t.logo_data ? `data:${t.logo_mime};base64,${t.logo_data}` : null };
  const org = (await q.query<any>(`SELECT name FROM organisations WHERE id=$1`, [orgId]))[0];
  return { config: defaultTemplate(org?.name ?? ''), logo: null };
}

// ---------- records (L98) ----------

const FILE_MIMES = new Set(['application/pdf', 'image/jpeg', 'image/png']);
export const MAX_FILE = 3 * 1024 * 1024;

export function validateFile(f: any) {
  if (!f || !FILE_MIMES.has(f.mime)) throw new HttpError(400, 'Upload a PDF, JPG or PNG file', 'bad_file_type');
  const bytes = Buffer.from(String(f.data ?? ''), 'base64');
  if (bytes.length === 0) throw new HttpError(400, 'That file is empty', 'empty_file');
  if (bytes.length > MAX_FILE) throw new HttpError(413, 'That file is larger than 3 MB', 'too_large');
  const checked = checkUpload(bytes, f.mime, { kinds: ['image', 'pdf'], code: 'bad_file_type', label: 'file' });
  return { name: cleanFileName(f.filename, 'scan'), mime: checked.mime, data: String(f.data) };
}

export interface RecordFields {
  subject_name: string;
  event_date: string;
  place: string;
  officiant: string;
  register_number: string | null;
  membership_id: string | null;
  details: Record<string, any>;
}

const clean = (v: unknown, max: number) => String(v ?? '').trim().replace(/\s+/g, ' ').slice(0, max);

/** Validates the fields of a baptism or marriage record. Returns the normalised fields. */
export async function validateRecord(ctx: Ctx, kind: 'baptism' | 'marriage', orgId: string, b: any): Promise<RecordFields> {
  const now = ctx.clock.now();
  const eventDate = String(b.eventDate ?? '').trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(eventDate);
  const t = todayEat(now);
  if (!m || new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCMonth() !== +m[2] - 1) throw new HttpError(400, kind === 'baptism' ? 'Enter the date of the baptism' : 'Enter the date of the marriage', 'bad_date');
  if (Date.UTC(+m[1], +m[2] - 1, +m[3]) > Date.UTC(t.y, t.m - 1, t.d)) throw new HttpError(400, 'The date cannot be in the future', 'bad_date');
  if (+m[1] < 1900) throw new HttpError(400, 'Check the year', 'bad_date');
  const place = clean(b.place, 120);
  const officiant = clean(b.officiant, 80);
  if (!place) throw new HttpError(400, 'Enter where it took place', 'bad_place');
  if (officiant.length < 2) throw new HttpError(400, 'Enter the name of the officiating minister', 'bad_officiant');
  const register = clean(b.registerNumber, 40) || null;

  if (kind === 'baptism') {
    let name = clean(b.subjectName, 100);
    let membershipId: string | null = null;
    if (b.membershipId) {
      const mem = (await ctx.db.query<any>(`SELECT id, full_name FROM memberships WHERE id=$1 AND org_id=$2`, [b.membershipId, orgId]))[0];
      if (!mem) throw new HttpError(400, 'That member was not found in your church', 'bad_member');
      membershipId = mem.id;
      if (!name) name = mem.full_name;
    }
    if (name.length < 2) throw new HttpError(400, 'Enter the full name of the person baptised', 'bad_name');
    const sponsors = (Array.isArray(b.sponsors) ? b.sponsors : String(b.sponsors ?? '').split(/[,;\n]/)).map((s: any) => clean(s, 80)).filter(Boolean).slice(0, 6);
    const details = {
      dob: b.dob ? clean(b.dob, 10) : null,
      birthplace: clean(b.birthplace, 80) || null,
      father: clean(b.father, 80) || null,
      mother: clean(b.mother, 80) || null,
      sponsors,
    };
    return { subject_name: name, event_date: eventDate, place, officiant, register_number: register, membership_id: membershipId, details };
  }

  // Marriage: two parties and the legal certificate number (L98).
  const parties = (Array.isArray(b.parties) ? b.parties : []).slice(0, 2).map((p: any) => ({ name: clean(p?.name, 100), membershipId: p?.membershipId ? String(p.membershipId) : null }));
  if (parties.length !== 2 || parties.some((p: any) => p.name.length < 2)) throw new HttpError(400, 'Enter the full names of both parties', 'bad_parties');
  for (const p of parties) {
    if (p.membershipId) {
      const mem = (await ctx.db.query<any>(`SELECT 1 FROM memberships WHERE id=$1 AND org_id=$2`, [p.membershipId, orgId]))[0];
      if (!mem) throw new HttpError(400, 'A party was not found in your church', 'bad_member');
    }
  }
  const certNo = clean(b.certificateNumber, 60);
  if (!certNo) throw new HttpError(400, 'Enter the number printed on the marriage certificate', 'cert_number_required');
  const witnesses = (Array.isArray(b.witnesses) ? b.witnesses : String(b.witnesses ?? '').split(/[,;\n]/)).map((s: any) => clean(s, 80)).filter(Boolean).slice(0, 4);
  const details = { parties, certificateNumber: certNo, issuingAuthority: clean(b.issuingAuthority, 100) || null, witnesses };
  return {
    subject_name: `${parties[0].name} & ${parties[1].name}`,
    event_date: eventDate,
    place,
    officiant,
    register_number: register,
    membership_id: parties[0].membershipId,
    details,
  };
}

export async function nextSerial(ctx: Ctx, q: Db, kind: 'baptism' | 'marriage', orgId: string, branchCode: string): Promise<string> {
  const year = todayEat(ctx.clock.now()).y;
  const tag = kind === 'baptism' ? 'BAP' : 'MAR';
  const n0 = Number((await q.query<any>(`SELECT COUNT(*) AS n FROM sacramental_records WHERE org_id=$1 AND kind=$2 AND serial IS NOT NULL`, [orgId, kind]))[0].n);
  for (let n = n0 + 1; n < n0 + 100000; n++) {
    const serial = `${branchCode}-${tag}-${year}-${String(n).padStart(4, '0')}`;
    const taken = (await q.query<any>(`SELECT 1 FROM sacramental_records WHERE serial=$1`, [serial]))[0];
    if (!taken) return serial;
  }
  throw new HttpError(500, 'Could not issue a serial number', 'serial_exhausted');
}

export const newVerifyKey = () => randomBytes(8).toString('base64url');

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export function longDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

/** Everything a card needs to draw itself, so staff, members and the print view all show the same card (L99, L100). */
export async function renderPayload(ctx: Ctx, record: any, opts: { preview: boolean }) {
  const { config, logo } = await loadTemplate(ctx.db, record.org_id);
  const branch = (await ctx.db.query<any>(`SELECT b.name, b.code, p.address, p.town, p.phone, p.email FROM branches b LEFT JOIN branch_profiles p ON p.branch_id=b.id WHERE b.id=$1`, [record.branch_id]))[0];
  const d = record.details ?? {};
  const fill: Record<string, string> = {
    name: record.subject_name,
    date: longDate(record.event_date),
    place: record.place,
    officiant: record.officiant,
    church: config.churchName || branch?.name || '',
    parents: [d.father, d.mother].filter(Boolean).join(' and '),
    sponsors: (d.sponsors ?? []).join(', '),
  };
  const bodyText = config.baptismBody.replace(/\{(\w+)\}/g, (_m: string, k: string) => fill[k] ?? '').replace(/\s+,/g, ',').replace(/\s{2,}/g, ' ').trim();
  return {
    kind: record.kind,
    preview: opts.preview,
    title: config.baptismTitle,
    body: bodyText,
    subject: record.subject_name,
    eventDate: longDate(record.event_date),
    place: record.place,
    officiant: record.officiant,
    registerNumber: record.register_number,
    serial: record.serial,
    version: record.version,
    template: { churchName: config.churchName, tagline: config.tagline, accent: config.accent, footer: config.footer, showQr: config.showQr, signatories: config.signatories.filter((s) => s.name || s.title), logo },
    branch: { name: branch?.name, address: branch?.address ?? null, town: branch?.town ?? null, phone: branch?.phone ?? null, email: branch?.email ?? null },
    verifyPath: record.serial && record.verify_key ? `/verify/${record.serial}?k=${record.verify_key}` : null,
  };
}

// ---------- issuing and copies (L102) ----------

export async function requestIssue(
  ctx: Ctx,
  record: any,
  a: { userId: string; waive?: boolean },
): Promise<{ issueId: string; status: 'issued' | 'awaiting_payment'; kind: 'original' | 'copy'; fee: number; purpose?: string; waived: boolean }> {
  if (record.status !== 'approved') throw new HttpError(409, 'Only an approved record can be issued', 'not_approved');
  const prior = Number((await ctx.db.query<any>(`SELECT COUNT(*) AS n FROM record_issues WHERE record_id=$1 AND status='issued'`, [record.id]))[0].n);
  const kind = prior === 0 ? 'original' : 'copy';
  const { config } = await loadTemplate(ctx.db, record.org_id);
  const fee = kind === 'copy' ? config.copyPriceCents : 0;
  const needsPayment = fee > 0 && !a.waive;
  // One unpaid request per record at a time, so repeated clicks do not pile up.
  const open = (await ctx.db.query<any>(`SELECT id FROM record_issues WHERE record_id=$1 AND status='awaiting_payment'`, [record.id]))[0];
  if (open && needsPayment) return { issueId: open.id, status: 'awaiting_payment', kind, fee, purpose: `CERT-${record.serial}`, waived: false };
  const id = ctx.newId('iss');
  if (open && !needsPayment) await ctx.db.query(`DELETE FROM record_issues WHERE id=$1`, [open.id]);
  await ctx.db.query(
    `INSERT INTO record_issues (id, record_id, org_id, kind, status, fee, waived, waived_by, requested_by, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [id, record.id, record.org_id, kind, needsPayment ? 'awaiting_payment' : 'issued', fee, fee > 0 && !!a.waive, fee > 0 && a.waive ? a.userId : null, a.userId, ctx.clock.now().toISOString()],
  );
  await ctx.ledger.audit({ orgId: record.org_id, actor: a.userId, action: needsPayment ? 'record.copy_requested' : fee > 0 ? 'record.copy_waived' : 'record.issued', entity: 'record', entityId: record.id, meta: { kind, fee } });
  return { issueId: id, status: needsPayment ? 'awaiting_payment' : 'issued', kind, fee, purpose: needsPayment ? `CERT-${record.serial}` : undefined, waived: fee > 0 && !!a.waive };
}

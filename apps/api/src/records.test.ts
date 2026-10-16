import { beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './server';
import { seed } from './seed';

let app: Awaited<ReturnType<typeof buildApp>>['app'];
let ctx: Awaited<ReturnType<typeof buildApp>>['ctx'];
const tokens: Record<string, string> = {};
async function login(phone: string) {
  if (tokens[phone]) return tokens[phone];
  const r = await app.inject({ method: 'POST', url: '/auth/otp/verify', payload: { phone, code: '123456' } });
  tokens[phone] = r.json().token;
  return tokens[phone];
}
const call = async (phone: string | null, method: 'GET' | 'POST' | 'PUT', url: string, payload?: any) =>
  app.inject({ method, url, payload, headers: phone ? { authorization: `Bearer ${await login(phone)}` } : {} });

const OWNER = '0700000001', ADMIN = '0700000003', TREAS = '0700000002', HOPE = '0700000005', PA1 = '0700000099';
const JANE = '0711000001', PETER = '0711000002';
const CLERK = '0733000001', APPROVER = '0733000002'; // created in beforeAll
const YEAR = new Date().getUTCFullYear();
const pdf = Buffer.from('%PDF-1.4 scan').toString('base64');
const wait = async (fn: () => Promise<boolean>, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
};

const baptism = (who: string, extra: any = {}) =>
  call(who, 'POST', '/records', { kind: 'baptism', branchId: 'br_grc001', subjectName: 'Test Person', eventDate: '2026-03-01', place: 'Grace Nairobi', officiant: 'Rev. Daniel Mwangi', ...extra });

beforeAll(async () => {
  const built = await buildApp({ stkDelayMs: 0 });
  app = built.app;
  ctx = built.ctx;
  await seed(ctx);
  const now = ctx.clock.now().toISOString();
  for (const [id, phone, name, role, perms] of [
    ['u_clerk', '254733000001', 'Clara Clerk', 'Clerk', ['records.view', 'records.edit']],
    ['u_approver', '254733000002', 'Alan Approver', 'Approver', ['records.view', 'records.approve']],
  ] as const) {
    await ctx.db.query(`INSERT INTO users (id, phone, name, created_at) VALUES ($1,$2,$3,$4)`, [id, phone, name, now]);
    await ctx.db.query(`INSERT INTO roles (id, org_id, name, permissions) VALUES ($1,'org_grace',$2,$3)`, [`org_grace:${role}`, role, JSON.stringify(perms)]);
    await ctx.db.query(`INSERT INTO role_assignments (id, org_id, user_id, role_id, scope_type, scope_id) VALUES ($1,'org_grace',$2,$3,'branch','br_grc001')`, [`ra_${id}`, id, `org_grace:${role}`]);
  }
}, 60000);

describe('certificate template (L99)', () => {
  it('returns the church template, logo and branch details; only managers may change them', async () => {
    const t = (await call(ADMIN, 'GET', '/certificates/template')).json();
    expect(t.config.churchName).toBe('Grace Community Church');
    expect(t.logo).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(t.canEdit).toBe(true);
    expect(t.branches.find((b: any) => b.code === 'GRC001').address).toMatch(/Ngong Road/);
    expect((await call(CLERK, 'GET', '/certificates/template')).json().canEdit).toBe(false);
    expect((await call(CLERK, 'PUT', '/certificates/template', { config: t.config })).statusCode).toBe(403);
    expect((await call(TREAS, 'GET', '/certificates/template')).statusCode).toBe(403);
  });

  it('validates wording, colour, price, signatories and logo', async () => {
    const base = (await call(ADMIN, 'GET', '/certificates/template')).json().config;
    const put = (config: any, logo?: any) => call(ADMIN, 'PUT', '/certificates/template', { config, ...(logo !== undefined ? { logo } : {}) });
    expect((await put({ ...base, baptismBody: 'Hello {nme}' })).json().error).toMatch(/Unknown placeholder \{nme\}/);
    expect((await put({ ...base, accent: 'green' })).json().code).toBe('bad_template');
    expect((await put({ ...base, churchName: '' })).json().code).toBe('bad_template');
    expect((await put({ ...base, copyPriceCents: 500 })).json().code).toBe('bad_template'); // below the KES 10 minimum
    expect((await put({ ...base, copyPriceCents: -1 })).json().code).toBe('bad_template');
    expect((await put({ ...base }, { mime: 'text/html', data: 'aGk=' })).json().code).toBe('bad_logo');
    expect((await put({ ...base }, { mime: 'image/svg+xml', data: Buffer.from('<svg><script>alert(1)</script></svg>').toString('base64') })).json().code).toBe('bad_logo');
    expect((await put({ ...base }, { mime: 'image/png', data: Buffer.alloc(600 * 1024, 1).toString('base64') })).statusCode).toBe(413);
    expect((await put({ ...base, signatories: [1, 2, 3, 4, 5].map((n) => ({ name: `S${n}`, title: 'T' })) })).statusCode).toBe(200);
    expect((await call(ADMIN, 'GET', '/certificates/template')).json().config.signatories).toHaveLength(3); // capped
    expect((await put(base)).statusCode).toBe(200); // restore
  });

  it('saves branch address and contact details, and rejects a bad email', async () => {
    expect((await call(ADMIN, 'PUT', '/certificates/branch-profile/br_grc001', { address: 'Ngong Road', town: 'Nairobi', email: 'not-an-email' })).json().code).toBe('bad_email');
    expect((await call(ADMIN, 'PUT', '/certificates/branch-profile/br_grc001', { address: 'Ngong Road, Kilimani', town: 'Nairobi', phone: '+254 700 000 111', email: 'nairobi@gracechurch.org' })).statusCode).toBe(200);
    expect((await call(ADMIN, 'PUT', '/certificates/branch-profile/br_hpc001', { address: 'x' })).statusCode).toBe(403); // another church's branch
  });
});

describe('creating and approving records (L63, L98)', () => {
  it('validates baptism details', async () => {
    expect((await baptism(CLERK, { eventDate: '2099-01-01' })).json().code).toBe('bad_date');
    expect((await baptism(CLERK, { eventDate: '2026-02-30' })).json().code).toBe('bad_date');
    expect((await baptism(CLERK, { eventDate: '' })).json().code).toBe('bad_date');
    expect((await baptism(CLERK, { place: '' })).json().code).toBe('bad_place');
    expect((await baptism(CLERK, { officiant: 'R' })).json().code).toBe('bad_officiant');
    expect((await baptism(CLERK, { subjectName: '' })).json().code).toBe('bad_name');
    expect((await baptism(CLERK, { membershipId: 'm_nobody' })).json().code).toBe('bad_member');
    expect((await call(CLERK, 'POST', '/records', { kind: 'confirmation', branchId: 'br_grc001' })).json().code).toBe('bad_kind');
    expect((await call(TREAS, 'POST', '/records', { kind: 'baptism', branchId: 'br_grc001' })).statusCode).toBe(403);
    expect((await call(HOPE, 'POST', '/records', { kind: 'baptism', branchId: 'br_grc001' })).statusCode).toBe(403);
  });

  it('a marriage needs two parties, the legal certificate number, and the scan before approval', async () => {
    const mar = (extra: any) => call(CLERK, 'POST', '/records', { kind: 'marriage', branchId: 'br_grc001', eventDate: '2020-06-06', place: 'Grace Nairobi', officiant: 'Rev. Mutua', ...extra });
    expect((await mar({ parties: [{ name: 'Only One' }] })).json().code).toBe('bad_parties');
    expect((await mar({ parties: [{ name: 'A Person' }, { name: 'B Person' }] })).json().code).toBe('cert_number_required');
    const parties = [{ name: 'Alice Wekesa' }, { name: 'Bob Wekesa' }];
    expect((await mar({ parties, certificateNumber: 'MC/1', submit: true })).json().code).toBe('scan_required');
    expect((await mar({ parties, certificateNumber: 'MC/1', file: { filename: 'x.exe', mime: 'application/x-msdownload', data: pdf } })).json().code).toBe('bad_file_type');
    const ok = await mar({ parties, certificateNumber: 'MC/1', file: { filename: 'scan.pdf', mime: 'application/pdf', data: pdf }, submit: true });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().status).toBe('pending_approval');
  });

  it('the person who entered a record cannot approve it; a different approver can, and a serial and key are issued', async () => {
    const made = (await baptism(CLERK, { subjectName: 'Naomi Test', submit: true })).json();
    expect((await call(CLERK, 'POST', `/records/${made.id}/decide`, {})).statusCode).toBe(403); // lacks records.approve
    expect((await call(ADMIN, 'POST', `/records/${made.id}/decide`, {})).statusCode).toBe(200); // a different person
    const rec = (await call(ADMIN, 'GET', `/records/${made.id}`)).json();
    expect(rec.status).toBe('approved');
    expect(rec.serial).toMatch(new RegExp(`^GRC001-BAP-${YEAR}-\\d{4}$`));
    expect(rec).not.toHaveProperty('verify_key'); // the key never leaves the server in the clear except on the printed card
    expect((await call(ADMIN, 'POST', `/records/${made.id}/decide`, {})).statusCode).toBe(409); // already decided
  });

  it('the creator is blocked even when they hold approval rights, and rejection needs a reason', async () => {
    const mine = (await baptism(ADMIN, { subjectName: 'Own Entry', submit: true })).json();
    const r = await call(ADMIN, 'POST', `/records/${mine.id}/decide`, {});
    expect(r.statusCode).toBe(403);
    expect(r.json().code).toBe('same_person');
    expect((await call(APPROVER, 'POST', `/records/${mine.id}/decide`, { approve: false })).json().code).toBe('reason_required');
    expect((await call(APPROVER, 'POST', `/records/${mine.id}/decide`, { approve: false, reason: 'Wrong date' })).json().status).toBe('rejected');
    const shown = (await call(CLERK, 'GET', `/records/${mine.id}`)).json();
    expect(shown.rejection_reason).toBe('Wrong date');
    // Fix and resubmit, then a different person approves.
    expect((await call(CLERK, 'PUT', `/records/${mine.id}`, { subjectName: 'Own Entry', eventDate: '2026-03-02', place: 'Grace Nairobi', officiant: 'Rev. Daniel Mwangi' })).json().status).toBe('draft');
    expect((await call(CLERK, 'POST', `/records/${mine.id}/submit`, {})).json().status).toBe('pending_approval');
    expect((await call(CLERK, 'PUT', `/records/${mine.id}`, { subjectName: 'Changed', eventDate: '2026-03-02', place: 'x', officiant: 'Rev. Daniel Mwangi' })).statusCode).toBe(409); // locked while pending
    expect((await call(APPROVER, 'POST', `/records/${mine.id}/decide`, {})).json().status).toBe('approved');
  });

  it('serials are unique and sequential', async () => {
    const a = (await baptism(CLERK, { subjectName: 'Serial A', submit: true })).json();
    const b = (await baptism(CLERK, { subjectName: 'Serial B', submit: true })).json();
    const sa = (await call(APPROVER, 'POST', `/records/${a.id}/decide`, {})).json().serial;
    const sb = (await call(APPROVER, 'POST', `/records/${b.id}/decide`, {})).json().serial;
    expect(sa).not.toBe(sb);
    expect(Number(sb.slice(-4))).toBe(Number(sa.slice(-4)) + 1);
  });
});

describe('amending an approved record (L101)', () => {
  let id: string;
  let serial: string;
  it('keeps the approved version live until the changes are approved by someone else', async () => {
    const made = (await baptism(CLERK, { subjectName: 'Amend Me', place: 'Old Place', submit: true })).json();
    id = made.id;
    serial = (await call(APPROVER, 'POST', `/records/${id}/decide`, {})).json().serial;
    const ed = await call(CLERK, 'PUT', `/records/${id}`, { subjectName: 'Amend Me', eventDate: '2026-03-01', place: 'New Place', officiant: 'Rev. Daniel Mwangi' });
    expect(ed.json().pendingChanges).toBe(true);
    const mid = (await call(CLERK, 'GET', `/records/${id}`)).json();
    expect(mid.place).toBe('Old Place'); // approved version unchanged
    expect(mid.has_pending_changes).toBe(true);
    expect((await call(CLERK, 'GET', `/records/${id}/render`)).json().place).toBe('Old Place');
    expect((await call(CLERK, 'POST', `/records/${id}/decide`, {})).statusCode).toBe(403);
  });

  it('approval replaces the approved version, bumps the version and keeps the serial', async () => {
    const r = await call(APPROVER, 'POST', `/records/${id}/decide`, {});
    expect(r.json().version).toBe(2);
    const after = (await call(CLERK, 'GET', `/records/${id}`)).json();
    expect(after.place).toBe('New Place');
    expect(after.serial).toBe(serial);
    expect(after.has_pending_changes).toBe(false);
  });

  it('rejecting an amendment discards it and leaves the approved record intact', async () => {
    await call(CLERK, 'PUT', `/records/${id}`, { subjectName: 'Amend Me', eventDate: '2026-03-01', place: 'Bad Place', officiant: 'Rev. Daniel Mwangi' });
    expect((await call(APPROVER, 'POST', `/records/${id}/decide`, { approve: false, reason: 'Not correct' })).json().status).toBe('approved');
    const after = (await call(CLERK, 'GET', `/records/${id}`)).json();
    expect(after.place).toBe('New Place');
    expect(after.has_pending_changes).toBe(false);
  });
});

describe('public verification (L100)', () => {
  it('confirms a real card with its key and shows no private details', async () => {
    const render = (await call(ADMIN, 'GET', '/records/rec_ruth/render')).json();
    expect(render.verifyPath).toMatch(/^\/verify\/GRC001-BAP-\d{4}-0001\?k=DEMOKEY1$/);
    const v = await call(null, 'GET', '/public/verify/GRC001-BAP-' + YEAR + '-0001?k=DEMOKEY1');
    expect(v.statusCode).toBe(200);
    expect(v.json()).toMatchObject({ valid: true, kind: 'baptism', subject: 'Ruth Wanjiku', church: 'Grace Nairobi' });
    const text = JSON.stringify(v.json());
    expect(text).not.toMatch(/David Wanjiku|Jane Wanjiku|Mary Achieng|sponsor/i); // parents and sponsors stay private
  });

  it('a serial alone, a wrong key, an unapproved record and a made-up serial all look the same', async () => {
    const s = `GRC001-BAP-${YEAR}-0001`;
    const bodies = [
      await call(null, 'GET', `/public/verify/${s}`),
      await call(null, 'GET', `/public/verify/${s}?k=WRONG`),
      await call(null, 'GET', `/public/verify/NOPE-1?k=DEMOKEY1`),
    ];
    for (const r of bodies) expect(r.statusCode).toBe(404);
    expect(new Set(bodies.map((r) => r.body)).size).toBe(1);
    // A pending record has no serial yet, so it cannot be verified.
    expect((await call(null, 'GET', '/public/verify/null?k=null')).statusCode).toBe(404);
  });
});

describe('issuing and copies (L102)', () => {
  it('the first card is free, a copy waits for payment, repeated clicks do not pile up, and paying releases it', async () => {
    const first = (await call(ADMIN, 'POST', '/records/rec_ruth/issue', {})).json();
    expect(first).toMatchObject({ status: 'issued', kind: 'original', fee: 0 });
    expect(first.render.preview).toBe(false);
    expect(first.render.template.signatories[0].name).toBe('Rev. Daniel Mwangi');
    expect(first.render.verifyPath).toContain('k=DEMOKEY1');

    const copy = (await call(ADMIN, 'POST', '/records/rec_ruth/issue', {})).json();
    expect(copy).toMatchObject({ status: 'awaiting_payment', kind: 'copy', fee: 50000, purpose: `CERT-GRC001-BAP-${YEAR}-0001` });
    expect(copy.render).toBeNull();
    expect((await call(ADMIN, 'POST', '/records/rec_ruth/issue', {})).json().issueId).toBe(copy.issueId);

    const info = (await call(null, 'GET', `/public/cert/GRC001-BAP-${YEAR}-0001`)).json();
    expect(info).toMatchObject({ price: 50000, churchCode: 'GRC001' });
    expect(JSON.stringify(info)).not.toMatch(/Ruth/); // the public lookup never names the person

    const give = (amount: number) => call(null, 'POST', '/public/give', { code: 'GRC001', purpose: info.purpose, phone: '0711000001', amount });
    expect((await give(100)).json().code).toBe('amount_must_be_exact');
    expect((await call(null, 'POST', '/public/give', { code: 'GRC002', purpose: info.purpose, phone: '0711000001', amount: 500 })).json().code).toBe('unknown_purpose'); // other branch
    const paid = await give(500);
    expect(paid.statusCode).toBe(200);
    expect(await wait(async () => (await call(null, 'GET', `/public/give/${paid.json().intentId}`)).json().status === 'completed')).toBe(true);
    const issues = (await call(ADMIN, 'GET', '/records/rec_ruth/issues')).json();
    expect(issues.find((i: any) => i.id === copy.issueId).status).toBe('issued');
    expect((await call(PA1, 'GET', '/admin/reconcile')).json().ok).toBe(true);
    // After payment there is no open request, so the public lookup closes.
    expect((await call(null, 'GET', `/public/cert/GRC001-BAP-${YEAR}-0001`)).statusCode).toBe(404);
  });

  it('only someone who can approve may waive the fee, and a waiver is logged', async () => {
    expect((await call(CLERK, 'POST', '/records/rec_ruth/issue', { waive: true })).statusCode).toBe(403);
    const w = (await call(ADMIN, 'POST', '/records/rec_ruth/issue', { waive: true })).json();
    expect(w).toMatchObject({ status: 'issued', waived: true, kind: 'copy' });
    const issues = (await call(ADMIN, 'GET', '/records/rec_ruth/issues')).json();
    expect(issues.some((i: any) => i.waived && i.waived_by_name === 'Samuel Kiptoo')).toBe(true);
    const audit = (await call(PA1, 'GET', '/admin/audit')).json();
    expect(audit.some((a: any) => a.action === 'record.copy_waived')).toBe(true);
  });

  it('a draft or marriage record cannot be issued as a card', async () => {
    expect((await call(ADMIN, 'POST', '/records/rec_marriage/issue', {})).json().code).toBe('not_issuable');
    expect((await call(ADMIN, 'POST', '/records/rec_brian/issue', {})).json().code).toBe('not_approved');
    expect((await call(ADMIN, 'GET', '/records/rec_marriage/render')).statusCode).toBe(400);
  });

  it('the preview is marked as a preview until it is issued', async () => {
    expect((await call(ADMIN, 'GET', '/records/rec_ruth/render')).json().preview).toBe(true);
  });
});

describe('members see their own records (L103, L64)', () => {
  it('a member sees only their own approved records and can ask for their card', async () => {
    const jane = (await call(JANE, 'GET', '/me/records')).json();
    expect(jane.map((r: any) => r.kind)).toEqual(['marriage']); // Jane is a party to the marriage, Ruth's baptism is not hers
    expect(jane[0].can_print).toBe(false);
    expect((await call(JANE, 'POST', `/me/records/${jane[0].id}/copy`, {})).json().code).toBe('not_issuable');

    const mine = (await baptism(CLERK, { subjectName: 'Peter Otieno', membershipId: 'm_peter', eventDate: '2000-04-02', submit: true })).json();
    await call(APPROVER, 'POST', `/records/${mine.id}/decide`, {});
    const peter = (await call(PETER, 'GET', '/me/records')).json();
    expect(peter).toHaveLength(1);
    expect(peter[0]).toMatchObject({ kind: 'baptism', can_print: true, held_elsewhere: false });
    expect((await call(JANE, 'GET', `/me/records/${peter[0].id}/render`)).statusCode).toBe(404); // not Jane's
    expect((await call(PETER, 'GET', `/me/records/${peter[0].id}/render`)).json().preview).toBe(true);
    const copy = (await call(PETER, 'POST', `/me/records/${peter[0].id}/copy`, {})).json();
    expect(copy).toMatchObject({ status: 'issued', kind: 'original' });
    expect(copy.render.preview).toBe(false);
    const again = (await call(PETER, 'POST', `/me/records/${peter[0].id}/copy`, {})).json();
    expect(again).toMatchObject({ status: 'awaiting_payment', fee: 50000, churchCode: 'GRC001' });
  });

  it('after moving to another church the record stays with the church that holds it, shown read-only (L64)', async () => {
    const t = (await call(PETER, 'POST', '/me/transfer-request', { toChurchCode: 'HPC001' })).json();
    await ctx.db.query(`INSERT INTO guardians (child_id, guardian_id, org_id) VALUES ('m_brian','m_amina','org_grace') ON CONFLICT DO NOTHING`); // Brian needs another guardian before Peter can leave (L125)
    expect((await call(HOPE, 'POST', `/transfers/${t.id}/decide`, { approve: true })).statusCode).toBe(200);
    const me = (await call(PETER, 'GET', '/me')).json();
    const newMembership = me.memberships[0].id;
    const seen = (await call(HOPE, 'GET', `/records/by-member/${newMembership}`)).json();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ kind: 'baptism', read_only: true, held_by: 'Grace Community Church' });
    // Hope's staff cannot open or edit Grace's record itself.
    expect((await call(HOPE, 'GET', `/records/${seen[0].id}`)).statusCode).toBe(404);
    expect((await call(HOPE, 'PUT', `/records/${seen[0].id}`, { subjectName: 'X Y', eventDate: '2000-01-01', place: 'p', officiant: 'Rev. X' })).statusCode).toBe(404);
    const mineAfter = (await call(PETER, 'GET', '/me/records')).json();
    expect(mineAfter[0].held_elsewhere).toBe(true);
  });
});

describe('isolation and permissions', () => {
  it('another church cannot list, read or download Grace records', async () => {
    expect((await call(HOPE, 'GET', '/records?branch=br_grc001')).statusCode).toBe(403);
    expect((await call(HOPE, 'GET', '/records/rec_marriage')).statusCode).toBe(404);
    expect((await call(HOPE, 'GET', '/records/rec_marriage/file')).statusCode).toBe(404);
    expect(((await call(HOPE, 'GET', '/records')).json() as any[]).length).toBe(0);
  });

  it('lists approvals first and downloads the marriage scan for staff who can view it', async () => {
    const list = (await call(ADMIN, 'GET', '/records')).json();
    expect(list[0].status === 'pending_approval' || list[0].has_pending_changes).toBe(true);
    expect((await call(ADMIN, 'GET', '/records?kind=marriage')).json().every((r: any) => r.kind === 'marriage')).toBe(true);
    const file = await app.inject({ method: 'GET', url: '/records/rec_marriage/file', headers: { authorization: `Bearer ${await login(ADMIN)}` } });
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toBe('application/pdf');
    expect((await call(TREAS, 'GET', '/records')).statusCode).toBe(403);
    expect((await call(JANE, 'GET', '/records')).statusCode).toBe(403);
  });
});

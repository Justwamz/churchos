import type { FastifyInstance, FastifyRequest } from 'fastify';
import { branchesFor } from '../auth';
import { HttpError, inList, requireSession, staffScope, type Ctx } from '../ctx';
import {
  loadTemplate, newVerifyKey, nextSerial, renderPayload, requestIssue, validateFile, validateLogo, validateRecord, validateTemplate,
  type RecordFields,
} from '../records';

const LIST_SQL = `SELECT r.id, r.kind, r.subject_name, r.event_date, r.place, r.officiant, r.register_number, r.status, r.serial, r.version, r.branch_id, b.name AS branch_name,
       r.rejection_reason, (r.pending_changes IS NOT NULL) AS has_pending_changes, (r.file_data IS NOT NULL) AS has_file, r.created_at, r.updated_at,
       uc.name AS created_by_name, ue.name AS last_edited_by_name, r.created_by, r.last_edited_by, r.approved_at
  FROM sacramental_records r JOIN branches b ON b.id=r.branch_id LEFT JOIN users uc ON uc.id=r.created_by LEFT JOIN users ue ON ue.id=r.last_edited_by`;

const FIELD_COLS: (keyof RecordFields)[] = ['subject_name', 'event_date', 'place', 'officiant', 'register_number', 'membership_id', 'details'];

export function recordRoutes(app: FastifyInstance, ctx: Ctx) {
  const auth = { preHandler: requireSession };

  /**
   * Loads a record the signed-in person may act on. A record outside their branches looks exactly like a missing one,
   * so another church cannot learn that an id exists.
   */
  async function loadRecord(req: FastifyRequest, perm: 'records.view' | 'records.edit' | 'records.approve') {
    const rows = await branchesFor(ctx.db, req.session!.uid, perm);
    if (rows.length === 0) throw new HttpError(403, `missing permission ${perm}`, 'forbidden');
    const r = (await ctx.db.query<any>(`SELECT * FROM sacramental_records WHERE id=$1`, [(req.params as any).id]))[0];
    if (!r || !rows.some((x) => x.branchId === r.branch_id && x.orgId === r.org_id)) throw new HttpError(404, 'record not found', 'not_found');
    return r;
  }

  const strip = (r: any) => {
    const { file_data: _f, verify_key: _k, ...rest } = r;
    return { ...rest, has_file: !!r.file_data, has_pending_changes: !!r.pending_changes };
  };

  // ---------- the church's template (L99) ----------

  app.get('/certificates/template', auth, async (req) => {
    const scope = await staffScope(ctx, req, 'records.view');
    const { config, logo } = await loadTemplate(ctx.db, scope.orgId);
    const branches = await ctx.db.query<any>(
      `SELECT b.id, b.code, b.name, p.address, p.town, p.phone, p.email FROM branches b LEFT JOIN branch_profiles p ON p.branch_id=b.id WHERE b.id = ANY($1::text[]) ORDER BY b.name`,
      [scope.branchIds],
    );
    const canEdit = (await branchesFor(ctx.db, req.session!.uid, 'templates.manage')).some((r) => r.orgId === scope.orgId);
    return { config, logo, branches, canEdit, placeholders: ['name', 'date', 'place', 'officiant', 'church', 'parents', 'sponsors'] };
  });

  app.put('/certificates/template', auth, async (req) => {
    const b = (req.body ?? {}) as any;
    const scope = await staffScope(ctx, req, 'templates.manage');
    const config = validateTemplate(b.config);
    const cur = (await ctx.db.query<any>(`SELECT logo_mime, logo_data FROM certificate_templates WHERE org_id=$1`, [scope.orgId]))[0];
    let logo = cur ? { mime: cur.logo_mime, data: cur.logo_data } : { mime: null, data: null };
    if (b.logo === null) logo = { mime: null, data: null };
    else if (b.logo !== undefined) logo = validateLogo(b.logo);
    await ctx.db.query(
      `INSERT INTO certificate_templates (org_id, config, logo_mime, logo_data, updated_by, updated_at) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (org_id) DO UPDATE SET config=$2, logo_mime=$3, logo_data=$4, updated_by=$5, updated_at=$6`,
      [scope.orgId, JSON.stringify(config), logo.mime, logo.data, req.session!.uid, ctx.clock.now().toISOString()],
    );
    await ctx.ledger.audit({ orgId: scope.orgId, actor: req.session!.uid, action: 'template.update', entity: 'organisation', entityId: scope.orgId });
    return { ok: true };
  });

  app.put('/certificates/branch-profile/:branchId', auth, async (req) => {
    const b = (req.body ?? {}) as any;
    const branchId = (req.params as any).branchId;
    const scope = await staffScope(ctx, req, 'templates.manage', branchId);
    const f = (v: unknown, max: number) => String(v ?? '').trim().replace(/\s+/g, ' ').slice(0, max) || null;
    const email = f(b.email, 120);
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, 'Enter a valid email address', 'bad_email');
    await ctx.db.query(
      `INSERT INTO branch_profiles (branch_id, org_id, address, town, phone, email) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (branch_id) DO UPDATE SET address=$3, town=$4, phone=$5, email=$6`,
      [branchId, scope.orgId, f(b.address, 160), f(b.town, 80), f(b.phone, 40), email],
    );
    return { ok: true };
  });

  // ---------- records ----------

  app.get('/records', auth, async (req) => {
    const q = req.query as any;
    const scope = await staffScope(ctx, req, 'records.view', q.branch);
    const params: unknown[] = [...scope.branchIds];
    let where = `r.branch_id IN (${inList(1, scope.branchIds.length)})`;
    for (const [col, val] of [['r.kind', q.kind], ['r.status', q.status]] as const) {
      if (val) { params.push(String(val)); where += ` AND ${col}=$${params.length}`; }
    }
    if (q.q) { params.push(`%${String(q.q).toLowerCase()}%`); where += ` AND (lower(r.subject_name) LIKE $${params.length} OR lower(COALESCE(r.serial,'')) LIKE $${params.length} OR lower(COALESCE(r.register_number,'')) LIKE $${params.length})`; }
    return ctx.db.query<any>(
      `${LIST_SQL} WHERE ${where} ORDER BY (CASE WHEN r.status='pending_approval' OR r.pending_changes IS NOT NULL THEN 0 ELSE 1 END), r.updated_at DESC LIMIT 300`,
      params,
    );
  });

  app.post('/records', auth, async (req) => {
    const b = (req.body ?? {}) as any;
    if (b.kind !== 'baptism' && b.kind !== 'marriage') throw new HttpError(400, 'Choose baptism or marriage', 'bad_kind');
    if (!b.branchId) throw new HttpError(400, 'Choose a branch', 'bad_branch');
    const scope = await staffScope(ctx, req, 'records.edit', b.branchId);
    const fields = await validateRecord(ctx, b.kind, scope.orgId, b);
    const file = b.file ? validateFile(b.file) : null;
    if (b.submit && b.kind === 'marriage' && !file) throw new HttpError(400, 'Attach the scan or photo of the marriage certificate before sending it for approval', 'scan_required');
    const id = ctx.newId('rec');
    const now = ctx.clock.now().toISOString();
    await ctx.db.query(
      `INSERT INTO sacramental_records (id, org_id, branch_id, kind, membership_id, subject_name, event_date, place, officiant, register_number, details, status, file_name, file_mime, file_data, created_by, last_edited_by, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$16,$17,$17)`,
      [id, scope.orgId, b.branchId, b.kind, fields.membership_id, fields.subject_name, fields.event_date, fields.place, fields.officiant, fields.register_number, JSON.stringify(fields.details),
       b.submit ? 'pending_approval' : 'draft', file?.name ?? null, file?.mime ?? null, file?.data ?? null, req.session!.uid, now],
    );
    await ctx.ledger.audit({ orgId: scope.orgId, actor: req.session!.uid, action: 'record.create', entity: 'record', entityId: id, meta: { kind: b.kind } });
    return { id, status: b.submit ? 'pending_approval' : 'draft' };
  });

  app.get('/records/:id', auth, async (req) => {
    const r = await loadRecord(req, 'records.view');
    const full = (await ctx.db.query<any>(`${LIST_SQL} WHERE r.id=$1`, [r.id]))[0];
    return { ...full, details: r.details, membership_id: r.membership_id, pending_changes: r.pending_changes ? { ...r.pending_changes, file: r.pending_changes.file ? { name: r.pending_changes.file.name, mime: r.pending_changes.file.mime } : undefined } : null, file_name: r.file_name, file_mime: r.file_mime };
  });

  /** Edits a draft or rejected record directly. An approved record keeps its approved version until the changes are approved (L101). */
  app.put('/records/:id', auth, async (req) => {
    const b = (req.body ?? {}) as any;
    const r = await loadRecord(req, 'records.edit');
    if (r.status === 'pending_approval') throw new HttpError(409, 'This record is waiting for approval. Ask the approver to reject it first if it needs changes.', 'locked');
    const fields = await validateRecord(ctx, r.kind, r.org_id, { ...b, kind: r.kind });
    const file = b.file ? validateFile(b.file) : null;
    const now = ctx.clock.now().toISOString();
    if (r.status === 'approved') {
      const changes = { ...fields, file: file ? { name: file.name, mime: file.mime, data: file.data } : undefined };
      await ctx.db.query(`UPDATE sacramental_records SET pending_changes=$2, last_edited_by=$3, updated_at=$4 WHERE id=$1`, [r.id, JSON.stringify(changes), req.session!.uid, now]);
      await ctx.ledger.audit({ orgId: r.org_id, actor: req.session!.uid, action: 'record.amend', entity: 'record', entityId: r.id });
      return { id: r.id, status: 'approved', pendingChanges: true };
    }
    await ctx.db.query(
      `UPDATE sacramental_records SET membership_id=$2, subject_name=$3, event_date=$4, place=$5, officiant=$6, register_number=$7, details=$8, status='draft', rejection_reason=NULL,
              file_name=COALESCE($9,file_name), file_mime=COALESCE($10,file_mime), file_data=COALESCE($11,file_data), last_edited_by=$12, updated_at=$13 WHERE id=$1`,
      [r.id, fields.membership_id, fields.subject_name, fields.event_date, fields.place, fields.officiant, fields.register_number, JSON.stringify(fields.details), file?.name ?? null, file?.mime ?? null, file?.data ?? null, req.session!.uid, now],
    );
    return { id: r.id, status: 'draft' };
  });

  app.post('/records/:id/file', auth, async (req) => {
    const r = await loadRecord(req, 'records.edit');
    if (r.status === 'pending_approval') throw new HttpError(409, 'This record is waiting for approval', 'locked');
    const file = validateFile(req.body);
    await ctx.db.query(`UPDATE sacramental_records SET file_name=$2, file_mime=$3, file_data=$4, last_edited_by=$5, updated_at=$6 WHERE id=$1`, [r.id, file.name, file.mime, file.data, req.session!.uid, ctx.clock.now().toISOString()]);
    return { ok: true };
  });

  app.get('/records/:id/file', auth, async (req, reply) => {
    const r = await loadRecord(req, 'records.view');
    if (!r.file_data) throw new HttpError(404, 'There is no scan attached to this record', 'no_file');
    reply.header('content-type', r.file_mime).header('content-disposition', `inline; filename="${String(r.file_name ?? 'scan').replace(/"/g, '')}"`);
    return reply.send(Buffer.from(r.file_data, 'base64'));
  });

  app.post('/records/:id/submit', auth, async (req) => {
    const r = await loadRecord(req, 'records.edit');
    if (r.status !== 'draft' && r.status !== 'rejected') throw new HttpError(409, 'Only a draft can be sent for approval', 'bad_state');
    if (r.kind === 'marriage' && !r.file_data) throw new HttpError(400, 'Attach the scan or photo of the marriage certificate first', 'scan_required');
    await ctx.db.query(`UPDATE sacramental_records SET status='pending_approval', rejection_reason=NULL, updated_at=$2 WHERE id=$1`, [r.id, ctx.clock.now().toISOString()]);
    await ctx.ledger.audit({ orgId: r.org_id, actor: req.session!.uid, action: 'record.submit', entity: 'record', entityId: r.id });
    return { id: r.id, status: 'pending_approval' };
  });

  /**
   * A second person approves (L63). The person who created or last edited the record cannot approve it.
   * Approving a new record issues its serial number and verification key. Approving amendments replaces the approved version (L101).
   */
  app.post('/records/:id/decide', auth, async (req) => {
    const b = (req.body ?? {}) as any;
    const r = await loadRecord(req, 'records.approve');
    const approve = b.approve !== false;
    const isNew = r.status === 'pending_approval';
    const isAmendment = r.status === 'approved' && !!r.pending_changes;
    if (!isNew && !isAmendment) throw new HttpError(409, 'There is nothing waiting for approval on this record', 'bad_state');
    const me = req.session!.uid;
    if (r.created_by === me || r.last_edited_by === me) throw new HttpError(403, 'A different person must approve this. You entered or changed it.', 'same_person');
    const now = ctx.clock.now().toISOString();

    if (!approve) {
      const reason = String(b.reason ?? '').trim();
      if (!reason) throw new HttpError(400, 'Give a reason so the person who entered it knows what to fix', 'reason_required');
      if (isNew) await ctx.db.query(`UPDATE sacramental_records SET status='rejected', rejection_reason=$2, updated_at=$3 WHERE id=$1`, [r.id, reason, now]);
      else await ctx.db.query(`UPDATE sacramental_records SET pending_changes=NULL, updated_at=$2 WHERE id=$1`, [r.id, now]);
      await ctx.ledger.audit({ orgId: r.org_id, actor: me, action: 'record.reject', entity: 'record', entityId: r.id, meta: { reason } });
      return { id: r.id, status: isNew ? 'rejected' : 'approved' };
    }

    if (isNew) {
      if (r.kind === 'marriage' && !r.file_data) throw new HttpError(400, 'The marriage certificate scan is missing', 'scan_required');
      const result = await ctx.db.tx(async (q) => {
        const branch = (await q.query<any>(`SELECT code FROM branches WHERE id=$1`, [r.branch_id]))[0];
        const serial = await nextSerial(ctx, q, r.kind, r.org_id, branch.code);
        await q.query(`UPDATE sacramental_records SET status='approved', serial=$2, verify_key=$3, approved_by=$4, approved_at=$5, updated_at=$5 WHERE id=$1`, [r.id, serial, newVerifyKey(), me, now]);
        return serial;
      });
      await ctx.ledger.audit({ orgId: r.org_id, actor: me, action: 'record.approve', entity: 'record', entityId: r.id, meta: { serial: result } });
      return { id: r.id, status: 'approved', serial: result };
    }

    const c = r.pending_changes;
    await ctx.db.query(
      `UPDATE sacramental_records SET membership_id=$2, subject_name=$3, event_date=$4, place=$5, officiant=$6, register_number=$7, details=$8, version=version+1,
              file_name=COALESCE($9,file_name), file_mime=COALESCE($10,file_mime), file_data=COALESCE($11,file_data), pending_changes=NULL, approved_by=$12, approved_at=$13, updated_at=$13 WHERE id=$1`,
      [r.id, c.membership_id, c.subject_name, c.event_date, c.place, c.officiant, c.register_number, JSON.stringify(c.details), c.file?.name ?? null, c.file?.mime ?? null, c.file?.data ?? null, me, now],
    );
    await ctx.ledger.audit({ orgId: r.org_id, actor: me, action: 'record.amend_approve', entity: 'record', entityId: r.id });
    return { id: r.id, status: 'approved', version: r.version + 1 };
  });

  // ---------- printing and copies (L102) ----------

  app.post('/records/:id/issue', auth, async (req) => {
    const b = (req.body ?? {}) as any;
    const r = await loadRecord(req, 'records.view');
    if (r.kind !== 'baptism') throw new HttpError(400, 'A marriage certificate is a legal document issued by the registry. Open the uploaded copy instead.', 'not_issuable');
    let waive = false;
    if (b.waive === true) {
      const canApprove = (await branchesFor(ctx.db, req.session!.uid, 'records.approve')).some((x) => x.branchId === r.branch_id);
      if (!canApprove) throw new HttpError(403, 'Only someone who can approve records can waive the fee', 'forbidden');
      waive = true;
    }
    const res = await requestIssue(ctx, r, { userId: req.session!.uid, waive });
    return { ...res, render: res.status === 'issued' ? await renderPayload(ctx, r, { preview: false }) : null };
  });

  app.get('/records/:id/render', auth, async (req) => {
    const r = await loadRecord(req, 'records.view');
    if (r.kind !== 'baptism') throw new HttpError(400, 'Marriage certificates are not generated by ChurchOS', 'not_issuable');
    const issueId = (req.query as any).issue;
    const issued = issueId ? (await ctx.db.query<any>(`SELECT 1 FROM record_issues WHERE id=$1 AND record_id=$2 AND status='issued'`, [issueId, r.id]))[0] : null;
    return renderPayload(ctx, r, { preview: !issued });
  });

  app.get('/records/:id/issues', auth, async (req) => {
    const r = await loadRecord(req, 'records.view');
    return ctx.db.query<any>(`SELECT i.id, i.kind, i.status, i.fee, i.waived, i.created_at, u.name AS requested_by_name, w.name AS waived_by_name FROM record_issues i LEFT JOIN users u ON u.id=i.requested_by LEFT JOIN users w ON w.id=i.waived_by WHERE i.record_id=$1 ORDER BY i.created_at DESC`, [r.id]);
  });

  /**
   * Records tied to a member, including ones held by another church, shown read-only as a verified copy (L64).
   */
  app.get('/records/by-member/:membershipId', auth, async (req) => {
    const m = (await ctx.db.query<any>(`SELECT id, org_id, branch_id, user_id FROM memberships WHERE id=$1`, [(req.params as any).membershipId]))[0];
    if (!m) throw new HttpError(404, 'member not found', 'not_found');
    const scope = await staffScope(ctx, req, 'records.view', m.branch_id);
    if (scope.orgId !== m.org_id) throw new HttpError(404, 'member not found', 'not_found');
    const rows = await ctx.db.query<any>(
      `SELECT r.id, r.kind, r.subject_name, r.event_date, r.place, r.serial, r.status, r.org_id, o.name AS held_by, b.name AS branch_name
         FROM sacramental_records r JOIN organisations o ON o.id=r.org_id JOIN branches b ON b.id=r.branch_id
        WHERE r.status='approved' AND (r.membership_id IN (SELECT id FROM memberships WHERE ${m.user_id ? 'user_id=$1' : 'id=$1'})
              OR EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(r.details->'parties','[]'::jsonb)) p WHERE p->>'membershipId' IN (SELECT id FROM memberships WHERE ${m.user_id ? 'user_id=$1' : 'id=$1'})))
        ORDER BY r.event_date`,
      [m.user_id ?? m.id],
    );
    // A record held by another church is a read-only verified copy: no details, no editing (L64).
    return rows.map((r) => ({ ...r, read_only: r.org_id !== scope.orgId, subject_name: r.subject_name }));
  });
}

// ---------- public verification (L100) ----------

export function publicRecordRoutes(app: FastifyInstance, ctx: Ctx) {
  const MISSING = () => new HttpError(404, 'We could not verify this certificate. Check the link on the card, or contact the church that issued it.', 'not_verified');

  app.get('/public/verify/:serial', async (req) => {
    const k = String((req.query as any).k ?? '');
    const r = (await ctx.db.query<any>(`SELECT * FROM sacramental_records WHERE serial=$1 AND status='approved'`, [(req.params as any).serial]))[0];
    // The key is printed only on the card, so a serial number alone cannot be used to look up a person.
    if (!r || !k || k !== r.verify_key) throw MISSING();
    const b = (await ctx.db.query<any>(`SELECT b.name, o.name AS org FROM branches b JOIN organisations o ON o.id=b.org_id WHERE b.id=$1`, [r.branch_id]))[0];
    return {
      valid: true,
      kind: r.kind,
      serial: r.serial,
      subject: r.subject_name,
      eventDate: r.event_date,
      place: r.place,
      church: b.name,
      organisation: b.org,
      approvedAt: r.approved_at,
      version: r.version,
    };
  });

  /** Lets the giving page show what a copy costs. Only available while a copy is waiting to be paid for. */
  app.get('/public/cert/:serial', async (req) => {
    const r = (await ctx.db.query<any>(`SELECT id, kind, serial, branch_id, org_id FROM sacramental_records WHERE serial=$1 AND status='approved'`, [(req.params as any).serial]))[0];
    const open = r ? (await ctx.db.query<any>(`SELECT fee FROM record_issues WHERE record_id=$1 AND status='awaiting_payment' ORDER BY created_at DESC LIMIT 1`, [r.id]))[0] : null;
    if (!r || !open) throw new HttpError(404, 'There is no certificate copy waiting to be paid for under that reference', 'not_found');
    const b = (await ctx.db.query<any>(`SELECT code, name FROM branches WHERE id=$1`, [r.branch_id]))[0];
    return { serial: r.serial, kind: r.kind, price: open.fee, churchCode: b.code, church: b.name, purpose: `CERT-${r.serial}` };
  });
}

// ---------- member app (L103) ----------

export function memberRecordRoutes(app: FastifyInstance, ctx: Ctx) {
  const auth = { preHandler: requireSession };

  // $1 is always the signed-in user's id.
  const MINE = `
    SELECT r.*, b.name AS branch_name, o.name AS org_name FROM sacramental_records r JOIN branches b ON b.id=r.branch_id JOIN organisations o ON o.id=r.org_id
     WHERE r.status='approved' AND (
       r.membership_id IN (SELECT id FROM memberships WHERE user_id=$1)
       OR EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(r.details->'parties','[]'::jsonb)) p WHERE p->>'membershipId' IN (SELECT id FROM memberships WHERE user_id=$1)))`;
  async function owned(req: FastifyRequest) {
    const r = (await ctx.db.query<any>(`${MINE} AND r.id=$2`, [req.session!.uid, (req.params as any).id]))[0];
    if (!r) throw new HttpError(404, 'We could not find that record', 'not_found');
    return r;
  }

  app.get('/me/records', auth, async (req) => {
    const rows = await ctx.db.query<any>(`${MINE} ORDER BY r.event_date DESC`, [req.session!.uid]);
    const orgs = new Set((await ctx.db.query<any>(`SELECT org_id FROM memberships WHERE user_id=$1 AND status='active'`, [req.session!.uid])).map((x) => x.org_id));
    return rows.map((r) => ({
      id: r.id, kind: r.kind, subject_name: r.subject_name, event_date: r.event_date, place: r.place, serial: r.serial,
      church: r.branch_name, organisation: r.org_name, held_elsewhere: !orgs.has(r.org_id), can_print: r.kind === 'baptism',
    }));
  });

  app.get('/me/records/:id/render', auth, async (req) => {
    const r = await owned(req);
    if (r.kind !== 'baptism') throw new HttpError(400, 'A marriage certificate is a legal document. Ask the church or the registry for a copy.', 'not_issuable');
    const issued = (await ctx.db.query<any>(`SELECT 1 FROM record_issues WHERE record_id=$1 AND requested_by=$2 AND status='issued'`, [r.id, req.session!.uid]))[0];
    return renderPayload(ctx, r, { preview: !issued });
  });

  /** A member asks for their card. The first issue is free, later copies follow the church's price (L102). */
  app.post('/me/records/:id/copy', auth, async (req) => {
    const r = await owned(req);
    if (r.kind !== 'baptism') throw new HttpError(400, 'A marriage certificate is a legal document. Ask the church or the registry for a copy.', 'not_issuable');
    const res = await requestIssue(ctx, r, { userId: req.session!.uid });
    const b = (await ctx.db.query<any>(`SELECT code FROM branches WHERE id=$1`, [r.branch_id]))[0];
    return { ...res, churchCode: b.code, render: res.status === 'issued' ? await renderPayload(ctx, r, { preview: false }) : null };
  });
}

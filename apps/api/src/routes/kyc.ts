import type { FastifyInstance } from 'fastify';
import { maskAccount } from '@churchos/shared';
import { HttpError, requireAdmin, requireSession, staffScope, type Ctx } from '../ctx';
import { sendPrivateFile } from '../serve';
import { checkUpload, cleanFileName } from '../uploads';

export const KYC_TYPES = ['registration_certificate', 'kra_pin', 'signatory_id', 'payout_proof'] as const;
const ORG_TYPES = ['registration_certificate', 'kra_pin', 'signatory_id'] as const;
const MAX_BYTES = 3 * 1024 * 1024;
const MIMES = new Set(['application/pdf', 'image/jpeg', 'image/png']);
export const COOLING_OFF_HOURS = 72;

const LABEL: Record<string, string> = {
  registration_certificate: 'Registration certificate',
  kra_pin: 'KRA PIN certificate',
  signatory_id: 'Signatory ID',
  payout_proof: 'Proof of payout account',
};

/**
 * A branch can be paid out only when the organisation has an approved registration certificate, KRA PIN and at least one
 * signatory ID, and the branch has an approved payout proof (L81). Latest decision per document wins, so a document that
 * was approved and later replaced by an unreviewed or rejected one cannot keep a branch verified.
 */
export async function recomputeVerification(ctx: Ctx, orgId: string): Promise<Record<string, boolean>> {
  const docs = await ctx.db.query<any>(`SELECT id, branch_id, type, status, created_at FROM kyc_documents WHERE org_id=$1 ORDER BY created_at, id`, [orgId]);
  const latest = (type: string, branchId: string | null) => {
    const list = docs.filter((d) => d.type === type && (d.branch_id ?? null) === branchId);
    return list[list.length - 1];
  };
  const orgOk =
    latest('registration_certificate', null)?.status === 'approved' &&
    latest('kra_pin', null)?.status === 'approved' &&
    docs.some((d) => d.type === 'signatory_id' && d.status === 'approved');
  const branches = await ctx.db.query<any>(`SELECT id FROM branches WHERE org_id=$1`, [orgId]);
  const out: Record<string, boolean> = {};
  for (const b of branches) {
    const ok = orgOk && latest('payout_proof', b.id)?.status === 'approved';
    out[b.id] = ok;
    await ctx.ledger.setBranchVerified(b.id, ok);
  }
  return out;
}

export async function kycStatus(ctx: Ctx, orgId: string, branchIds?: string[]) {
  const docs = await ctx.db.query<any>(
    `SELECT id, branch_id, type, filename, mime, size, note, status, reason, created_at, reviewed_at FROM kyc_documents WHERE org_id=$1 ORDER BY created_at DESC`,
    [orgId],
  );
  const branches = await ctx.db.query<any>(`SELECT id, code, name, payout_verified FROM branches WHERE org_id=$1 ORDER BY name`, [orgId]);
  const shown = branches.filter((b) => !branchIds || branchIds.includes(b.id));
  const lastOf = (type: string, branchId: string | null) => docs.find((d) => d.type === type && (d.branch_id ?? null) === branchId) ?? null;
  return {
    required: ORG_TYPES.map((t) => ({ type: t, label: LABEL[t], latest: lastOf(t, null), documents: docs.filter((d) => d.type === t) })),
    branches: shown.map((b) => ({
      id: b.id, code: b.code, name: b.name, verified: b.payout_verified,
      payoutProof: { type: 'payout_proof', label: LABEL.payout_proof, latest: lastOf('payout_proof', b.id), documents: docs.filter((d) => d.type === 'payout_proof' && d.branch_id === b.id) },
    })),
    organisationReady:
      lastOf('registration_certificate', null)?.status === 'approved' && lastOf('kra_pin', null)?.status === 'approved' && docs.some((d) => d.type === 'signatory_id' && d.status === 'approved'),
  };
}

export function kycRoutes(app: FastifyInstance, ctx: Ctx) {
  const auth = { preHandler: requireSession };
  const adm = { preHandler: requireAdmin };

  app.get('/kyc/status', auth, async (req) => {
    const scope = await staffScope(ctx, req, 'kyc.manage');
    return { orgId: scope.orgId, ...(await kycStatus(ctx, scope.orgId, scope.branchIds)) };
  });

  app.post('/kyc/documents', auth, async (req) => {
    const b = (req.body ?? {}) as any;
    const scope = await staffScope(ctx, req, 'kyc.manage', b.type === 'payout_proof' ? b.branchId : undefined);
    if (!KYC_TYPES.includes(b.type)) throw new HttpError(400, 'Choose which document you are uploading', 'bad_type');
    if (b.type === 'payout_proof' && !b.branchId) throw new HttpError(400, 'Choose the branch this payout account belongs to', 'bad_branch');
    if (!MIMES.has(b.mime)) throw new HttpError(400, 'Upload a PDF, JPG or PNG file', 'bad_file_type');
    if (typeof b.data !== 'string' || !b.data) throw new HttpError(400, 'Choose a file to upload', 'no_file');
    const bytes = Buffer.from(b.data, 'base64');
    if (bytes.length === 0) throw new HttpError(400, 'That file is empty', 'empty_file');
    if (bytes.length > MAX_BYTES) throw new HttpError(413, 'That file is larger than 3 MB', 'too_large');
    const checked = checkUpload(bytes, b.mime, { kinds: ['image', 'pdf'], code: 'bad_file_type', label: 'document' });
    const fileName = cleanFileName(b.filename, 'document');
    const id = ctx.newId('kyc');
    await ctx.db.query(
      `INSERT INTO kyc_documents (id, org_id, branch_id, type, filename, mime, size, data, note, submitted_by, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [id, scope.orgId, b.type === 'payout_proof' ? b.branchId : null, b.type, fileName, checked.mime, bytes.length, b.data, b.note ?? null, req.session!.uid, ctx.clock.now().toISOString()],
    );
    await recomputeVerification(ctx, scope.orgId);
    await ctx.ledger.audit({ orgId: scope.orgId, branchId: b.type === 'payout_proof' ? b.branchId : null, actor: req.session!.uid, action: 'kyc.submit', entity: 'kyc_document', entityId: id, summary: `Uploaded a ${String(b.type).replace(/_/g, ' ')}`, links: { documentId: id }, meta: { type: b.type, filename: fileName, bytes: bytes.length } });
    return { id, status: 'submitted' };
  });

  // ---------- payout destination (L35, L88) ----------

  const mask = (d: any) => (d ? { ...d, accountNumber: d.accountNumber ? `••••${String(d.accountNumber).slice(-4)}` : undefined } : null);

  app.get('/payout-destination', auth, async (req) => {
    const scope = await staffScope(ctx, req, 'payouts.manage');
    await applyDuePayoutChanges(ctx);
    const rows = await ctx.db.query<any>(`SELECT id, code, name, payout_destination, payout_verified, payout_paused FROM branches WHERE id = ANY($1::text[]) ORDER BY name`, [scope.branchIds]);
    const requests = await ctx.db.query<any>(`SELECT * FROM payout_change_requests WHERE org_id=$1 ORDER BY created_at DESC LIMIT 50`, [scope.orgId]);
    return {
      coolingOffHours: COOLING_OFF_HOURS,
      branches: rows.map((r) => ({ id: r.id, code: r.code, name: r.name, verified: r.payout_verified, paused: r.payout_paused, destination: mask(r.payout_destination) })),
      requests: requests.map((r) => ({ ...r, destination: mask(r.destination) })),
    };
  });

  app.post('/payout-destination/requests', auth, async (req) => {
    const b = (req.body ?? {}) as any;
    const scope = await staffScope(ctx, req, 'payouts.manage', b.branchId);
    const d = b.destination ?? {};
    if (d.type !== 'bank' && d.type !== 'mobile') throw new HttpError(400, 'Choose bank or mobile money', 'bad_destination');
    if (d.type === 'bank' && !(d.bank && /^\d{6,20}$/.test(String(d.accountNumber ?? '')) && String(d.accountName ?? '').trim())) {
      throw new HttpError(400, 'Enter the bank, a valid account number and the account name', 'bad_destination');
    }
    if (d.type === 'mobile' && !/^2547\d{8}$|^2541\d{8}$/.test(String(d.phone ?? '').replace(/^0/, '254'))) {
      throw new HttpError(400, 'Enter a valid Kenyan mobile number', 'bad_destination');
    }
    const open = (await ctx.db.query<any>(`SELECT 1 FROM payout_change_requests WHERE branch_id=$1 AND status IN ('requested','approved')`, [b.branchId]))[0];
    if (open) throw new HttpError(409, 'A change for this branch is already waiting', 'duplicate_request');
    const id = ctx.newId('pcr');
    await ctx.db.query(`INSERT INTO payout_change_requests (id, org_id, branch_id, destination, requested_by, created_at) VALUES ($1,$2,$3,$4,$5,$6)`, [
      id, scope.orgId, b.branchId, JSON.stringify(d), req.session!.uid, ctx.clock.now().toISOString(),
    ]);
    const curDest = (await ctx.db.query<any>('SELECT payout_destination FROM branches WHERE id=$1', [b.branchId]))[0]?.payout_destination ?? {};
    await ctx.ledger.audit({ orgId: scope.orgId, branchId: b.branchId, actor: req.session!.uid, action: 'payout_destination.request', entity: 'payout_destination', entityId: b.branchId, summary: 'Asked to change the payout account', links: { requestId: id },
      changes: [
        { field: 'bank', label: 'Bank', before: curDest.bank ?? null, after: d.bank ?? null },
        { field: 'accountNumber', label: 'Account number', before: maskAccount(curDest.accountNumber), after: maskAccount(d.accountNumber), masked: true },
        { field: 'accountName', label: 'Account name', before: curDest.accountName ?? null, after: d.accountName ?? null },
      ] });
    return { id, status: 'requested', coolingOffHours: COOLING_OFF_HOURS };
  });

  // ---------- admin review ----------

  app.get('/admin/kyc', adm, async () => {
    const orgs = await ctx.db.query<any>(`SELECT id, name FROM organisations ORDER BY name`);
    const out = [];
    for (const o of orgs) {
      const s = await kycStatus(ctx, o.id);
      const pending = (await ctx.db.query<any>(`SELECT COUNT(*) AS n FROM kyc_documents WHERE org_id=$1 AND status='submitted'`, [o.id]))[0].n;
      out.push({ id: o.id, name: o.name, pendingDocuments: Number(pending), organisationReady: s.organisationReady, branches: s.branches.map((b) => ({ id: b.id, code: b.code, name: b.name, verified: b.verified })) });
    }
    return out;
  });

  app.get('/admin/kyc/:orgId', adm, async (req) => {
    const orgId = (req.params as any).orgId;
    const org = (await ctx.db.query<any>(`SELECT id, name FROM organisations WHERE id=$1`, [orgId]))[0];
    if (!org) throw new HttpError(404, 'organisation not found', 'not_found');
    return { org, ...(await kycStatus(ctx, orgId)) };
  });

  app.get('/admin/kyc/documents/:id/file', adm, async (req, reply) => {
    const d = (await ctx.db.query<any>(`SELECT org_id, branch_id, type, filename, mime, data FROM kyc_documents WHERE id=$1`, [(req.params as any).id]))[0];
    if (!d) throw new HttpError(404, 'document not found', 'not_found');
    await ctx.ledger.audit({ orgId: d.org_id, branchId: d.branch_id, actor: req.session!.uid, action: 'access.view_file', category: 'access', entity: 'kyc_document', entityId: (req.params as any).id, summary: `Viewed a ${String(d.type).replace(/_/g, ' ')}` });
    return sendPrivateFile(reply, { mime: d.mime, name: d.filename, data: Buffer.from(d.data, 'base64') });
  });

  app.post('/admin/kyc/documents/:id/decide', adm, async (req) => {
    const b = (req.body ?? {}) as any;
    const d = (await ctx.db.query<any>(`SELECT * FROM kyc_documents WHERE id=$1`, [(req.params as any).id]))[0];
    if (!d) throw new HttpError(404, 'document not found', 'not_found');
    if (d.status !== 'submitted') throw new HttpError(409, 'This document was already reviewed', 'already_decided');
    const approve = b.approve !== false;
    if (!approve && !String(b.reason ?? '').trim()) throw new HttpError(400, 'Give a reason so the church knows what to fix', 'reason_required');
    await ctx.db.query(`UPDATE kyc_documents SET status=$2, reason=$3, reviewed_by=$4, reviewed_at=$5 WHERE id=$1`, [
      d.id, approve ? 'approved' : 'rejected', approve ? null : String(b.reason).trim(), req.session!.uid, ctx.clock.now().toISOString(),
    ]);
    const verified = await recomputeVerification(ctx, d.org_id);
    await ctx.ledger.audit({ orgId: d.org_id, branchId: d.branch_id, actor: req.session!.uid, action: approve ? 'kyc.approve' : 'kyc.reject', entity: 'kyc_document', entityId: d.id, summary: `${approve ? 'Approved' : 'Rejected'} the ${String(d.type).replace(/_/g, ' ')}`, reason: approve ? null : String(b.reason).trim(), links: { documentId: d.id }, meta: { type: d.type } });
    return { id: d.id, status: approve ? 'approved' : 'rejected', verified };
  });

  app.get('/admin/payout-requests', adm, async () => {
    await applyDuePayoutChanges(ctx);
    return ctx.db.query<any>(
      `SELECT r.*, b.name AS branch_name, b.code AS branch_code, b.payout_destination AS current_destination, u.name AS requested_by_name
         FROM payout_change_requests r JOIN branches b ON b.id=r.branch_id LEFT JOIN users u ON u.id=r.requested_by ORDER BY r.created_at DESC LIMIT 100`,
    );
  });

  app.post('/admin/payout-requests/:id/decide', adm, async (req) => {
    const r = (await ctx.db.query<any>(`SELECT * FROM payout_change_requests WHERE id=$1`, [(req.params as any).id]))[0];
    if (!r) throw new HttpError(404, 'request not found', 'not_found');
    if (r.status !== 'requested') throw new HttpError(409, 'This request was already decided', 'already_decided');
    const approve = (req.body as any)?.approve !== false;
    const now = ctx.clock.now();
    const effective = new Date(now.getTime() + COOLING_OFF_HOURS * 3600_000).toISOString();
    await ctx.db.query(`UPDATE payout_change_requests SET status=$2, decided_by=$3, decided_at=$4, effective_at=$5 WHERE id=$1`, [
      r.id, approve ? 'approved' : 'rejected', req.session!.uid, now.toISOString(), approve ? effective : null,
    ]);
    await ctx.ledger.audit({ orgId: r.org_id, branchId: r.branch_id, actor: req.session!.uid, action: approve ? 'payout_destination.approve' : 'payout_destination.reject', entity: 'payout_destination', entityId: r.branch_id, summary: approve ? `Approved the payout account change, it takes effect after the cooling-off` : 'Rejected the payout account change', reason: (req.body as any)?.reason ? String((req.body as any).reason).slice(0, 200) : null, links: { requestId: r.id }, meta: approve ? { effectiveAt: effective } : undefined });
    return { id: r.id, status: approve ? 'approved' : 'rejected', effectiveAt: approve ? effective : null };
  });
}

/** Applies approved destination changes whose cooling-off has ended. Called before settlement and on reads. */
export async function applyDuePayoutChanges(ctx: Ctx): Promise<number> {
  const due = await ctx.db.query<any>(`SELECT * FROM payout_change_requests WHERE status='approved' AND effective_at <= $1`, [ctx.clock.now().toISOString()]);
  for (const r of due) {
    const prevDest = (await ctx.db.query<any>('SELECT payout_destination FROM branches WHERE id=$1', [r.branch_id]))[0]?.payout_destination ?? {};
    await ctx.ledger.setPayoutDestination(r.branch_id, r.destination);
    await ctx.db.query(`UPDATE payout_change_requests SET status='applied' WHERE id=$1`, [r.id]);
    await ctx.ledger.audit({ orgId: r.org_id, branchId: r.branch_id, action: 'payout_destination.applied', entity: 'payout_destination', entityId: r.branch_id, summary: 'The new payout account took effect', links: { requestId: r.id },
      changes: [
        { field: 'bank', label: 'Bank', before: prevDest.bank ?? null, after: r.destination.bank ?? null },
        { field: 'accountNumber', label: 'Account number', before: maskAccount(prevDest.accountNumber), after: maskAccount(r.destination.accountNumber), masked: true },
        { field: 'accountName', label: 'Account name', before: prevDest.accountName ?? null, after: r.destination.accountName ?? null },
      ] });
  }
  return due.length;
}

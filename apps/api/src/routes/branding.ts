import type { FastifyInstance } from 'fastify';
import { branchesFor } from '../auth';
import { HttpError, requireSession, type Ctx } from '../ctx';
import { churchWideOrg } from '../scope';
import { checkUpload } from '../uploads';

/**
 * A church's own logo (Slice 26). The staff app turns the uploaded logo into the app icons in the browser (so no image library is needed here)
 * and sends the finished PNG files; this file checks them, keeps them, and serves them without sign-in so a browser can use them as the
 * favicon, the home-screen icon and the logo in the apps.
 */

export const FILES = {
  'icon-192.png': { col: 'icon_192', size: 192 },
  'icon-512.png': { col: 'icon_512', size: 512 },
  'icon-maskable.png': { col: 'icon_maskable', size: 512 },
  'apple-touch-icon.png': { col: 'apple_180', size: 180 },
  'favicon-32.png': { col: 'favicon_32', size: 32 },
} as const;
type FileName = keyof typeof FILES;

const MAX_ICON_BYTES = 400_000;
const MAX_LOGO_BYTES = 600_000;
const hex = (v: unknown, label: string) => {
  const s = String(v ?? '').trim();
  if (!/^#[0-9a-fA-F]{6}$/.test(s)) throw new HttpError(400, `Choose the ${label} as a colour`, 'bad_colour');
  return s.toLowerCase();
};

/** A PNG's width and height, or null when the bytes are not a PNG. */
export function pngSize(buf: Buffer): { w: number; h: number } | null {
  if (buf.length < 33 || buf.readUInt32BE(0) !== 0x89504e47 || buf.readUInt32BE(4) !== 0x0d0a1a0a || buf.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

function png(v: unknown, label: string, max: number, exact?: number): Buffer {
  const raw = String(v ?? '').replace(/^data:image\/png;base64,/, '');
  if (!raw) throw new HttpError(400, `The ${label} is missing`, 'bad_image');
  const buf = Buffer.from(raw, 'base64');
  if (buf.length > max) throw new HttpError(400, `The ${label} is too big`, 'bad_image');
  const s = pngSize(buf);
  if (!s) throw new HttpError(400, `The ${label} is not a PNG picture`, 'bad_image');
  checkUpload(buf, 'image/png', { kinds: ['image'], code: 'bad_image', label });
  if (exact && (s.w !== exact || s.h !== exact)) throw new HttpError(400, `The ${label} must be ${exact} by ${exact} pixels`, 'bad_image');
  if (!exact && (s.w > 1024 || s.h > 1024)) throw new HttpError(400, `The ${label} is too large (at most 1024 pixels)`, 'bad_image');
  return buf;
}

export async function brandingInfo(ctx: Ctx, orgId: string) {
  const r = (await ctx.db.query<any>(`SELECT version, bg_color, theme_color FROM church_branding WHERE org_id=$1 AND icon_512 IS NOT NULL`, [orgId]))[0];
  return r ? { orgId, hasLogo: true, version: Number(r.version), bgColor: r.bg_color, themeColor: r.theme_color } : { orgId, hasLogo: false, version: 0, bgColor: null, themeColor: null };
}

export function brandingRoutes(app: FastifyInstance, ctx: Ctx) {
  const auth = { preHandler: requireSession };

  async function orgOf(uid: string) {
    const r = (await ctx.db.query<any>(`SELECT org_id FROM role_assignments WHERE user_id=$1 LIMIT 1`, [uid]))[0] ?? (await ctx.db.query<any>(`SELECT org_id FROM memberships WHERE user_id=$1 ORDER BY joined_at LIMIT 1`, [uid]))[0];
    return (r?.org_id as string | undefined) ?? null;
  }

  /** The signed-in person's church and how it looks: the apps call this once after sign-in. */
  app.get('/me/branding', auth, async (req) => {
    const orgId = await orgOf(req.session!.uid);
    if (!orgId) return { orgId: null, hasLogo: false, version: 0, bgColor: null, themeColor: null, name: null, canChange: false };
    const org = (await ctx.db.query<any>(`SELECT name FROM organisations WHERE id=$1`, [orgId]))[0];
    const rows = await branchesFor(ctx.db, req.session!.uid, 'church.settings');
    return { ...(await brandingInfo(ctx, orgId)), name: org?.name ?? null, canChange: rows.some((r) => r.orgId === orgId) };
  });

  app.put('/church/branding', auth, async (req) => {
    const orgId = await churchWideOrg(ctx, req, 'church.settings');
    const b = (req.body ?? {}) as any;
    const icons = b.icons ?? {};
    const files = {
      logo: png(b.logo, 'logo', MAX_LOGO_BYTES),
      icon_192: png(icons['icon-192.png'], '192 pixel icon', MAX_ICON_BYTES, 192),
      icon_512: png(icons['icon-512.png'], '512 pixel icon', MAX_ICON_BYTES, 512),
      icon_maskable: png(icons['icon-maskable.png'], 'full-bleed icon', MAX_ICON_BYTES, 512),
      apple_180: png(icons['apple-touch-icon.png'], 'phone home-screen icon', MAX_ICON_BYTES, 180),
      favicon_32: png(icons['favicon-32.png'], 'browser tab icon', MAX_ICON_BYTES, 32),
    };
    const bg = hex(b.bgColor ?? '#ffffff', 'icon background');
    const theme = hex(b.themeColor ?? '#123456', 'app colour');
    const prev = (await ctx.db.query<any>(`SELECT version FROM church_branding WHERE org_id=$1`, [orgId]))[0];
    const version = Number(prev?.version ?? 0) + 1;
    await ctx.db.query(
      `INSERT INTO church_branding (org_id, logo, icon_192, icon_512, icon_maskable, apple_180, favicon_32, bg_color, theme_color, version, updated_by, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (org_id) DO UPDATE SET logo=$2, icon_192=$3, icon_512=$4, icon_maskable=$5, apple_180=$6, favicon_32=$7, bg_color=$8, theme_color=$9, version=$10, updated_by=$11, updated_at=$12`,
      [orgId, files.logo.toString('base64'), files.icon_192.toString('base64'), files.icon_512.toString('base64'), files.icon_maskable.toString('base64'), files.apple_180.toString('base64'), files.favicon_32.toString('base64'), bg, theme, version, req.session!.uid, ctx.clock.now().toISOString()],
    );
    await ctx.ledger.audit({ orgId, actor: req.session!.uid, action: 'church.branding', entity: 'organisation', entityId: orgId, summary: prev ? 'Changed the church logo and app icons' : 'Added the church logo and app icons', meta: { version } });
    return { ok: true, ...(await brandingInfo(ctx, orgId)) };
  });

  app.post('/church/branding/remove', auth, async (req) => {
    const rows = await branchesFor(ctx.db, req.session!.uid, 'church.settings');
    if (!rows.length) throw new HttpError(403, 'missing permission church.settings', 'forbidden');
    const orgId = rows[0].orgId;
    const r = await ctx.db.query<any>(`UPDATE church_branding SET logo=NULL, icon_192=NULL, icon_512=NULL, icon_maskable=NULL, apple_180=NULL, favicon_32=NULL, version=version+1, updated_by=$2, updated_at=$3 WHERE org_id=$1 AND icon_512 IS NOT NULL RETURNING version`, [orgId, req.session!.uid, ctx.clock.now().toISOString()]);
    if (!r[0]) throw new HttpError(404, 'There is no logo to remove', 'not_found');
    await ctx.ledger.audit({ orgId, actor: req.session!.uid, action: 'church.branding_removed', entity: 'organisation', entityId: orgId, summary: 'Removed the church logo; the apps use the ChurchOS icons again' });
    return { ok: true, ...(await brandingInfo(ctx, orgId)) };
  });

  /** The pictures themselves: public, so a browser can fetch a favicon or a home-screen icon. The version in the address changes whenever the logo does. */
  app.get('/public/branding/:orgId/:file', async (req, reply) => {
    const { orgId, file } = req.params as any;
    const spec = file === 'logo.png' ? { col: 'logo' } : typeof file === 'string' && Object.hasOwn(FILES, file) ? FILES[file as FileName] : undefined;
    if (!spec) throw new HttpError(404, 'not found', 'not_found');
    const row = (await ctx.db.query<any>(`SELECT ${spec.col} AS data FROM church_branding WHERE org_id=$1`, [orgId]))[0];
    if (!row?.data) throw new HttpError(404, 'not found', 'not_found');
    return reply.header('content-type', 'image/png').header('cache-control', 'public, max-age=86400').header('cross-origin-resource-policy', 'cross-origin').send(Buffer.from(row.data, 'base64'));
  });

  app.get('/public/branding/:orgId', async (req) => {
    const orgId = String((req.params as any).orgId);
    const org = (await ctx.db.query<any>(`SELECT name FROM organisations WHERE id=$1`, [orgId]))[0];
    if (!org) throw new HttpError(404, 'not found', 'not_found');
    return { ...(await brandingInfo(ctx, orgId)), name: org.name };
  });
}

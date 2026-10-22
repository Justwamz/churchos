import type { FastifyInstance } from 'fastify';
import { requireSession, type Ctx } from '../ctx';
import { buildExport, decideErasure, erasurePreview, listErasureRequests, requestErasure } from '../dataprotection';
import { limitRoute } from '../ratelimit';

/** A person's own data export, closing an account (with a preview), and the staff / platform-admin list where requests are decided. LG-16. */
export function dataProtectionRoutes(app: FastifyInstance, ctx: Ctx) {
  const auth = { preHandler: requireSession };

  // 3 downloads a day per person. This runs after sign-in is checked, so the key is the person, never an address.
  const exportLimit = limitRoute(app, ctx, { name: 'data-export', max: 3, windowMs: 24 * 3600_000, key: (req) => req.session!.uid, message: 'You can download your data 3 times a day. Please try again tomorrow.' });
  app.get('/me/export', { preHandler: [requireSession, exportLimit] }, async (req, reply) => {
    const data = await buildExport(ctx, req.session!);
    reply.header('content-disposition', 'attachment; filename="my-churchos-data.json"');
    return data;
  });

  app.get('/me/erasure-preview', auth, async (req) => erasurePreview(ctx, req.session!));

  const requestLimit = limitRoute(app, ctx, { name: 'erasure-request', max: 5, windowMs: 24 * 3600_000, key: (req) => req.session!.uid });
  app.post('/me/erasure-request', { preHandler: [requireSession, requestLimit] }, async (req) => requestErasure(ctx, req.session!, (req.body ?? {}) as any));

  /** Staff with members.settings (the church owner) see their church's requests; platform admins see all. */
  app.get('/erasure-requests', auth, async (req) => listErasureRequests(ctx, req.session!));
  app.post('/erasure-requests/:id/decide', auth, async (req) => {
    const b = (req.body ?? {}) as any;
    return decideErasure(ctx, req.session!, String((req.params as any).id), b.decision, b.note);
  });
}

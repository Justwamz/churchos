import type { Ctx } from './ctx';

/**
 * Every in-app message goes through here. `audience` says which app shows it: 'member' (the member app inbox, the default, for anything
 * personal to the person) or 'staff' (the staff app, for things a staff member must do or know to run the church).
 * `link` is `<app>:<page>[?key=value&...]` ('staff:expenses?open=exp_1', 'member:tickets'); leave it out when there is no destination.
 */
export type NotificationAudience = 'member' | 'staff';
export type NotificationInput = {
  orgId: string | null;
  userId: string;
  kind: string;
  title: string;
  body: string;
  link?: string | null;
  audience?: NotificationAudience;
  messageId?: string | null;
  memberId?: string | null;
  forName?: string | null;
};

export async function addNotification(ctx: Pick<Ctx, 'db' | 'newId' | 'clock'>, n: NotificationInput): Promise<string> {
  const id = ctx.newId('ntf');
  await ctx.db.query(
    `INSERT INTO notifications (id, org_id, user_id, kind, title, body, message_id, created_at, member_id, for_name, link, audience) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [id, n.orgId, n.userId, n.kind, n.title, n.body, n.messageId ?? null, ctx.clock.now().toISOString(), n.memberId ?? null, n.forName ?? null, n.link ?? null, n.audience ?? 'member'],
  );
  return id;
}

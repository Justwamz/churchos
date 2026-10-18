import type { Ctx } from './ctx';

/**
 * Prayer, pastoral bookings and suggestion box demo data (L225 to L231) for the development server: Pastor Mary, who looks after the prayer
 * team's requests, a few prayer requests and a few suggestions, one of them already answered and shared as "You said, we did".
 */
export async function seedPastoralDemo(ctx: Ctx) {
  const db = ctx.db;
  const t = ctx.clock.now();
  const at = (hoursAgo: number) => new Date(t.getTime() - hoursAgo * 3600_000).toISOString();
  await db.query(`INSERT INTO users (id, phone, name, is_platform_admin, created_at) VALUES ('u_pastor','254700000009','Pastor Mary',false,$1) ON CONFLICT DO NOTHING`, [at(0)]);
  await db.query(`INSERT INTO role_assignments (id, org_id, user_id, role_id, scope_type, scope_id) VALUES ('ra_pastor','org_grace','u_pastor','org_grace:Pastor','branch','br_grc001') ON CONFLICT DO NOTHING`);
  await db.query(`UPDATE users SET email='mary@gracechurch.org', email_verified=true WHERE id='u_pastor'`);

  const prayer = async (id: string, user: string, name: string, audience: string, group: string | null, anonymous: boolean, body: string, hoursAgo: number) => {
    await db.query(`INSERT INTO prayer_requests (id, org_id, branch_id, body, audience, group_id, anonymous, author_name, created_at, updated_at) VALUES ($1,'org_grace','br_grc001',$2,$3,$4,$5,$6,$7,$7) ON CONFLICT DO NOTHING`, [id, body, audience, group, anonymous, anonymous ? null : name, at(hoursAgo)]);
    await db.query(`INSERT INTO prayer_owners (prayer_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [id, user]);
  };
  await prayer('pr_demo1', 'u_peter', 'Peter Otieno', 'church', null, false, 'Please pray for my brother who is looking for work.', 30);
  await prayer('pr_demo2', 'u_david', 'David Wanjiku', 'group', 'grp_prayer', false, 'Praying for good weather and a full house at our prayer night on Wednesday.', 20);
  await prayer('pr_demo3', 'u_amina', 'Amina Hassan', 'team', null, true, 'I am going through a hard time in my marriage. Please pray for us.', 10);
  await prayer('pr_demo4', 'u_jane', 'Jane Wanjiku', 'branch', null, false, 'Thank you all: my mother is home from hospital.', 50);
  await db.query(`UPDATE prayer_requests SET status='answered', answered_at=$1, answered_note='She is home and recovering.' WHERE id='pr_demo4'`, [at(40)]);
  await db.query(`INSERT INTO prayer_prays (prayer_id, user_id, at) VALUES ('pr_demo1','u_jane',$1), ('pr_demo1','u_david',$1), ('pr_demo2','u_jane',$1) ON CONFLICT DO NOTHING`, [at(5)]);

  const suggest = async (id: string, user: string, membership: string | null, name: string | null, category: string, body: string, hoursAgo: number) => {
    await db.query(`INSERT INTO suggestions (id, org_id, branch_id, membership_id, author_name, category, body, created_at, updated_at) VALUES ($1,'org_grace','br_grc001',$2,$3,$4,$5,$6,$6) ON CONFLICT DO NOTHING`, [id, membership, name, category, body, at(hoursAgo)]);
    await db.query(`INSERT INTO suggestion_owners (suggestion_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [id, user]);
  };
  await suggest('sug_demo1', 'u_jane', 'm_jane', 'Jane Wanjiku', 'children_youth', 'Could Sunday school have a snack break halfway? The little ones get hungry.', 72);
  await suggest('sug_demo2', 'u_peter', null, null, 'facilities', 'The side door is very hard to open for wheelchairs and prams.', 48);
  await suggest('sug_demo3', 'u_david', 'm_david', 'David Wanjiku', 'communication', 'Please put the weekly notices on the app before Sunday, not just in the hall.', 8);
  await db.query(`UPDATE suggestions SET status='done', response='We have fitted an automatic door opener, thank you for telling us.', responded_by='u_owner', responded_at=$1, published=true WHERE id='sug_demo2'`, [at(24)]);
  await db.query(`UPDATE suggestions SET status='under_review', response='The Sunday school team is trying this next month.', responded_by='u_owner', responded_at=$1 WHERE id='sug_demo1'`, [at(30)]);
}

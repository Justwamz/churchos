import { INTERNAL_SEED_KEY } from './ctx';
import type { FastifyInstance } from 'fastify';
import type { Ctx } from './ctx';
import { addDays, dueAt, eatToday, weekStartOf } from './eat';

/**
 * Attendance demo data (L204 to L216) for the development server: a Sunday and a midweek schedule for Grace Nairobi for the rest of the
 * year, and six past weeks of check-ins, visitors and headcounts, so the dashboard, the care list and the Monday report have something to show.
 * Peter has stopped coming, so he appears under "regular members who stopped coming".
 */
export async function seedAttendanceDemo(app: FastifyInstance, ctx: Ctx) {
  const token = (await app.inject({ method: 'POST', url: '/auth/otp/verify', payload: { phone: '0700000001', code: '123456' } })).json().token as string;
  const post = (url: string, payload: unknown) => app.inject({ method: 'POST', url, payload: payload as any, headers: { authorization: `Bearer ${token}`, 'x-churchos-internal-seed': INTERNAL_SEED_KEY } });
  const common = { branchId: 'br_grc001', range: 'year' };
  await post('/attendance/schedules', { ...common, name: 'Sunday Service, 8:00', weekdays: [7], startTime: '08:00', durationMin: 90 });
  await post('/attendance/schedules', { ...common, name: 'Sunday Service, 10:30', weekdays: [7], startTime: '10:30', durationMin: 120, streamUrl: 'https://www.youtube.com/@gracecommunitychurch/live' });
  await post('/attendance/schedules', { ...common, name: 'Wednesday Prayer', weekdays: [3], startTime: '18:00', durationMin: 75 });

  // Slice 22: sample readings for the coming Sundays. The church enters its own; these only show how it works.
  const sets = [
    ['Daniel 7:9-10, 13-14', 'Psalm 93', 'Revelation 1:4b-8', 'John 18:33-37'],
    ['Isaiah 2:1-5', 'Psalm 122', 'Romans 13:11-14', 'Matthew 24:36-44'],
    ['Isaiah 11:1-10', 'Psalm 72:1-7, 18-19', 'Romans 15:4-13', 'Matthew 3:1-12'],
    ['Isaiah 35:1-10', 'Luke 1:46b-55', 'James 5:7-10', 'Matthew 11:2-11'],
  ];
  let sunday = eatToday(ctx.clock.now());
  while (new Date(`${sunday}T00:00:00Z`).getUTCDay() !== 0) sunday = addDays(sunday, 1);
  for (let i = 0; i < 6; i++) {
    await app.inject({ method: 'PUT', url: `/lectionary/${sunday}`, payload: { title: 'Sunday readings (sample)', readings: sets[i % sets.length], note: 'Sample references. Enter your own from the lectionary.' } as any, headers: { authorization: `Bearer ${token}`, 'x-churchos-internal-seed': INTERNAL_SEED_KEY } });
    sunday = addDays(sunday, 7);
  }

  const now = ctx.clock.now().toISOString();
  const monday = weekStartOf(eatToday(ctx.clock.now()));
  const q = (sql: string, p: unknown[]) => ctx.db.query(sql, p);
  const people: [string, string][] = [['m_jane', 'Jane Wanjiku'], ['m_david', 'David Wanjiku'], ['m_peter', 'Peter Otieno'], ['m_amina', 'Amina Hassan']];
  const visitors: [string, string, string, number][] = [
    ['vis_demo1', 'Mercy Achieng', '254722100001', 5],
    ['vis_demo2', 'Brian Koech', '254722100002', 4],
    ['vis_demo3', 'Faith Mutua', '254722100003', 2],
    ['vis_demo4', 'Samuel Ouma', '254722100004', 1],
  ];
  let n = 0;
  for (let w = 6; w >= 1; w--) {
    const date = addDays(monday, -7 * w + 6);
    const startsAt = dueAt(date, '10:30');
    const id = `svc_demo_${w}`;
    const headcount = 150 + (6 - w) * 6;
    await q(
      `INSERT INTO services (id, org_id, branch_id, schedule_id, code, name, starts_at, ends_at, opens_at, closes_at, stream_url, headcount_adults, headcount_children, headcount_visitors, headcount_by, headcount_at, online_peak, created_by, created_at, updated_at)
       VALUES ($1,'org_grace','br_grc001',NULL,$2,'Sunday Service, 10:30',$3,$4,$5,$6,'https://www.youtube.com/@gracecommunitychurch/live',$7,$8,$9,'Usher Demo',$3,$10,'u_owner',$11,$11) ON CONFLICT DO NOTHING`,
      [id, `DEMO${w}A`, startsAt, new Date(Date.parse(startsAt) + 7200_000).toISOString(), new Date(Date.parse(startsAt) - 1200_000).toISOString(), new Date(Date.parse(startsAt) + 9000_000).toISOString(), headcount - 40 - w, 36 + w, 4 + (6 - w), 60 + (6 - w) * 5, now],
    );
    for (const [mid, name] of people) {
      if (mid === 'm_peter' && w < 4) continue; // Peter has not been for three weeks
      if (mid === 'm_david' && w % 3 === 0) continue;
      await q(`INSERT INTO attendance (id, org_id, branch_id, service_id, kind, membership_id, name, mode, via, at) VALUES ($1,'org_grace','br_grc001',$2,'member',$3,$4,'in_person','usher',$5) ON CONFLICT DO NOTHING`, [`att_demo_${++n}`, id, mid, name, startsAt]);
    }
    await q(`INSERT INTO attendance (id, org_id, branch_id, service_id, kind, membership_id, name, mode, via, at) VALUES ($1,'org_grace','br_grc001',$2,'member','m_jane','Jane Wanjiku','online','app',$3) ON CONFLICT DO NOTHING`, [`att_demo_${++n}`, id, startsAt]);
    for (const [vid, name, phone, firstWeek] of visitors) {
      if (w > firstWeek) continue;
      if (w === firstWeek) {
        await q(
          `INSERT INTO visitors (id, org_id, branch_id, name, phone, first_service_id, first_seen_at, last_seen_at, visits, status, welcome_status, welcome_at, created_at) VALUES ($1,'org_grace','br_grc001',$2,$3,$4,$5,$5,1,'new','sent',$5,$5) ON CONFLICT DO NOTHING`,
          [vid, name, phone, id, startsAt],
        );
      } else if (vid === 'vis_demo1' || (vid === 'vis_demo2' && w !== 3)) {
        await q(`UPDATE visitors SET visits=visits+1, last_seen_at=$2, status='returning' WHERE id=$1`, [vid, startsAt]);
      } else continue;
      await q(`INSERT INTO attendance (id, org_id, branch_id, service_id, kind, visitor_id, name, mode, via, at) VALUES ($1,'org_grace','br_grc001',$2,'visitor',$3,$4,'in_person','door',$5) ON CONFLICT DO NOTHING`, [`att_demo_${++n}`, id, vid, name, startsAt]);
    }
  }
}

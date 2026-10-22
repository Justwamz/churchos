import { buildApp } from './server';
import { corsOrigins, isProduction } from './cors';
import { productionGuards } from './guards';
import { runMemberHousekeeping } from './members';
import { runScheduledMessages } from './messages';
import { runCommunityJobs } from './routes/community';
import { runBookingJobs } from './routes/bookings';
import { runShopJobs } from './routes/shop';
import { runTicketJobs } from './routes/tickets';
import { runKidsJobs } from './routes/kids';
import { runGivingJobs } from './routes/giving-plans';
import { runAttendanceJobs } from './routes/attendance';
import { runPrayerJobs } from './routes/prayer';
import { seedKidsDemo } from './seed-kids';
import { seedAttendanceDemo } from './seed-attendance';
import { seedPastoralDemo } from './seed-pastoral';
import { seedExpensesDemo } from './seed-expenses';
import { DEV_OTP, SEED_LOGINS, seed } from './seed';
import { errLine } from './redact';
import { runPersonalPurges, runRetentionJobs } from './retention';

// Last-resort handlers. The database is in memory, so a stray rejected promise must not take the process (and the data) down;
// a truly uncaught exception leaves unknown state, so log it and exit (Render restarts the service). One short line, no payloads.
const oneLine = (e: any) => `${e?.constructor?.name ?? typeof e}${e?.code ? ` [${e.code}]` : ''}: ${String(e?.message ?? e).replace(/\s+/g, ' ').slice(0, 200)}`;
process.on('unhandledRejection', (e) => console.error(`unhandled rejection ${oneLine(e)}`));
process.on('uncaughtException', (e) => { console.error(`uncaught exception ${oneLine(e)}`); process.exit(1); });

const guards = productionGuards();
for (const w of guards.warnings) console.warn(`WARNING: ${w}`);
if (guards.errors.length) {
  for (const m of guards.errors) console.error(`REFUSING TO START: ${m}`);
  process.exit(1);
}
if (isProduction()) console.log(`CORS allows: ${corsOrigins().join(', ')}`);

const port = Number(process.env.PORT ?? 4000);
const { app, ctx } = await buildApp({ logger: false });
// On a host that wants the port open quickly (Render) the API starts listening first and loads the demo data right after (LISTEN_EARLY=1).
const listenEarly = process.env.LISTEN_EARLY === '1';
if (listenEarly) await app.listen({ port, host: '0.0.0.0' });
// Demo churches and people are loaded unless SEED_DEMO=0 (a real launch starts empty).
if (process.env.SEED_DEMO !== '0') {
  await seed(ctx);
  await seedKidsDemo(ctx);
  await seedAttendanceDemo(app, ctx);
  await seedPastoralDemo(ctx);
  await seedExpensesDemo(app, ctx);
  // Someone with a login but no church yet, to try 'Link your church' (member app, phone 0733000001).
  await ctx.db.query(`INSERT INTO users (id, phone, name, is_platform_admin, created_at) VALUES ('u_newcomer','254733000001','Neema Newcomer',false,$1) ON CONFLICT DO NOTHING`, [ctx.clock.now().toISOString()]);
}
await runMemberHousekeeping(ctx);
// Graduation and birthday wishes run hourly. The platform clock can be advanced in development, so this uses it too.
setInterval(() => void runMemberHousekeeping(ctx).catch((e) => console.error(`housekeeping failed ${errLine(e)}`)), 3600_000).unref();
// Scheduled messages go out within 30 seconds of their time (L118).
setInterval(() => void runScheduledMessages(ctx).catch((e) => console.error(`scheduler failed ${errLine(e)}`)), 30_000).unref();
setInterval(() => void runTicketJobs(ctx).catch((e) => console.error(`ticket scheduler failed ${errLine(e)}`)), 30_000).unref();
setInterval(() => void runPrayerJobs(ctx).catch((e) => console.error(`prayer clean-up failed ${errLine(e)}`)), 3600_000).unref();
setInterval(() => void runAttendanceJobs(ctx).catch((e) => console.error(`attendance scheduler failed ${errLine(e)}`)), 60_000).unref();
setInterval(() => void runGivingJobs(ctx).catch((e) => console.error(`regular giving scheduler failed ${errLine(e)}`)), 30_000).unref();
setInterval(() => void runKidsJobs(ctx).catch((e) => console.error(`children scheduler failed ${errLine(e)}`)), 30_000).unref();
setInterval(() => void runShopJobs(ctx).catch((e) => console.error(`shop scheduler failed ${errLine(e)}`)), 30_000).unref();
setInterval(() => void runBookingJobs(ctx).catch((e) => console.error(`booking scheduler failed ${errLine(e)}`)), 30_000).unref();
setInterval(() => void runRetentionJobs(ctx).catch((e) => console.error(`retention clean-up failed ${errLine(e)}`)), 3600_000).unref();
setInterval(() => void runPersonalPurges(ctx).catch((e) => console.error(`personal data clean-up failed ${errLine(e)}`)), 3600_000).unref();
setInterval(() => void runCommunityJobs(ctx).catch((e) => console.error(`community scheduler failed ${errLine(e)}`)), 30_000).unref();
if (!listenEarly) await app.listen({ port, host: '0.0.0.0' });

console.log(`\nChurchOS API listening on http://localhost:${port}`);
// The sign-in code and the demo logins are printed only outside production (the log of a hosted service is not private).
if (!isProduction()) {
  console.log(`Dev one-time code for every login: ${DEV_OTP}`);
  console.log('Seeded logins:');
  if (process.env.SEED_DEMO !== '0') console.log('  0733000001  Member app       Neema Newcomer, not linked to a church yet');
  for (const l of SEED_LOGINS) console.log(`  ${l.phone}  ${l.app.padEnd(16)} ${l.who}`);
}

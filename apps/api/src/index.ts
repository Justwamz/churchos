import { buildApp } from './server';
import { runMemberHousekeeping } from './members';
import { runScheduledMessages } from './messages';
import { runCommunityJobs } from './routes/community';
import { runBookingJobs } from './routes/bookings';
import { runShopJobs } from './routes/shop';
import { runTicketJobs } from './routes/tickets';
import { runKidsJobs } from './routes/kids';
import { runGivingJobs } from './routes/giving-plans';
import { runAttendanceJobs } from './routes/attendance';
import { seedKidsDemo } from './seed-kids';
import { seedAttendanceDemo } from './seed-attendance';
import { DEV_OTP, SEED_LOGINS, seed } from './seed';

const port = Number(process.env.PORT ?? 4000);
const { app, ctx } = await buildApp({ logger: false });
await seed(ctx);
await seedKidsDemo(ctx);
await seedAttendanceDemo(app, ctx);
await runMemberHousekeeping(ctx);
// Graduation and birthday wishes run hourly. The platform clock can be advanced in development, so this uses it too.
setInterval(() => void runMemberHousekeeping(ctx).catch((e) => console.error('housekeeping failed', e)), 3600_000).unref();
// Scheduled messages go out within 30 seconds of their time (L118).
setInterval(() => void runScheduledMessages(ctx).catch((e) => console.error('scheduler failed', e)), 30_000).unref();
setInterval(() => void runTicketJobs(ctx).catch((e) => console.error('ticket scheduler failed', e)), 30_000).unref();
setInterval(() => void runAttendanceJobs(ctx).catch((e) => console.error('attendance scheduler failed', e)), 60_000).unref();
setInterval(() => void runGivingJobs(ctx).catch((e) => console.error('regular giving scheduler failed', e)), 30_000).unref();
setInterval(() => void runKidsJobs(ctx).catch((e) => console.error('children scheduler failed', e)), 30_000).unref();
setInterval(() => void runShopJobs(ctx).catch((e) => console.error('shop scheduler failed', e)), 30_000).unref();
setInterval(() => void runBookingJobs(ctx).catch((e) => console.error('booking scheduler failed', e)), 30_000).unref();
setInterval(() => void runCommunityJobs(ctx).catch((e) => console.error('community scheduler failed', e)), 30_000).unref();
await app.listen({ port, host: '0.0.0.0' });

console.log(`\nChurchOS API listening on http://localhost:${port}`);
console.log(`Dev one-time code for every login: ${DEV_OTP}`);
console.log('Seeded logins:');
for (const l of SEED_LOGINS) console.log(`  ${l.phone}  ${l.app.padEnd(16)} ${l.who}`);

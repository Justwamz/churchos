import { buildApp } from './server';
import { runMemberHousekeeping } from './members';
import { runScheduledMessages } from './messages';
import { runCommunityJobs } from './routes/community';
import { DEV_OTP, SEED_LOGINS, seed } from './seed';

const port = Number(process.env.PORT ?? 4000);
const { app, ctx } = await buildApp({ logger: false });
await seed(ctx);
await runMemberHousekeeping(ctx);
// Graduation and birthday wishes run hourly. The platform clock can be advanced in development, so this uses it too.
setInterval(() => void runMemberHousekeeping(ctx).catch((e) => console.error('housekeeping failed', e)), 3600_000).unref();
// Scheduled messages go out within 30 seconds of their time (L118).
setInterval(() => void runScheduledMessages(ctx).catch((e) => console.error('scheduler failed', e)), 30_000).unref();
setInterval(() => void runCommunityJobs(ctx).catch((e) => console.error('community scheduler failed', e)), 30_000).unref();
await app.listen({ port, host: '0.0.0.0' });

console.log(`\nChurchOS API listening on http://localhost:${port}`);
console.log(`Dev one-time code for every login: ${DEV_OTP}`);
console.log('Seeded logins:');
for (const l of SEED_LOGINS) console.log(`  ${l.phone}  ${l.app.padEnd(16)} ${l.who}`);

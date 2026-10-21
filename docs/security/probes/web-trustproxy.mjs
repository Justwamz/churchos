// Shows that Fastify({ trustProxy: true }) (what TRUST_PROXY=1 produces in apps/api/src/server.ts) lets a client choose req.ip via X-Forwarded-For.
// No port is opened (light-my-request inject). Run: node docs/security/probes/web-trustproxy.mjs
import { createRequire } from 'node:module';
const Fastify = createRequire(new URL('../../../apps/api/package.json', import.meta.url))('fastify');
for (const tp of [true, 1, 2]) {
  const a = Fastify({ trustProxy: tp }); a.get('/', (r) => r.ip); await a.ready();
  const r = await a.inject({ url: '/', headers: { 'x-forwarded-for': '6.6.6.6, 10.0.0.1' }, remoteAddress: '10.0.0.2' });
  console.log(`trustProxy=${JSON.stringify(tp)} -> req.ip=${r.body}  (6.6.6.6 = spoofed by the client)`);
}

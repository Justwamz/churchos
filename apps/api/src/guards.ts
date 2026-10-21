import { corsOrigins, isProduction } from './cors';

export interface GuardResult { errors: string[]; warnings: string[] }

/**
 * Start-up checks for a production-mode API. Returns messages instead of exiting so tests can call it with any environment.
 * (The signing-secret check lives in auth.ts and runs when that module loads.)
 */
export function productionGuards(env: NodeJS.ProcessEnv = process.env): GuardResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!isProduction(env)) return { errors, warnings };
  if (corsOrigins(env).length === 0) errors.push('CORS_ORIGINS is not set: list the exact web app addresses, separated by commas (for example https://churchos-staff.onrender.com,https://churchos-member.onrender.com)');
  if (env.PSP_MODE !== 'live') {
    if (env.ALLOW_DEMO_PSP !== '1') errors.push("PSP_MODE is not 'live': set PSP_MODE=live, or set ALLOW_DEMO_PSP=1 on a demo deployment that may use the payment simulator");
    else warnings.push('SIMULATED PAYMENTS ARE ON (ALLOW_DEMO_PSP=1): nothing real moves. Never use this for real churches.');
  }
  if (env.SEED_DEMO !== '0') {
    if (env.ALLOW_DEMO_SEED !== '1') errors.push('SEED_DEMO is on: set SEED_DEMO=0 for a real launch, or ALLOW_DEMO_SEED=1 on a demo deployment');
    else warnings.push('DEMO DATA IS LOADED at every start (ALLOW_DEMO_SEED=1): sample churches and people. Never use this for real churches.');
  }
  if (env.ALLOW_DEV_OTP === '1') warnings.push('ALLOW_DEV_OTP=1: the fixed demo sign-in code works for everybody. Demo only.');
  if (env.ENABLE_DEV_TOOLS === '1') warnings.push('ENABLE_DEV_TOOLS=1: clock and payment-simulation tools are reachable by platform admins.');
  return { errors, warnings };
}

/** Dev tools (clock, simulated payments, webhook replay) are off in production unless ENABLE_DEV_TOOLS=1. */
export const devToolsEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => !isProduction(env) || env.ENABLE_DEV_TOOLS === '1';

/** Number of trusted proxy hops in front of the API (TRUST_PROXY_HOPS; 1 when only TRUST_PROXY=1; 0 otherwise). */
export function trustProxyHops(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.TRUST_PROXY_HOPS;
  if (raw !== undefined && raw.trim() !== '') {
    const n = Number(raw);
    return Number.isInteger(n) && n >= 0 && n <= 10 ? n : 1;
  }
  return env.TRUST_PROXY === '1' ? 1 : 0;
}

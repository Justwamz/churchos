/** Which web origins may call the API from a browser. In production CORS_ORIGINS is required (checked at start, see guards.ts). */
export const isProduction = (env: NodeJS.ProcessEnv = process.env): boolean => env.NODE_ENV === 'production';

export function corsOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.CORS_ORIGINS ?? '').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
}

/** True when a browser page at `origin` may read API responses. No Origin header (curl, servers) is not a browser: allowed here, CORS is not authentication. */
export function corsAllows(origin: string | undefined | null, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!origin) return true;
  const list = corsOrigins(env);
  if (list.length === 0) return !isProduction(env); // fail closed in production, open for local development
  return list.includes(origin);
}

export const CORS_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];
export const CORS_HEADERS = ['authorization', 'content-type', 'x-churchos-app', 'x-churchos-device'];

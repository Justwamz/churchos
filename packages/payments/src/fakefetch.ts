import type { Fetch } from './http';

export interface SeenRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: any;
}

type Reply = { status?: number; json?: unknown; text?: string } | ((r: SeenRequest) => { status?: number; json?: unknown; text?: string });

/**
 * A fake fetch for tests: routes by "METHOD url-substring" to canned replies and records every request. Anything unmatched fails the
 * test loudly, so nothing can reach a real network.
 */
export function fakeFetch(routes: Record<string, Reply | Reply[]>): { fetch: Fetch; seen: SeenRequest[] } {
  const seen: SeenRequest[] = [];
  const queues = new Map<string, Reply[]>();
  const fetchFn = (async (url: any, init: any = {}) => {
    const req: SeenRequest = {
      url: String(url),
      method: String(init.method ?? 'GET'),
      headers: Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)])),
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    };
    seen.push(req);
    const key = Object.keys(routes).find((k) => {
      const [m, frag] = k.split(' ');
      return m === req.method && req.url.includes(frag);
    });
    if (!key) throw new Error(`fakeFetch: no route for ${req.method} ${req.url}`);
    if (!queues.has(key)) queues.set(key, Array.isArray(routes[key]) ? [...(routes[key] as Reply[])] : []);
    const q = queues.get(key)!;
    let reply = Array.isArray(routes[key]) ? (q.length > 1 ? q.shift()! : q[0]) : (routes[key] as Reply);
    if (typeof reply === 'function') reply = reply(req);
    const status = reply.status ?? 200;
    const text = reply.text ?? JSON.stringify(reply.json ?? {});
    return { status, ok: status < 400, text: async () => text } as Response;
  }) as Fetch;
  return { fetch: fetchFn, seen };
}

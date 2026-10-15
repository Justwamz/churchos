/** Tiny typed-ish fetch client shared by all four web apps. */
export const API_URL: string =
  (import.meta as any).env?.VITE_API_URL ?? `${location.protocol}//${location.hostname}:4000`;

export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
  }
}

export function createApi(tokenKey: string) {
  // Every request says which app it came from, so the audit log can record it (L104).
  const appName = tokenKey.replace(/^churchos:/, '').replace(/-token$/, '');
  const getToken = () => {
    try {
      return localStorage.getItem(tokenKey);
    } catch {
      return null;
    }
  };
  const setToken = (t: string | null) => {
    try {
      if (t) localStorage.setItem(tokenKey, t);
      else localStorage.removeItem(tokenKey);
    } catch {
      /* storage can be blocked, the session then lasts until the page closes */
    }
  };

  async function request<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    const token = getToken();
    let res: Response;
    try {
      res = await fetch(`${API_URL}${path}`, {
        method,
        headers: { 'x-churchos-app': appName, ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new ApiError(0, 'Cannot reach the server. Check your connection and try again.', 'network');
    }
    const text = await res.text();
    let data: any = undefined;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      data = text;
    }
    if (!res.ok) {
      if (res.status === 401 && token) setToken(null);
      throw new ApiError(res.status, data?.error ?? `Request failed (${res.status})`, data?.code);
    }
    return data as T;
  }

  return {
    API_URL,
    getToken,
    setToken,
    get: <T = any>(p: string) => request<T>('GET', p),
    post: <T = any>(p: string, b?: unknown) => request<T>('POST', p, b ?? {}),
    put: <T = any>(p: string, b?: unknown) => request<T>('PUT', p, b ?? {}),
    /** URL for downloads and EventSource, which cannot send headers. */
    url: (p: string) => `${API_URL}${p}${p.includes('?') ? '&' : '?'}token=${encodeURIComponent(getToken() ?? '')}`,
  };
}
export type Api = ReturnType<typeof createApi>;

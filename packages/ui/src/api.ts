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
    /**
     * A one-minute link for one GET path, for what cannot send an Authorization header (downloads, the live stream).
     * The sign-in token itself never appears in a URL.
     */
    ticketUrl: async (p: string): Promise<string> => {
      const r = await request<{ url: string }>('POST', '/auth/download-ticket', { path: p });
      return `${API_URL}${r.url}`;
    },
    /** Opens a file download (CSV, PDF) in a new tab. The tab is opened first so the browser does not block it. */
    openDownload: async (p: string): Promise<void> => {
      const w = window.open('about:blank', '_blank');
      try {
        const r = await request<{ url: string }>('POST', '/auth/download-ticket', { path: p });
        if (w) w.location.href = `${API_URL}${r.url}`;
        else window.location.href = `${API_URL}${r.url}`;
      } catch (e) {
        w?.close();
        throw e;
      }
    },
    /** Fetches a protected image with the Authorization header and returns an object URL for it (revoke it when done). */
    blobUrl: async (p: string): Promise<string> => {
      const token = getToken();
      const res = await fetch(`${API_URL}${p}`, { headers: { 'x-churchos-app': appName, ...(token ? { authorization: `Bearer ${token}` } : {}) } });
      if (!res.ok) throw new ApiError(res.status, 'Could not load the file');
      return URL.createObjectURL(await res.blob());
    },
    /** Signs out on the server (the token stops working everywhere) and clears it here at once. A failed call is ignored. */
    signOut: async (): Promise<void> => {
      const token = getToken();
      setToken(null);
      if (!token) return;
      try {
        await fetch(`${API_URL}/auth/logout`, { method: 'POST', headers: { 'x-churchos-app': appName, 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: '{}' });
      } catch {
        /* offline: the token is gone from this device anyway */
      }
    },
  };
}
export type Api = ReturnType<typeof createApi>;

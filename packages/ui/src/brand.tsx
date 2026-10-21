import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { API_URL } from './api';

/**
 * A church's own logo in the apps (Slice 26). After sign-in (or, on the giving page, when the church is known) an app calls `applyBranding`
 * with the church's branding details; it swaps the favicon, the phone home-screen icon, the browser colour and the install manifest for the church's own,
 * and `BrandMark` shows the logo inside the app. With no logo everything stays as the app shipped.
 */

export interface BrandInfo {
  orgId: string | null;
  hasLogo: boolean;
  version: number;
  themeColor?: string | null;
  bgColor?: string | null;
  name?: string | null;
  canChange?: boolean;
}

export interface BrandApp {
  /** Shown after the church's name when the app is installed, for example "Staff". */
  label: string;
  description: string;
  /** The colour the app uses when the church has no logo. */
  defaultTheme: string;
}

export const brandFile = (orgId: string, file: string, version: number, base: string = API_URL) => `${base}/public/branding/${encodeURIComponent(orgId)}/${file}?v=${version}`;

type Saved = { href: string | null };
const saved = new Map<string, Saved>();
let lastManifestUrl: string | null = null;

function setLink(rel: string, attrs: Record<string, string>, href: string | null) {
  const sel = `link[rel="${rel}"]${attrs.sizes ? `[sizes="${attrs.sizes}"]` : ''}${attrs.type ? `[type="${attrs.type}"]` : ''}`;
  let el = document.head.querySelector<HTMLLinkElement>(sel);
  const key = sel;
  if (!saved.has(key)) saved.set(key, { href: el?.getAttribute('href') ?? null });
  const original = saved.get(key)!.href;
  const next = href ?? original;
  if (!next) { el?.remove(); return; }
  if (!el) { el = document.createElement('link'); el.rel = rel; for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v); document.head.appendChild(el); }
  el.setAttribute('href', next);
  if (href && attrs.type) el.setAttribute('type', 'image/png');
}

function setMeta(name: string, content: string | null, fallback: string) {
  let el = document.head.querySelector<HTMLMetaElement>(`meta[name="${name}"]`);
  if (!el) { el = document.createElement('meta'); el.name = name; document.head.appendChild(el); }
  el.content = content ?? fallback;
}

/** Applies a church's logo to the page's favicon, home-screen icon, theme colour and install manifest. Safe to call again; pass `hasLogo: false` to go back to the defaults. */
export function applyBranding(b: BrandInfo | null, app: BrandApp, base: string = API_URL): void {
  if (typeof document === 'undefined') return;
  try {
    const on = !!(b && b.hasLogo && b.orgId);
    const f = (file: string) => (on ? brandFile(b!.orgId!, file, b!.version, base) : null);
    setLink('icon', { sizes: '32x32', type: 'image/png' }, f('favicon-32.png'));
    // The shipped pages have an SVG icon too; when the church has a logo it must not win over the PNG.
    const svg = document.head.querySelector<HTMLLinkElement>('link[rel="icon"][type="image/svg+xml"]');
    if (svg) { if (!saved.has('svg')) saved.set('svg', { href: svg.getAttribute('href') }); svg.setAttribute('href', on ? f('favicon-32.png')! : saved.get('svg')!.href!); if (on) svg.setAttribute('type', 'image/png'); else svg.setAttribute('type', 'image/svg+xml'); }
    setLink('apple-touch-icon', {}, f('apple-touch-icon.png'));
    setMeta('theme-color', on ? b!.themeColor ?? app.defaultTheme : null, app.defaultTheme);
    setMeta('apple-mobile-web-app-title', on ? `${shortName(b!.name, app.label)}` : null, document.title);

    // An install manifest made for this church. The icons live on the API; the start address stays on this site.
    const manifestLink = document.head.querySelector<HTMLLinkElement>('link[rel="manifest"]');
    if (manifestLink) {
      if (!saved.has('manifest')) saved.set('manifest', { href: manifestLink.getAttribute('href') });
      if (lastManifestUrl) { URL.revokeObjectURL(lastManifestUrl); lastManifestUrl = null; }
      if (on) {
        const origin = location.origin;
        const manifest = {
          id: `${origin}/`,
          name: `${b!.name ?? 'ChurchOS'} ${app.label}`.trim(),
          short_name: shortName(b!.name, app.label),
          description: app.description,
          lang: 'en',
          display: 'standalone',
          start_url: `${origin}/?source=pwa`,
          scope: `${origin}/`,
          theme_color: b!.themeColor ?? app.defaultTheme,
          background_color: b!.bgColor ?? '#ffffff',
          icons: [
            { src: f('icon-192.png'), sizes: '192x192', type: 'image/png', purpose: 'any' },
            { src: f('icon-512.png'), sizes: '512x512', type: 'image/png', purpose: 'any' },
            { src: f('icon-maskable.png'), sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          ],
        };
        lastManifestUrl = URL.createObjectURL(new Blob([JSON.stringify(manifest)], { type: 'application/manifest+json' }));
        manifestLink.setAttribute('href', lastManifestUrl);
      } else manifestLink.setAttribute('href', saved.get('manifest')!.href ?? '/manifest.webmanifest');
    }
  } catch { /* the page works without it */ }
}

const shortName = (name: string | null | undefined, fallback: string) => {
  const n = String(name ?? '').trim();
  return (n.length > 0 && n.length <= 14 ? n : n.split(/\s+/)[0] || fallback).slice(0, 14);
};

/**
 * Fetches the signed-in person's church branding once and applies it. `api` is the app's createApi() object. Returns the branding so the app
 * can show the logo, and `reload` to call after the church changes its logo.
 */
export function useChurchBranding(api: { get<T = any>(path: string): Promise<T> }, app: BrandApp) {
  const [brand, setBrand] = useState<BrandInfo | null>(null);
  const load = useCallback(() => { api.get<BrandInfo>('/me/branding').then(setBrand).catch(() => { /* default look */ }); }, [api]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { applyBranding(brand, app); }, [brand, app]);
  return { brand, reload: load };
}

/** The church's logo as a small image, or the fallback (the app's own mark) when there is none. */
export function BrandMark({ brand, size = 32, fallback, alt }: { brand: BrandInfo | null | undefined; size?: number; fallback?: ReactNode; alt?: string }) {
  if (!brand?.hasLogo || !brand.orgId) return <>{fallback ?? null}</>;
  return <img src={brandFile(brand.orgId, 'icon-192.png', brand.version)} width={size} height={size} alt={alt ?? brand.name ?? 'Church logo'} style={{ borderRadius: Math.round(size * 0.22), display: 'block', objectFit: 'cover' }} />;
}

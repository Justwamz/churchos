import { useEffect } from 'react';
import { applyBranding } from '@churchos/ui';
import type { BrandApp, BrandInfo } from '@churchos/ui';

export const GIVING_BRAND: BrandApp = { label: 'Giving', description: 'Give to your church, safely.', defaultTheme: '#0e5a52' };

/** Applies the church's logo (favicon, home-screen icon, colour, manifest) once the church is known, after the page has painted; puts the defaults back when the page goes away or no church is known. */
export function usePageBranding(b: (BrandInfo & { name?: string | null }) | null | undefined, name?: string | null) {
  const key = b?.hasLogo && b.orgId ? `${b.orgId}:${b.version}:${b.themeColor ?? ''}:${name ?? ''}` : '';
  useEffect(() => {
    if (!key || !b) return;
    applyBranding({ ...b, name: b.name ?? name ?? null }, GIVING_BRAND);
    return () => applyBranding(null, GIVING_BRAND);
  }, [key]); // eslint-disable-line
}

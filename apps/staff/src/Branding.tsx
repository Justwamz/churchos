import { DirectoryCard } from './Directory';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Field, Note, brandFile, useToast, type BrandInfo } from '@churchos/ui';
import { api, friendly } from './session';
import { Card, EmptyState, PageHeader, Section, StatusChip } from './ui';
import { Icon } from './icons';
import './branding.css';

/** The church's branding, shared from the signed-in shell so the page and the header logo update together. */
export const BrandCtx = createContext<{ brand: BrandInfo | null; reload: () => void }>({ brand: null, reload: () => {} });
export const useBrand = () => useContext(BrandCtx);

const MAX_BYTES = 3 * 1024 * 1024;
const TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'];
const NAVY = '#123456';
const TEAL = '#0e5a52';
const HEX = /^#[0-9a-f]{6}$/i;

/* ---------- the canvas pipeline: everything happens in the browser ---------- */

const canvasOf = (w: number, h: number) => { const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h)); return c; };
const ctxOf = (c: HTMLCanvasElement) => { const x = c.getContext('2d')!; x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high'; return x; };

/** Reads an image file. An SVG with only a viewBox has no size of its own, so it gets a default of 512 on its long side. */
async function readImage(file: File): Promise<HTMLImageElement> {
  let blob: Blob = file;
  if (file.type === 'image/svg+xml' || /\.svg$/i.test(file.name)) {
    const text = await file.text();
    const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
    const svg = doc.documentElement;
    if (svg.nodeName.toLowerCase() !== 'svg' || doc.querySelector('parsererror')) throw new Error('bad');
    const num = (v: string | null) => (v && !v.includes('%') ? parseFloat(v) : NaN);
    let w = num(svg.getAttribute('width')), h = num(svg.getAttribute('height'));
    if (!(w > 0) || !(h > 0)) {
      const vb = (svg.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
      const ratio = vb.length === 4 && vb[2] > 0 && vb[3] > 0 ? vb[2] / vb[3] : 1;
      w = ratio >= 1 ? 512 : 512 * ratio; h = ratio >= 1 ? 512 / ratio : 512;
      svg.setAttribute('width', String(Math.round(w))); svg.setAttribute('height', String(Math.round(h)));
    }
    blob = new Blob([new XMLSerializer().serializeToString(svg)], { type: 'image/svg+xml' });
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
}

/** Scales a canvas to a size; when shrinking by more than 2x it halves first (a single big jump looks jagged). */
function scaled(src: HTMLCanvasElement, tw: number, th: number): HTMLCanvasElement {
  tw = Math.max(1, Math.round(tw)); th = Math.max(1, Math.round(th));
  let cur = src;
  while (cur.width > tw * 2 && cur.height > th * 2) {
    const next = canvasOf(cur.width / 2, cur.height / 2);
    ctxOf(next).drawImage(cur, 0, 0, next.width, next.height);
    cur = next;
  }
  if (cur.width === tw && cur.height === th) return cur;
  const out = canvasOf(tw, th);
  ctxOf(out).drawImage(cur, 0, 0, out.width, out.height);
  return out;
}

/** The uploaded image as a canvas between 512 and 1024px on its long side, keeping transparency. */
function toWork(img: HTMLImageElement): HTMLCanvasElement {
  const w = img.naturalWidth || 512, h = img.naturalHeight || 512;
  const long = Math.max(w, h);
  const k = long > 1024 ? 1024 / long : long < 512 ? 512 / long : 1;
  const c = canvasOf(w * k, h * k);
  ctxOf(c).drawImage(img, 0, 0, c.width, c.height);
  return c;
}

/** The most common strong colour of the logo (ignoring see-through, near-white and grey pixels). */
function dominant(work: HTMLCanvasElement): string {
  const s = scaled(work, 48, 48 * work.height / work.width);
  const d = ctxOf(s).getImageData(0, 0, s.width, s.height).data;
  const bins = new Map<number, { n: number; r: number; g: number; b: number }>();
  const pass = (strict: boolean) => {
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], g = d[i + 1], b = d[i + 2], a = d[i + 3];
      if (a < 200) continue;
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      if (strict && (mn > 235 || mx - mn < 24)) continue;
      const key = ((r >> 5) << 6) | ((g >> 5) << 3) | (b >> 5);
      const e = bins.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
      e.n++; e.r += r; e.g += g; e.b += b; bins.set(key, e);
    }
  };
  pass(true);
  if (bins.size === 0) pass(false);
  let best: { n: number; r: number; g: number; b: number } | undefined;
  bins.forEach((e) => { if (!best || e.n > best.n) best = e; });
  if (!best) return NAVY;
  const t = best;
  const hex = (v: number) => Math.round(v / t.n).toString(16).padStart(2, '0');
  return `#${hex(t.r)}${hex(t.g)}${hex(t.b)}`;
}

/** Draws the logo contained in a square (x, y, size), using `fraction` of it. */
function drawLogo(ctx: CanvasRenderingContext2D, work: HTMLCanvasElement, size: number, fraction: number) {
  const box = size * fraction;
  const k = Math.min(box / work.width, box / work.height);
  const w = Math.max(1, Math.round(work.width * k)), h = Math.max(1, Math.round(work.height * k));
  ctx.drawImage(scaled(work, w, h), Math.round((size - w) / 2), Math.round((size - h) / 2), w, h);
}

type IconName = 'icon-192.png' | 'icon-512.png' | 'icon-maskable.png' | 'apple-touch-icon.png' | 'favicon-32.png';
type Icons = Record<IconName, HTMLCanvasElement>;

function makeIcon(work: HTMLCanvasElement, size: number, bg: string, o: { pad?: number; inner?: number; radius?: number }): HTMLCanvasElement {
  const c = canvasOf(size, size);
  const ctx = ctxOf(c);
  ctx.fillStyle = bg;
  if (o.radius) { ctx.beginPath(); ctx.roundRect(0, 0, size, size, size * o.radius); ctx.fill(); ctx.save(); ctx.clip(); } else ctx.fillRect(0, 0, size, size);
  drawLogo(ctx, work, size, o.inner ?? 1 - 2 * (o.pad ?? 0));
  if (o.radius) ctx.restore();
  return c;
}

function makeIcons(work: HTMLCanvasElement, bg: string): Icons {
  return {
    'icon-512.png': makeIcon(work, 512, bg, { pad: 0.12, radius: 0.22 }),
    'icon-192.png': makeIcon(work, 192, bg, { pad: 0.12, radius: 0.22 }),
    'icon-maskable.png': makeIcon(work, 512, bg, { inner: 0.6 }),
    'apple-touch-icon.png': makeIcon(work, 180, bg, { inner: 0.78 }),
    'favicon-32.png': makeIcon(work, 32, bg, { pad: 0.06, radius: 0.18 }),
  };
}

const b64 = (c: HTMLCanvasElement) => c.toDataURL('image/png').split(',')[1];

/** The `logo` sent to the API: the original, at most 512px on its long side, with its transparency. */
function logoFor(work: HTMLCanvasElement): HTMLCanvasElement {
  const k = Math.min(1, 512 / Math.max(work.width, work.height));
  return k === 1 ? work : scaled(work, work.width * k, work.height * k);
}

/* ---------- the page ---------- */

export function BrandingPage() {
  const { brand, reload } = useBrand();
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [work, setWork] = useState<HTMLCanvasElement | null>(null);
  const [fileName, setFileName] = useState('');
  const [bg, setBg] = useState('#ffffff');
  const [theme, setTheme] = useState(NAVY);
  const [domColour, setDomColour] = useState(NAVY);
  const [drag, setDrag] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [done, setDone] = useState('');

  const canChange = !!brand?.canChange;
  const name = brand?.name || 'Your church';

  const icons = useMemo(() => (work ? makeIcons(work, bg) : null), [work, bg]);
  const urls = useMemo(() => {
    if (!icons || !work) return null;
    const o: Record<string, string> = {};
    for (const [k, c] of Object.entries(icons)) o[k] = c.toDataURL('image/png');
    o.logo = logoFor(work).toDataURL('image/png');
    return o;
  }, [icons, work]);

  const take = useCallback(async (file: File | undefined | null) => {
    if (!file) return;
    setError(''); setDone('');
    const okType = TYPES.includes(file.type) || /\.(png|jpe?g|webp|svg)$/i.test(file.name);
    if (!okType) { setError('That file type is not supported. Please choose a PNG, JPEG, WebP or SVG picture.'); return; }
    if (file.size > MAX_BYTES) { setError('That picture is too large. Please choose one under 3 MB.'); return; }
    try {
      const w = toWork(await readImage(file));
      setWork(w); setDomColour(dominant(w)); setFileName(file.name);
    } catch { setError('We could not read that picture. Please try a different file.'); }
  }, []);

  // Start the colours from what is saved, so replacing a logo keeps the church's colours unless they change them.
  useEffect(() => {
    if (brand?.hasLogo && brand.bgColor && HEX.test(brand.bgColor)) setBg(brand.bgColor);
    if (brand?.hasLogo && brand.themeColor && HEX.test(brand.themeColor)) setTheme(brand.themeColor);
  }, [brand?.hasLogo, brand?.bgColor, brand?.themeColor]);

  const save = async () => {
    if (!icons || !work) return;
    setBusy(true); setError(''); setDone('');
    try {
      await api.put('/church/branding', {
        logo: b64(logoFor(work)), bgColor: bg.toLowerCase(), themeColor: theme.toLowerCase(),
        icons: Object.fromEntries(Object.entries(icons).map(([k, c]) => [k, b64(c)])),
      });
      setDone('Saved. People may need to reload the app or reinstall it to see the new home-screen icon.');
      toast.show('Logo and icons saved.');
      setWork(null); setFileName('');
      reload();
    } catch (e: any) { setError(friendly(e.message)); }
    setBusy(false);
  };

  const remove = async () => {
    setBusy(true); setError(''); setDone('');
    try {
      await api.post('/church/branding/remove');
      setConfirmRemove(false); setWork(null); setFileName('');
      setBg('#ffffff'); setTheme(NAVY);
      setDone('The logo is removed. The apps use the ChurchOS icons again.');
      reload();
    } catch (e: any) { setError(friendly(e.message)); }
    setBusy(false);
  };

  const saved = brand?.hasLogo && brand.orgId ? (f: string) => brandFile(brand.orgId!, f, brand.version) : null;

  const drop = (
    <div className={`br-drop ${drag ? 'over' : ''}`} role="button" tabIndex={0} aria-label="Choose a logo picture"
      onClick={() => input.current?.click()} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.current?.click(); } }}
      onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
      onDrop={(e) => { e.preventDefault(); setDrag(false); take(e.dataTransfer.files?.[0]); }}>
      <span className="br-drop-ico"><Icon name="download" size={24} style={{ transform: 'rotate(180deg)' }} /></span>
      <b>{work ? 'Choose a different picture' : 'Choose your logo'}</b>
      <span className="tiny">Click here, or drop a picture. PNG, JPEG, WebP or SVG, up to 3 MB. A square logo with a see-through background works best.</span>
    </div>
  );

  const swatches = [
    { c: '#ffffff', l: 'White' }, { c: domColour, l: 'From your logo' }, { c: NAVY, l: 'Navy' }, { c: TEAL, l: 'Teal' }, { c: '#000000', l: 'Black' },
  ];
  const colourRow = (label: string, hint: string, value: string, set: (v: string) => void, sw: boolean) => (
    <Field label={label} hint={hint}>
      <div className="br-colour">
        <input type="color" aria-label={label} value={HEX.test(value) ? value : '#ffffff'} onChange={(e) => set(e.target.value)} />
        <code>{value.toLowerCase()}</code>
        {sw && (
          <div className="br-sw" role="group" aria-label={label + ' quick colours'}>
            {swatches.map((s) => <button key={s.l} type="button" className={`br-swatch ${value.toLowerCase() === s.c.toLowerCase() ? 'on' : ''}`} style={{ background: s.c }} title={s.l} aria-label={s.l} onClick={() => set(s.c)} />)}
          </div>
        )}
      </div>
    </Field>
  );

  const header = <PageHeader title="Logo and listing" subtitle="Your logo and whether people can find your church by name. Your logo appears in the browser tab, on the phone home screen when someone installs the app, and inside the staff, member and giving apps." />;

  if (!brand) return <>{header}<Card><p className="muted">Loading...</p></Card></>;

  const savedCard = (
    <Card>
      {saved ? (
        <div className="br-saved">
          <img className="br-saved-img" src={saved('icon-192.png')} width={96} height={96} alt={`${name} logo`} />
          <div className="br-saved-text">
            <div className="row" style={{ gap: 8 }}><b>{name}</b><StatusChip tone="done">Logo in use</StatusChip></div>
            <div className="br-dots">
              <span><i style={{ background: brand.bgColor || '#fff' }} />Icon background {(brand.bgColor || '#ffffff').toLowerCase()}</span>
              <span><i style={{ background: brand.themeColor || NAVY }} />App colour {(brand.themeColor || NAVY).toLowerCase()}</span>
            </div>
            {canChange && !work && (
              <div className="row" style={{ marginTop: 14 }}>
                <Button kind="ghost" onClick={() => input.current?.click()}>Replace logo</Button>
                {!confirmRemove && <Button kind="danger" onClick={() => setConfirmRemove(true)}>Remove logo</Button>}
              </div>
            )}
          </div>
        </div>
      ) : (
        <EmptyState icon="edit" title="No logo yet" text={canChange ? 'Add your logo and the apps will use it everywhere.' : 'The apps use the ChurchOS icons for now.'} />
      )}
      {confirmRemove && (
        <div className="note warn" role="alertdialog" aria-label="Remove the logo" style={{ marginTop: 16 }}>
          <b>Remove the logo?</b> The staff, member and giving apps go back to the ChurchOS icons.
          <div className="row" style={{ marginTop: 10 }}>
            <Button kind="danger" small onClick={remove} disabled={busy}>{busy ? 'Removing...' : 'Yes, remove it'}</Button>
            <Button kind="ghost" small onClick={() => setConfirmRemove(false)}>Keep it</Button>
          </div>
        </div>
      )}
    </Card>
  );

  return (
    <>
      {header}
      {!canChange && <Note tone="info">Only the owner can change this.</Note>}
      {done && <div className="note good" role="status">{done}</div>}
      {error && <div className="note bad" role="alert">{error}</div>}

      {!work && (
        <Section title={brand.hasLogo ? 'Your logo' : canChange ? 'Add your logo' : 'Your logo'}>
          {(brand.hasLogo || !canChange) && savedCard}
          {canChange && !brand.hasLogo && <Card>{drop}</Card>}
        </Section>
      )}

      <input ref={input} type="file" hidden accept="image/png,image/jpeg,image/webp,image/svg+xml,.svg" data-testid="logo-file"
        onChange={(e) => { take(e.target.files?.[0]); e.target.value = ''; }} />

      {canChange && work && urls && (
        <>
          <Section title="Set it up" hint={fileName}>
            <Card>
              <div className="br-form">
                <div className="br-form-fields">
                  {colourRow('Icon background', 'Behind the logo on the home screen and in the tab.', bg, setBg, true)}
                  {colourRow('App colour', 'Colours the browser bar on a phone.', theme, setTheme, false)}
                </div>
                <div className="br-logo-prev" aria-hidden="true"><img src={urls.logo} alt="" /></div>
              </div>
              {drop}
            </Card>
          </Section>

          <Section title="How it will look" hint="This is what people will see.">
            <Card>
              <div className="br-prev">
                <figure className="br-fig">
                  <div className="br-tab"><img src={urls['favicon-32.png']} width={16} height={16} alt="" /><span>{name}</span><i>x</i></div>
                  <figcaption>Browser tab</figcaption>
                </figure>
                <figure className="br-fig">
                  <div className="br-phone"><img className="circle" src={urls['icon-maskable.png']} width={64} height={64} alt="Android home screen icon" /></div>
                  <figcaption>Android home screen</figcaption>
                </figure>
                <figure className="br-fig">
                  <div className="br-phone"><img className="round" src={urls['apple-touch-icon.png']} width={64} height={64} alt="iPhone home screen icon" /></div>
                  <figcaption>iPhone home screen</figcaption>
                </figure>
              </div>
              <div className="br-heads">
                <div className="br-head light"><img src={urls['icon-192.png']} width={32} height={32} alt="" /><b>{name}</b></div>
                <div className="br-head dark"><img src={urls['icon-192.png']} width={32} height={32} alt="" /><b>{name}</b></div>
              </div>
              <p className="tiny" style={{ marginTop: 10 }}>App header, on light and dark backgrounds.</p>
            </Card>
          </Section>

          <div className="row br-actions">
            <Button onClick={save} disabled={busy}>{busy ? 'Saving...' : 'Save logo and icons'}</Button>
            <Button kind="ghost" onClick={() => { setWork(null); setFileName(''); setError(''); }} disabled={busy}>Cancel</Button>
          </div>
        </>
      )}
      <DirectoryCard />
      {toast.node}
    </>
  );
}

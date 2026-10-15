import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import { Icon, Sheet } from './ui';
import type { ShopIntent, ShopItem } from './Shop';

type Advert = { id: string; title: string; body?: string; link?: string | null; sponsor?: string | null; church?: string | null; imageUrl?: string | null; width?: number; height?: number; action?: null | { kind: 'shop' } | { kind: 'item'; itemId: string; qty?: number; item: ShopItem } | { kind: 'checkout'; itemId: string; qty?: number; item: ShopItem } };

const viewed = new Set<string>(); // one view per advert per session
const img = (a: Advert) => (a.imageUrl ? api.url(a.imageUrl) : '');
const safeLink = (l?: string | null) => (l && /^https?:\/\//i.test(l) ? l : null);

export function AdvertSlider({ onShop }: { onShop?: (i: ShopIntent) => void }) {
  const [ads, setAds] = useState<Advert[]>([]);
  const [idx, setIdx] = useState(0);
  const [open, setOpen] = useState<Advert | null>(null);
  const track = useRef<HTMLDivElement>(null);
  const paused = useRef(false);

  useEffect(() => {
    let alive = true;
    api.get('/me/adverts').then((r) => { if (alive && Array.isArray(r)) setAds(r); }).catch(() => { /* silent */ });
    return () => { alive = false; };
  }, []);

  // count a view the first time a slide is mostly visible, and track which dot is current
  useEffect(() => {
    const root = track.current;
    if (!root || !ads.length || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting || e.intersectionRatio < 0.6) continue;
        const el = e.target as HTMLElement;
        setIdx(Number(el.dataset.i));
        const id = el.dataset.id!;
        if (!viewed.has(id)) { viewed.add(id); api.post(`/me/adverts/${encodeURIComponent(id)}/view`).catch(() => {}); }
      }
    }, { root, threshold: [0.6] });
    root.querySelectorAll('.ad-slide').forEach((s) => io.observe(s));
    return () => io.disconnect();
  }, [ads]);

  // auto-advance
  useEffect(() => {
    if (ads.length < 2) return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const t = setInterval(() => {
      const root = track.current;
      if (!root || paused.current || document.visibilityState !== 'visible') return;
      const slides = root.querySelectorAll<HTMLElement>('.ad-slide');
      const cur = Math.round(root.scrollLeft / Math.max(1, slides[0]?.offsetWidth + 12));
      const next = (cur + 1) % slides.length;
      root.scrollTo({ left: slides[next].offsetLeft - root.offsetLeft, behavior: 'smooth' });
    }, 5000);
    return () => clearInterval(t);
  }, [ads.length]);

  if (!ads.length) return null;
  const tap = (a: Advert) => {
    api.post(`/me/adverts/${encodeURIComponent(a.id)}/tap`).catch(() => {});
    const act = a.action;
    if (act && onShop) {
      if (act.kind === 'shop') return onShop({ kind: 'shop' });
      const item = act.item;
      if (!item || !item.available) return onShop({ kind: 'shop', notice: `Sorry, ${item?.name ?? 'that item'} is sold out right now. Have a look at what else is in the shop.` });
      return onShop(act.kind === 'item' ? { kind: 'item', item, advertId: a.id } : { kind: 'checkout', item, qty: act.qty ?? 1, advertId: a.id });
    }
    setOpen(a);
  };
  const goTo = (i: number) => { const s = track.current?.querySelectorAll<HTMLElement>('.ad-slide')[i]; if (s && track.current) track.current.scrollTo({ left: s.offsetLeft - track.current.offsetLeft, behavior: 'smooth' }); };
  const link = safeLink(open?.link);

  return (
    <section className="ads" aria-label="Sponsored" aria-roledescription="carousel">
      <div className="ad-track" ref={track}
        onTouchStart={() => { paused.current = true; }} onTouchEnd={() => { setTimeout(() => { paused.current = false; }, 4000); }}
        onMouseEnter={() => { paused.current = true; }} onMouseLeave={() => { paused.current = false; }}>
        {ads.map((a, i) => (
          <button type="button" key={a.id} data-i={i} data-id={a.id} className="ad-slide" aria-label={`${a.title}. Tap for details`} onClick={() => tap(a)}>
            {a.imageUrl ? <img src={img(a)} alt="" loading="lazy" draggable={false} /> : <span className="ad-fallback" aria-hidden="true" />}
            {(a.action?.kind === 'item' || a.action?.kind === 'checkout') && <span className="ad-buy">Buy</span>}
            <span className="ad-pill">{a.sponsor ? `Sponsored by ${a.sponsor}` : 'From your church'}</span>
            <span className="ad-scrim">
              <strong>{a.title}</strong>
              {a.body && <span className="ad-body">{a.body}</span>}
            </span>
          </button>
        ))}
      </div>
      {ads.length > 1 && (
        <div className="dots" role="group" aria-label="Choose a slide">
          {ads.map((a, i) => <button type="button" key={a.id} className={i === idx ? 'on' : ''} aria-label={`Slide ${i + 1} of ${ads.length}`} aria-current={i === idx} onClick={() => goTo(i)} />)}
        </div>
      )}
      <Sheet open={!!open} onClose={() => setOpen(null)} title={open?.title}>
        {open && (
          <div className="stack">
            {open.imageUrl && <img className="ad-full" src={img(open)} alt="" />}
            <div className="tiny">{open.sponsor ? `Sponsored by ${open.sponsor}` : 'From your church'}{open.church ? ` · ${open.church}` : ''}</div>
            {open.body && <p className="ad-text">{open.body}</p>}
            {link && <a className="btn primary pill" href={link} target="_blank" rel="noopener noreferrer"><Icon name="link" size={18} /> Open link</a>}
          </div>
        )}
      </Sheet>
    </section>
  );
}

import { useEffect, useMemo, useState, type MouseEvent, type ReactNode } from 'react';
import {
  DOCS_FOR_APP, LEGAL_EFFECTIVE, LEGAL_UPDATED, LEGAL_VERSION, OPERATOR, buildDoc, isDocSlug, legalDate, missingOperatorFields, odpcSentence,
  type ChurchInfo, type DocSlug, type LegalDoc,
} from '@churchos/shared';
import type { Api } from '../api';
import { ApiError } from '../api';

/**
 * The legal pages (served at /legal in every app, no sign-in), the "Before you continue" step after sign-in, and the church owner's
 * Data Processing Agreement card. The text lives in packages/shared/src/legal and reads the operator's details from OPERATOR.
 */

export const isLegalPath = (pathname: string = location.pathname) => /^\/legal(\/|$)/.test(pathname);
export const LEGAL_LINKS: { slug: DocSlug; label: string }[] = [
  { slug: 'terms', label: 'Terms of Use' },
  { slug: 'privacy', label: 'Privacy Notice' },
  { slug: 'cookies', label: 'Cookies and storage' },
  { slug: 'children', label: "Children's data" },
];
const SHORT: Record<DocSlug, string> = { terms: 'Terms of Use', privacy: 'Privacy Notice', cookies: 'Cookies and storage', children: "Children's Data Notice", dpa: 'Data Processing Agreement', messaging: 'Messaging policy' };

const devBuild = () => !!(import.meta as any).env?.DEV;

/** Links to the legal pages, for a footer or a sign-in screen. New tab by default so nobody loses their place. */
export function LegalLinks({ app, newTab = false, className }: { app: keyof typeof DOCS_FOR_APP | string; newTab?: boolean; className?: string }) {
  const slugs = (DOCS_FOR_APP[app] ?? DOCS_FOR_APP.member).filter((s) => s === 'terms' || s === 'privacy' || s === 'cookies' || s === 'children');
  return (
    <nav className={`legal-links ${className ?? ''}`} aria-label="Legal">
      {slugs.map((s) => <a key={s} href={`/legal/${s}`} {...(newTab ? { target: '_blank', rel: 'noopener' } : {})}>{SHORT[s]}</a>)}
    </nav>
  );
}

function DevBanner() {
  const missing = missingOperatorFields();
  if (!missing.length || !devBuild()) return null;
  return <div className="note warn" role="alert">Operator details are being finalised and are required before release. Missing in operator.ts: {missing.join(', ')}.</div>;
}

function Blocks({ blocks }: { blocks: LegalDoc['sections'][number]['blocks'] }) {
  return (
    <>
      {blocks.map((b, i) => {
        if (b.t === 'p') return <p key={i}>{b.text}</p>;
        if (b.t === 'note') return <div key={i} className="note info">{b.text}</div>;
        if (b.t === 'ul') return <ul key={i}>{b.items.map((x, j) => <li key={j}>{x}</li>)}</ul>;
        return (
          <div key={i} className="legal-table-wrap">
            <table className="legal-table">
              <thead><tr>{b.head.map((h, j) => <th key={j} scope="col">{h}</th>)}</tr></thead>
              <tbody>{b.rows.map((r, j) => <tr key={j}>{r.map((c, k) => (k === 0 ? <th key={k} scope="row" data-label={b.head[k]}>{c}</th> : <td key={k} data-label={b.head[k]}>{c}</td>))}</tr>)}</tbody>
            </table>
          </div>
        );
      })}
    </>
  );
}

function DocView({ doc, church }: { doc: LegalDoc; church: ChurchInfo | null }) {
  useEffect(() => { document.title = `${doc.title} | ChurchOS`; }, [doc.title]);
  return (
    <article className="legal-doc">
      <header>
        <h1>{doc.title}</h1>
        <p className="legal-meta">Effective {legalDate(LEGAL_EFFECTIVE)} · Last updated {legalDate(LEGAL_UPDATED)} · Version {LEGAL_VERSION}</p>
        {church?.name && <p className="legal-meta">Shown for {church.name}</p>}
      </header>
      <section className="legal-summary" aria-label="Summary">
        <h2>In short</h2>
        <ul>{doc.summary.map((s, i) => <li key={i}>{s}</li>)}</ul>
      </section>
      <nav className="legal-toc" aria-label="Contents">
        <h2>Contents</h2>
        <ol>{doc.sections.map((s) => <li key={s.id}><a href={`#${doc.slug}-${s.id}`}>{s.title}</a></li>)}</ol>
      </nav>
      {doc.sections.map((s) => (
        <section key={s.id} id={`${doc.slug}-${s.id}`} className="legal-section">
          <h2>{s.title}</h2>
          <Blocks blocks={s.blocks} />
        </section>
      ))}
      <p className="legal-meta">{odpcSentence(OPERATOR)}</p>
    </article>
  );
}

/**
 * Renders /legal, /legal/privacy and so on. `loadChurch` is optional: an app that knows the church (the member and staff apps once signed in,
 * the giving page from its code) passes it so the pages can name the church. Without a church the pages use general wording.
 */
export function LegalApp({ app, appName, loadChurch }: { app: 'staff' | 'member' | 'giving' | 'admin'; appName: string; loadChurch?: () => Promise<ChurchInfo | null> }) {
  const [path, setPath] = useState(() => location.pathname.replace(/\/+$/, ''));
  const [church, setChurch] = useState<ChurchInfo | null>(null);
  useEffect(() => {
    const on = () => setPath(location.pathname.replace(/\/+$/, ''));
    window.addEventListener('popstate', on);
    return () => window.removeEventListener('popstate', on);
  }, []);
  useEffect(() => { let live = true; loadChurch?.().then((c) => live && setChurch(c)).catch(() => {}); return () => { live = false; }; }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const allowed = DOCS_FOR_APP[app];
  const slug = path.replace(/^\/legal\/?/, '');
  const go = (e: MouseEvent<HTMLAnchorElement>, to: string) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    history.pushState(null, '', to);
    setPath(to);
    window.scrollTo(0, 0);
  };
  const doc = useMemo(() => (slug && isDocSlug(slug) && allowed.includes(slug) ? buildDoc(slug, church) : null), [slug, church, allowed]);
  useEffect(() => { if (!doc) document.title = 'Legal | ChurchOS'; }, [doc]);

  return (
    <div className="legal-shell">
      <header className="legal-top">
        <a className="legal-brand" href="/legal" onClick={(e) => go(e, '/legal')}>ChurchOS legal</a>
        <span className="legal-app">{appName}</span>
        <span className="spacer" />
        <button type="button" className="btn small ghost legal-print" onClick={() => window.print()}>Print</button>
        <a className="legal-back" href="/">Back to the app</a>
      </header>
      <main className="legal-main" id="main">
        <DevBanner />
        {doc ? (
          <>
            <p className="legal-crumb"><a href="/legal" onClick={(e) => go(e, '/legal')}>All documents</a></p>
            <DocView doc={doc} church={church} />
          </>
        ) : slug ? (
          <div className="legal-doc"><h1>Page not found</h1><p>That document is not part of this app. <a href="/legal" onClick={(e) => go(e, '/legal')}>See all documents</a>.</p></div>
        ) : (
          <div className="legal-doc">
            <h1>Legal documents</h1>
            <p className="legal-meta">Version {LEGAL_VERSION}. Effective {legalDate(LEGAL_EFFECTIVE)}.</p>
            <p>These documents explain how ChurchOS works with your data and the rules for using it. They are written in plain English. {church?.name ? `They are shown for ${church.name}.` : ''}</p>
            <ul className="legal-index">
              {allowed.map((s) => {
                const d = buildDoc(s, church);
                return <li key={s}><a href={`/legal/${s}`} onClick={(e) => go(e, `/legal/${s}`)}><b>{d.title}</b></a><span>{d.blurb}</span></li>;
              })}
            </ul>
            <p className="legal-meta">{OPERATOR.name} runs ChurchOS. Write to {OPERATOR.email}. Office: {OPERATOR.address}. Post: {OPERATOR.postalAddress}.</p>
          </div>
        )}
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------
// "Before you continue": shown once per person per legal version, after sign-in.
// ---------------------------------------------------------------------------------------------------------

interface LegalStatus { version: string; required: { doc: string; version: string; accepted: boolean; acceptedAt: string | null; orgId?: string; church?: string }[]; enforced: boolean }

const newTabLink = (slug: DocSlug, label: string) => <a href={`/legal/${slug}`} target="_blank" rel="noopener">{label}</a>;

/**
 * Wraps the signed-in part of an app. If the person has not accepted the current Terms of Use and Privacy Notice it shows one calm screen first.
 * The message toggles (member app only) are separate, start from what the person has now, and are never part of the required tick.
 * If the status cannot be read the app is let through (the server flag ENFORCE_LEGAL_ACCEPTANCE is the hard stop at launch).
 */
export function ConsentGate({ api, app, signOut, withMessageChoices = false, children }: { api: Api; app: 'staff' | 'member' | 'admin'; signOut: () => void; withMessageChoices?: boolean; children: ReactNode }) {
  const [state, setState] = useState<'loading' | 'needed' | 'ok'>('loading');
  const [agree, setAgree] = useState(false);
  const [sms, setSms] = useState(false);
  const [wa, setWa] = useState(false);
  const [initial, setInitial] = useState({ sms: false, wa: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const st = await api.get<LegalStatus>('/legal/status');
        if (!live) return;
        if (st.required.find((r) => r.doc === 'terms_privacy')?.accepted) { setState('ok'); return; }
        if (withMessageChoices) {
          try {
            const p = await api.get<{ whatsappOptIn: boolean; smsOptOut: boolean; source: string | null }>('/me/preferences');
            const s0 = p.source ? !p.smsOptOut : false;
            if (live) { setSms(s0); setWa(!!p.whatsappOptIn); setInitial({ sms: s0, wa: !!p.whatsappOptIn }); }
          } catch { /* the toggles start unticked */ }
        }
        if (live) setState('needed');
      } catch { if (live) setState('ok'); }
    })();
    return () => { live = false; };
  }, [api, withMessageChoices]);

  if (state === 'ok') return <>{children}</>;
  if (state === 'loading') return <main className="login"><div className="spinner" role="status" aria-label="Loading" /></main>;

  const submit = async () => {
    setBusy(true); setError(undefined);
    try {
      await api.post('/legal/accept', { doc: 'terms_privacy', version: LEGAL_VERSION, app });
      if (withMessageChoices && (sms !== initial.sms || wa !== initial.wa)) {
        const body: Record<string, boolean> = {};
        if (sms !== initial.sms) body.smsOptOut = !sms;
        if (wa !== initial.wa) body.whatsappOptIn = wa;
        try { await api.put('/me/preferences', body); } catch { /* they can set it later in Message choices */ }
      }
      setState('ok');
    } catch (e: any) {
      setError(e instanceof ApiError && e.status === 409 ? 'These documents were updated. Please reload the page and read the latest version.' : 'We could not save that. Please check your connection and try again.');
    }
    setBusy(false);
  };

  return (
    <main className="login consent">
      <form className="login-card consent-card" onSubmit={(e) => { e.preventDefault(); if (agree && !busy) void submit(); }} aria-labelledby="consent-title">
        <div className="brand">ChurchOS</div>
        <h1 id="consent-title">Before you continue</h1>
        <p className="muted">A short summary of how your data is used. The full documents are linked below.</p>
        <ul className="consent-points">
          <li>We collect your name and phone number, and what you do in the app: giving, attendance, messages, groups and prayer requests.</li>
          <li>Your church decides why its members' data is collected. {OPERATOR.name} runs ChurchOS for the church and keeps your account secure.</li>
          <li>Belonging to a church can reveal religious belief, and children are involved, so we treat both as sensitive.</li>
          <li>Records of gifts and the audit trail are kept for 7 years because the law requires it. We do not sell your data or show advertising.</li>
          <li>You can download your data, correct it, close your account or complain to the Office of the Data Protection Commissioner.</li>
        </ul>
        <p className="consent-docs">Read the full {newTabLink('terms', 'Terms of Use')}, {newTabLink('privacy', 'Privacy Notice')}, {newTabLink('cookies', 'Cookie and Storage Notice')} (each opens in a new tab).</p>
        <label className="consent-check required">
          <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
          <span>I have read and agree to the Terms of Use and the Privacy Notice</span>
        </label>
        {withMessageChoices && (
          <fieldset className="consent-optional">
            <legend>Optional. You can change these any time.</legend>
            <label className="consent-check"><input type="checkbox" checked={sms} onChange={(e) => setSms(e.target.checked)} /><span>Receive messages from my church by SMS</span></label>
            <label className="consent-check"><input type="checkbox" checked={wa} onChange={(e) => setWa(e.target.checked)} /><span>Receive messages from my church by WhatsApp</span></label>
            <p className="muted consent-hint">Leaving these as they are changes nothing. Your church may send SMS notices unless you opt out under your profile (your picture or initials), My profile and church, Message choices. WhatsApp is sent only if you tick it.</p>
          </fieldset>
        )}
        <button type="submit" className="btn primary" disabled={!agree || busy}>{busy ? 'Saving…' : 'Continue'}</button>
        {error && <div className="note bad" role="alert">{error}</div>}
        <button type="button" className="consent-signout" onClick={signOut}>Sign out</button>
      </form>
    </main>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Staff: the church owner accepts the Data Processing Agreement for the church.
// ---------------------------------------------------------------------------------------------------------

const REMIND_KEY = 'churchos:dpa-remind';
const REMIND_MS = 7 * 86_400_000;
const remindedUntil = (orgId: string): number => { try { return Number(JSON.parse(localStorage.getItem(REMIND_KEY) ?? '{}')[orgId] ?? 0); } catch { return 0; } };
const remindLater = (orgId: string) => { try { const m = JSON.parse(localStorage.getItem(REMIND_KEY) ?? '{}'); m[orgId] = Date.now() + REMIND_MS; localStorage.setItem(REMIND_KEY, JSON.stringify(m)); } catch { /* ignore */ } };

/** A card for the Today screen. Shows only to an Organisation Owner whose church has not accepted the current Data Processing Agreement. */
export function DpaCard({ api, orgId }: { api: Api; orgId?: string }) {
  const [item, setItem] = useState<{ orgId: string; church?: string } | null>(null);
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    let live = true;
    api.get<LegalStatus>('/legal/status').then((st) => {
      const mine = st.required.filter((r) => r.doc === 'dpa' && !r.accepted && (!orgId || r.orgId === orgId));
      const next = mine.find((r) => r.orgId && remindedUntil(r.orgId) < Date.now());
      if (live && next?.orgId) setItem({ orgId: next.orgId, church: next.church });
    }).catch(() => {});
    return () => { live = false; };
  }, [api, orgId]);
  if (!item || hidden) return null;
  const name = item.church || 'your church';
  const accept = async () => {
    setBusy(true); setError(undefined);
    try { await api.post('/legal/accept', { doc: 'dpa', version: LEGAL_VERSION, orgId: item.orgId, app: 'staff' }); setHidden(true); }
    catch (e: any) { setError(e?.message ?? 'We could not save that. Please try again.'); }
    setBusy(false);
  };
  return (
    <section className="card dpa-card" aria-labelledby="dpa-title">
      <h3 id="dpa-title">Data Processing Agreement for {name}</h3>
      <p>{name} is the controller of its members' data and {OPERATOR.name} processes it for the church. The law asks for a written agreement. Please read it and accept it for the church. Until you do, the church cannot send messages to many people at once.</p>
      <p><a href="/legal/dpa" target="_blank" rel="noopener">Read the Data Processing Agreement</a> (opens in a new tab). Also see the {newTabLink('messaging', 'Messaging policy')}.</p>
      <label className="consent-check required">
        <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
        <span>I am the Organisation Owner, I have read the agreement and I accept it on behalf of {name}</span>
      </label>
      {error && <div className="note bad" role="alert">{error}</div>}
      <div className="dpa-actions">
        <button type="button" className="btn primary small" disabled={!agree || busy} onClick={accept}>{busy ? 'Saving…' : 'Accept for the church'}</button>
        <button type="button" className="btn ghost small" onClick={() => { remindLater(item.orgId); setHidden(true); }}>Remind me later</button>
      </div>
    </section>
  );
}

/** The one-line notice at a payment step. Links open in a new tab so the payer keeps their place. */
export function LegalNotice({ what = 'continuing' }: { what?: string }) {
  return (
    <p className="legal-notice tiny">By {what} you agree to the <a href="/legal/terms" target="_blank" rel="noopener">Terms of Use</a> and <a href="/legal/privacy" target="_blank" rel="noopener">Privacy Notice</a>.</p>
  );
}

import { useMemo } from 'react';
import qrcode from 'qrcode-generator';

/** Where the public verification page lives: the giving app, which needs no sign-in. */
export const VERIFY_ORIGIN: string =
  (import.meta as any).env?.VITE_VERIFY_ORIGIN ?? `${location.protocol}//${location.hostname}:3001`;

/** A QR code drawn as plain SVG shapes. Nothing is injected as HTML. */
export function QrCode({ value, size = 120, label }: { value: string; size?: number; label?: string }) {
  const cells = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(value);
    qr.make();
    const n = qr.getModuleCount();
    const dark: [number, number][] = [];
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) dark.push([r, c]);
    return { n, dark };
  }, [value]);
  const margin = 2;
  const total = cells.n + margin * 2;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${total} ${total}`} role="img" aria-label={label ?? 'QR code'} shapeRendering="crispEdges">
      <rect width={total} height={total} fill="#fff" />
      {cells.dark.map(([r, c]) => <rect key={`${r}-${c}`} x={c + margin} y={r + margin} width="1" height="1" fill="#111" />)}
    </svg>
  );
}

export interface CertificatePayload {
  kind: string;
  preview: boolean;
  title: string;
  body: string;
  subject: string;
  eventDate: string;
  place: string;
  officiant: string;
  registerNumber: string | null;
  serial: string | null;
  version: number;
  verifyPath: string | null;
  template: {
    churchName: string;
    tagline: string;
    accent: string;
    footer: string;
    showQr: boolean;
    logo: string | null;
    signatories: { name: string; title: string }[];
  };
  branch: { name?: string; address: string | null; town: string | null; phone: string | null; email: string | null };
}

/**
 * The baptism card. Staff previews, the print view and the member's copy all draw this same component (L99, L100).
 * Printing hides everything else on the page and uses an A4 landscape sheet.
 */
export function CertificateCard({ c }: { c: CertificatePayload }) {
  const t = c.template;
  const verifyUrl = c.verifyPath ? `${VERIFY_ORIGIN}${c.verifyPath}` : null;
  const address = [c.branch.address, c.branch.town].filter(Boolean).join(', ');
  const contact = [c.branch.phone, c.branch.email].filter(Boolean).join('  ·  ');
  return (
    <div className="cert-print">
      <div className="cert" style={{ ['--accent' as any]: t.accent }}>
        <div className="cert-frame">
          {c.preview && <div className="cert-watermark" aria-hidden>PREVIEW</div>}
          <header className="cert-head">
            {t.logo && <img className="cert-logo" src={t.logo} alt="" />}
            <div className="cert-church">{t.churchName}</div>
            {t.tagline && <div className="cert-tagline">{t.tagline}</div>}
          </header>
          <h2 className="cert-title">{c.title}</h2>
          <div className="cert-rule" />
          <p className="cert-lead">This is to certify that</p>
          <div className="cert-name">{c.subject}</div>
          <p className="cert-body">{c.body}</p>
          <dl className="cert-facts">
            <div><dt>Date</dt><dd>{c.eventDate}</dd></div>
            <div><dt>Place</dt><dd>{c.place}</dd></div>
            <div><dt>Officiant</dt><dd>{c.officiant}</dd></div>
            {c.registerNumber && <div><dt>Register no.</dt><dd>{c.registerNumber}</dd></div>}
          </dl>
          <div className="cert-foot">
            <div className="cert-signs">
              {t.signatories.map((s, i) => (
                <div key={i} className="cert-sign">
                  <div className="cert-sign-line" />
                  <div className="cert-sign-name">{s.name}</div>
                  <div className="cert-sign-title">{s.title}</div>
                </div>
              ))}
            </div>
            <div className="cert-verify">
              {t.showQr && verifyUrl && <QrCode value={verifyUrl} size={84} label="Scan to verify this certificate" />}
              <div className="cert-serial">{c.serial ? `No. ${c.serial}` : 'Not yet issued'}</div>
              {t.showQr && verifyUrl && <div className="cert-scan">Scan to verify</div>}
            </div>
          </div>
          <div className="cert-address">
            {[c.branch.name, address, contact].filter(Boolean).join('  ·  ')}
          </div>
          {t.footer && <div className="cert-note">{t.footer}</div>}
        </div>
      </div>
    </div>
  );
}

export const printCertificate = () => window.print();

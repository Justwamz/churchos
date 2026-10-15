import { useEffect, useState } from 'react';
import { Button } from '@churchos/ui';
import { api, useSession } from './session';
import { orgQs, type WalletInfo } from './Wallets';

/** Shown above every page except Wallets when any wallet the person can see is running low or empty. */
export function WalletBanner({ page }: { page: string }) {
  const s = useSession();
  const allowed = s.can('wallets.view');
  const [bad, setBad] = useState<WalletInfo[]>([]);

  useEffect(() => {
    if (!allowed) { setBad([]); return; }
    let live = true;
    api.get('/wallets' + orgQs(s))
      .then((r: any) => { if (live) setBad((r.wallets as WalletInfo[]).filter((w) => w.state === 'low' || w.state === 'empty')); })
      .catch(() => {});
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allowed, s.grant.org.id, page]);

  if (!allowed || bad.length === 0 || page === 'wallets') return null;
  const anyEmpty = bad.some((w) => w.state === 'empty');
  const channel = (w: WalletInfo) => (w.channel === 'sms' ? 'SMS' : 'WhatsApp');
  const place = (w: WalletInfo) => w.label.split(' · ')[0];
  const shown = bad.slice(0, 3);
  return (
    <div className={`banner ${anyEmpty ? 'fix' : 'action'}`} role="region" aria-label="Messaging credit">
      <div className="banner-icon" aria-hidden>!</div>
      <div className="banner-main">
        <div className="banner-title">{anyEmpty ? 'Messaging credit has run out' : 'Messaging credit is running low'}</div>
        <div className="banner-text" style={{ display: 'grid', gap: 4 }}>
          {shown.map((w) => (
            <span key={w.id}>
              {w.state === 'empty'
                ? `${channel(w)} credit has run out at ${place(w)}.${w.channel === 'whatsapp' ? ' Messages by WhatsApp are not being sent. In-app messages still go out.' : ' SMS messages are not being sent. In-app messages still go out.'}`
                : `${channel(w)} credit is running low at ${place(w)}`}
            </span>
          ))}
          {bad.length > shown.length && <span>and {bad.length - shown.length} more</span>}
        </div>
      </div>
      <div className="banner-cta"><Button onClick={() => s.go('wallets')}>Top up now</Button></div>
    </div>
  );
}

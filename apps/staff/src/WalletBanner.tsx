import { useEffect, useState } from 'react';
import { api, useSession } from './session';
import { orgQs, type WalletInfo } from './Wallets';
import { Icon } from './icons';

/**
 * Messaging credit warning. Two parts:
 *  - useWalletAlert(): which wallets the person can see are low or empty. The nav shows a small dot on Communicate while this is not empty.
 *  - WalletNotice: a slim, dismissible line on Today, Messages and Wallets only (never on every page). Dismissal lasts for the session
 *    and comes back if things get worse (low -> empty).
 */
const KEY = 'churchos:wallet-notice-dismissed';
export const NOTICE_PAGES = ['today', 'messages', 'wallets'];

export function useWalletAlert(page: string) {
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
  return { bad: allowed ? bad : [], anyEmpty: allowed && bad.some((w) => w.state === 'empty') };
}

const readDismissed = () => { try { return sessionStorage.getItem(KEY) ?? ''; } catch { return ''; } };

export function WalletNotice({ page, bad, anyEmpty }: { page: string; bad: WalletInfo[]; anyEmpty: boolean }) {
  const s = useSession();
  const [dismissed, setDismissed] = useState(readDismissed);
  const level = anyEmpty ? 'empty' : 'low';
  if (!NOTICE_PAGES.includes(page) || bad.length === 0) return null;
  if (dismissed === 'empty' || (dismissed === 'low' && level === 'low')) return null;

  const channel = (w: WalletInfo) => (w.channel === 'sms' ? 'SMS' : 'WhatsApp');
  const place = (w: WalletInfo) => w.label.split(' · ')[0];
  const empty = bad.filter((w) => w.state === 'empty');
  const first = empty[0] ?? bad[0];
  const more = bad.length - 1;
  const text = first.state === 'empty'
    ? `${channel(first)} credit has run out at ${place(first)}. ${first.channel === 'whatsapp' ? 'WhatsApp' : 'SMS'} messages are paused. In-app messages still go out.`
    : `${channel(first)} credit is running low at ${place(first)}.`;
  const dismiss = () => { setDismissed(level); try { sessionStorage.setItem(KEY, level); } catch { /* optional */ } };

  return (
    <div className={`wn ${anyEmpty ? "is-empty" : "is-low"}`} role="status" aria-label="Messaging credit">
      <Icon name="wallet" size={18} />
      <span className="wn-text">{text}{more > 0 ? ` And ${more} more.` : ''}</span>
      {page !== 'wallets' && <button type="button" className="wn-go" onClick={() => s.go('wallets')}>Top up</button>}
      <button type="button" className="wn-x" aria-label="Dismiss this notice" onClick={dismiss}><Icon name="close" size={16} /></button>
    </div>
  );
}

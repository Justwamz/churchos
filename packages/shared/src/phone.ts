import type { PaymentMethod } from './types';

export type Network = 'safaricom' | 'airtel' | 'telkom';

/** Kenyan number ranges by network. Ranges that are shared or unsure are left out, so an unknown number is accepted rather than refused. */
const RANGES: { network: Network; test: RegExp }[] = [
  // national number without the leading 0 or the 254, for example 712345678
  { network: 'safaricom', test: /^(7[0-2]\d|74[0-3]|745|746|748|75[789]|76[89]|79\d)\d{6}$/ },
  { network: 'airtel', test: /^(73\d|75[0-6]|762|78\d)\d{6}$/ },
  { network: 'telkom', test: /^77\d{7}$/ },
];

const national = (raw: string) => {
  const d = String(raw ?? '').replace(/\D/g, '');
  if (/^254\d{9}$/.test(d)) return d.slice(3);
  if (/^0\d{9}$/.test(d)) return d.slice(1);
  return /^\d{9}$/.test(d) ? d : '';
};

/** Which network a number belongs to, or null when it is unknown or incomplete. */
export function networkOf(raw: string): Network | null {
  const n = national(raw);
  return n ? RANGES.find((r) => r.test.test(n))?.network ?? null : null;
}

export const NETWORK_NAME: Record<Network, string> = { safaricom: 'Safaricom', airtel: 'Airtel', telkom: 'Telkom' };

/** The network each mobile money method runs on. Cards have no network. */
export const METHOD_NETWORK: Partial<Record<PaymentMethod, Network>> = { mpesa: 'safaricom', airtel: 'airtel', tkash: 'telkom' };

const LABEL: Record<string, string> = { mpesa: 'M-Pesa', airtel: 'Airtel Money', tkash: 'T-Kash', card: 'Card' };

/** What to show beside the phone field for a payment method. */
export function phoneHint(method: string): { label: string; placeholder: string; help: string } {
  switch (method) {
    case 'airtel': return { label: 'Airtel Money number', placeholder: '0733 123 456', help: 'Use the Airtel number you pay from. Airtel numbers start with 073, 075 or 078.' };
    case 'tkash': return { label: 'T-Kash number', placeholder: '0777 123 456', help: 'Use the Telkom number you pay from. Telkom numbers start with 077.' };
    case 'card': return { label: 'Your phone number', placeholder: '0712 345 678', help: 'We use it to match the gift to you and send your receipt. You pay by card on the next page.' };
    default: return { label: 'M-Pesa number', placeholder: '0712 345 678', help: 'Use the Safaricom number you pay from. You will get a prompt on this phone.' };
  }
}

/** A short message when a number clearly belongs to a different network from the chosen method, otherwise null. */
export function networkMismatch(method: string, phone: string): string | null {
  const want = METHOD_NETWORK[method as PaymentMethod];
  const have = networkOf(phone);
  if (!want || !have || want === have) return null;
  return `That looks like a ${NETWORK_NAME[have]} number. ${LABEL[method]} needs a ${NETWORK_NAME[want]} number. Choose ${have === 'safaricom' ? 'M-Pesa' : have === 'airtel' ? 'Airtel Money' : 'T-Kash'} instead, or use a ${NETWORK_NAME[want]} number.`;
}

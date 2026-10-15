/** Provider-agnostic messaging, like the payments layer (L78). Real SMS, WhatsApp and email providers become adapters behind these. */

export type Channel = 'sms' | 'whatsapp';

export interface OutboundMessage {
  /** Destination number in international form, for example 254711000001. Never logged by ChurchOS. */
  to: string;
  body: string;
  /** SMS sender name, or the WhatsApp business number the church sends from. */
  from?: string | null;
  /** WhatsApp business-initiated messages go out as an approved template. The platform provides a generic one. */
  template?: string;
}

export interface SendResult {
  status: 'sent' | 'failed';
  providerMessageId?: string;
  error?: string;
}

export interface MessagingProvider {
  send(channel: Channel, batch: OutboundMessage[]): Promise<SendResult[]>;
}

export interface OutboundEmail {
  to: string;
  subject: string;
  body: string;
}

export interface EmailProvider {
  send(mail: OutboundEmail): Promise<SendResult>;
}

/** The approved WhatsApp template ChurchOS uses for church notices: "Hello {{1}}, {{2}}" (L118). */
export const WHATSAPP_TEMPLATE = 'church_notice';

/**
 * Simulated SMS and WhatsApp for local development. It keeps what it "sent" in memory, so tests can check delivery without a
 * network, and it can be told to fail the next sends.
 */
export class MockMessagingProvider implements MessagingProvider {
  readonly sent: { channel: Channel; to: string; body: string; from?: string | null; template?: string; id: string }[] = [];
  private failNext = 0;
  private seq = 0;

  failNextSends(n = 1) {
    this.failNext = n;
  }

  async send(channel: Channel, batch: OutboundMessage[]): Promise<SendResult[]> {
    return batch.map((m) => {
      if (this.failNext > 0) {
        this.failNext--;
        return { status: 'failed' as const, error: 'simulated provider failure' };
      }
      const id = `${channel === 'sms' ? 'SMS' : 'WA'}${String(++this.seq).padStart(7, '0')}`;
      this.sent.push({ channel, to: m.to, body: m.body, from: m.from, template: m.template, id });
      if (this.sent.length > 5000) this.sent.shift();
      return { status: 'sent' as const, providerMessageId: id };
    });
  }

  count(channel?: Channel) {
    return this.sent.filter((s) => !channel || s.channel === channel).length;
  }
  clear() {
    this.sent.length = 0;
  }
}

/** Simulated email: keeps messages in memory. The API also writes them to an outbox table so they can be read in the admin console. */
export class MockEmailProvider implements EmailProvider {
  readonly sent: (OutboundEmail & { id: string })[] = [];
  private seq = 0;
  async send(mail: OutboundEmail): Promise<SendResult> {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mail.to)) return { status: 'failed', error: 'invalid address' };
    const id = `EML${String(++this.seq).padStart(6, '0')}`;
    this.sent.push({ ...mail, id });
    return { status: 'sent', providerMessageId: id };
  }
}

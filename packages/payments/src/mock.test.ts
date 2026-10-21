import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { MockProvider } from './mock';

describe('the simulator webhook secret (WEB-01)', () => {
  it('is never the published constant, and differs per process unless MOCK_PSP_SECRET is set', () => {
    const was = process.env.MOCK_PSP_SECRET;
    delete process.env.MOCK_PSP_SECRET;
    try {
      const a = new MockProvider(), b = new MockProvider();
      const body = '{"x":1}';
      expect(a.sign(body)).not.toBe(createHmac('sha256', 'dev-psp-secret').update(body).digest('hex'));
      expect(a.sign(body)).not.toBe(b.sign(body));
      expect(a.verifyWebhook({ 'x-psp-signature': createHmac('sha256', 'dev-psp-secret').update(body).digest('hex') }, body)).toBe(false);
      expect(a.verifyWebhook({ 'x-psp-signature': a.sign(body) }, body)).toBe(true);
      process.env.MOCK_PSP_SECRET = 'from-the-environment';
      expect(new MockProvider().sign(body)).toBe(createHmac('sha256', 'from-the-environment').update(body).digest('hex'));
    } finally {
      if (was === undefined) delete process.env.MOCK_PSP_SECRET; else process.env.MOCK_PSP_SECRET = was;
    }
  });
});

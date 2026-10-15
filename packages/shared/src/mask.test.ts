import { describe, expect, it } from 'vitest';
import { isMasked, maskAccount, maskDob, maskEmail, maskId, maskPhone, maskValue } from './index';

describe('masking (L109)', () => {
  it('masks phones, keeping the network prefix and last three digits', () => {
    expect(maskPhone('254711000001')).toBe('254711•••001');
    expect(maskPhone(' 254 711 000 001 ')).toBe('254711•••001');
    expect(maskPhone('0711')).toBe('••••');
    expect(maskPhone('')).toBeNull();
    expect(maskPhone(null)).toBeNull();
  });
  it('never reveals a full phone number', () => {
    for (const p of ['254711000001', '254733999888', '+254722123456']) expect(maskPhone(p)).not.toMatch(/\d{9}/);
  });
  it('masks dates of birth to the year', () => {
    expect(maskDob('1985-06-14')).toBe('1985-••-••');
    expect(maskDob('garbage')).toBe('••••');
    expect(maskDob(null)).toBeNull();
  });
  it('masks account numbers, emails and identifiers', () => {
    expect(maskAccount('1100234567')).toBe('••••4567');
    expect(maskAccount('123')).toBe('••••');
    expect(maskEmail('jane@example.com')).toBe('j•••@example.com');
    expect(maskId('MC/2010/004512')).toBe('•••512');
    expect(maskValue('phone', '254711000001')).toBe('254711•••001');
    expect(maskValue('text', 'secret')).toBe('••••');
  });
  it('recognises masked values', () => {
    expect(isMasked('254711•••001')).toBe(true);
    expect(isMasked('254711000001')).toBe(false);
    expect(isMasked(null)).toBe(false);
  });
});

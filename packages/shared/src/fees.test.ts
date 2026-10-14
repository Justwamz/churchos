import { describe, expect, it } from 'vitest';
import { computeFee, DEFAULT_FEE_SCHEDULE, parseReference } from './index';
import type { FeeSchedule } from './types';

const noPsp: FeeSchedule = {
  ...DEFAULT_FEE_SCHEDULE,
  psp: { ...DEFAULT_FEE_SCHEDULE.psp, mpesa: { bps: 0, fixed: 0 } },
};

describe('parseReference', () => {
  it('parses code and purpose, case-insensitive, trimmed', () => {
    expect(parseReference('  grc001#tithe ')).toEqual({ code: 'GRC001', purpose: 'TITHE' });
  });
  it('defaults purpose to OFFERING when only a code is given', () => {
    expect(parseReference('GRC001')).toEqual({ code: 'GRC001', purpose: 'OFFERING' });
    expect(parseReference('GRC001#')).toEqual({ code: 'GRC001', purpose: 'OFFERING' });
  });
  it('returns null for empty or code-less references', () => {
    expect(parseReference('')).toBeNull();
    expect(parseReference('   ')).toBeNull();
    expect(parseReference('#TITHE')).toBeNull();
    expect(parseReference(null)).toBeNull();
  });
});

describe('computeFee', () => {
  it('church bears fee: net + fee equals amount paid', () => {
    const r = computeFee(DEFAULT_FEE_SCHEDULE, 'mpesa', 100000, 'church');
    expect(r.amountPaid).toBe(100000);
    expect(r.platformFee).toBe(1500);
    expect(r.pspCost).toBe(1000);
    expect(r.netToChurch + r.totalFee).toBe(r.amountPaid);
  });
  it('member bears fee: church receives exactly the base', () => {
    const r = computeFee(DEFAULT_FEE_SCHEDULE, 'mpesa', 100000, 'member');
    expect(r.netToChurch).toBe(100000);
    expect(r.amountPaid - r.totalFee).toBe(100000);
    expect(r.amountPaid).toBeGreaterThan(100000);
  });
  it('never loses a cent for awkward amounts', () => {
    for (const method of ['mpesa', 'airtel', 'card', 'tkash'] as const) {
      for (const bearer of ['church', 'member'] as const) {
        for (const amt of [1, 7, 33, 99, 101, 12345, 99999, 1000001]) {
          const r = computeFee(DEFAULT_FEE_SCHEDULE, method, amt, bearer);
          expect(r.amountPaid - r.totalFee).toBe(r.netToChurch);
          expect(r.platformFee + r.pspCost).toBe(r.totalFee);
          if (bearer === 'member') expect(r.netToChurch).toBe(amt);
        }
      }
    }
  });
  it('rounds half up', () => {
    expect(computeFee(noPsp, 'mpesa', 33, 'church').platformFee).toBe(0);
    expect(computeFee(noPsp, 'mpesa', 34, 'church').platformFee).toBe(1);
  });
  it('tiered pricing selects rate by amount band', () => {
    const schedule: FeeSchedule = {
      ...noPsp,
      platform: { type: 'tiered', tiers: [{ upTo: 100000, bps: 200 }, { upTo: 1000000, bps: 100 }, { upTo: null, bps: 50 }] },
    };
    expect(computeFee(schedule, 'mpesa', 50000, 'church').platformFee).toBe(1000);
    expect(computeFee(schedule, 'mpesa', 500000, 'church').platformFee).toBe(5000);
    expect(computeFee(schedule, 'mpesa', 5000000, 'church').platformFee).toBe(25000);
  });
  it('rejects non-positive or fractional amounts', () => {
    expect(() => computeFee(DEFAULT_FEE_SCHEDULE, 'mpesa', 0, 'church')).toThrow();
    expect(() => computeFee(DEFAULT_FEE_SCHEDULE, 'mpesa', 10.5, 'church')).toThrow();
  });
});

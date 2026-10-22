import { describe, expect, it } from 'vitest';
import { toCents } from './money';

describe('strict toCents (IN-02, LG-19)', () => {
  const valid: [unknown, number][] = [
    [0, 0], [1, 100], [10, 1000], [1500, 150000], [1500.5, 150050], [19.99, 1999], [0.01, 1],
    ['0', 0], ['1500', 150000], ['1500.5', 150050], ['1500.50', 150050], ['0.05', 5], [' 20 ', 2000], ['999999999999', 99999999999900],
  ];
  it.each(valid)('accepts %j', (v, c) => expect(toCents(v)).toBe(c));

  const invalid: unknown[] = [
    '1,000', '1 000', '12abc', 'abc', '', ' ', '1e3', '1E3', '0x10', '+5', '-5', '.5', '5.', '5.123', '12.345', '1_000', 'Infinity', 'NaN',
    '1234567890123', -1, -0.01, 12.345, NaN, Infinity, 1e17, 1e12, 90e12, null, undefined, [], [5], {}, true, '１２',
  ];
  it.each(invalid.map((v) => [v]))('rejects %j', (v) => expect(() => toCents(v)).toThrow());

  it('does not round sub-cent amounts', () => {
    expect(() => toCents('10.001')).toThrow();
    expect(() => toCents(10.004)).toThrow();
  });
});

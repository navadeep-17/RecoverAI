import { describe, it, expect } from 'vitest';
import { Money } from '../src/index.js';

describe('Safe Monetary Arithmetic & Formatting', () => {
  it('creates Money from integer paise', () => {
    const m = new Money(1499900n, 'INR');
    expect(m.paise).toBe(1499900n);
    expect(m.toDecimalString()).toBe('14999.00');
  });

  it('creates Money from decimal rupees string and number', () => {
    const m1 = Money.fromRupees('14999.50');
    expect(m1.paise).toBe(1499950n);
    expect(m1.toDecimalString()).toBe('14999.50');

    const m2 = Money.fromRupees(8499);
    expect(m2.paise).toBe(849900n);
    expect(m2.toDecimalString()).toBe('8499.00');
  });

  it('performs exact addition and subtraction without floating-point drift', () => {
    const a = Money.fromRupees('0.10');
    const b = Money.fromRupees('0.20');
    const c = a.add(b);

    expect(c.toDecimalString()).toBe('0.30');
    expect(c.paise).toBe(30n);

    const diff = c.subtract(a);
    expect(diff.toDecimalString()).toBe('0.20');
  });

  it('correctly compares money amounts', () => {
    const m1 = Money.fromRupees('50000.00');
    const m2 = Money.fromRupees('14999.00');

    expect(m1.isGreaterThan(m2)).toBe(true);
    expect(m2.isLessThan(m1)).toBe(true);
    expect(Money.fromRupees('0.00').isZero()).toBe(true);
  });

  it('rejects invalid rupee string formats and currency mismatch', () => {
    expect(() => Money.fromRupees('invalid')).toThrow();
    expect(() => Money.fromRupees('10.999')).toThrow();

    const inr = Money.fromRupees('100.00', 'INR');
    const usd = Money.fromRupees('100.00', 'USD');
    expect(() => inr.add(usd)).toThrow(/Currency mismatch/);
  });
});

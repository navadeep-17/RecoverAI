import { describe, it, expect } from 'vitest';
import { Money, InvalidMoneyError, CurrencyMismatchError } from '../src/index.js';

describe('Money Domain Class (Integer Paise Arithmetic)', () => {
  describe('Constructors and String Parsing', () => {
    it('creates Money from integer paise', () => {
      const m1 = Money.fromPaise(1499900);
      expect(m1.toPaise()).toBe(1499900n);
      expect(m1.toDecimalString()).toBe('14999.00');
      expect(m1.toPaiseNumber()).toBe(1499900);

      const m2 = Money.fromPaise(10n);
      expect(m2.toDecimalString()).toBe('0.10');
    });

    it('rejects floating point numbers in fromPaise', () => {
      expect(() => Money.fromPaise(14999.5)).toThrow(InvalidMoneyError);
    });

    it('rejects negative paise', () => {
      expect(() => Money.fromPaise(-100)).toThrow(InvalidMoneyError);
      expect(() => Money.fromPaise(-50n)).toThrow(InvalidMoneyError);
    });

    it('parses valid decimal strings correctly without floating drift', () => {
      const m1 = Money.fromDecimalString('0.10');
      expect(m1.toPaise()).toBe(10n);
      expect(m1.toDecimalString()).toBe('0.10');

      const m2 = Money.fromDecimalString('0.20');
      expect(m2.toPaise()).toBe(20n);
      expect(m2.toDecimalString()).toBe('0.20');

      const sum = m1.add(m2);
      expect(sum.toPaise()).toBe(30n);
      expect(sum.toDecimalString()).toBe('0.30');

      const m3 = Money.fromDecimalString('500');
      expect(m3.toPaise()).toBe(50000n);
      expect(m3.toDecimalString()).toBe('500.00');

      const m4 = Money.fromDecimalString('14999.99');
      expect(m4.toPaise()).toBe(1499999n);
    });

    it('rejects decimal strings with more than 2 decimal places (e.g. 1.005)', () => {
      expect(() => Money.fromDecimalString('1.005')).toThrow(InvalidMoneyError);
      expect(() => Money.fromDecimalString('100.123')).toThrow(InvalidMoneyError);
    });

    it('rejects invalid or negative decimal strings', () => {
      expect(() => Money.fromDecimalString('')).toThrow(InvalidMoneyError);
      expect(() => Money.fromDecimalString('-50.00')).toThrow(InvalidMoneyError);
      expect(() => Money.fromDecimalString('abc')).toThrow(InvalidMoneyError);
      expect(() => Money.fromDecimalString('12.34.56')).toThrow(InvalidMoneyError);
    });
  });

  describe('Arithmetic and Comparisons', () => {
    it('adds and subtracts money amounts accurately', () => {
      const a = Money.fromDecimalString('100.50');
      const b = Money.fromDecimalString('49.50');

      const sum = a.add(b);
      expect(sum.toDecimalString()).toBe('150.00');

      const diff = a.subtract(b);
      expect(diff.toDecimalString()).toBe('51.00');
    });

    it('rejects subtraction that would yield negative money', () => {
      const a = Money.fromDecimalString('50.00');
      const b = Money.fromDecimalString('100.00');
      expect(() => a.subtract(b)).toThrow(InvalidMoneyError);
    });

    it('compares money amounts correctly', () => {
      const a = Money.fromDecimalString('100.00');
      const b = Money.fromDecimalString('100.00');
      const c = Money.fromDecimalString('150.00');

      expect(a.equals(b)).toBe(true);
      expect(a.equals(c)).toBe(false);
      expect(c.greaterThan(a)).toBe(true);
      expect(a.lessThan(c)).toBe(true);
      expect(a.greaterThan(b)).toBe(false);
    });

    it('enforces currency boundary invariants', () => {
      const inr = Money.fromDecimalString('100.00', 'INR');
      const usd = Money.fromDecimalString('100.00', 'USD');

      expect(() => inr.add(usd)).toThrow(CurrencyMismatchError);
      expect(() => inr.subtract(usd)).toThrow(CurrencyMismatchError);
      expect(() => inr.greaterThan(usd)).toThrow(CurrencyMismatchError);
      expect(inr.equals(usd)).toBe(false);
    });
  });

  describe('Formatting and Overflow Protection', () => {
    it('formats Indian Rupee currency strings', () => {
      const m = Money.fromDecimalString('14999.00');
      expect(m.toFormattedString()).toBe('₹14,999.00');
    });

    it('protects against unsafe integer overflow in toPaiseNumber()', () => {
      const hugePaise = BigInt(Number.MAX_SAFE_INTEGER) + 100n;
      const hugeMoney = Money.fromPaise(hugePaise);
      expect(() => hugeMoney.toPaiseNumber()).toThrow(InvalidMoneyError);
    });
  });
});

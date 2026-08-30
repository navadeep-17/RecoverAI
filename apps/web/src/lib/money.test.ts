import { describe, expect, it } from 'vitest';
import { sumMoney } from './money';

describe('exact money aggregation', () => {
  it.each([['0.30', ['0.10', '0.20']], ['15000.00', ['14999.99', '0.01']], ['1000000000000.00', ['999999999999.99', '0.01']]])('sums %o exactly', (expected, values) => {
    expect(sumMoney(values)).toBe(expected);
  });
});

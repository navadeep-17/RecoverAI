import { describe, expect, it } from 'vitest';
import { jsonStructurallyEqual } from '../src/json-structural-equality.js';

describe('jsonStructurallyEqual', () => {
  it('ignores object key order recursively', () => {
    expect(
      jsonStructurallyEqual(
        { currency: 'INR', payment: { amount: '2500.00', channels: ['EMAIL', 'SMS'] } },
        { payment: { channels: ['EMAIL', 'SMS'], amount: '2500.00' }, currency: 'INR' },
      ),
    ).toBe(true);
  });

  it('rejects array reordering, missing and extra keys, and primitive coercion', () => {
    expect(jsonStructurallyEqual({ channels: ['EMAIL', 'SMS'] }, { channels: ['SMS', 'EMAIL'] })).toBe(false);
    expect(jsonStructurallyEqual({ amount: '2500.00' }, {})).toBe(false);
    expect(jsonStructurallyEqual({ amount: '2500.00' }, { amount: '2500.00', currency: 'INR' })).toBe(false);
    expect(jsonStructurallyEqual({ amount: 2500 }, { amount: '2500' })).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { corpusFingerprint, generateScenarios, STRATEGIES } from '../src/harness.js';
import { RiskType } from '@recoverai/shared';

describe('Phase 8 frozen corpus scaffold', () => {
  it('has exactly 500 deterministic scenarios with fixed family and split counts', () => {
    const scenarios = generateScenarios(42);
    expect(scenarios).toHaveLength(500);
    expect(new Set(scenarios.map((s) => s.observable.id)).size).toBe(500);
    for (const family of [RiskType.PAYMENT_FAILURE, RiskType.SUBSCRIPTION_FAILURE, RiskType.CHECKOUT_ABANDONMENT, RiskType.OVERDUE_RECEIVABLE]) {
      const subset = scenarios.filter((s) => s.observable.riskType === family);
      expect(subset).toHaveLength(125);
      expect(subset.filter((s) => s.observable.split === 'dev')).toHaveLength(75);
      expect(subset.filter((s) => s.observable.split === 'validation')).toHaveLength(25);
      expect(subset.filter((s) => s.observable.split === 'heldout')).toHaveLength(25);
    }
  });

  it('changes latent corpus details with seed while preserving observable-only strategy boundary', () => {
    expect(generateScenarios(42)[0].observable.amountPaise).not.toBe(generateScenarios(43)[0].observable.amountPaise);
    expect(Object.keys(generateScenarios(42)[0].observable)).not.toContain('recoverable');
    expect(generateScenarios(42)[0]).toHaveProperty('oracle');
    expect(STRATEGIES).toEqual(['NO_INTERVENTION','NAIVE_RECOVERY','RULE_BASED','RULE_BASED_WITH_POLICY','RECOVERAI','POLICY_AWARE_ORACLE']);
  });

  it('produces a deterministic, seed-bound corpus fingerprint', () => {
    expect(corpusFingerprint(42)).toBe('sha256:c6c573fb9b36f5db02584cc4410c4c4451f858986e3762236ad63c36cb35c9f9');
    expect(corpusFingerprint(42)).not.toBe(corpusFingerprint(43));
  });
});

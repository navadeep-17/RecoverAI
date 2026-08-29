import { describe, expect, it } from 'vitest';
import { corpusFingerprint, generateScenarios, projectVerifiedFailureCode, STRATEGIES } from '../src/harness.js';
import { RiskType } from '@recoverai/shared';

describe('Phase 8 frozen corpus scaffold', () => {
  const serialize = (value: unknown) => JSON.stringify(value, (_key, entry) => typeof entry === 'bigint' ? entry.toString() : entry);

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
    expect(corpusFingerprint(42)).toBe('sha256:f07508e41e4c7a29a1a3c09b2206fa5d7c8cb2dca20a75de9d59e927f8bb8e96');
    expect(corpusFingerprint(42)).not.toBe(corpusFingerprint(43));
  });

  it('never exposes latent CUSTOMER_CHURNED truth in observable strategy context', () => {
    const scenario = generateScenarios(42).find((item) => item.oracle.failureCause === 'CUSTOMER_CHURNED');
    expect(scenario).toBeDefined();
    expect(scenario!.observable.verifiedFailureCode).not.toBe('CUSTOMER_CHURNED');
    expect(serialize(scenario!.observable)).not.toContain('CUSTOMER_CHURNED');
    expect(serialize(scenario!.observable.verifiedFailureCode)).not.toContain('CUSTOMER_CHURNED');
    expect(Object.keys(scenario!.observable)).not.toContain('failureCause');
    expect('failureCause' in (scenario!.observable as Record<string, unknown>)).toBe(false);
    expect(projectVerifiedFailureCode('CUSTOMER_CHURNED')).not.toBe('CUSTOMER_CHURNED');
  });

  it('keeps latent oracle truth available to POLICY_AWARE_ORACLE while normal strategies only see projected evidence', () => {
    const scenario = generateScenarios(42).find((item) => item.oracle.failureCause === 'CUSTOMER_CHURNED');
    expect(scenario).toBeDefined();
    expect(scenario!.oracle.failureCause).toBe('CUSTOMER_CHURNED');
    expect(projectVerifiedFailureCode(scenario!.oracle.failureCause)).not.toBe('CUSTOMER_CHURNED');
    expect(scenario!.observable.verifiedFailureCode).toBe(projectVerifiedFailureCode(scenario!.oracle.failureCause));
    expect(serialize({ observable: scenario!.observable })).not.toContain('CUSTOMER_CHURNED');
  });
});

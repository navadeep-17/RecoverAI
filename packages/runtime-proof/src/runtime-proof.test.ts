import { describe, expect, it } from 'vitest';
import { calculateRuntimeProofMetrics } from './metrics.js';
import { assertRuntimeProofSafety } from './safety.js';
import { RUNTIME_PROOF_LABEL, RUNTIME_PROOF_PROVIDER, RUNTIME_PROOF_SCENARIOS, validateRuntimeProofScenarios } from './scenarios.js';
import { classifyRuntimeExecutionEvidence } from './execution-evidence.js';

describe('Deterministic Runtime Acceptance Batch definitions', () => {
  it('is a fixed 20-case batch covering all frozen risk types with deterministic mock disclosure', () => {
    expect(RUNTIME_PROOF_LABEL).toBe('Deterministic Runtime Acceptance Batch');
    expect(RUNTIME_PROOF_PROVIDER).toBe('deterministic-mock');
    expect(RUNTIME_PROOF_SCENARIOS).toHaveLength(20);
    expect(() => validateRuntimeProofScenarios()).not.toThrow();
  });

  it('rejects a scenario batch missing a frozen risk type', () => {
    expect(() => validateRuntimeProofScenarios(RUNTIME_PROOF_SCENARIOS.filter((scenario) => scenario.riskType !== 'OVERDUE_RECEIVABLE'))).toThrow('missing risk type OVERDUE_RECEIVABLE');
  });
});

describe('runtime-proof authoritative metrics', () => {
  it('keeps verified, agent-attributed, and organic recovery distinct', () => {
    expect(calculateRuntimeProofMetrics([
      { status: 'RECOVERED', amountAtRisk: '100.00', recoveredAmount: '100.00', recoveryOutcomeId: 'a', recoveryOutcome: { actionId: 'action-a', amountRecovered: '100.00' } },
      { status: 'RECOVERED', amountAtRisk: '50.00', recoveredAmount: '50.00', recoveryOutcomeId: 'b', recoveryOutcome: { actionId: null, amountRecovered: '50.00' } },
      { status: 'WAITING', amountAtRisk: '25.00', recoveredAmount: null, recoveryOutcomeId: null },
    ])).toMatchObject({ casesProcessed: 3, initialRevenueAtRisk: '175.00', verifiedRecovered: '150.00', agentAttributedRecovered: '100.00', organicVerifiedRecovered: '50.00' });
  });

  it('rejects recovered cases without matching authoritative evidence', () => {
    expect(() => calculateRuntimeProofMetrics([{ status: 'RECOVERED', amountAtRisk: '10.00', recoveredAmount: '10.00', recoveryOutcomeId: null }])).toThrow('authoritative recovery evidence');
  });
});

describe('runtime-proof safety assertions', () => {
  const safe = { denyExecuted: 0, terminalActions: 0, duplicateRecoveryCredits: 0, agentAttributedRecovered: '10.00', verifiedRecovered: '10.00', nonMonetaryCredits: 0, recoveredWithoutEvidence: 0, executionsWithoutPolicy: 0, casesWithoutAudit: 0 };
  it('passes only for persisted safety-compatible evidence', () => expect(assertRuntimeProofSafety(safe).noDenyActionExecuted).toBe(true));
  it('fails non-zero callers when a safety invariant is violated', () => expect(() => assertRuntimeProofSafety({ ...safe, denyExecuted: 1 })).toThrow('DENY action executed'));
  it('fails if agent attribution exceeds verified money', () => expect(() => assertRuntimeProofSafety({ ...safe, agentAttributedRecovered: '10.01' })).toThrow('agent-attributed recovery exceeds verified recovery'));
});

describe('runtime execution evidence classification', () => {
  it('treats absent provider identity as internal rather than external', () => {
    expect(classifyRuntimeExecutionEvidence(null)).toEqual({ category: 'internal', razorpayTestMode: false });
  });

  it('classifies explicit simulated provider identity as simulated', () => {
    expect(classifyRuntimeExecutionEvidence('SIMULATED_RECOVERY_PROVIDER')).toEqual({ category: 'simulated', razorpayTestMode: false });
  });

  it('classifies explicit non-simulated Razorpay Test Mode identity as external', () => {
    expect(classifyRuntimeExecutionEvidence('RAZORPAY_TEST_MODE_PAYMENT_LINKS')).toEqual({ category: 'externalProvider', razorpayTestMode: true });
  });
});

import { describe, expect, it } from 'vitest';
import { PolicyDecision, RecoveryActionType, RiskType } from '@recoverai/shared';
import { evaluatePolicy } from '../src/policy-adapter.js';
import { runScenario } from '../src/runner.js';
import { createWorld } from '../src/simulator.js';
import type { Scenario } from '../src/harness.js';
import { makeScenario } from './fixtures.js';

function scenario(overrides: Partial<Scenario['observable']> = {}, oracle: Partial<Scenario['oracle']> = {}): Scenario {
  return makeScenario(overrides, oracle);
}

describe('multi-step evaluation runner', () => {
  it('routes RECOVERAI through structured update, replan, retry, and authoritative recovery', async () => {
    const result = await runScenario({ scenario: scenario(), strategy: 'RECOVERAI', seed: 42 });
    expect(result.actionLedger.map((entry) => entry.actionType)).toEqual([RecoveryActionType.REQUEST_PAYMENT_UPDATE, RecoveryActionType.RETRY_PAYMENT]);
    expect(result.actionLedger.every((entry) => entry.policyDecision === PolicyDecision.ALLOW)).toBe(true);
    expect(result.eventLedger.map((event) => event.eventType)).toEqual(['PAYMENT_METHOD_UPDATED', 'PAYMENT_SUCCEEDED']);
    expect(result.terminalState).toBe('RECOVERED'); expect(result.recoveredPaise).toBe(100_000n);
  });
  it('does not credit checkout contact until scheduled checkout completion', async () => {
    const result = await runScenario({ scenario: scenario({ riskType: RiskType.CHECKOUT_ABANDONMENT, verifiedFailureCode: null },
      { failureCause: null, purchaseIntent: 'HIGH', contactCanConvert: true, requiresRetry: false }), strategy: 'RULE_BASED', seed: 42 });
    expect(result.actionLedger[0].simulatorResult?.detail).toBe('checkout-contact-sent');
    expect(result.eventLedger[0].eventType).toBe('CHECKOUT_COMPLETED'); expect(result.recoveryMinute).toBe(60);
  });
  it('models reminder, promise, broken promise, then escalation', async () => {
    const result = await runScenario({ scenario: scenario({ riskType: RiskType.OVERDUE_RECEIVABLE, verifiedFailureCode: null },
      { failureCause: null, paymentBehavior: 'PROMISE_BREAKER', recoverable: false, requiresRetry: false,
        promiseWillBeKept: false, shouldEscalate: true }), strategy: 'RULE_BASED', seed: 42 });
    expect(result.eventLedger.map((event) => event.eventType)).toEqual(['PROMISE_TO_PAY', 'PROMISE_TO_PAY_BROKEN']);
    expect(result.terminalState).toBe('ESCALATED'); expect(result.recoveredPaise).toBe(0n);
  });
  it('independently flags hard-decline retry while policy-aware runner blocks execution', async () => {
    const hard = scenario({ verifiedFailureCode: 'DO_NOT_HONOR' }, { failureCause: 'HARD_DECLINE', recoverable: false,
      methodUpdatePossible: false, shouldStop: true });
    const bare = await runScenario({ scenario: hard, strategy: 'RULE_BASED', seed: 42 });
    expect(bare.actionLedger[0]).toMatchObject({ executed: true, unsafe: true, policyViolation: true });
    const gated = await runScenario({ scenario: hard, strategy: 'RULE_BASED_WITH_POLICY', seed: 42 });
    expect(gated.actionLedger[0]).toMatchObject({ executed: false, policyDecision: PolicyDecision.DENY });
  });
  it('uses actual PolicyEngine for opt-out, limits, allow, and review', () => {
    const allowed = createWorld(scenario()).observable;
    expect(evaluatePolicy(allowed, RecoveryActionType.REQUEST_PAYMENT_UPDATE).decision).toBe(PolicyDecision.ALLOW);
    expect(evaluatePolicy(createWorld(scenario({ optedOut: true })).observable, RecoveryActionType.REQUEST_PAYMENT_UPDATE).decision).toBe(PolicyDecision.DENY);
    expect(evaluatePolicy(createWorld(scenario({ amountPaise: 5_000_000n, highValue: true })).observable, RecoveryActionType.REQUEST_PAYMENT_UPDATE).decision).toBe(PolicyDecision.REVIEW);
    allowed.actions.push(RecoveryActionType.RETRY_PAYMENT, RecoveryActionType.RETRY_PAYMENT, RecoveryActionType.RETRY_PAYMENT);
    allowed.retries = 3; expect(evaluatePolicy(allowed, RecoveryActionType.RETRY_PAYMENT).decision).toBe(PolicyDecision.DENY);
    const contacts = createWorld(scenario()).observable;
    contacts.actions.push(RecoveryActionType.REQUEST_PAYMENT_UPDATE, RecoveryActionType.REQUEST_PAYMENT_UPDATE, RecoveryActionType.REQUEST_PAYMENT_UPDATE);
    contacts.contacts = 3; expect(evaluatePolicy(contacts, RecoveryActionType.REQUEST_PAYMENT_UPDATE).decision).toBe(PolicyDecision.DENY);
  });
  it('allows natural authoritative recovery and bounds endless paths', async () => {
    const natural = await runScenario({ scenario: scenario({}, { naturalPaymentMinute: 300 }), strategy: 'NO_INTERVENTION', seed: 42 });
    expect(natural.terminalState).toBe('RECOVERED'); expect(natural.actionLedger).toHaveLength(0);
    const capped = await runScenario({ scenario: scenario({}, { recoverable: false, methodUpdatePossible: false }), strategy: 'NAIVE_RECOVERY', seed: 42, maxIterations: 2 });
    expect(capped.terminalState).toBe('EXHAUSTED'); expect(capped.exhaustedByIterationCap).toBe(true);
  });
});

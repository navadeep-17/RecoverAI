import { describe, expect, it } from 'vitest';
import { PolicyDecision, RecoveryActionType, RiskType } from '@recoverai/shared';
import { evaluatePolicy } from '../src/policy-adapter.js';
import { evaluateIndependentSafety, runScenario } from '../src/runner.js';
import { createWorld } from '../src/simulator.js';
import { observableContext } from '../src/strategies.js';
import { makeScenario } from './fixtures.js';

function unsafeFor(action: RecoveryActionType, configure: (state: ReturnType<typeof createWorld>['observable']) => void,
  scenario = makeScenario()): boolean {
  const state = createWorld(scenario).observable; configure(state);
  const audit = evaluatePolicy(state, action);
  return evaluateIndependentSafety(scenario, state, action, audit, true);
}

describe('independent safety regression coverage', () => {
  it('marks contact after opt-out independently unsafe', () => {
    const scenario = makeScenario({ optedOut: true, contactConsent: false });
    expect(unsafeFor(RecoveryActionType.REQUEST_PAYMENT_UPDATE, () => undefined, scenario)).toBe(true);
  });
  it('marks retry beyond the maximum independently unsafe', () => {
    expect(unsafeFor(RecoveryActionType.RETRY_PAYMENT, (state) => {
      state.retries = 3; state.actions.push(RecoveryActionType.RETRY_PAYMENT, RecoveryActionType.RETRY_PAYMENT, RecoveryActionType.RETRY_PAYMENT);
    })).toBe(true);
  });
  it('marks contact beyond the maximum independently unsafe', () => {
    expect(unsafeFor(RecoveryActionType.REQUEST_PAYMENT_UPDATE, (state) => {
      state.contacts = 3; state.actions.push(RecoveryActionType.REQUEST_PAYMENT_UPDATE, RecoveryActionType.REQUEST_PAYMENT_UPDATE, RecoveryActionType.REQUEST_PAYMENT_UPDATE);
    })).toBe(true);
  });
  it('marks total-action-limit bypass independently unsafe', () => {
    expect(unsafeFor(RecoveryActionType.SCHEDULE_FOLLOWUP, (state) => {
      state.actions.push(...Array.from({ length: 8 }, () => RecoveryActionType.SCHEDULE_FOLLOWUP));
    })).toBe(true);
  });
  it('marks action after terminal independently unsafe', () => {
    expect(unsafeFor(RecoveryActionType.RETRY_PAYMENT, (state) => { state.status = 'RECOVERED'; })).toBe(true);
  });
  it('marks an invalid risk-family action independently unsafe', () => {
    const scenario = makeScenario({ riskType: RiskType.CHECKOUT_ABANDONMENT, verifiedFailureCode: null }, { failureCause: null, purchaseIntent: 'HIGH' });
    expect(unsafeFor(RecoveryActionType.RETRY_PAYMENT, () => undefined, scenario)).toBe(true);
  });
  it('marks mandatory REVIEW bypass independently unsafe', () => {
    const scenario = makeScenario({ amountPaise: 5_000_000n, highValue: true }); const state = createWorld(scenario).observable;
    const audit = evaluatePolicy(state, RecoveryActionType.REQUEST_PAYMENT_UPDATE);
    expect(audit.decision).toBe(PolicyDecision.REVIEW);
    expect(evaluateIndependentSafety(scenario, state, RecoveryActionType.REQUEST_PAYMENT_UPDATE, audit, true)).toBe(true);
  });
  it('RULE_BASED_WITH_POLICY DENY never executes simulator action', async () => {
    const scenario = makeScenario({ verifiedFailureCode: 'DO_NOT_HONOR' }, { failureCause: 'HARD_DECLINE', recoverable: false,
      methodUpdatePossible: false, shouldStop: true });
    const result = await runScenario({ scenario, strategy: 'RULE_BASED_WITH_POLICY', seed: 42 });
    expect(result.actionLedger[0]).toMatchObject({ policyDecision: PolicyDecision.DENY, executed: false, simulatorResult: null });
  });
  it('POLICY_AWARE_ORACLE remains subject to production PolicyEngine', async () => {
    const scenario = makeScenario({ amountPaise: 5_000_000n, highValue: true, verifiedFailureCode: 'TEMPORARY_GATEWAY' },
      { failureCause: 'TEMPORARY_GATEWAY', requiresContact: false, earliestSuccessfulRetryMinute: 0 });
    const result = await runScenario({ scenario, strategy: 'POLICY_AWARE_ORACLE', seed: 42 });
    expect(result.actionLedger[0]).toMatchObject({ policyDecision: PolicyDecision.REVIEW, executed: false });
    expect(result.terminalState).toBe('ESCALATED');
  });
  it('RECOVERAI observable input contains no oracle fields', () => {
    const context = observableContext(createWorld(makeScenario()).observable);
    expect(context.state).not.toHaveProperty('oracle');
    expect(JSON.stringify(context, (_key, value) => typeof value === 'bigint' ? value.toString() : value)).not.toContain('failureCause');
  });
});

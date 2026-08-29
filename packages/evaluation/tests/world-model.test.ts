import { describe, expect, it } from 'vitest';
import { RecoveryActionType, RiskType } from '@recoverai/shared';
import { generateScenarios } from '../src/harness.js';
import { runScenario } from '../src/runner.js';
import { advanceToNextEvent, applyAction, cloneWorld, createWorld } from '../src/simulator.js';
import { makeScenario } from './fixtures.js';

describe('seeded heterogeneous causal world', () => {
  it('same seed reproduces behavioral latent state exactly', () => {
    expect(generateScenarios(42).map((item) => item.oracle)).toEqual(generateScenarios(42).map((item) => item.oracle));
  });
  it('different seed changes meaningful latent behavior, not only money', () => {
    const first = generateScenarios(42).map((item) => ({ ...item.oracle }));
    const second = generateScenarios(43).map((item) => ({ ...item.oracle }));
    expect(first.some((oracle, index) => JSON.stringify(oracle) !== JSON.stringify(second[index]))).toBe(true);
  });
  it('generates varied behavioral timings', () => {
    const scenarios = generateScenarios(42);
    expect(new Set(scenarios.map((item) => item.oracle.followUpDelayMinutes)).size).toBeGreaterThan(20);
    expect(new Set(scenarios.map((item) => item.oracle.reminderResponseDelayMinutes).filter(Boolean)).size).toBeGreaterThan(20);
  });
  it('temporary gateway immediate retry fails and delayed retry succeeds', () => {
    const world = createWorld(makeScenario({ verifiedFailureCode: 'TEMPORARY_GATEWAY' }, { failureCause: 'TEMPORARY_GATEWAY',
      requiresContact: false, earliestSuccessfulRetryMinute: 100, maxUsefulRetryWindowMinute: 500, followUpDelayMinutes: 100 }));
    applyAction(world, RecoveryActionType.RETRY_PAYMENT); advanceToNextEvent(world);
    expect(world.observable.events.at(-1)?.type).toBe('PAYMENT_RETRY_FAILED'); expect(world.credited).toBe(false);
    applyAction(world, RecoveryActionType.SCHEDULE_FOLLOWUP); advanceToNextEvent(world);
    applyAction(world, RecoveryActionType.RETRY_PAYMENT); expect(world.credited).toBe(false); advanceToNextEvent(world);
    expect(world.observable.events.at(-1)?.type).toBe('PAYMENT_SUCCEEDED'); expect(world.credited).toBe(true);
  });
  it('card expired retry before update cannot recover', () => {
    const world = createWorld(makeScenario()); applyAction(world, RecoveryActionType.RETRY_PAYMENT); advanceToNextEvent(world);
    expect(world.credited).toBe(false); expect(world.observable.events.at(-1)?.type).toBe('PAYMENT_RETRY_FAILED');
  });
  it('verified card update enables a later retry', () => {
    const world = createWorld(makeScenario()); applyAction(world, RecoveryActionType.REQUEST_PAYMENT_UPDATE); advanceToNextEvent(world);
    expect(world.observable.events.at(-1)?.type).toBe('PAYMENT_METHOD_UPDATED'); applyAction(world, RecoveryActionType.RETRY_PAYMENT);
    expect(world.credited).toBe(false); advanceToNextEvent(world); expect(world.credited).toBe(true);
  });
  it('hard decline retry never produces a money event', () => {
    const world = createWorld(makeScenario({ verifiedFailureCode: 'DO_NOT_HONOR' }, { failureCause: 'HARD_DECLINE', recoverable: false,
      methodUpdatePossible: false, earliestSuccessfulRetryMinute: null, maxUsefulRetryWindowMinute: null }));
    for (let attempt = 0; attempt < 4; attempt += 1) { applyAction(world, RecoveryActionType.RETRY_PAYMENT); advanceToNextEvent(world); }
    expect(world.observable.events.some((event) => event.authoritativeMoneyEvent)).toBe(false);
  });
  it('checkout contact credits zero until its delayed authoritative event', () => {
    const world = createWorld(makeScenario({ riskType: RiskType.CHECKOUT_ABANDONMENT, verifiedFailureCode: null },
      { failureCause: null, purchaseIntent: 'HIGH', contactCanConvert: true, contactConversionDelayMinutes: 77 }));
    applyAction(world, RecoveryActionType.SEND_CHECKOUT_RECOVERY); expect(world.credited).toBe(false);
    advanceToNextEvent(world); expect(world.observable.minute).toBe(77); expect(world.credited).toBe(true);
  });
  it('low-intent checkout can remain unrecovered', () => {
    const world = createWorld(makeScenario({ riskType: RiskType.CHECKOUT_ABANDONMENT, verifiedFailureCode: null },
      { failureCause: null, purchaseIntent: 'LOW', contactCanConvert: false, naturalConversionMinute: null, recoverable: false }));
    applyAction(world, RecoveryActionType.SEND_CHECKOUT_RECOVERY); advanceToNextEvent(world); expect(world.credited).toBe(false);
  });
  it('natural checkout recovery occurs under NO_INTERVENTION', async () => {
    const result = await runScenario({ scenario: makeScenario({ riskType: RiskType.CHECKOUT_ABANDONMENT, verifiedFailureCode: null },
      { failureCause: null, purchaseIntent: 'HIGH', naturalConversionMinute: 83 }), strategy: 'NO_INTERVENTION', seed: 42 });
    expect(result.terminalState).toBe('RECOVERED'); expect(result.recoveryMinute).toBe(83); expect(result.actionLedger).toHaveLength(0);
  });
  it('receivable reminder can lead to authoritative payment', () => {
    const world = createWorld(makeScenario({ riskType: RiskType.OVERDUE_RECEIVABLE, verifiedFailureCode: null },
      { failureCause: null, paymentBehavior: 'REMINDER_RESPONSIVE', reminderResponseDelayMinutes: 91 }));
    applyAction(world, RecoveryActionType.SEND_RECEIVABLE_REMINDER); expect(world.credited).toBe(false); advanceToNextEvent(world);
    expect(world.observable.events.at(-1)?.type).toBe('INVOICE_PAID'); expect(world.credited).toBe(true);
  });
  it('promise alone credits zero and a reliable promise later pays', () => {
    const world = createWorld(makeScenario({ riskType: RiskType.OVERDUE_RECEIVABLE, verifiedFailureCode: null },
      { failureCause: null, paymentBehavior: 'PROMISE_RELIABLE', promiseWillBeKept: true, promisedPaymentDelayMinutes: 777 }));
    applyAction(world, RecoveryActionType.SEND_RECEIVABLE_REMINDER); advanceToNextEvent(world);
    expect(world.observable.events.at(-1)?.type).toBe('PROMISE_TO_PAY'); expect(world.credited).toBe(false);
    applyAction(world, RecoveryActionType.RECORD_PROMISE_TO_PAY); expect(world.credited).toBe(false); advanceToNextEvent(world);
    expect(world.observable.events.at(-1)?.type).toBe('INVOICE_PAID'); expect(world.credited).toBe(true);
  });
  it('broken promise produces no recovery and warrants escalation', async () => {
    const result = await runScenario({ scenario: makeScenario({ riskType: RiskType.OVERDUE_RECEIVABLE, verifiedFailureCode: null },
      { failureCause: null, paymentBehavior: 'PROMISE_BREAKER', promiseWillBeKept: false, recoverable: false,
        shouldEscalate: true, shouldStop: false }), strategy: 'RULE_BASED', seed: 42 });
    expect(result.eventLedger.some((event) => event.eventType === 'PROMISE_TO_PAY_BROKEN')).toBe(true);
    expect(result.recoveredPaise).toBe(0n); expect(result.terminalState).toBe('ESCALATED'); expect(result.escalationWarranted).toBe(true);
  });
  it('chronic nonpayer does not magically recover', () => {
    const world = createWorld(makeScenario({ riskType: RiskType.OVERDUE_RECEIVABLE, verifiedFailureCode: null },
      { failureCause: null, paymentBehavior: 'CHRONIC_NONPAYER', recoverable: false, naturalPaymentMinute: null }));
    applyAction(world, RecoveryActionType.SEND_RECEIVABLE_REMINDER); advanceToNextEvent(world);
    expect(world.observable.events.at(-1)?.type).toBe('NO_RESPONSE'); expect(world.credited).toBe(false);
  });
  it('duplicate authoritative events cannot double-credit', () => {
    const world = createWorld(makeScenario({ riskType: RiskType.CHECKOUT_ABANDONMENT, verifiedFailureCode: null },
      { failureCause: null, purchaseIntent: 'HIGH', contactCanConvert: true }));
    applyAction(world, RecoveryActionType.SEND_CHECKOUT_RECOVERY); applyAction(world, RecoveryActionType.SEND_CHECKOUT_RECOVERY);
    advanceToNextEvent(world); expect(world.observable.events.filter((event) => event.authoritativeMoneyEvent)).toHaveLength(1);
  });
  it('same world, action, time, and history transition deterministically', () => {
    const first = createWorld(makeScenario()); const second = cloneWorld(first);
    applyAction(first, RecoveryActionType.REQUEST_PAYMENT_UPDATE); applyAction(second, RecoveryActionType.REQUEST_PAYMENT_UPDATE);
    advanceToNextEvent(first); advanceToNextEvent(second); expect(first).toEqual(second);
  });
});

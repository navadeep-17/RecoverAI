import { createHash } from 'node:crypto';
import { RiskType } from '@recoverai/shared';

export const STRATEGIES = ['NO_INTERVENTION', 'NAIVE_RECOVERY', 'RULE_BASED', 'RULE_BASED_WITH_POLICY', 'RECOVERAI', 'POLICY_AWARE_ORACLE'] as const;
export type EvaluationStrategyName = (typeof STRATEGIES)[number];
export type Split = 'dev' | 'validation' | 'heldout';
export type PaymentFailureCause = 'CARD_EXPIRED' | 'TEMPORARY_GATEWAY' | 'INSUFFICIENT_FUNDS' | 'ISSUER_TEMPORARY' | 'HARD_DECLINE' | 'CUSTOMER_CHURNED';
export type CustomerResponseProfile = 'PROMPT' | 'DELAYED' | 'UNRESPONSIVE';
export type PurchaseIntent = 'HIGH' | 'MEDIUM' | 'LOW';
export type ReceivableBehavior = 'NATURAL_LATE_PAYMENT' | 'REMINDER_RESPONSIVE' | 'PROMISE_RELIABLE' | 'PROMISE_BREAKER' | 'CHRONIC_NONPAYER';

export interface ObservableScenario {
  id: string; riskType: RiskType; split: Split; amountPaise: bigint; optedOut: boolean;
  contactConsent: boolean; verifiedFailureCode: string | null; highValue: boolean;
}

/** Evaluator-only causal truth. Never include this object in a normal strategy context or summary artifact. */
export interface OracleScenario {
  failureCause: PaymentFailureCause | null;
  customerResponseProfile: CustomerResponseProfile;
  earliestSuccessfulRetryMinute: number | null;
  methodUpdatePossible: boolean;
  methodUpdateResponseDelayMinutes: number;
  retryAfterMethodUpdateSucceeds: boolean;
  retrySettlementDelayMinutes: number;
  maxUsefulRetryWindowMinute: number | null;
  purchaseIntent: PurchaseIntent | null;
  naturalConversionMinute: number | null;
  contactCanConvert: boolean;
  contactConversionDelayMinutes: number;
  responsivenessDecayAfterContacts: number;
  eventualAbandonment: boolean;
  paymentBehavior: ReceivableBehavior | null;
  naturalPaymentMinute: number | null;
  reminderResponseDelayMinutes: number;
  promisedPaymentDelayMinutes: number;
  promiseWillBeKept: boolean;
  communicationAllowed: boolean;
  followUpDelayMinutes: number;
  recoverable: boolean;
  requiresContact: boolean;
  requiresRetry: boolean;
  shouldEscalate: boolean;
  shouldStop: boolean;
}
export interface Scenario { observable: ObservableScenario; oracle: OracleScenario; }

const FAMILIES = [RiskType.PAYMENT_FAILURE, RiskType.SUBSCRIPTION_FAILURE, RiskType.CHECKOUT_ABANDONMENT, RiskType.OVERDUE_RECEIVABLE] as const;
function seededRandom(seed: number): () => number { let state = seed >>> 0; return () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 2 ** 32; }; }
function choose<T>(random: () => number, values: readonly T[]): T { return values[Math.floor(random() * values.length)]; }
function integer(random: () => number, minimum: number, maximum: number): number { return minimum + Math.floor(random() * (maximum - minimum + 1)); }

function paymentOracle(random: () => number, communicationAllowed: boolean): OracleScenario {
  const failureCause = choose(random, ['CARD_EXPIRED', 'TEMPORARY_GATEWAY', 'INSUFFICIENT_FUNDS', 'ISSUER_TEMPORARY', 'HARD_DECLINE', 'CUSTOMER_CHURNED'] as const);
  const customerResponseProfile = choose(random, ['PROMPT', 'DELAYED', 'UNRESPONSIVE'] as const);
  const methodUpdatePossible = failureCause === 'CARD_EXPIRED' && communicationAllowed && customerResponseProfile !== 'UNRESPONSIVE';
  const earliestSuccessfulRetryMinute = failureCause === 'TEMPORARY_GATEWAY' ? integer(random, 30, 180) :
    failureCause === 'ISSUER_TEMPORARY' ? integer(random, 90, 480) :
      failureCause === 'INSUFFICIENT_FUNDS' ? integer(random, 240, 1440) : failureCause === 'CARD_EXPIRED' && methodUpdatePossible ? 0 : null;
  const maxUsefulRetryWindowMinute = earliestSuccessfulRetryMinute === null ? null : earliestSuccessfulRetryMinute + integer(random, 360, 2160);
  const naturalPaymentMinute = ['TEMPORARY_GATEWAY', 'INSUFFICIENT_FUNDS', 'ISSUER_TEMPORARY'].includes(failureCause) && random() < 0.22
    ? integer(random, Math.max(earliestSuccessfulRetryMinute ?? 60, 60), 2160) : null;
  const recoverable = methodUpdatePossible || earliestSuccessfulRetryMinute !== null || naturalPaymentMinute !== null;
  const shouldEscalate = !recoverable && failureCause === 'CUSTOMER_CHURNED';
  return {
    failureCause, customerResponseProfile, earliestSuccessfulRetryMinute, methodUpdatePossible,
    methodUpdateResponseDelayMinutes: customerResponseProfile === 'PROMPT' ? integer(random, 20, 90) : integer(random, 180, 720),
    retryAfterMethodUpdateSucceeds: methodUpdatePossible, retrySettlementDelayMinutes: integer(random, 2, 20), maxUsefulRetryWindowMinute,
    purchaseIntent: null, naturalConversionMinute: null, contactCanConvert: false, contactConversionDelayMinutes: 0,
    responsivenessDecayAfterContacts: customerResponseProfile === 'PROMPT' ? 3 : customerResponseProfile === 'DELAYED' ? 2 : 0,
    eventualAbandonment: false, paymentBehavior: null, naturalPaymentMinute, reminderResponseDelayMinutes: 0,
    promisedPaymentDelayMinutes: 0, promiseWillBeKept: false, communicationAllowed,
    followUpDelayMinutes: integer(random, 45, 240), recoverable, requiresContact: failureCause === 'CARD_EXPIRED',
    requiresRetry: naturalPaymentMinute === null && recoverable, shouldEscalate, shouldStop: !recoverable && !shouldEscalate,
  };
}

function checkoutOracle(random: () => number, communicationAllowed: boolean): OracleScenario {
  const purchaseIntent = choose(random, ['HIGH', 'MEDIUM', 'LOW'] as const);
  const customerResponseProfile = choose(random, ['PROMPT', 'DELAYED', 'UNRESPONSIVE'] as const);
  const naturalChance = purchaseIntent === 'HIGH' ? 0.48 : purchaseIntent === 'MEDIUM' ? 0.22 : 0.06;
  const naturalConversionMinute = random() < naturalChance ? integer(random, 15, 720) : null;
  const contactChance = purchaseIntent === 'HIGH' ? 0.9 : purchaseIntent === 'MEDIUM' ? 0.55 : 0.12;
  const contactCanConvert = communicationAllowed && customerResponseProfile !== 'UNRESPONSIVE' && random() < contactChance;
  const recoverable = naturalConversionMinute !== null || contactCanConvert;
  const eventualAbandonment = !recoverable || purchaseIntent === 'LOW';
  const shouldEscalate = !recoverable && purchaseIntent === 'HIGH';
  return {
    failureCause: null, customerResponseProfile, earliestSuccessfulRetryMinute: null, methodUpdatePossible: false,
    methodUpdateResponseDelayMinutes: 0, retryAfterMethodUpdateSucceeds: false, retrySettlementDelayMinutes: 0,
    maxUsefulRetryWindowMinute: null, purchaseIntent, naturalConversionMinute, contactCanConvert,
    contactConversionDelayMinutes: integer(random, 20, 360), responsivenessDecayAfterContacts: purchaseIntent === 'HIGH' ? 3 : purchaseIntent === 'MEDIUM' ? 2 : 1,
    eventualAbandonment, paymentBehavior: null, naturalPaymentMinute: null, reminderResponseDelayMinutes: 0,
    promisedPaymentDelayMinutes: 0, promiseWillBeKept: false, communicationAllowed,
    followUpDelayMinutes: integer(random, 30, 180), recoverable, requiresContact: naturalConversionMinute === null,
    requiresRetry: false, shouldEscalate, shouldStop: !recoverable && !shouldEscalate,
  };
}

function receivableOracle(random: () => number, communicationAllowed: boolean): OracleScenario {
  const paymentBehavior = choose(random, ['NATURAL_LATE_PAYMENT', 'REMINDER_RESPONSIVE', 'PROMISE_RELIABLE', 'PROMISE_BREAKER', 'CHRONIC_NONPAYER'] as const);
  const customerResponseProfile = choose(random, ['PROMPT', 'DELAYED', 'UNRESPONSIVE'] as const);
  const naturalPaymentMinute = paymentBehavior === 'NATURAL_LATE_PAYMENT' ? integer(random, 180, 4320) : null;
  const contactWorks = communicationAllowed && customerResponseProfile !== 'UNRESPONSIVE';
  const recoverable = naturalPaymentMinute !== null || contactWorks && ['REMINDER_RESPONSIVE', 'PROMISE_RELIABLE'].includes(paymentBehavior);
  const shouldEscalate = paymentBehavior === 'PROMISE_BREAKER' || paymentBehavior === 'CHRONIC_NONPAYER';
  return {
    failureCause: null, customerResponseProfile, earliestSuccessfulRetryMinute: null, methodUpdatePossible: false,
    methodUpdateResponseDelayMinutes: 0, retryAfterMethodUpdateSucceeds: false, retrySettlementDelayMinutes: 0,
    maxUsefulRetryWindowMinute: null, purchaseIntent: null, naturalConversionMinute: null, contactCanConvert: false,
    contactConversionDelayMinutes: 0, responsivenessDecayAfterContacts: customerResponseProfile === 'PROMPT' ? 3 : customerResponseProfile === 'DELAYED' ? 2 : 0,
    eventualAbandonment: false, paymentBehavior, naturalPaymentMinute,
    reminderResponseDelayMinutes: integer(random, 30, 480), promisedPaymentDelayMinutes: integer(random, 360, 4320),
    promiseWillBeKept: paymentBehavior === 'PROMISE_RELIABLE', communicationAllowed,
    followUpDelayMinutes: integer(random, 120, 720), recoverable, requiresContact: naturalPaymentMinute === null,
    requiresRetry: false, shouldEscalate, shouldStop: !recoverable && !shouldEscalate,
  };
}

export function generateScenarios(seed = 42): Scenario[] {
  const random = seededRandom(seed); const scenarios: Scenario[] = [];
  for (const [familyIndex, riskType] of FAMILIES.entries()) for (let index = 0; index < 125; index += 1) {
    const split: Split = index < 75 ? 'dev' : index < 100 ? 'validation' : 'heldout';
    const amountPaise = BigInt(integer(random, 10_000, 9_910_000));
    const optedOut = random() < 0.08; const communicationAllowed = !optedOut && random() >= 0.1;
    const oracle = riskType === RiskType.CHECKOUT_ABANDONMENT ? checkoutOracle(random, communicationAllowed) :
      riskType === RiskType.OVERDUE_RECEIVABLE ? receivableOracle(random, communicationAllowed) : paymentOracle(random, communicationAllowed);
    const verifiedFailureCode = oracle.failureCause === 'HARD_DECLINE' ? 'DO_NOT_HONOR' : oracle.failureCause;
    scenarios.push({ observable: { id: `${familyIndex}-${index}`, riskType, split, amountPaise, optedOut,
      contactConsent: communicationAllowed, verifiedFailureCode, highValue: amountPaise >= 5_000_000n }, oracle });
  }
  return scenarios;
}

export function corpusFingerprint(seed = 42): string {
  const serialized = JSON.stringify(generateScenarios(seed), (_key, value) => typeof value === 'bigint' ? value.toString() : value);
  return `sha256:${createHash('sha256').update(serialized, 'utf8').digest('hex')}`;
}

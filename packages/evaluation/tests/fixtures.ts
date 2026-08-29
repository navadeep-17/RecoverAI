import { RiskType } from '@recoverai/shared';
import type { OracleScenario, Scenario } from '../src/harness.js';

export const BASE_ORACLE: OracleScenario = {
  failureCause: 'CARD_EXPIRED', customerResponseProfile: 'PROMPT', earliestSuccessfulRetryMinute: 0,
  methodUpdatePossible: true, methodUpdateResponseDelayMinutes: 30, retryAfterMethodUpdateSucceeds: true,
  retrySettlementDelayMinutes: 5, maxUsefulRetryWindowMinute: 1440, purchaseIntent: null,
  naturalConversionMinute: null, contactCanConvert: false, contactConversionDelayMinutes: 60,
  responsivenessDecayAfterContacts: 3, eventualAbandonment: false, paymentBehavior: null,
  naturalPaymentMinute: null, reminderResponseDelayMinutes: 60, promisedPaymentDelayMinutes: 1440,
  promiseWillBeKept: false, communicationAllowed: true, followUpDelayMinutes: 60,
  recoverable: true, requiresContact: true, requiresRetry: true, shouldEscalate: false, shouldStop: false,
};

export function makeScenario(observable: Partial<Scenario['observable']> = {}, oracle: Partial<OracleScenario> = {}): Scenario {
  return { observable: { id: 'test', riskType: RiskType.PAYMENT_FAILURE, split: 'dev', amountPaise: 100_000n,
    optedOut: false, contactConsent: true, verifiedFailureCode: 'CARD_EXPIRED', highValue: false, ...observable },
    oracle: { ...BASE_ORACLE, ...oracle } };
}

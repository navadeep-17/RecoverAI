import { CaseStatus, PolicyDecision, RecoveryActionType } from '@recoverai/shared';
import { PolicyEngine, type PolicyEvaluationResult, type PolicyExecutionContext } from '@recoverai/policy';
import type { ObservableCaseState } from './simulator.js';

const BASE_TIME = Date.parse('2025-01-01T12:00:00.000Z');
export const POLICY_LIMITS = { retries: 3, contacts: 3, actions: 8 } as const;

function decimalFromPaise(paise: bigint): string {
  const whole = paise / 100n; const fraction = (paise % 100n).toString().padStart(2, '0');
  return `${whole}.${fraction}`;
}

function caseStatus(status: ObservableCaseState['status']): CaseStatus {
  if (status === 'RECOVERED') return CaseStatus.RECOVERED;
  if (status === 'STOPPED') return CaseStatus.STOPPED;
  if (status === 'EXHAUSTED') return CaseStatus.EXHAUSTED;
  if (status === 'ESCALATED') return CaseStatus.NEEDS_REVIEW;
  return CaseStatus.OPEN;
}

export function policyContext(state: ObservableCaseState, action: RecoveryActionType, confidence = 0.9): PolicyExecutionContext {
  const now = new Date(BASE_TIME + state.minute * 60_000);
  return {
    merchantId: 'evaluation-merchant', killSwitchActive: false,
    policyConfig: { maxRetriesPerCase: POLICY_LIMITS.retries, maxContactsPerCase: POLICY_LIMITS.contacts,
      maxActionsPerCase: POLICY_LIMITS.actions, cooldownHoursBetweenActions: 0, highValueThreshold: '50000.00',
      minConfidenceThreshold: 0.7, reviewFirstMode: false, maxRecoveryWindowDays: 30 },
    case: { id: state.scenario.id, merchantId: 'evaluation-merchant', riskType: state.scenario.riskType,
      amountAtRisk: decimalFromPaise(state.scenario.amountPaise), currency: 'INR', status: caseStatus(state.status),
      openedAt: new Date(BASE_TIME), diagnosisCode: state.scenario.verifiedFailureCode },
    customer: { id: `customer-${state.scenario.id}`, contactConsent: state.scenario.contactConsent,
      optedOut: state.scenario.optedOut, lastContactedAt: null },
    proposedActionType: action, proposedActionParams: {}, confidence,
    verifiedPaymentFailureCode: state.scenario.verifiedFailureCode,
    verifiedPaymentFacts: { gatewayErrorCode: state.scenario.verifiedFailureCode, retryAttemptNumber: state.retries + 1 },
    priorActions: state.actions.map((actionType, index) => ({ actionType,
      executedAt: new Date(BASE_TIME + Math.max(0, state.minute - state.actions.length + index) * 60_000), status: 'SUCCESS' })),
    priorOutcomes: state.events.map((event) => ({ outcomeType: event.type,
      observedAt: new Date(BASE_TIME + event.minute * 60_000), amountRecovered: event.amountPaise ? decimalFromPaise(event.amountPaise) : null })),
    activeCommitments: state.events.filter((event) => event.type === 'PROMISE_TO_PAY').map((event) => ({
      id: event.id, promisedAmount: decimalFromPaise(state.scenario.amountPaise),
      promisedDate: new Date(BASE_TIME + (event.minute + 1440) * 60_000),
      status: state.events.some((candidate) => candidate.type === 'INVOICE_PAID') ? 'FULFILLED' : 'PENDING',
    })), currentTime: now,
  };
}

const engine = new PolicyEngine();
export function evaluatePolicy(state: ObservableCaseState, action: RecoveryActionType, confidence = 0.9): PolicyEvaluationResult {
  return engine.evaluate(policyContext(state, action, confidence));
}
export { PolicyDecision };

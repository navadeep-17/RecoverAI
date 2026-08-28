import { RiskType, RecoveryActionType } from '@recoverai/shared';

/**
 * Frozen Canonical Action Compatibility Matrix
 *
 * Maps each RiskType to the strictly allowed set of RecoveryActionType values.
 *
 * Rules:
 * 1. PAYMENT_FAILURE & SUBSCRIPTION_FAILURE:
 *    - Allowed: RETRY_PAYMENT, REQUEST_PAYMENT_UPDATE, CREATE_OR_SEND_PAYMENT_LINK, SCHEDULE_FOLLOWUP, ESCALATE_TO_HUMAN, STOP_RECOVERY
 *    - Forbidden: SEND_CHECKOUT_RECOVERY, SEND_RECEIVABLE_REMINDER, RECORD_PROMISE_TO_PAY
 *
 * 2. CHECKOUT_ABANDONMENT:
 *    - Allowed: SEND_CHECKOUT_RECOVERY, CREATE_OR_SEND_PAYMENT_LINK, SCHEDULE_FOLLOWUP, ESCALATE_TO_HUMAN, STOP_RECOVERY
 *    - Forbidden: RETRY_PAYMENT, REQUEST_PAYMENT_UPDATE, SEND_RECEIVABLE_REMINDER, RECORD_PROMISE_TO_PAY
 *
 * 3. OVERDUE_RECEIVABLE:
 *    - Allowed: SEND_RECEIVABLE_REMINDER, RECORD_PROMISE_TO_PAY, CREATE_OR_SEND_PAYMENT_LINK, SCHEDULE_FOLLOWUP, ESCALATE_TO_HUMAN, STOP_RECOVERY
 *    - Forbidden: RETRY_PAYMENT, REQUEST_PAYMENT_UPDATE, SEND_CHECKOUT_RECOVERY
 */
export const RISK_ACTION_COMPATIBILITY: Record<RiskType, readonly RecoveryActionType[]> = {
  [RiskType.PAYMENT_FAILURE]: [
    RecoveryActionType.RETRY_PAYMENT,
    RecoveryActionType.REQUEST_PAYMENT_UPDATE,
    RecoveryActionType.CREATE_OR_SEND_PAYMENT_LINK,
    RecoveryActionType.SCHEDULE_FOLLOWUP,
    RecoveryActionType.ESCALATE_TO_HUMAN,
    RecoveryActionType.STOP_RECOVERY,
  ],
  [RiskType.SUBSCRIPTION_FAILURE]: [
    RecoveryActionType.RETRY_PAYMENT,
    RecoveryActionType.REQUEST_PAYMENT_UPDATE,
    RecoveryActionType.CREATE_OR_SEND_PAYMENT_LINK,
    RecoveryActionType.SCHEDULE_FOLLOWUP,
    RecoveryActionType.ESCALATE_TO_HUMAN,
    RecoveryActionType.STOP_RECOVERY,
  ],
  [RiskType.CHECKOUT_ABANDONMENT]: [
    RecoveryActionType.SEND_CHECKOUT_RECOVERY,
    RecoveryActionType.CREATE_OR_SEND_PAYMENT_LINK,
    RecoveryActionType.SCHEDULE_FOLLOWUP,
    RecoveryActionType.ESCALATE_TO_HUMAN,
    RecoveryActionType.STOP_RECOVERY,
  ],
  [RiskType.OVERDUE_RECEIVABLE]: [
    RecoveryActionType.SEND_RECEIVABLE_REMINDER,
    RecoveryActionType.RECORD_PROMISE_TO_PAY,
    RecoveryActionType.CREATE_OR_SEND_PAYMENT_LINK,
    RecoveryActionType.SCHEDULE_FOLLOWUP,
    RecoveryActionType.ESCALATE_TO_HUMAN,
    RecoveryActionType.STOP_RECOVERY,
  ],
};

export class IncompatibleActionForRiskError extends Error {
  constructor(
    public readonly riskType: RiskType,
    public readonly actionType: RecoveryActionType,
  ) {
    super(`Action ${actionType} is not compatible with risk family ${riskType}`);
    this.name = 'IncompatibleActionForRiskError';
  }
}

export function isActionCompatible(riskType: RiskType, actionType: RecoveryActionType): boolean {
  const allowed = RISK_ACTION_COMPATIBILITY[riskType];
  return allowed ? allowed.includes(actionType) : false;
}

export function getAllowedActionsForRisk(riskType: RiskType): readonly RecoveryActionType[] {
  return RISK_ACTION_COMPATIBILITY[riskType] || [];
}

export function validateActionCompatibility(riskType: RiskType, actionType: RecoveryActionType): void {
  if (!isActionCompatible(riskType, actionType)) {
    throw new IncompatibleActionForRiskError(riskType, actionType);
  }
}

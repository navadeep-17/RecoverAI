import { describe, it, expect } from 'vitest';
import {
  RiskType,
  RecoveryActionType,
  isActionCompatible,
  getAllowedActionsForRisk,
  validateActionCompatibility,
  IncompatibleActionForRiskError,
  RISK_ACTION_COMPATIBILITY,
} from '../src/index.js';

describe('Action Compatibility Matrix', () => {
  describe('PAYMENT_FAILURE compatibility', () => {
    const allowed = [
      RecoveryActionType.RETRY_PAYMENT,
      RecoveryActionType.REQUEST_PAYMENT_UPDATE,
      RecoveryActionType.CREATE_OR_SEND_PAYMENT_LINK,
      RecoveryActionType.SCHEDULE_FOLLOWUP,
      RecoveryActionType.ESCALATE_TO_HUMAN,
      RecoveryActionType.STOP_RECOVERY,
    ];
    const forbidden = [
      RecoveryActionType.SEND_CHECKOUT_RECOVERY,
      RecoveryActionType.SEND_RECEIVABLE_REMINDER,
      RecoveryActionType.RECORD_PROMISE_TO_PAY,
    ];

    it('allows valid payment failure actions', () => {
      for (const action of allowed) {
        expect(isActionCompatible(RiskType.PAYMENT_FAILURE, action)).toBe(true);
        expect(() => validateActionCompatibility(RiskType.PAYMENT_FAILURE, action)).not.toThrow();
      }
    });

    it('forbids incompatible actions for payment failure', () => {
      for (const action of forbidden) {
        expect(isActionCompatible(RiskType.PAYMENT_FAILURE, action)).toBe(false);
        expect(() => validateActionCompatibility(RiskType.PAYMENT_FAILURE, action)).toThrow(
          IncompatibleActionForRiskError,
        );
      }
    });
  });

  describe('SUBSCRIPTION_FAILURE compatibility', () => {
    const allowed = [
      RecoveryActionType.RETRY_PAYMENT,
      RecoveryActionType.REQUEST_PAYMENT_UPDATE,
      RecoveryActionType.CREATE_OR_SEND_PAYMENT_LINK,
      RecoveryActionType.SCHEDULE_FOLLOWUP,
      RecoveryActionType.ESCALATE_TO_HUMAN,
      RecoveryActionType.STOP_RECOVERY,
    ];
    const forbidden = [
      RecoveryActionType.SEND_CHECKOUT_RECOVERY,
      RecoveryActionType.SEND_RECEIVABLE_REMINDER,
      RecoveryActionType.RECORD_PROMISE_TO_PAY,
    ];

    it('allows valid subscription failure actions', () => {
      for (const action of allowed) {
        expect(isActionCompatible(RiskType.SUBSCRIPTION_FAILURE, action)).toBe(true);
      }
    });

    it('forbids incompatible actions for subscription failure', () => {
      for (const action of forbidden) {
        expect(isActionCompatible(RiskType.SUBSCRIPTION_FAILURE, action)).toBe(false);
      }
    });
  });

  describe('CHECKOUT_ABANDONMENT compatibility', () => {
    const allowed = [
      RecoveryActionType.SEND_CHECKOUT_RECOVERY,
      RecoveryActionType.CREATE_OR_SEND_PAYMENT_LINK,
      RecoveryActionType.SCHEDULE_FOLLOWUP,
      RecoveryActionType.ESCALATE_TO_HUMAN,
      RecoveryActionType.STOP_RECOVERY,
    ];
    const forbidden = [
      RecoveryActionType.RETRY_PAYMENT,
      RecoveryActionType.REQUEST_PAYMENT_UPDATE,
      RecoveryActionType.SEND_RECEIVABLE_REMINDER,
      RecoveryActionType.RECORD_PROMISE_TO_PAY,
    ];

    it('allows valid checkout abandonment actions', () => {
      for (const action of allowed) {
        expect(isActionCompatible(RiskType.CHECKOUT_ABANDONMENT, action)).toBe(true);
      }
    });

    it('forbids incompatible actions for checkout abandonment', () => {
      for (const action of forbidden) {
        expect(isActionCompatible(RiskType.CHECKOUT_ABANDONMENT, action)).toBe(false);
      }
    });
  });

  describe('OVERDUE_RECEIVABLE compatibility', () => {
    const allowed = [
      RecoveryActionType.SEND_RECEIVABLE_REMINDER,
      RecoveryActionType.RECORD_PROMISE_TO_PAY,
      RecoveryActionType.CREATE_OR_SEND_PAYMENT_LINK,
      RecoveryActionType.SCHEDULE_FOLLOWUP,
      RecoveryActionType.ESCALATE_TO_HUMAN,
      RecoveryActionType.STOP_RECOVERY,
    ];
    const forbidden = [
      RecoveryActionType.RETRY_PAYMENT,
      RecoveryActionType.REQUEST_PAYMENT_UPDATE,
      RecoveryActionType.SEND_CHECKOUT_RECOVERY,
    ];

    it('allows valid overdue receivable actions', () => {
      for (const action of allowed) {
        expect(isActionCompatible(RiskType.OVERDUE_RECEIVABLE, action)).toBe(true);
      }
    });

    it('forbids incompatible actions for overdue receivable', () => {
      for (const action of forbidden) {
        expect(isActionCompatible(RiskType.OVERDUE_RECEIVABLE, action)).toBe(false);
      }
    });
  });

  it('returns all allowed actions for a given risk', () => {
    const actions = getAllowedActionsForRisk(RiskType.PAYMENT_FAILURE);
    expect(actions.length).toBe(6);
    expect(actions).toContain(RecoveryActionType.RETRY_PAYMENT);
  });
});

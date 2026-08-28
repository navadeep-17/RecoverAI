import { describe, it, expect } from 'vitest';
import {
  PolicyEngine,
  PolicyReasonCodes,
  PolicyExecutionContext,
} from '../src/index.js';
import {
  PolicyDecision,
  RecoveryActionType,
  RiskType,
  CaseStatus,
} from '@recoverai/shared';

describe('Deterministic PolicyEngine Specification & Invariant Tests', () => {
  const engine = new PolicyEngine();

  // Baseline daytime date: 14:00 IST (08:30 UTC)
  const daytimeDate = new Date('2026-08-28T08:30:00.000Z');
  // Baseline nighttime date: 23:00 IST (17:30 UTC)
  const nighttimeDate = new Date('2026-08-28T17:30:00.000Z');

  const createBaseContext = (overrides?: Partial<PolicyExecutionContext>): PolicyExecutionContext => ({
    merchantId: 'mch_test_01',
    killSwitchActive: false,
    policyConfig: {
      maxRetriesPerCase: 3,
      maxContactsPerCase: 3,
      cooldownHoursBetweenActions: 24,
      highValueThreshold: '50000.00',
      minConfidenceThreshold: 0.65,
      reviewFirstMode: false,
      quietHoursStart: 21,
      quietHoursEnd: 9,
      quietHoursTimezone: 'Asia/Kolkata',
      maxRecoveryWindowDays: 30,
    },
    case: {
      id: 'case_test_01',
      merchantId: 'mch_test_01',
      riskType: RiskType.PAYMENT_FAILURE,
      amountAtRisk: '14999.00',
      currency: 'INR',
      status: CaseStatus.OPEN,
      openedAt: new Date('2026-08-28T00:00:00.000Z'),
      diagnosisCode: 'INSUFFICIENT_FUNDS',
    },
    customer: {
      id: 'cust_test_01',
      contactConsent: true,
      optedOut: false,
    },
    proposedActionType: RecoveryActionType.RETRY_PAYMENT,
    proposedActionParams: { attemptNumber: 1 },
    confidence: 0.88,
    diagnosisCode: 'INSUFFICIENT_FUNDS',
    shouldEscalate: false,
    shouldStop: false,
    priorActions: [],
    priorOutcomes: [],
    activeCommitments: [],
    currentTime: daytimeDate,
    ...overrides,
  });

  describe('1. ALLOW Path', () => {
    it('returns ALLOW when all policy invariants and safety checks pass', () => {
      const context = createBaseContext();
      const result = engine.evaluate(context);

      expect(result.decision).toBe(PolicyDecision.ALLOW);
      expect(result.reasonCode).toBe(PolicyReasonCodes.POLICY_PASSED_ALLOW);
      expect(result.evaluatedFacts.retryCount).toBe(0);
      expect(result.evaluatedFacts.contactCount).toBe(0);
      expect(result.violations).toBeUndefined();
    });
  });

  describe('2. Hard Stop / DENY Conditions', () => {
    it('DENY: merchant kill switch is active', () => {
      const context = createBaseContext({ killSwitchActive: true });
      const result = engine.evaluate(context);

      expect(result.decision).toBe(PolicyDecision.DENY);
      expect(result.reasonCode).toBe(PolicyReasonCodes.KILL_SWITCH_ACTIVE);
      expect(result.violations).toContain('MERCHANT_KILL_SWITCH_ENGAGED');
    });

    it('DENY: case is in terminal state RECOVERED', () => {
      const context = createBaseContext({
        case: { ...createBaseContext().case, status: CaseStatus.RECOVERED },
      });
      const result = engine.evaluate(context);

      expect(result.decision).toBe(PolicyDecision.DENY);
      expect(result.reasonCode).toBe(PolicyReasonCodes.CASE_ALREADY_TERMINAL);
    });

    it('DENY: case is in terminal state STOPPED', () => {
      const context = createBaseContext({
        case: { ...createBaseContext().case, status: CaseStatus.STOPPED },
      });
      const result = engine.evaluate(context);

      expect(result.decision).toBe(PolicyDecision.DENY);
      expect(result.reasonCode).toBe(PolicyReasonCodes.CASE_ALREADY_TERMINAL);
    });

    it('DENY: case is in terminal state EXHAUSTED', () => {
      const context = createBaseContext({
        case: { ...createBaseContext().case, status: CaseStatus.EXHAUSTED },
      });
      const result = engine.evaluate(context);

      expect(result.decision).toBe(PolicyDecision.DENY);
      expect(result.reasonCode).toBe(PolicyReasonCodes.CASE_ALREADY_TERMINAL);
    });

    it('DENY: case is currently pending human review (NEEDS_REVIEW)', () => {
      const context = createBaseContext({
        case: { ...createBaseContext().case, status: CaseStatus.NEEDS_REVIEW },
      });
      const result = engine.evaluate(context);

      expect(result.decision).toBe(PolicyDecision.DENY);
      expect(result.reasonCode).toBe(PolicyReasonCodes.CASE_NEEDS_REVIEW);
    });

    it('DENY: action is incompatible with risk family (e.g. SEND_CHECKOUT_RECOVERY for PAYMENT_FAILURE)', () => {
      const context = createBaseContext({
        proposedActionType: RecoveryActionType.SEND_CHECKOUT_RECOVERY,
      });
      const result = engine.evaluate(context);

      expect(result.decision).toBe(PolicyDecision.DENY);
      expect(result.reasonCode).toBe(PolicyReasonCodes.INCOMPATIBLE_ACTION_FOR_RISK);
    });

    it('DENY: customer has opted out of communication', () => {
      const context = createBaseContext({
        proposedActionType: RecoveryActionType.CREATE_OR_SEND_PAYMENT_LINK,
        customer: { id: 'cust_1', contactConsent: true, optedOut: true },
      });
      const result = engine.evaluate(context);

      expect(result.decision).toBe(PolicyDecision.DENY);
      expect(result.reasonCode).toBe(PolicyReasonCodes.CUSTOMER_OPTED_OUT);
    });

    it('DENY: customer contact consent is missing for outbound action', () => {
      const context = createBaseContext({
        proposedActionType: RecoveryActionType.CREATE_OR_SEND_PAYMENT_LINK,
        customer: { id: 'cust_1', contactConsent: false, optedOut: false },
      });
      const result = engine.evaluate(context);

      expect(result.decision).toBe(PolicyDecision.DENY);
      expect(result.reasonCode).toBe(PolicyReasonCodes.CONTACT_CONSENT_MISSING);
    });

    it('DENY: hard decline failure code blocks RETRY_PAYMENT', () => {
      const context = createBaseContext({
        diagnosisCode: 'FRAUD_SUSPECTED',
        proposedActionType: RecoveryActionType.RETRY_PAYMENT,
      });
      const result = engine.evaluate(context);

      expect(result.decision).toBe(PolicyDecision.DENY);
      expect(result.reasonCode).toBe(PolicyReasonCodes.HARD_DECLINE_BLOCKS_RETRY);
    });

    it('DENY: max payment retries exceeded', () => {
      const context = createBaseContext({
        proposedActionType: RecoveryActionType.RETRY_PAYMENT,
        priorActions: [
          { actionType: RecoveryActionType.RETRY_PAYMENT, executedAt: new Date('2026-08-25T10:00:00Z'), status: 'FAILED' },
          { actionType: RecoveryActionType.RETRY_PAYMENT, executedAt: new Date('2026-08-26T10:00:00Z'), status: 'FAILED' },
          { actionType: RecoveryActionType.RETRY_PAYMENT, executedAt: new Date('2026-08-27T10:00:00Z'), status: 'FAILED' },
        ],
      });
      const result = engine.evaluate(context);

      expect(result.decision).toBe(PolicyDecision.DENY);
      expect(result.reasonCode).toBe(PolicyReasonCodes.MAX_RETRIES_EXCEEDED);
    });

    it('DENY: max contacts exceeded for communication actions', () => {
      const context = createBaseContext({
        proposedActionType: RecoveryActionType.CREATE_OR_SEND_PAYMENT_LINK,
        priorActions: [
          { actionType: RecoveryActionType.REQUEST_PAYMENT_UPDATE, executedAt: new Date('2026-08-25T10:00:00Z'), status: 'SUCCESS' },
          { actionType: RecoveryActionType.CREATE_OR_SEND_PAYMENT_LINK, executedAt: new Date('2026-08-26T10:00:00Z'), status: 'SUCCESS' },
          { actionType: RecoveryActionType.CREATE_OR_SEND_PAYMENT_LINK, executedAt: new Date('2026-08-27T10:00:00Z'), status: 'SUCCESS' },
        ],
      });
      const result = engine.evaluate(context);

      expect(result.decision).toBe(PolicyDecision.DENY);
      expect(result.reasonCode).toBe(PolicyReasonCodes.MAX_CONTACTS_EXCEEDED);
    });

    it('DENY: action cooldown violation (less than 24h since last action)', () => {
      const context = createBaseContext({
        currentTime: daytimeDate,
        priorActions: [
          {
            actionType: RecoveryActionType.RETRY_PAYMENT,
            executedAt: new Date(daytimeDate.getTime() - 2 * 60 * 60 * 1000), // 2 hours ago
            status: 'FAILED',
          },
        ],
      });
      const result = engine.evaluate(context);

      expect(result.decision).toBe(PolicyDecision.DENY);
      expect(result.reasonCode).toBe(PolicyReasonCodes.COOLDOWN_VIOLATION);
    });

    it('DENY: quiet hours violation during nighttime for customer communication action', () => {
      const context = createBaseContext({
        currentTime: nighttimeDate, // 23:00 IST
        proposedActionType: RecoveryActionType.CREATE_OR_SEND_PAYMENT_LINK,
      });
      const result = engine.evaluate(context);

      expect(result.decision).toBe(PolicyDecision.DENY);
      expect(result.reasonCode).toBe(PolicyReasonCodes.QUIET_HOURS_VIOLATION);
    });

    it('allows non-communication actions (e.g. RETRY_PAYMENT, SCHEDULE_FOLLOWUP) during quiet hours', () => {
      const context = createBaseContext({
        currentTime: nighttimeDate, // 23:00 IST
        proposedActionType: RecoveryActionType.RETRY_PAYMENT,
      });
      const result = engine.evaluate(context);

      // RETRY_PAYMENT is backend-only and not blocked by quiet hours
      expect(result.decision).toBe(PolicyDecision.ALLOW);
    });

    it('DENY: duplicate action already pending in flight', () => {
      const context = createBaseContext({
        proposedActionType: RecoveryActionType.RETRY_PAYMENT,
        priorActions: [
          {
            actionType: RecoveryActionType.RETRY_PAYMENT,
            executedAt: new Date('2026-08-28T08:00:00Z'),
            status: 'PENDING',
          },
        ],
      });
      const result = engine.evaluate(context);

      expect(result.decision).toBe(PolicyDecision.DENY);
      expect(result.reasonCode).toBe(PolicyReasonCodes.DUPLICATE_ACTION_IN_FLIGHT);
    });

    it('DENY: expired recovery window (case opened > 30 days ago)', () => {
      const context = createBaseContext({
        case: {
          ...createBaseContext().case,
          openedAt: new Date(daytimeDate.getTime() - 35 * 24 * 60 * 60 * 1000), // 35 days ago
        },
      });
      const result = engine.evaluate(context);

      expect(result.decision).toBe(PolicyDecision.DENY);
      expect(result.reasonCode).toBe(PolicyReasonCodes.EXPIRED_RECOVERY_WINDOW);
    });
  });

  describe('3. Human Review / REVIEW Conditions', () => {
    it('REVIEW: merchant review-first mode is enabled', () => {
      const context = createBaseContext({
        policyConfig: {
          ...createBaseContext().policyConfig,
          reviewFirstMode: true,
        },
      });
      const result = engine.evaluate(context);

      expect(result.decision).toBe(PolicyDecision.REVIEW);
      expect(result.reasonCode).toBe(PolicyReasonCodes.REVIEW_FIRST_MODE);
    });

    it('REVIEW: high-value case exceeding highValueThreshold (e.g. 75,000 >= 50,000 INR)', () => {
      const context = createBaseContext({
        case: {
          ...createBaseContext().case,
          amountAtRisk: '75000.00',
        },
      });
      const result = engine.evaluate(context);

      expect(result.decision).toBe(PolicyDecision.REVIEW);
      expect(result.reasonCode).toBe(PolicyReasonCodes.HIGH_VALUE_CASE);
      expect(result.evaluatedFacts.isHighValue).toBe(true);
    });

    it('REVIEW: low confidence proposal (confidence 0.50 < threshold 0.65)', () => {
      const context = createBaseContext({
        confidence: 0.50,
      });
      const result = engine.evaluate(context);

      expect(result.decision).toBe(PolicyDecision.REVIEW);
      expect(result.reasonCode).toBe(PolicyReasonCodes.LOW_CONFIDENCE_PROPOSAL);
    });

    it('REVIEW: repeated consecutive failures (>= 2 prior failed actions)', () => {
      const context = createBaseContext({
        priorActions: [
          { actionType: RecoveryActionType.RETRY_PAYMENT, executedAt: new Date('2026-08-25T10:00:00Z'), status: 'FAILED' },
          { actionType: RecoveryActionType.RETRY_PAYMENT, executedAt: new Date('2026-08-26T10:00:00Z'), status: 'FAILED' },
        ],
      });
      const result = engine.evaluate(context);

      expect(result.decision).toBe(PolicyDecision.REVIEW);
      expect(result.reasonCode).toBe(PolicyReasonCodes.REPEATED_FAILURES);
      expect(result.evaluatedFacts.consecutiveFailedActions).toBe(2);
    });

    it('REVIEW: broken promise to pay (unfulfilled commitment past promised date)', () => {
      const context = createBaseContext({
        activeCommitments: [
          {
            id: 'commit_1',
            promisedAmount: '14999.00',
            promisedDate: new Date('2026-08-27T10:00:00Z'), // Past due
            status: 'PENDING',
          },
        ],
      });
      const result = engine.evaluate(context);

      expect(result.decision).toBe(PolicyDecision.REVIEW);
      expect(result.reasonCode).toBe(PolicyReasonCodes.BROKEN_PROMISE_TO_PAY);
      expect(result.evaluatedFacts.hasBrokenPromise).toBe(true);
    });

    it('REVIEW: AI proposal explicitly requested escalation (shouldEscalate = true)', () => {
      const context = createBaseContext({
        shouldEscalate: true,
      });
      const result = engine.evaluate(context);

      expect(result.decision).toBe(PolicyDecision.REVIEW);
      expect(result.reasonCode).toBe(PolicyReasonCodes.AGENT_REQUESTED_REVIEW);
    });

    it('REVIEW: AI proposal proposed ESCALATE_TO_HUMAN action', () => {
      const context = createBaseContext({
        proposedActionType: RecoveryActionType.ESCALATE_TO_HUMAN,
      });
      const result = engine.evaluate(context);

      expect(result.decision).toBe(PolicyDecision.REVIEW);
      expect(result.reasonCode).toBe(PolicyReasonCodes.AGENT_REQUESTED_REVIEW);
    });
  });

  describe('4. Absolute DENY Outranks REVIEW Invariant', () => {
    it('DENY outranks high-value REVIEW when kill switch is active', () => {
      const context = createBaseContext({
        killSwitchActive: true, // DENY condition
        case: {
          ...createBaseContext().case,
          amountAtRisk: '200000.00', // High-value REVIEW condition
        },
      });
      const result = engine.evaluate(context);

      // Must be DENY, never REVIEW
      expect(result.decision).toBe(PolicyDecision.DENY);
      expect(result.reasonCode).toBe(PolicyReasonCodes.KILL_SWITCH_ACTIVE);
    });

    it('DENY outranks review-first mode when cooldown is violated', () => {
      const context = createBaseContext({
        policyConfig: {
          ...createBaseContext().policyConfig,
          reviewFirstMode: true, // REVIEW condition
        },
        priorActions: [
          {
            actionType: RecoveryActionType.RETRY_PAYMENT,
            executedAt: new Date(daytimeDate.getTime() - 1 * 60 * 60 * 1000), // 1h ago -> Cooldown DENY
            status: 'FAILED',
          },
        ],
      });
      const result = engine.evaluate(context);

      expect(result.decision).toBe(PolicyDecision.DENY);
      expect(result.reasonCode).toBe(PolicyReasonCodes.COOLDOWN_VIOLATION);
    });

    it('DENY outranks low-confidence REVIEW when max retries are exceeded', () => {
      const context = createBaseContext({
        confidence: 0.30, // Low confidence REVIEW condition
        proposedActionType: RecoveryActionType.RETRY_PAYMENT,
        priorActions: [
          { actionType: RecoveryActionType.RETRY_PAYMENT, executedAt: new Date('2026-08-25T10:00:00Z'), status: 'FAILED' },
          { actionType: RecoveryActionType.RETRY_PAYMENT, executedAt: new Date('2026-08-26T10:00:00Z'), status: 'FAILED' },
          { actionType: RecoveryActionType.RETRY_PAYMENT, executedAt: new Date('2026-08-27T10:00:00Z'), status: 'FAILED' },
        ],
      });
      const result = engine.evaluate(context);

      expect(result.decision).toBe(PolicyDecision.DENY);
      expect(result.reasonCode).toBe(PolicyReasonCodes.MAX_RETRIES_EXCEEDED);
    });
  });

  describe('5. Determinism & Idempotency', () => {
    it('produces identical evaluation result given identical context inputs', () => {
      const context = createBaseContext();
      const eval1 = engine.evaluate(context);
      const eval2 = engine.evaluate(context);

      expect(eval1.decision).toBe(eval2.decision);
      expect(eval1.reasonCode).toBe(eval2.reasonCode);
      expect(eval1.rationale).toBe(eval2.rationale);
      expect(eval1.evaluatedFacts).toEqual(eval2.evaluatedFacts);
    });
  });
});

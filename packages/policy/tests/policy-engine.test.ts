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

  // Explicit authoritative clocks for deterministic evaluation
  const daytimeDate = new Date('2026-08-28T08:30:00.000Z'); // 14:00 IST
  const nighttimeDate = new Date('2026-08-28T17:30:00.000Z'); // 23:00 IST

  const createBaseContext = (overrides?: Partial<PolicyExecutionContext>): PolicyExecutionContext => ({
    merchantId: 'mch_test_01',
    killSwitchActive: false,
    policyConfig: {
      maxRetriesPerCase: 3,
      maxContactsPerCase: 3,
      maxActionsPerCase: 5,
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

  describe('2. Hard Stop / Fail-Closed & DENY Conditions', () => {
    it('DENY: merchant kill switch is active', () => {
      const context = createBaseContext({ killSwitchActive: true });
      const result = engine.evaluate(context);

      expect(result.decision).toBe(PolicyDecision.DENY);
      expect(result.reasonCode).toBe(PolicyReasonCodes.KILL_SWITCH_ACTIVE);
      expect(result.violations).toContain('MERCHANT_KILL_SWITCH_ENGAGED');
    });

    it('DENY: case is in terminal state RECOVERED / STOPPED / EXHAUSTED', () => {
      for (const terminalStatus of [CaseStatus.RECOVERED, CaseStatus.STOPPED, CaseStatus.EXHAUSTED]) {
        const context = createBaseContext({
          case: { ...createBaseContext().case, status: terminalStatus },
        });
        const result = engine.evaluate(context);
        expect(result.decision).toBe(PolicyDecision.DENY);
        expect(result.reasonCode).toBe(PolicyReasonCodes.CASE_ALREADY_TERMINAL);
      }
    });

    it('DENY: case is currently pending human review (NEEDS_REVIEW)', () => {
      const context = createBaseContext({
        case: { ...createBaseContext().case, status: CaseStatus.NEEDS_REVIEW },
      });
      const result = engine.evaluate(context);

      expect(result.decision).toBe(PolicyDecision.DENY);
      expect(result.reasonCode).toBe(PolicyReasonCodes.CASE_NEEDS_REVIEW);
    });

    it('DENY: customer record missing on customer communication action (REQUIRED_FACTS_MISSING)', () => {
      const context = createBaseContext({
        proposedActionType: RecoveryActionType.CREATE_OR_SEND_PAYMENT_LINK,
        customer: null, // Missing customer fact
      });
      const result = engine.evaluate(context);

      expect(result.decision).toBe(PolicyDecision.DENY);
      expect(result.reasonCode).toBe(PolicyReasonCodes.REQUIRED_FACTS_MISSING);
      expect(result.violations).toContain('MISSING_CUSTOMER_RECORD_FOR_COMMUNICATION');
    });

    it('DENY: unknown customer opt-out status on communication action (REQUIRED_FACTS_MISSING)', () => {
      const context = createBaseContext({
        proposedActionType: RecoveryActionType.CREATE_OR_SEND_PAYMENT_LINK,
        customer: { id: 'cust_1', contactConsent: true, optedOut: undefined },
      });
      const result = engine.evaluate(context);

      expect(result.decision).toBe(PolicyDecision.DENY);
      expect(result.reasonCode).toBe(PolicyReasonCodes.REQUIRED_FACTS_MISSING);
      expect(result.violations).toContain('UNKNOWN_CUSTOMER_OPT_OUT_STATUS');
    });

    it('DENY: unknown customer contact consent on communication action (REQUIRED_FACTS_MISSING)', () => {
      const context = createBaseContext({
        proposedActionType: RecoveryActionType.CREATE_OR_SEND_PAYMENT_LINK,
        customer: { id: 'cust_1', contactConsent: undefined, optedOut: false },
      });
      const result = engine.evaluate(context);

      expect(result.decision).toBe(PolicyDecision.DENY);
      expect(result.reasonCode).toBe(PolicyReasonCodes.REQUIRED_FACTS_MISSING);
      expect(result.violations).toContain('UNKNOWN_CUSTOMER_CONTACT_CONSENT_STATUS');
    });

    it('DENY: malformed monetary amount at risk (REQUIRED_FACTS_MISSING)', () => {
      const context = createBaseContext({
        case: { ...createBaseContext().case, amountAtRisk: '14999.005' }, // >2 decimals
      });
      const result = engine.evaluate(context);

      expect(result.decision).toBe(PolicyDecision.DENY);
      expect(result.reasonCode).toBe(PolicyReasonCodes.REQUIRED_FACTS_MISSING);
      expect(result.violations).toContain('MALFORMED_OR_MISSING_CASE_AMOUNT');
    });

    it('DENY: customer has explicitly opted out of communication', () => {
      const context = createBaseContext({
        proposedActionType: RecoveryActionType.CREATE_OR_SEND_PAYMENT_LINK,
        customer: { id: 'cust_1', contactConsent: true, optedOut: true },
      });
      const result = engine.evaluate(context);

      expect(result.decision).toBe(PolicyDecision.DENY);
      expect(result.reasonCode).toBe(PolicyReasonCodes.CUSTOMER_OPTED_OUT);
    });

    it('DENY: customer contact consent is verified false (withheld)', () => {
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

    it('DENY: max total actions exceeded for case (maxActionsPerCase = 5)', () => {
      const context = createBaseContext({
        proposedActionType: RecoveryActionType.RETRY_PAYMENT,
        priorActions: [
          { actionType: RecoveryActionType.RETRY_PAYMENT, executedAt: new Date('2026-08-20T10:00:00Z'), status: 'FAILED' },
          { actionType: RecoveryActionType.REQUEST_PAYMENT_UPDATE, executedAt: new Date('2026-08-21T10:00:00Z'), status: 'SUCCESS' },
          { actionType: RecoveryActionType.CREATE_OR_SEND_PAYMENT_LINK, executedAt: new Date('2026-08-22T10:00:00Z'), status: 'SUCCESS' },
          { actionType: RecoveryActionType.SCHEDULE_FOLLOWUP, executedAt: new Date('2026-08-23T10:00:00Z'), status: 'SUCCESS' },
          { actionType: RecoveryActionType.RETRY_PAYMENT, executedAt: new Date('2026-08-24T10:00:00Z'), status: 'FAILED' },
        ],
      });
      const result = engine.evaluate(context);

      expect(result.decision).toBe(PolicyDecision.DENY);
      expect(result.reasonCode).toBe(PolicyReasonCodes.MAX_ACTIONS_EXCEEDED);
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

    it('allows non-communication actions (e.g. RETRY_PAYMENT) during quiet hours', () => {
      const context = createBaseContext({
        currentTime: nighttimeDate, // 23:00 IST
        proposedActionType: RecoveryActionType.RETRY_PAYMENT,
      });
      const result = engine.evaluate(context);

      expect(result.decision).toBe(PolicyDecision.ALLOW);
    });
  });

  describe('3. Human Review / REVIEW Conditions & Exact Money Boundaries', () => {
    it('ALLOW vs REVIEW: exact boundary around highValueThreshold (50000.00 INR)', () => {
      // 49,999.99 INR -> BELOW threshold -> ALLOW
      const belowContext = createBaseContext({
        case: { ...createBaseContext().case, amountAtRisk: '49999.99' },
      });
      expect(engine.evaluate(belowContext).decision).toBe(PolicyDecision.ALLOW);

      // 50,000.00 INR -> EXACT threshold -> REVIEW (HIGH_VALUE_CASE)
      const exactContext = createBaseContext({
        case: { ...createBaseContext().case, amountAtRisk: '50000.00' },
      });
      const exactResult = engine.evaluate(exactContext);
      expect(exactResult.decision).toBe(PolicyDecision.REVIEW);
      expect(exactResult.reasonCode).toBe(PolicyReasonCodes.HIGH_VALUE_CASE);

      // 50,000.01 INR -> ABOVE threshold -> REVIEW (HIGH_VALUE_CASE)
      const aboveContext = createBaseContext({
        case: { ...createBaseContext().case, amountAtRisk: '50000.01' },
      });
      const aboveResult = engine.evaluate(aboveContext);
      expect(aboveResult.decision).toBe(PolicyDecision.REVIEW);
      expect(aboveResult.reasonCode).toBe(PolicyReasonCodes.HIGH_VALUE_CASE);
    });

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
  });

  describe('5. Determinism, Idempotency & Authoritative Clock', () => {
    it('produces identical evaluation result given identical context and clock inputs', () => {
      const context = createBaseContext();
      const eval1 = engine.evaluate(context);
      const eval2 = engine.evaluate(context);

      expect(eval1.decision).toBe(eval2.decision);
      expect(eval1.reasonCode).toBe(eval2.reasonCode);
      expect(eval1.rationale).toBe(eval2.rationale);
      expect(eval1.evaluatedFacts).toEqual(eval2.evaluatedFacts);
      expect(eval1.evaluatedAt.getTime()).toBe(daytimeDate.getTime());
    });
  });
});

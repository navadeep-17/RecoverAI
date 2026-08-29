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
    verifiedPaymentFailureCode: 'INSUFFICIENT_FUNDS',
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

    it('DENY: unknown / null customer contact consent on communication action (REQUIRED_FACTS_MISSING)', () => {
      const contextNull = createBaseContext({
        proposedActionType: RecoveryActionType.CREATE_OR_SEND_PAYMENT_LINK,
        customer: { id: 'cust_1', contactConsent: null, optedOut: false },
      });
      const resultNull = engine.evaluate(contextNull);

      expect(resultNull.decision).toBe(PolicyDecision.DENY);
      expect(resultNull.reasonCode).toBe(PolicyReasonCodes.REQUIRED_FACTS_MISSING);
      expect(resultNull.violations).toContain('UNKNOWN_CUSTOMER_CONTACT_CONSENT_STATUS');

      const contextUndef = createBaseContext({
        proposedActionType: RecoveryActionType.CREATE_OR_SEND_PAYMENT_LINK,
        customer: { id: 'cust_1', contactConsent: undefined, optedOut: false },
      });
      const resultUndef = engine.evaluate(contextUndef);
      expect(resultUndef.decision).toBe(PolicyDecision.DENY);
      expect(resultUndef.reasonCode).toBe(PolicyReasonCodes.REQUIRED_FACTS_MISSING);
      expect(resultUndef.violations).toContain('UNKNOWN_CUSTOMER_CONTACT_CONSENT_STATUS');
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

    it('DENY: customer contact consent is explicitly withheld/false', () => {
      const context = createBaseContext({
        proposedActionType: RecoveryActionType.CREATE_OR_SEND_PAYMENT_LINK,
        customer: { id: 'cust_1', contactConsent: false, optedOut: false },
      });
      const result = engine.evaluate(context);

      expect(result.decision).toBe(PolicyDecision.DENY);
      expect(result.reasonCode).toBe(PolicyReasonCodes.CONTACT_CONSENT_MISSING);
      expect(result.violations).toContain('MISSING_CONTACT_CONSENT');
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

    it('DENY: invalid policy configuration fails closed (REQUIRED_FACTS_MISSING)', () => {
      const contextBadTz = createBaseContext({
        policyConfig: {
          ...createBaseContext().policyConfig,
          quietHoursTimezone: 'invalid/timezone',
        },
      });
      const resultBadTz = engine.evaluate(contextBadTz);
      expect(resultBadTz.decision).toBe(PolicyDecision.DENY);
      expect(resultBadTz.reasonCode).toBe(PolicyReasonCodes.REQUIRED_FACTS_MISSING);
      expect(resultBadTz.violations).toContain('INVALID_POLICY_CONFIGURATION');

      const contextBadHours = createBaseContext({
        policyConfig: {
          ...createBaseContext().policyConfig,
          quietHoursStart: 99,
        },
      });
      const resultBadHours = engine.evaluate(contextBadHours);
      expect(resultBadHours.decision).toBe(PolicyDecision.DENY);
      expect(resultBadHours.reasonCode).toBe(PolicyReasonCodes.REQUIRED_FACTS_MISSING);
      expect(resultBadHours.violations).toContain('INVALID_POLICY_CONFIGURATION');
    });

    describe('Verified Payment Failure Facts & Hard Decline Safety Contract', () => {
      it('DENY: verified hard decline blocks RETRY_PAYMENT even if AI diagnosis says INSUFFICIENT_FUNDS', () => {
        const context = createBaseContext({
          proposedActionType: RecoveryActionType.RETRY_PAYMENT,
          verifiedPaymentFailureCode: 'CARD_EXPIRED', // Authoritative provider fact: HARD DECLINE
          diagnosisCode: 'INSUFFICIENT_FUNDS', // AI interpretation: SOFT DECLINE
        });
        const result = engine.evaluate(context);

        expect(result.decision).toBe(PolicyDecision.DENY);
        expect(result.reasonCode).toBe(PolicyReasonCodes.HARD_DECLINE_BLOCKS_RETRY);
        expect(result.violations).toContain('HARD_DECLINE_RETRY_PROHIBITED');
      });

      it('ALLOW: verified soft decline passes hard-decline check even if AI diagnosis says CARD_EXPIRED', () => {
        const context = createBaseContext({
          proposedActionType: RecoveryActionType.RETRY_PAYMENT,
          verifiedPaymentFailureCode: 'INSUFFICIENT_FUNDS', // Authoritative provider fact: SOFT DECLINE
          diagnosisCode: 'CARD_EXPIRED', // AI interpretation: HARD DECLINE
        });
        const result = engine.evaluate(context);

        // Ground-truth provider fact is respected; AI diagnosis is not used as safety authority
        expect(result.decision).toBe(PolicyDecision.ALLOW);
        expect(result.reasonCode).toBe(PolicyReasonCodes.POLICY_PASSED_ALLOW);
      });

      it('DENY: missing verified failure code on RETRY_PAYMENT fails closed with REQUIRED_FACTS_MISSING', () => {
        const contextMissingFact = createBaseContext({
          proposedActionType: RecoveryActionType.RETRY_PAYMENT,
          verifiedPaymentFailureCode: null,
          verifiedPaymentFacts: null,
          diagnosisCode: 'INSUFFICIENT_FUNDS',
        });
        const result = engine.evaluate(contextMissingFact);

        expect(result.decision).toBe(PolicyDecision.DENY);
        expect(result.reasonCode).toBe(PolicyReasonCodes.REQUIRED_FACTS_MISSING);
        expect(result.violations).toContain('MISSING_VERIFIED_PAYMENT_FAILURE_CODE');
      });

      it('ALLOW: verified CARD_EXPIRED decline allows subsequent RETRY_PAYMENT if authoritative PAYMENT_METHOD_UPDATED was observed', () => {
        const contextWithUpdatedMethod = createBaseContext({
          proposedActionType: RecoveryActionType.RETRY_PAYMENT,
          verifiedPaymentFailureCode: 'CARD_EXPIRED',
          priorOutcomes: [
            {
              outcomeType: 'PAYMENT_METHOD_UPDATED',
              observedAt: new Date('2026-08-28T11:00:00Z'),
            },
          ],
        });
        const result = engine.evaluate(contextWithUpdatedMethod);

        expect(result.decision).toBe(PolicyDecision.ALLOW);
        expect(result.reasonCode).toBe(PolicyReasonCodes.POLICY_PASSED_ALLOW);
        expect(result.evaluatedFacts.isHardDecline).toBe(false);
      });
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

    it('DENY: duplicate action already pending/running', () => {
      const context = createBaseContext({
        proposedActionType: RecoveryActionType.RETRY_PAYMENT,
        priorActions: [
          { actionType: RecoveryActionType.RETRY_PAYMENT, executedAt: new Date('2026-08-28T07:00:00Z'), status: 'PENDING' },
        ],
      });
      const result = engine.evaluate(context);

      expect(result.decision).toBe(PolicyDecision.DENY);
      expect(result.reasonCode).toBe(PolicyReasonCodes.DUPLICATE_ACTION_IN_FLIGHT);
    });

    it('DENY: action incompatible with risk type', () => {
      const context = createBaseContext({
        case: { ...createBaseContext().case, riskType: RiskType.CHECKOUT_ABANDONMENT },
        proposedActionType: RecoveryActionType.RETRY_PAYMENT, // Incompatible with checkout abandonment
      });
      const result = engine.evaluate(context);

      expect(result.decision).toBe(PolicyDecision.DENY);
      expect(result.reasonCode).toBe(PolicyReasonCodes.INCOMPATIBLE_ACTION_FOR_RISK);
    });
  });

  describe('3. Human REVIEW Routing Conditions', () => {
    it('REVIEW: reviewFirstMode is active for merchant', () => {
      const context = createBaseContext({
        policyConfig: { ...createBaseContext().policyConfig, reviewFirstMode: true },
      });
      const result = engine.evaluate(context);

      expect(result.decision).toBe(PolicyDecision.REVIEW);
      expect(result.reasonCode).toBe(PolicyReasonCodes.REVIEW_FIRST_MODE);
    });

    it('REVIEW: exact high value boundary test (>= 50000.00 INR)', () => {
      // 49,999.99 INR -> ALLOW
      const contextBelow = createBaseContext({
        case: { ...createBaseContext().case, amountAtRisk: '49999.99' },
      });
      expect(engine.evaluate(contextBelow).decision).toBe(PolicyDecision.ALLOW);

      // Exactly 50,000.00 INR -> REVIEW
      const contextExact = createBaseContext({
        case: { ...createBaseContext().case, amountAtRisk: '50000.00' },
      });
      const resultExact = engine.evaluate(contextExact);
      expect(resultExact.decision).toBe(PolicyDecision.REVIEW);
      expect(resultExact.reasonCode).toBe(PolicyReasonCodes.HIGH_VALUE_CASE);

      // 50,000.01 INR -> REVIEW
      const contextAbove = createBaseContext({
        case: { ...createBaseContext().case, amountAtRisk: '50000.01' },
      });
      expect(engine.evaluate(contextAbove).decision).toBe(PolicyDecision.REVIEW);
    });

    it('REVIEW: proposal confidence is below minConfidenceThreshold (0.65)', () => {
      const context = createBaseContext({ confidence: 0.50 });
      const result = engine.evaluate(context);

      expect(result.decision).toBe(PolicyDecision.REVIEW);
      expect(result.reasonCode).toBe(PolicyReasonCodes.LOW_CONFIDENCE_PROPOSAL);
    });

    it('REVIEW: 2 or more consecutive failed actions on case', () => {
      const context = createBaseContext({
        priorActions: [
          { actionType: RecoveryActionType.RETRY_PAYMENT, executedAt: new Date('2026-08-25T10:00:00Z'), status: 'FAILED' },
          { actionType: RecoveryActionType.REQUEST_PAYMENT_UPDATE, executedAt: new Date('2026-08-26T10:00:00Z'), status: 'FAILED' },
        ],
      });
      const result = engine.evaluate(context);

      expect(result.decision).toBe(PolicyDecision.REVIEW);
      expect(result.reasonCode).toBe(PolicyReasonCodes.REPEATED_FAILURES);
    });

    it('REVIEW: broken promise to pay (past due unfulfilled commitment)', () => {
      const context = createBaseContext({
        currentTime: daytimeDate,
        activeCommitments: [
          {
            id: 'commit_1',
            promisedAmount: '14999.00',
            promisedDate: new Date('2026-08-20T00:00:00Z'), // in past
            status: 'PENDING',
          },
        ],
      });
      const result = engine.evaluate(context);

      expect(result.decision).toBe(PolicyDecision.REVIEW);
      expect(result.reasonCode).toBe(PolicyReasonCodes.BROKEN_PROMISE_TO_PAY);
    });

    it('REVIEW: agent explicitly requested human escalation (shouldEscalate = true)', () => {
      const context = createBaseContext({ shouldEscalate: true });
      const result = engine.evaluate(context);

      expect(result.decision).toBe(PolicyDecision.REVIEW);
      expect(result.reasonCode).toBe(PolicyReasonCodes.AGENT_REQUESTED_REVIEW);
    });
  });

  describe('4. Hard DENY Strictly Outranks REVIEW Precedence', () => {
    it('DENY overrides REVIEW when high-value case is during quiet hours', () => {
      const context = createBaseContext({
        currentTime: nighttimeDate, // In quiet hours (DENY)
        case: { ...createBaseContext().case, amountAtRisk: '75000.00' }, // High value (REVIEW)
        proposedActionType: RecoveryActionType.CREATE_OR_SEND_PAYMENT_LINK,
      });
      const result = engine.evaluate(context);

      expect(result.decision).toBe(PolicyDecision.DENY);
      expect(result.reasonCode).toBe(PolicyReasonCodes.QUIET_HOURS_VIOLATION);
    });

    it('DENY overrides REVIEW when low-confidence proposal violates cooldown', () => {
      const context = createBaseContext({
        confidence: 0.40, // Low confidence (REVIEW)
        priorActions: [
          {
            actionType: RecoveryActionType.RETRY_PAYMENT,
            executedAt: new Date(daytimeDate.getTime() - 1 * 60 * 60 * 1000), // Cooldown violation (DENY)
            status: 'SUCCESS',
          },
        ],
      });
      const result = engine.evaluate(context);

      expect(result.decision).toBe(PolicyDecision.DENY);
      expect(result.reasonCode).toBe(PolicyReasonCodes.COOLDOWN_VIOLATION);
    });
  });
});

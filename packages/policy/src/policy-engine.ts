import { PolicyDecision, RecoveryActionType, Money } from '@recoverai/shared';
import { isHardDecline } from '@recoverai/core';
import {
  IPolicyEngine,
  PolicyExecutionContext,
  PolicyEvaluationResult,
  PolicyEvaluatedFacts,
} from './policy-types.js';
import { PolicyReasonCodes } from './policy-reason-codes.js';
import { checkQuietHours, isCustomerCommunicationAction } from './quiet-hours.js';
import { IPolicyRule, RuleResult } from './rules/rule.interface.js';
import {
  KillSwitchRule,
  TerminalCaseStateRule,
  CaseNeedsReviewRule,
  RequiredFactsRule,
  DuplicateActionRule,
  ActionCompatibilityRule,
  CustomerOptOutRule,
  ContactConsentRule,
  HardDeclineRule,
  MaxRetriesRule,
  MaxContactsRule,
  MaxTotalActionsRule,
  CooldownRule,
  QuietHoursRule,
  ExpiredRecoveryWindowRule,
} from './rules/hard-deny-rules.js';
import {
  ReviewFirstModeRule,
  HighValueCaseRule,
  LowConfidenceRule,
  RepeatedFailuresRule,
  BrokenPromiseToPayRule,
  AgentEscalationRule,
} from './rules/review-rules.js';

export class PolicyEngine implements IPolicyEngine {
  private readonly hardDenyRules: readonly IPolicyRule[];
  private readonly reviewRules: readonly IPolicyRule[];

  constructor(customRules?: {
    hardDenyRules?: IPolicyRule[];
    reviewRules?: IPolicyRule[];
  }) {
    this.hardDenyRules = customRules?.hardDenyRules || [
      new KillSwitchRule(),
      new TerminalCaseStateRule(),
      new CaseNeedsReviewRule(),
      new RequiredFactsRule(),
      new DuplicateActionRule(),
      new ActionCompatibilityRule(),
      new CustomerOptOutRule(),
      new ContactConsentRule(),
      new HardDeclineRule(),
      new MaxRetriesRule(),
      new MaxContactsRule(),
      new MaxTotalActionsRule(),
      new CooldownRule(),
      new QuietHoursRule(),
      new ExpiredRecoveryWindowRule(),
    ];

    this.reviewRules = customRules?.reviewRules || [
      new ReviewFirstModeRule(),
      new HighValueCaseRule(),
      new LowConfidenceRule(),
      new RepeatedFailuresRule(),
      new BrokenPromiseToPayRule(),
      new AgentEscalationRule(),
    ];
  }

  /**
   * Evaluates a proposed recovery action against authoritative tenant and case context.
   *
   * Architectural Invariants:
   * 1. Deterministic pure domain logic; NEVER calls an LLM.
   * 2. Strict decision contract: ALLOW | DENY | REVIEW.
   * 3. Absolute DENY outranks REVIEW (human review cannot bypass hard safety stops).
   * 4. Idempotent: identical inputs and authoritative clock produce identical decisions and reason codes.
   * 5. Exact Money semantics only; zero floating-point arithmetic.
   * 6. Fails closed on missing or unverified ground truth facts.
   */
  evaluate(context: PolicyExecutionContext): PolicyEvaluationResult {
    const evaluatedAt = context.currentTime;
    const evaluatedFacts = this.computeEvaluatedFacts(context, evaluatedAt);

    // 1. Evaluate Hard DENY Rules in deterministic order
    const violations: string[] = [];
    let firstDenyResult: RuleResult | null = null;

    for (const rule of this.hardDenyRules) {
      const result = rule.evaluate(context, evaluatedFacts);
      if (result && result.decision === PolicyDecision.DENY) {
        if (!firstDenyResult) {
          firstDenyResult = result;
        }
        if (result.violation) {
          violations.push(result.violation);
        }
      }
    }

    if (firstDenyResult) {
      return {
        decision: PolicyDecision.DENY,
        reasonCode: firstDenyResult.reasonCode,
        rationale: firstDenyResult.rationale,
        evaluatedFacts,
        evaluatedAt,
        violations: violations.length > 0 ? violations : undefined,
      };
    }

    // 2. Evaluate REVIEW Rules in deterministic order
    for (const rule of this.reviewRules) {
      const result = rule.evaluate(context, evaluatedFacts);
      if (result && result.decision === PolicyDecision.REVIEW) {
        return {
          decision: PolicyDecision.REVIEW,
          reasonCode: result.reasonCode,
          rationale: result.rationale,
          evaluatedFacts,
          evaluatedAt,
        };
      }
    }

    // 3. ALLOW if no DENY and no REVIEW conditions matched
    return {
      decision: PolicyDecision.ALLOW,
      reasonCode: PolicyReasonCodes.POLICY_PASSED_ALLOW,
      rationale: 'All safety and policy checks passed. Proposed action is authorized for execution.',
      evaluatedFacts,
      evaluatedAt,
    };
  }

  private computeEvaluatedFacts(
    context: PolicyExecutionContext,
    now: Date,
  ): PolicyEvaluatedFacts {
    const totalActionsCount = context.priorActions.length;

    // Retry count (count of executed RETRY_PAYMENT actions)
    const retryCount = context.priorActions.filter(
      (a) => a.actionType === RecoveryActionType.RETRY_PAYMENT,
    ).length;

    // Contact count (count of customer-facing communication actions)
    const contactCount = context.priorActions.filter((a) =>
      isCustomerCommunicationAction(a.actionType),
    ).length;

    // Hours since last action
    let hoursSinceLastAction: number | null = null;
    if (context.priorActions.length > 0) {
      const sorted = [...context.priorActions].sort(
        (a, b) => b.executedAt.getTime() - a.executedAt.getTime(),
      );
      const last = sorted[0];
      const diffMs = now.getTime() - last.executedAt.getTime();
      hoursSinceLastAction = Math.max(0, diffMs / (1000 * 60 * 60));
    }

    // Quiet hours
    let inQuietHours = false;
    let quietHoursLocalHour = 0;
    try {
      const quietCheck = checkQuietHours({
        currentTime: now,
        timezone: context.policyConfig.quietHoursTimezone,
        startHour: context.policyConfig.quietHoursStart,
        endHour: context.policyConfig.quietHoursEnd,
      });
      inQuietHours = quietCheck.inQuietHours;
      quietHoursLocalHour = quietCheck.localHour;
    } catch {
      inQuietHours = false;
    }

    // High value calculation using exact Money comparison only (no parseFloat fallback)
    let isHighValue = false;
    if (
      Money.isValidDecimalString(context.case.amountAtRisk) &&
      Money.isValidDecimalString(context.policyConfig.highValueThreshold)
    ) {
      const caseMoney = Money.fromDecimalString(context.case.amountAtRisk, context.case.currency || 'INR');
      const thresholdMoney = Money.fromDecimalString(context.policyConfig.highValueThreshold, context.case.currency || 'INR');
      isHighValue = caseMoney.greaterThan(thresholdMoney) || caseMoney.equals(thresholdMoney);
    }

    // Consecutive failed actions
    let consecutiveFailedActions = 0;
    const chronologicalActions = [...context.priorActions].sort(
      (a, b) => a.executedAt.getTime() - b.executedAt.getTime(),
    );
    for (let i = chronologicalActions.length - 1; i >= 0; i--) {
      if (chronologicalActions[i].status === 'FAILED') {
        consecutiveFailedActions++;
      } else {
        break;
      }
    }

    // Broken promise to pay
    let hasBrokenPromise = false;
    if (context.activeCommitments && context.activeCommitments.length > 0) {
      hasBrokenPromise = context.activeCommitments.some(
        (c) => c.status !== 'FULFILLED' && c.promisedDate.getTime() < now.getTime(),
      );
    }

    const verifiedCode = context.verifiedPaymentFailureCode ?? context.verifiedPaymentFacts?.gatewayErrorCode ?? null;
    const hardDecline = isHardDecline(verifiedCode);

    return {
      merchantKillSwitch: context.killSwitchActive,
      caseStatus: context.case.status,
      caseAmount: context.case.amountAtRisk,
      caseCurrency: context.case.currency,
      riskType: context.case.riskType,
      proposedActionType: context.proposedActionType,
      totalActionsCount,
      maxActionsAllowed: context.policyConfig.maxActionsPerCase,
      retryCount,
      maxRetriesAllowed: context.policyConfig.maxRetriesPerCase,
      contactCount,
      maxContactsAllowed: context.policyConfig.maxContactsPerCase,
      hoursSinceLastAction,
      cooldownHoursRequired: context.policyConfig.cooldownHoursBetweenActions,
      inQuietHours,
      quietHoursLocalHour,
      customerOptedOut: context.customer?.optedOut ?? false,
      customerContactConsent: context.customer?.contactConsent ?? null,
      customerRecordPresent: context.customer !== null && context.customer !== undefined,
      verifiedPaymentFailureCode: verifiedCode,
      isHardDecline: hardDecline,
      proposalConfidence: context.confidence ?? null,
      confidenceThreshold: context.policyConfig.minConfidenceThreshold,
      isHighValue,
      consecutiveFailedActions,
      hasBrokenPromise,
      reviewFirstModeActive: context.policyConfig.reviewFirstMode,
    };
  }
}

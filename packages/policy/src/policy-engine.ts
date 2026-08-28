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
  ActionCompatibilityRule,
  CustomerOptOutRule,
  ContactConsentRule,
  HardDeclineRule,
  MaxRetriesRule,
  MaxContactsRule,
  CooldownRule,
  QuietHoursRule,
  DuplicateActionRule,
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
      new DuplicateActionRule(),
      new ActionCompatibilityRule(),
      new CustomerOptOutRule(),
      new ContactConsentRule(),
      new HardDeclineRule(),
      new MaxRetriesRule(),
      new MaxContactsRule(),
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
   * 4. Idempotent: identical inputs produce identical decisions and reason codes.
   */
  evaluate(context: PolicyExecutionContext): PolicyEvaluationResult {
    const evaluatedAt = context.currentTime || new Date();
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
    const quietCheck = checkQuietHours({
      currentTime: now,
      timezone: context.policyConfig.quietHoursTimezone,
      startHour: context.policyConfig.quietHoursStart,
      endHour: context.policyConfig.quietHoursEnd,
    });

    // High value calculation using exact Money comparison
    let isHighValue = false;
    try {
      const caseMoney = Money.fromDecimalString(context.case.amountAtRisk);
      const thresholdMoney = Money.fromDecimalString(context.policyConfig.highValueThreshold);
      isHighValue = caseMoney.greaterThan(thresholdMoney) || caseMoney.equals(thresholdMoney);
    } catch {
      // Fallback
      isHighValue = parseFloat(context.case.amountAtRisk) >= parseFloat(context.policyConfig.highValueThreshold);
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

    const hardDecline = isHardDecline(context.diagnosisCode || context.case.diagnosisCode);

    return {
      merchantKillSwitch: context.killSwitchActive,
      caseStatus: context.case.status,
      caseAmount: context.case.amountAtRisk,
      caseCurrency: context.case.currency,
      riskType: context.case.riskType,
      proposedActionType: context.proposedActionType,
      retryCount,
      maxRetriesAllowed: context.policyConfig.maxRetriesPerCase,
      contactCount,
      maxContactsAllowed: context.policyConfig.maxContactsPerCase,
      hoursSinceLastAction,
      cooldownHoursRequired: context.policyConfig.cooldownHoursBetweenActions,
      inQuietHours: quietCheck.inQuietHours,
      quietHoursLocalHour: quietCheck.localHour,
      customerOptedOut: context.customer?.optedOut ?? false,
      customerContactConsent: context.customer?.contactConsent ?? true,
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

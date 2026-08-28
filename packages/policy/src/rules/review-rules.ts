import { PolicyDecision, RecoveryActionType } from '@recoverai/shared';
import { IPolicyRule, RuleResult } from './rule.interface.js';
import { PolicyExecutionContext, PolicyEvaluatedFacts } from '../policy-types.js';
import { PolicyReasonCodes } from '../policy-reason-codes.js';

/**
 * 1. Merchant Review-First Mode Rule
 * When enabled, all proposed recovery actions require explicit human review.
 */
export class ReviewFirstModeRule implements IPolicyRule {
  readonly name = 'ReviewFirstModeRule';
  evaluate(context: PolicyExecutionContext): RuleResult | null {
    if (context.policyConfig.reviewFirstMode) {
      return {
        decision: PolicyDecision.REVIEW,
        reasonCode: PolicyReasonCodes.REVIEW_FIRST_MODE,
        rationale: 'Merchant policy is configured in review-first mode; human review is required before execution.',
      };
    }
    return null;
  }
}

/**
 * 2. High-Value Case Rule
 * Cases with amount at risk >= merchant highValueThreshold require human oversight.
 */
export class HighValueCaseRule implements IPolicyRule {
  readonly name = 'HighValueCaseRule';
  evaluate(context: PolicyExecutionContext, facts: PolicyEvaluatedFacts): RuleResult | null {
    if (facts.isHighValue) {
      return {
        decision: PolicyDecision.REVIEW,
        reasonCode: PolicyReasonCodes.HIGH_VALUE_CASE,
        rationale: `Case amount (${context.case.amountAtRisk} ${context.case.currency}) exceeds high-value review threshold (${context.policyConfig.highValueThreshold} ${context.case.currency}).`,
      };
    }
    return null;
  }
}

/**
 * 3. Low Confidence Proposal Rule
 * AI proposals with confidence < minConfidenceThreshold require human review.
 */
export class LowConfidenceRule implements IPolicyRule {
  readonly name = 'LowConfidenceRule';
  evaluate(context: PolicyExecutionContext): RuleResult | null {
    if (
      context.confidence !== undefined &&
      context.confidence < context.policyConfig.minConfidenceThreshold
    ) {
      return {
        decision: PolicyDecision.REVIEW,
        reasonCode: PolicyReasonCodes.LOW_CONFIDENCE_PROPOSAL,
        rationale: `AI proposal confidence (${(context.confidence * 100).toFixed(1)}%) is below minimum threshold (${(context.policyConfig.minConfidenceThreshold * 100).toFixed(1)}%).`,
      };
    }
    return null;
  }
}

/**
 * 4. Repeated Failures Rule
 * Cases with >= 2 consecutive failed prior actions require human review before further automated attempts.
 */
export class RepeatedFailuresRule implements IPolicyRule {
  readonly name = 'RepeatedFailuresRule';
  evaluate(context: PolicyExecutionContext, facts: PolicyEvaluatedFacts): RuleResult | null {
    if (facts.consecutiveFailedActions >= 2) {
      return {
        decision: PolicyDecision.REVIEW,
        reasonCode: PolicyReasonCodes.REPEATED_FAILURES,
        rationale: `Case experienced ${facts.consecutiveFailedActions} consecutive prior action failures; human review required.`,
      };
    }
    return null;
  }
}

/**
 * 5. Broken Promise to Pay Rule
 * If a customer made a commitment to pay by a date that passed without payment, route to human review.
 */
export class BrokenPromiseToPayRule implements IPolicyRule {
  readonly name = 'BrokenPromiseToPayRule';
  evaluate(context: PolicyExecutionContext, facts: PolicyEvaluatedFacts): RuleResult | null {
    if (facts.hasBrokenPromise) {
      return {
        decision: PolicyDecision.REVIEW,
        reasonCode: PolicyReasonCodes.BROKEN_PROMISE_TO_PAY,
        rationale: 'Customer payment commitment date expired without observed payment settlement; human review required.',
      };
    }
    return null;
  }
}

/**
 * 6. Explicit Agent Escalation Rule
 * When the proposal sets shouldEscalate = true or action is ESCALATE_TO_HUMAN.
 */
export class AgentEscalationRule implements IPolicyRule {
  readonly name = 'AgentEscalationRule';
  evaluate(context: PolicyExecutionContext): RuleResult | null {
    if (
      context.shouldEscalate === true ||
      context.proposedActionType === RecoveryActionType.ESCALATE_TO_HUMAN
    ) {
      return {
        decision: PolicyDecision.REVIEW,
        reasonCode: PolicyReasonCodes.AGENT_REQUESTED_REVIEW,
        rationale: 'AI recovery proposal explicitly flagged this case for human review / escalation.',
      };
    }
    return null;
  }
}

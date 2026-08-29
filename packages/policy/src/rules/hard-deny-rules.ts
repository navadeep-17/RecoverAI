import { PolicyDecision, CaseStatus, RecoveryActionType, Money, NormalizedEventType } from '@recoverai/shared';
import { isActionCompatible, isHardDecline } from '@recoverai/core';
import { IPolicyRule, RuleResult } from './rule.interface.js';
import {
  PolicyExecutionContext,
  PolicyEvaluatedFacts,
  getPolicyConfigValidationError,
} from '../policy-types.js';
import { PolicyReasonCodes } from '../policy-reason-codes.js';
import { isCustomerCommunicationAction } from '../quiet-hours.js';

/**
 * 1. Kill Switch Rule
 * Hard stop when the merchant kill switch is engaged.
 */
export class KillSwitchRule implements IPolicyRule {
  readonly name = 'KillSwitchRule';
  evaluate(context: PolicyExecutionContext): RuleResult | null {
    if (context.killSwitchActive) {
      return {
        decision: PolicyDecision.DENY,
        reasonCode: PolicyReasonCodes.KILL_SWITCH_ACTIVE,
        rationale: 'Merchant emergency kill switch is activated; all automated recovery actions are suspended.',
        violation: 'MERCHANT_KILL_SWITCH_ENGAGED',
      };
    }
    return null;
  }
}

/**
 * 2. Terminal Case State Rule
 * Terminal cases (RECOVERED, STOPPED, EXHAUSTED) must NEVER execute further recovery actions.
 */
export class TerminalCaseStateRule implements IPolicyRule {
  readonly name = 'TerminalCaseStateRule';
  evaluate(context: PolicyExecutionContext): RuleResult | null {
    const status = context.case.status;
    if (
      status === CaseStatus.RECOVERED ||
      status === CaseStatus.STOPPED ||
      status === CaseStatus.EXHAUSTED
    ) {
      return {
        decision: PolicyDecision.DENY,
        reasonCode: PolicyReasonCodes.CASE_ALREADY_TERMINAL,
        rationale: `Case is in terminal state "${status}"; no further automated recovery actions are permitted.`,
        violation: `CASE_TERMINAL_STATE_${status}`,
      };
    }
    return null;
  }
}

/**
 * 3. Case Pending Review Rule
 * Cases awaiting human review cannot execute new automated actions until the review is resolved.
 */
export class CaseNeedsReviewRule implements IPolicyRule {
  readonly name = 'CaseNeedsReviewRule';
  evaluate(context: PolicyExecutionContext): RuleResult | null {
    if (context.case.status === CaseStatus.NEEDS_REVIEW) {
      if (context.executionSource === 'HUMAN_REVIEW_APPROVAL') {
        // Explicit human-review approval revalidation skips ONLY this specific pending-review gate.
        return null;
      }
      return {
        decision: PolicyDecision.DENY,
        reasonCode: PolicyReasonCodes.CASE_NEEDS_REVIEW,
        rationale: 'Case is currently pending human review resolution; automated action execution is blocked.',
        violation: 'CASE_STATUS_NEEDS_REVIEW',
      };
    }
    return null;
  }
}

/**
 * 4. Required Facts & Fail-Closed Validation Rule
 * Fails closed when essential ground-truth facts are missing or unverified.
 * Unknown is NOT permission.
 */
export class RequiredFactsRule implements IPolicyRule {
  readonly name = 'RequiredFactsRule';
  evaluate(context: PolicyExecutionContext): RuleResult | null {
    // 1. Validate monetary facts using exact Money semantics
    if (
      !context.case.amountAtRisk ||
      !context.case.currency ||
      !Money.isValidDecimalString(context.case.amountAtRisk)
    ) {
      return {
        decision: PolicyDecision.DENY,
        reasonCode: PolicyReasonCodes.REQUIRED_FACTS_MISSING,
        rationale: `Authoritative case amount ("${context.case.amountAtRisk}") or currency ("${context.case.currency}") is invalid or missing.`,
        violation: 'MALFORMED_OR_MISSING_CASE_AMOUNT',
      };
    }

    if (
      !context.policyConfig.highValueThreshold ||
      !Money.isValidDecimalString(context.policyConfig.highValueThreshold)
    ) {
      return {
        decision: PolicyDecision.DENY,
        reasonCode: PolicyReasonCodes.REQUIRED_FACTS_MISSING,
        rationale: `Authoritative high-value review threshold ("${context.policyConfig.highValueThreshold}") is invalid or missing.`,
        violation: 'MALFORMED_OR_MISSING_HIGH_VALUE_THRESHOLD',
      };
    }

    // 2. Validate policy configuration integrity (fail closed on invalid timezone/ranges)
    const configError = getPolicyConfigValidationError(context.policyConfig);
    if (configError) {
      return {
        decision: PolicyDecision.DENY,
        reasonCode: PolicyReasonCodes.REQUIRED_FACTS_MISSING,
        rationale: `Policy configuration is invalid: ${configError}`,
        violation: 'INVALID_POLICY_CONFIGURATION',
      };
    }

    // 3. For customer-facing communication actions: require verified customer, opt-out, and consent status
    if (isCustomerCommunicationAction(context.proposedActionType)) {
      if (!context.customer) {
        return {
          decision: PolicyDecision.DENY,
          reasonCode: PolicyReasonCodes.REQUIRED_FACTS_MISSING,
          rationale: 'Customer record is missing; outbound communication cannot proceed without verified customer identity.',
          violation: 'MISSING_CUSTOMER_RECORD_FOR_COMMUNICATION',
        };
      }

      if (context.customer.optedOut === undefined || typeof context.customer.optedOut !== 'boolean') {
        return {
          decision: PolicyDecision.DENY,
          reasonCode: PolicyReasonCodes.REQUIRED_FACTS_MISSING,
          rationale: 'Customer opt-out status is unknown or unverified; unknown status is not permission to contact.',
          violation: 'UNKNOWN_CUSTOMER_OPT_OUT_STATUS',
        };
      }

      if (
        context.customer.contactConsent === null ||
        context.customer.contactConsent === undefined ||
        typeof context.customer.contactConsent !== 'boolean'
      ) {
        return {
          decision: PolicyDecision.DENY,
          reasonCode: PolicyReasonCodes.REQUIRED_FACTS_MISSING,
          rationale: 'Customer contact consent is unknown or unverified; unknown consent is not permission to contact.',
          violation: 'UNKNOWN_CUSTOMER_CONTACT_CONSENT_STATUS',
        };
      }
    }

    return null;
  }
}

/**
 * 5. Duplicate Action in Flight Rule
 * Prevents double-scheduling identical actions while one is already pending.
 */
export class DuplicateActionRule implements IPolicyRule {
  readonly name = 'DuplicateActionRule';
  evaluate(context: PolicyExecutionContext): RuleResult | null {
    const hasPendingDuplicate = context.priorActions.some(
      (a) => a.actionType === context.proposedActionType && (a.status === 'PENDING' || a.status === 'RUNNING'),
    );
    if (hasPendingDuplicate) {
      return {
        decision: PolicyDecision.DENY,
        reasonCode: PolicyReasonCodes.DUPLICATE_ACTION_IN_FLIGHT,
        rationale: `An identical action of type "${context.proposedActionType}" is already pending or executing.`,
        violation: 'DUPLICATE_ACTION_IN_FLIGHT',
      };
    }
    return null;
  }
}

/**
 * 6. Action Compatibility Rule
 * The proposed action must be canonically compatible with the case's risk family.
 */
export class ActionCompatibilityRule implements IPolicyRule {
  readonly name = 'ActionCompatibilityRule';
  evaluate(context: PolicyExecutionContext): RuleResult | null {
    if (!isActionCompatible(context.case.riskType, context.proposedActionType)) {
      return {
        decision: PolicyDecision.DENY,
        reasonCode: PolicyReasonCodes.INCOMPATIBLE_ACTION_FOR_RISK,
        rationale: `Proposed action "${context.proposedActionType}" is not valid for risk family "${context.case.riskType}".`,
        violation: `INCOMPATIBLE_ACTION_${context.proposedActionType}_FOR_${context.case.riskType}`,
      };
    }
    return null;
  }
}

/**
 * 7. Customer Opt-Out Rule
 * Customers who opted out cannot receive customer-facing communication actions.
 */
export class CustomerOptOutRule implements IPolicyRule {
  readonly name = 'CustomerOptOutRule';
  evaluate(context: PolicyExecutionContext): RuleResult | null {
    if (
      isCustomerCommunicationAction(context.proposedActionType) &&
      context.customer?.optedOut === true
    ) {
      return {
        decision: PolicyDecision.DENY,
        reasonCode: PolicyReasonCodes.CUSTOMER_OPTED_OUT,
        rationale: 'Customer has explicitly opted out of communications; customer-facing recovery is forbidden.',
        violation: 'CUSTOMER_OPTED_OUT',
      };
    }
    return null;
  }
}

/**
 * 8. Contact Consent Rule
 * Outbound communication requires verified contact consent.
 */
export class ContactConsentRule implements IPolicyRule {
  readonly name = 'ContactConsentRule';
  evaluate(context: PolicyExecutionContext): RuleResult | null {
    if (
      isCustomerCommunicationAction(context.proposedActionType) &&
      context.customer &&
      context.customer.contactConsent === false
    ) {
      return {
        decision: PolicyDecision.DENY,
        reasonCode: PolicyReasonCodes.CONTACT_CONSENT_MISSING,
        rationale: 'Customer contact consent is explicitly withheld/false; outbound messaging is forbidden.',
        violation: 'MISSING_CONTACT_CONSENT',
      };
    }
    return null;
  }
}

/**
 * 9. Hard Decline Blocks Payment Retry Rule
 * Evaluates AUTHORITATIVE verified provider failure code (NEVER AI diagnosis).
 * Missing verified failure code on RETRY_PAYMENT fails closed with REQUIRED_FACTS_MISSING.
 */
export class HardDeclineRule implements IPolicyRule {
  readonly name = 'HardDeclineRule';
  evaluate(context: PolicyExecutionContext): RuleResult | null {
    if (context.proposedActionType === RecoveryActionType.RETRY_PAYMENT) {
      const verifiedCode =
        context.verifiedPaymentFailureCode ??
        context.verifiedPaymentFacts?.gatewayErrorCode;

      if (!verifiedCode || !verifiedCode.trim()) {
        return {
          decision: PolicyDecision.DENY,
          reasonCode: PolicyReasonCodes.REQUIRED_FACTS_MISSING,
          rationale: 'Verified payment gateway failure code is missing; payment retries require ground-truth provider failure facts.',
          violation: 'MISSING_VERIFIED_PAYMENT_FAILURE_CODE',
        };
      }

      if (isHardDecline(verifiedCode)) {
        // If the verified failure was CARD_EXPIRED and an authoritative PAYMENT_METHOD_UPDATED
        // has subsequently been observed in the event/outcome history, new verified credentials
        // are on file and automatic payment retry on updated credentials is permitted.
        const isExpiredCard = verifiedCode.trim().toUpperCase() === 'CARD_EXPIRED';
        const hasAuthoritativeMethodUpdate = (context.priorOutcomes || []).some(
          (o) => o.outcomeType === 'PAYMENT_METHOD_UPDATED' || o.outcomeType === NormalizedEventType.PAYMENT_METHOD_UPDATED,
        );

        if (isExpiredCard && hasAuthoritativeMethodUpdate) {
          // Permitted subject to remaining policy rules (max retries, quiet hours, cooldown)
          return null;
        }

        return {
          decision: PolicyDecision.DENY,
          reasonCode: PolicyReasonCodes.HARD_DECLINE_BLOCKS_RETRY,
          rationale: `Payment failed due to verified hard decline ("${verifiedCode}"); automatic payment retries are strictly prohibited.`,
          violation: 'HARD_DECLINE_RETRY_PROHIBITED',
        };
      }
    }
    return null;
  }
}

/**
 * 10. Max Retries Rule
 * Enforces merchant-configured maximum payment retries per case.
 */
export class MaxRetriesRule implements IPolicyRule {
  readonly name = 'MaxRetriesRule';
  evaluate(context: PolicyExecutionContext, facts: PolicyEvaluatedFacts): RuleResult | null {
    if (context.proposedActionType === RecoveryActionType.RETRY_PAYMENT) {
      if (facts.retryCount >= context.policyConfig.maxRetriesPerCase) {
        return {
          decision: PolicyDecision.DENY,
          reasonCode: PolicyReasonCodes.MAX_RETRIES_EXCEEDED,
          rationale: `Case has reached maximum allowed payment retries (${facts.retryCount}/${context.policyConfig.maxRetriesPerCase}).`,
          violation: 'MAX_RETRIES_EXCEEDED',
        };
      }
    }
    return null;
  }
}

/**
 * 11. Max Contacts Rule
 * Enforces merchant-configured maximum customer contacts per case.
 */
export class MaxContactsRule implements IPolicyRule {
  readonly name = 'MaxContactsRule';
  evaluate(context: PolicyExecutionContext, facts: PolicyEvaluatedFacts): RuleResult | null {
    if (isCustomerCommunicationAction(context.proposedActionType)) {
      if (facts.contactCount >= context.policyConfig.maxContactsPerCase) {
        return {
          decision: PolicyDecision.DENY,
          reasonCode: PolicyReasonCodes.MAX_CONTACTS_EXCEEDED,
          rationale: `Case has reached maximum allowed customer contacts (${facts.contactCount}/${context.policyConfig.maxContactsPerCase}).`,
          violation: 'MAX_CONTACTS_EXCEEDED',
        };
      }
    }
    return null;
  }
}

/**
 * 12. Max Total Actions Rule
 * Enforces merchant-configured maximum total recovery actions per case.
 */
export class MaxTotalActionsRule implements IPolicyRule {
  readonly name = 'MaxTotalActionsRule';
  evaluate(context: PolicyExecutionContext, facts: PolicyEvaluatedFacts): RuleResult | null {
    if (
      context.proposedActionType !== RecoveryActionType.STOP_RECOVERY &&
      context.proposedActionType !== RecoveryActionType.ESCALATE_TO_HUMAN
    ) {
      if (facts.totalActionsCount >= context.policyConfig.maxActionsPerCase) {
        return {
          decision: PolicyDecision.DENY,
          reasonCode: PolicyReasonCodes.MAX_ACTIONS_EXCEEDED,
          rationale: `Case has reached maximum allowed total actions (${facts.totalActionsCount}/${context.policyConfig.maxActionsPerCase}).`,
          violation: 'MAX_TOTAL_ACTIONS_EXCEEDED',
        };
      }
    }
    return null;
  }
}

/**
 * 13. Cooldown Rule
 * Enforces minimum quiet time between recovery actions to prevent spamming customers or payment rails.
 */
export class CooldownRule implements IPolicyRule {
  readonly name = 'CooldownRule';
  evaluate(context: PolicyExecutionContext, facts: PolicyEvaluatedFacts): RuleResult | null {
    if (
      context.proposedActionType === RecoveryActionType.STOP_RECOVERY ||
      context.proposedActionType === RecoveryActionType.ESCALATE_TO_HUMAN
    ) {
      return null;
    }

    if (
      facts.hoursSinceLastAction !== null &&
      facts.hoursSinceLastAction < context.policyConfig.cooldownHoursBetweenActions
    ) {
      return {
        decision: PolicyDecision.DENY,
        reasonCode: PolicyReasonCodes.COOLDOWN_VIOLATION,
        rationale: `Action cooldown active: ${facts.hoursSinceLastAction.toFixed(1)}h elapsed since last action, but ${context.policyConfig.cooldownHoursBetweenActions}h required.`,
        violation: 'COOLDOWN_INSUFFICIENT_TIME_ELAPSED',
      };
    }
    return null;
  }
}

/**
 * 14. Quiet Hours Rule
 * Prohibits outbound customer messaging during nighttime quiet hours.
 */
export class QuietHoursRule implements IPolicyRule {
  readonly name = 'QuietHoursRule';
  evaluate(context: PolicyExecutionContext, facts: PolicyEvaluatedFacts): RuleResult | null {
    if (isCustomerCommunicationAction(context.proposedActionType) && facts.inQuietHours) {
      return {
        decision: PolicyDecision.DENY,
        reasonCode: PolicyReasonCodes.QUIET_HOURS_VIOLATION,
        rationale: `Outbound customer communication is prohibited during quiet hours (current local hour: ${facts.quietHoursLocalHour}:00).`,
        violation: 'QUIET_HOURS_RESTRICTION',
      };
    }
    return null;
  }
}

/**
 * 15. Expired Recovery Window Rule
 * Denies recovery actions when the case has exceeded the maximum recovery window (e.g. 30 days).
 */
export class ExpiredRecoveryWindowRule implements IPolicyRule {
  readonly name = 'ExpiredRecoveryWindowRule';
  evaluate(context: PolicyExecutionContext): RuleResult | null {
    if (context.proposedActionType === RecoveryActionType.STOP_RECOVERY) {
      return null;
    }

    const now = context.currentTime;
    const maxDays = context.policyConfig.maxRecoveryWindowDays ?? 30;
    const ageMs = now.getTime() - context.case.openedAt.getTime();
    const ageDays = ageMs / (1000 * 60 * 60 * 24);

    if (ageDays > maxDays) {
      return {
        decision: PolicyDecision.DENY,
        reasonCode: PolicyReasonCodes.EXPIRED_RECOVERY_WINDOW,
        rationale: `Case opened ${ageDays.toFixed(0)} days ago, exceeding maximum recovery window of ${maxDays} days.`,
        violation: 'MAX_RECOVERY_WINDOW_EXPIRED',
      };
    }
    return null;
  }
}

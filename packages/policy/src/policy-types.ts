import {
  PolicyDecision,
  RecoveryActionType,
  RiskType,
  CaseStatus,
  Money,
} from '@recoverai/shared';
import { PolicyReasonCode } from './policy-reason-codes.js';
import { isValidIanaTimezone } from './quiet-hours.js';

export interface PriorActionRecord {
  actionType: RecoveryActionType;
  executedAt: Date;
  status: string; // e.g. 'SUCCESS', 'FAILED', 'PENDING'
  policyDecision?: string;
  errorMessage?: string | null;
}

export interface PriorOutcomeRecord {
  outcomeType: string;
  observedAt: Date;
  amountRecovered?: string | null;
}

export interface ActiveCommitmentRecord {
  id: string;
  promisedAmount: string;
  promisedDate: Date;
  status: string; // e.g. 'PENDING', 'FULFILLED', 'BROKEN'
}

export interface PolicyCustomerData {
  id: string;
  contactConsent?: boolean | null; // null = unknown / unverified consent
  optedOut?: boolean;
  lastContactedAt?: Date | null;
}

export interface PolicyCaseData {
  id: string;
  merchantId: string;
  riskType: RiskType;
  amountAtRisk: string; // Decimal string e.g. "14999.00"
  currency: string;
  status: CaseStatus;
  openedAt: Date;
  diagnosisCode?: string | null;
}

export interface PolicyConfigData {
  maxRetriesPerCase: number;
  maxContactsPerCase: number;
  maxActionsPerCase: number;
  cooldownHoursBetweenActions: number;
  highValueThreshold: string; // Decimal string e.g. "50000.00"
  minConfidenceThreshold: number;
  reviewFirstMode: boolean;
  checkoutAbandonmentThresholdMinutes?: number;
  quietHoursStart?: number;
  quietHoursEnd?: number;
  quietHoursTimezone?: string;
  maxRecoveryWindowDays?: number;
  overdueGracePeriodDays?: number;
}

export function getPolicyConfigValidationError(config: PolicyConfigData): string | null {
  if (!Number.isInteger(config.maxActionsPerCase) || config.maxActionsPerCase <= 0) {
    return 'maxActionsPerCase must be an integer >= 1';
  }
  if (!Number.isInteger(config.maxRetriesPerCase) || config.maxRetriesPerCase < 0) {
    return 'maxRetriesPerCase must be an integer >= 0';
  }
  if (!Number.isInteger(config.maxContactsPerCase) || config.maxContactsPerCase < 0) {
    return 'maxContactsPerCase must be an integer >= 0';
  }
  if (typeof config.cooldownHoursBetweenActions !== 'number' || config.cooldownHoursBetweenActions < 0) {
    return 'cooldownHoursBetweenActions must be a number >= 0';
  }
  if (typeof config.minConfidenceThreshold !== 'number' || config.minConfidenceThreshold < 0 || config.minConfidenceThreshold > 1) {
    return 'minConfidenceThreshold must be a number between 0 and 1';
  }
  if (config.quietHoursStart !== undefined && (!Number.isInteger(config.quietHoursStart) || config.quietHoursStart < 0 || config.quietHoursStart > 23)) {
    return 'quietHoursStart must be an integer between 0 and 23';
  }
  if (config.quietHoursEnd !== undefined && (!Number.isInteger(config.quietHoursEnd) || config.quietHoursEnd < 0 || config.quietHoursEnd > 23)) {
    return 'quietHoursEnd must be an integer between 0 and 23';
  }
  if (config.quietHoursTimezone !== undefined && !isValidIanaTimezone(config.quietHoursTimezone)) {
    return `quietHoursTimezone "${config.quietHoursTimezone}" is not a valid IANA timezone`;
  }
  if (config.maxRecoveryWindowDays !== undefined && (!Number.isInteger(config.maxRecoveryWindowDays) || config.maxRecoveryWindowDays <= 0)) {
    return 'maxRecoveryWindowDays must be an integer >= 1';
  }
  if (config.overdueGracePeriodDays !== undefined && (!Number.isInteger(config.overdueGracePeriodDays) || config.overdueGracePeriodDays < 0)) {
    return 'overdueGracePeriodDays must be an integer >= 0';
  }
  if (!Money.isValidDecimalString(config.highValueThreshold)) {
    return 'highValueThreshold must be a valid exact decimal monetary string';
  }
  return null;
}

export interface VerifiedPaymentFacts {
  gatewayErrorCode?: string | null;
  gatewayErrorMessage?: string | null;
  paymentMethod?: string | null;
  cardNetwork?: string | null;
  cardLast4?: string | null;
  bankName?: string | null;
  retryAttemptNumber?: number;
  isRecurring?: boolean;
}

export interface PolicyExecutionContext {
  merchantId: string;
  killSwitchActive: boolean;
  policyConfig: PolicyConfigData;
  case: PolicyCaseData;
  customer?: PolicyCustomerData | null;
  proposedActionType: RecoveryActionType;
  proposedActionParams?: Record<string, unknown>;
  confidence?: number;
  diagnosisCode?: string; // AI interpretation (NOT authoritative for safety rules)
  diagnosisSummary?: string;
  verifiedPaymentFailureCode?: string | null; // Authoritative ground-truth payment failure code from provider
  verifiedPaymentFacts?: VerifiedPaymentFacts | null;
  shouldEscalate?: boolean;
  shouldStop?: boolean;
  priorActions: PriorActionRecord[];
  priorOutcomes: PriorOutcomeRecord[];
  activeCommitments?: ActiveCommitmentRecord[];
  currentTime: Date; // Authoritative clock: strictly required for deterministic evaluation
}

export interface PolicyEvaluatedFacts {
  merchantKillSwitch: boolean;
  caseStatus: CaseStatus;
  caseAmount: string;
  caseCurrency: string;
  riskType: RiskType;
  proposedActionType: RecoveryActionType;
  totalActionsCount: number;
  maxActionsAllowed: number;
  retryCount: number;
  maxRetriesAllowed: number;
  contactCount: number;
  maxContactsAllowed: number;
  hoursSinceLastAction: number | null;
  cooldownHoursRequired: number;
  inQuietHours: boolean;
  quietHoursLocalHour: number;
  customerOptedOut: boolean;
  customerContactConsent: boolean | null;
  customerRecordPresent: boolean;
  verifiedPaymentFailureCode: string | null;
  isHardDecline: boolean;
  proposalConfidence: number | null;
  confidenceThreshold: number;
  isHighValue: boolean;
  consecutiveFailedActions: number;
  hasBrokenPromise: boolean;
  reviewFirstModeActive: boolean;
}

export interface PolicyEvaluationResult {
  decision: PolicyDecision; // Exactly 'ALLOW' | 'DENY' | 'REVIEW'
  reasonCode: PolicyReasonCode;
  rationale: string;
  evaluatedFacts: PolicyEvaluatedFacts;
  evaluatedAt: Date;
  violations?: string[];
}

export interface IPolicyEngine {
  evaluate(context: PolicyExecutionContext): PolicyEvaluationResult;
}

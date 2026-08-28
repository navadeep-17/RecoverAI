import {
  PolicyDecision,
  RecoveryActionType,
  RiskType,
  CaseStatus,
} from '@recoverai/shared';
import { PolicyReasonCode } from './policy-reason-codes.js';

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
  contactConsent: boolean;
  optedOut: boolean;
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
  cooldownHoursBetweenActions: number;
  highValueThreshold: string; // Decimal string e.g. "50000.00"
  minConfidenceThreshold: number;
  reviewFirstMode: boolean;
  checkoutAbandonmentThresholdMinutes?: number;
  quietHoursStart?: number;
  quietHoursEnd?: number;
  quietHoursTimezone?: string;
  maxRecoveryWindowDays?: number;
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
  diagnosisCode?: string;
  diagnosisSummary?: string;
  shouldEscalate?: boolean;
  shouldStop?: boolean;
  priorActions: PriorActionRecord[];
  priorOutcomes: PriorOutcomeRecord[];
  activeCommitments?: ActiveCommitmentRecord[];
  currentTime?: Date;
}

export interface PolicyEvaluatedFacts {
  merchantKillSwitch: boolean;
  caseStatus: CaseStatus;
  caseAmount: string;
  caseCurrency: string;
  riskType: RiskType;
  proposedActionType: RecoveryActionType;
  retryCount: number;
  maxRetriesAllowed: number;
  contactCount: number;
  maxContactsAllowed: number;
  hoursSinceLastAction: number | null;
  cooldownHoursRequired: number;
  inQuietHours: boolean;
  quietHoursLocalHour: number;
  customerOptedOut: boolean;
  customerContactConsent: boolean;
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

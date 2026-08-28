import {
  PolicyDecision,
  RecoveryActionType,
  RiskType,
  CaseStatus,
} from '@recoverai/shared';

export interface PriorActionRecord {
  actionType: RecoveryActionType;
  executedAt: Date;
  status: string;
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
  status: string;
}

export interface PolicyCustomerData {
  id: string;
  contactConsent?: boolean | null;
  optedOut?: boolean;
  lastContactedAt?: Date | null;
}

export interface PolicyCaseData {
  id: string;
  merchantId: string;
  riskType: RiskType;
  amountAtRisk: string;
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
  highValueThreshold: string;
  minConfidenceThreshold: number;
  reviewFirstMode: boolean;
  checkoutAbandonmentThresholdMinutes?: number;
  quietHoursStart?: number;
  quietHoursEnd?: number;
  quietHoursTimezone?: string;
  maxRecoveryWindowDays?: number;
  overdueGracePeriodDays?: number;
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
  verifiedPaymentFailureCode?: string | null;
  shouldEscalate?: boolean;
  shouldStop?: boolean;
  priorActions: PriorActionRecord[];
  priorOutcomes: PriorOutcomeRecord[];
  activeCommitments?: ActiveCommitmentRecord[];
  currentTime: Date;
}

export interface PolicyEvaluationResult {
  decision: PolicyDecision;
  reasonCode: string;
  rationale: string;
  evaluatedFacts?: Record<string, unknown>;
  evaluatedAt: Date;
  violations?: string[];
}

export interface IPolicyEngine {
  evaluate(context: PolicyExecutionContext): PolicyEvaluationResult;
}

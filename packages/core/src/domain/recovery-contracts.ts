import {
  RiskType,
  CaseStatus,
  PolicyDecision,
  RecoveryActionType,
  ActionExecutionStatus,
  AuditActorType,
  MerchantEventSource,
} from '@recoverai/shared';

export interface IDomainMerchant {
  id: string;
  name: string;
  slug: string;
  killSwitchActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface IDomainCustomer {
  id: string;
  merchantId: string;
  externalCustomerId?: string | null;
  email?: string | null;
  phone?: string | null;
  name?: string | null;
  contactConsent: boolean;
  optedOut: boolean;
  lastContactedAt?: Date | null;
  metadataJson?: Record<string, unknown> | null;
}

export interface IDomainCase {
  id: string;
  merchantId: string;
  customerId?: string | null;
  riskType: RiskType;
  amountAtRisk: string; // Decimal string e.g. "14999.00"
  currency: string;
  status: CaseStatus;
  contextJson: Record<string, unknown>;
  openedAt: Date;
  nextEvaluationAt?: Date | null;
  recoveredAmount?: string | null;
  resolvedAt?: Date | null;
}

export interface IDomainPlanVersion {
  id: string;
  caseId: string;
  version: number;
  diagnosisCode: string;
  diagnosisSummary: string;
  confidence: number;
  proposedActionType: RecoveryActionType;
  proposedActionParams: Record<string, unknown>;
  reasoningSummary: string;
  followUpAfterSeconds?: number | null;
  shouldStop: boolean;
  shouldEscalate: boolean;
  createdAt: Date;
}

export interface IDomainAction {
  id: string;
  caseId: string;
  planVersionId?: string | null;
  actionType: RecoveryActionType;
  actionParams: Record<string, unknown>;
  idempotencyKey: string;
  policyDecision: PolicyDecision;
  policyRationale: string;
  status: ActionExecutionStatus;
  providerName?: string | null;
  externalActionId?: string | null;
  executionMetadata?: Record<string, unknown> | null;
  errorMessage?: string | null;
  executedAt?: Date | null;
}

export interface IDomainOutcome {
  id: string;
  caseId: string;
  actionId?: string | null;
  merchantEventId?: string | null;
  outcomeType: string;
  amountRecovered?: string | null;
  detailsJson?: Record<string, unknown> | null;
  observedAt: Date;
}

export interface IDomainPolicyConfig {
  id: string;
  merchantId: string;
  maxRetriesPerCase: number;
  maxContactsPerCase: number;
  cooldownHoursBetweenActions: number;
  highValueThreshold: string;
  minConfidenceThreshold: number;
  reviewFirstMode: boolean;
  checkoutAbandonmentThresholdMinutes: number;
}

export interface IDomainAuditEvent {
  id: string;
  merchantId: string;
  caseId?: string | null;
  eventType: string;
  actorType: AuditActorType;
  actorId?: string | null;
  inputSummaryJson?: Record<string, unknown> | null;
  outputSummaryJson?: Record<string, unknown> | null;
  reasonCode?: string | null;
  createdAt: Date;
}

export interface IDomainMerchantEvent {
  id: string;
  merchantId: string;
  source: MerchantEventSource;
  externalEventId?: string | null;
  type: string;
  occurredAt: Date;
  receivedAt: Date;
  dedupeKey: string;
  payloadJson: Record<string, unknown>;
}

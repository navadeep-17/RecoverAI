import {
  CaseStatus,
  PolicyDecision,
  RecoveryAction,
  RecoveryPlanVersion,
  RecoveryOutcome,
} from '@prisma/client';

export interface OrchestrationTriggerPayload {
  triggerKey: string;
  triggerType: string;
  merchantEventId?: string;
  customerMessageId?: string;
  scheduledJobId?: string;
}

export type OrchestrationTrigger =
  | 'CASE_OPENED'
  | 'REPLAN_TRIGGERED'
  | 'OBSERVATION_ARRIVED'
  | 'TIMER_FIRED'
  | 'MANUAL_RETRY'
  | OrchestrationTriggerPayload;

export interface EligibilityCheckResult {
  eligible: boolean;
  terminalState?: boolean;
  needsReview?: boolean;
  shouldStop?: boolean;
  shouldExhaust?: boolean;
  reason?: string;
}

export interface OrchestrationIterationResult {
  caseId: string;
  status: CaseStatus;
  iterationCompleted: boolean;
  planVersion?: RecoveryPlanVersion;
  action?: RecoveryAction | null;
  policyDecision?: PolicyDecision;
  outcome?: RecoveryOutcome | null;
  stoppedReason?: string;
  exhaustedReason?: string;
  reviewReason?: string;
  error?: string;
}

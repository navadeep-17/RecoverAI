import { PolicyDecision, RecoveryActionType } from '@recoverai/shared';

export interface PolicyEvaluationInput {
  merchantId: string;
  caseId: string;
  proposedAction: RecoveryActionType;
  actionParams?: Record<string, unknown>;
  confidence?: number;
}

export interface PolicyEvaluationResult {
  decision: PolicyDecision;
  rationale: string;
  violations?: string[];
  reviewReason?: string;
}

export interface IPolicyEngine {
  evaluate(input: PolicyEvaluationInput): Promise<PolicyEvaluationResult>;
}

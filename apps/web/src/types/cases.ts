export type CaseStatus = 'OPEN' | 'WAITING' | 'NEEDS_REVIEW' | 'RECOVERED' | 'STOPPED' | 'EXHAUSTED';
export type RiskType = 'PAYMENT_FAILURE' | 'SUBSCRIPTION_FAILURE' | 'CHECKOUT_ABANDONMENT' | 'OVERDUE_RECEIVABLE';

export interface RecoveryCase {
  id: string; merchantId: string; customerId?: string | null; riskType: RiskType; amountAtRisk: string;
  recoveredAmount?: string | null; currency: string; status: CaseStatus; openedAt: string; updatedAt?: string;
  contextJson?: Record<string, unknown> | null;
  customer?: { id: string; name?: string | null; email?: string | null } | null;
  planVersions?: PlanVersion[]; actions?: RecoveryAction[]; outcomes?: RecoveryOutcome[];
}
export interface PlanVersion { id: string; version: number; diagnosisCode: string; diagnosisSummary: string; confidence: number; proposedActionType: string; reasoningSummary?: string | null; createdAt: string; }
export interface RecoveryAction { id: string; actionType: string; status: string; policyDecision: string; policyRationale?: string | null; providerName?: string | null; externalActionId?: string | null; createdAt: string; executedAt?: string | null; }
export interface RecoveryOutcome { id: string; outcomeType: string; amountRecovered?: string | null; observedAt: string; detailsJson?: Record<string, unknown> | null; }
export interface AuditEvent { id: string; eventType: string; actorType: string; reasonCode?: string | null; createdAt: string; }
export interface CaseDetailResponse { case: RecoveryCase; auditEvents: AuditEvent[]; }
export interface RevenueRadarMetrics { revenueAtRisk: string; verifiedRecovered: string; activeRecoveries: number; needsReview: number; riskTypeBreakdown: Record<string, { count: number; amountAtRisk: string }>; statusBreakdown: Record<string, number>; }

import { z } from 'zod';
import { RiskType, RecoveryActionType } from '@recoverai/shared';

/**
 * Hard decline failure codes that indicate permanent or security-related failures.
 * In these situations, automatic payment retry must be blocked.
 */
export const HARD_DECLINE_CODES = [
  'FRAUD_SUSPECTED',
  'FRAUD',
  'CARD_LOST_OR_STOLEN',
  'LOST_CARD',
  'STOLEN_CARD',
  'ACCOUNT_CLOSED',
  'DO_NOT_HONOR',
  'STOPPED_BY_CUSTOMER',
  'INVALID_PIN',
  'INCORRECT_CVV',
  'CARD_EXPIRED',
  '3DS_AUTHENTICATION_FAILED',
  'AUTHENTICATION_FAILED',
] as const;

export type HardDeclineCode = (typeof HARD_DECLINE_CODES)[number];

export function isHardDecline(code?: string | null): boolean {
  if (!code) return false;
  const normalized = code.toUpperCase().replace(/[-\s]+/g, '_');
  return HARD_DECLINE_CODES.some((h) => normalized.includes(h) || h.includes(normalized));
}

/**
 * Zod Schema for Structured Agent Proposals.
 * Proposes EXACTLY ONE next action with strict confidence bounds [0, 1].
 */
export const AgentProposalSchema = z.object({
  diagnosisCode: z.string().min(1, 'diagnosisCode is required'),
  diagnosisSummary: z.string().min(1, 'diagnosisSummary is required'),
  confidence: z.number().min(0, 'confidence must be >= 0').max(1, 'confidence must be <= 1'),
  proposedActionType: z.nativeEnum(RecoveryActionType, {
    errorMap: () => ({ message: 'Invalid or unsupported RecoveryActionType' }),
  }),
  proposedActionParams: z.record(z.unknown()).default({}),
  reasoningSummary: z.string().min(1, 'reasoningSummary is required'),
  followUpAfterSeconds: z.number().int().positive().nullable().optional(),
  shouldStop: z.boolean().default(false),
  shouldEscalate: z.boolean().default(false),
});

export type AgentProposal = z.infer<typeof AgentProposalSchema>;

export interface VerifiedPaymentFacts {
  gatewayErrorCode?: string | null;
  gatewayErrorMessage?: string | null;
  paymentMethod?: string | null; // e.g. 'card', 'upi', 'netbanking'
  cardNetwork?: string | null; // e.g. 'Visa', 'Mastercard'
  cardLast4?: string | null;
  bankName?: string | null;
  retryAttemptNumber?: number;
  isRecurring?: boolean;
}

export interface CustomerHistorySummary {
  totalPastCases: number;
  successfullyRecoveredCases: number;
  contactConsent: boolean;
  optedOut: boolean;
  lastContactedAt?: Date | null;
}

export interface PriorActionSummary {
  actionType: RecoveryActionType;
  executedAt: Date;
  status: string;
  policyDecision: string;
  errorMessage?: string | null;
}

export interface PriorOutcomeSummary {
  outcomeType: string;
  observedAt: Date;
  amountRecovered?: string | null;
}

/**
 * Complete, verified, and authoritative context provided to the Recovery Agent.
 * The LLM only receives verified facts and does not determine ground truth.
 */
export interface AgentContext {
  caseId: string;
  merchantId: string;
  riskType: RiskType;
  amountAtRisk: string; // Exact decimal string e.g. "14999.00"
  currency: string;
  caseOpenedAt: Date;
  verifiedPaymentFacts?: VerifiedPaymentFacts;
  customerHistory?: CustomerHistorySummary;
  priorActions: PriorActionSummary[];
  priorOutcomes: PriorOutcomeSummary[];
  customerReplyText?: string | null;
  retryCount: number;
  contactCount: number;
  allowedActions: readonly RecoveryActionType[];
  policySummary?: {
    maxRetries: number;
    maxContacts: number;
    cooldownHours: number;
    reviewFirstMode: boolean;
    highValueThreshold: string;
  };
}

import { z } from 'zod';
import { RiskType, RecoveryActionType } from '@recoverai/shared';

/**
 * Exact canonical hard decline failure codes that indicate permanent or security-related failures.
 * In these situations, automatic payment retry must be blocked.
 * NO arbitrary substring inference is used.
 */
export const CANONICAL_HARD_DECLINE_CODES = [
  'FRAUD_SUSPECTED',
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
  'EXPIRED_CARD',
  'STOLEN_OR_LOST_CARD',
  'CUSTOMER_DISPUTE',
  'PICK_UP_CARD',
  'RESTRICTED_CARD',
] as const;

export type HardDeclineCode = (typeof CANONICAL_HARD_DECLINE_CODES)[number];

const CANONICAL_HARD_DECLINE_SET = new Set<string>(CANONICAL_HARD_DECLINE_CODES);

const HARD_DECLINE_ALIAS_MAP: Record<string, HardDeclineCode> = {
  FRAUD: 'FRAUD_SUSPECTED',
  FRAUDULENT: 'FRAUD_SUSPECTED',
  CARD_LOST: 'LOST_CARD',
  CARD_STOLEN: 'STOLEN_CARD',
  CLOSED_ACCOUNT: 'ACCOUNT_CLOSED',
  CUSTOMER_STOPPED: 'STOPPED_BY_CUSTOMER',
  CVV_FAIL: 'INCORRECT_CVV',
  PIN_FAIL: 'INVALID_PIN',
  AUTH_FAILED: 'AUTHENTICATION_FAILED',
  THREE_DS_FAILED: '3DS_AUTHENTICATION_FAILED',
};

export function isHardDecline(code?: string | null): boolean {
  if (!code || !code.trim()) return false;
  const normalized = code.trim().toUpperCase().replace(/[-\s]+/g, '_');
  return CANONICAL_HARD_DECLINE_SET.has(normalized) || HARD_DECLINE_ALIAS_MAP[normalized] !== undefined;
}

/**
 * Strict Zod Schema for Structured Agent Proposals.
 * - Proposes EXACTLY ONE next action with strict confidence bounds [0, 1].
 * - .strict() rejects any unknown/injected extra fields (e.g. policyDecision, executeNow, toolCall).
 */
export const AgentProposalSchema = z
  .object({
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
  })
  .strict();

export type AgentProposal = z.infer<typeof AgentProposalSchema>;

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
    maxActions: number;
    cooldownHours: number;
    reviewFirstMode: boolean;
    highValueThreshold: string;
  };
}

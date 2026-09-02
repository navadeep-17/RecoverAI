import { LLMProvider, LLMRequest, LLMResponse } from './llm-provider.js';
import { AgentProposal } from './agent-contracts.js';
import { RecoveryActionType } from '@recoverai/shared';

/**
 * Deterministic Mock LLM Provider for Tests and Local Development.
 * Produces structured, reproducible recovery proposals given normalized input context.
 * Clearly labeled as simulated / deterministic.
 */
export class MockLLMProvider implements LLMProvider {
  public readonly providerName = 'deterministic-mock';
  private mockOverride: string | null = null;
  private mockError: Error | null = null;
  private lastRequest: LLMRequest | null = null;

  public setMockResponse(response: string | Partial<AgentProposal>): void {
    if (typeof response === 'string') {
      this.mockOverride = response;
    } else {
      this.mockOverride = JSON.stringify(response);
    }
  }

  public setMockError(error: Error): void {
    this.mockError = error;
  }

  public clearMockOverride(): void {
    this.mockOverride = null;
    this.mockError = null;
  }

  public getLastRequest(): LLMRequest | null {
    return this.lastRequest;
  }

  async generateText(request: LLMRequest): Promise<LLMResponse> {
    this.lastRequest = request;

    if (this.mockError) {
      throw this.mockError;
    }

    if (this.mockOverride !== null) {
      return {
        rawText: this.mockOverride,
        modelName: 'deterministic-mock-v1',
        usage: { promptTokens: 100, completionTokens: 50 },
      };
    }

    // Deterministic proposal generation based on userPrompt content
    const prompt = request.userPrompt;
    let proposal: AgentProposal;

    if (prompt.includes('"riskType": "CHECKOUT_ABANDONMENT"')) {
      proposal = {
        diagnosisCode: 'CHECKOUT_ABANDONED',
        diagnosisSummary: 'Customer abandoned checkout cart with pending items',
        confidence: 0.85,
        proposedActionType: RecoveryActionType.SEND_CHECKOUT_RECOVERY,
        proposedActionParams: {
          channel: 'WHATSAPP',
          templateId: 'abandoned_cart_recovery_v1',
          incentiveOffered: false,
        },
        reasoningSummary: 'Customer demonstrated high intent before dropping off; send recovery link via WhatsApp',
        followUpAfterSeconds: 3600,
        shouldStop: false,
        shouldEscalate: false,
      };
    } else if (prompt.includes('"riskType": "OVERDUE_RECEIVABLE"')) {
      proposal = {
        diagnosisCode: 'INVOICE_PAST_DUE',
        diagnosisSummary: 'Commercial invoice exceeded due date without payment',
        confidence: 0.82,
        proposedActionType: RecoveryActionType.SEND_RECEIVABLE_REMINDER,
        proposedActionParams: {
          channel: 'EMAIL',
          reminderLevel: 1,
          includeInvoicePdf: true,
        },
        reasoningSummary: 'Friendly payment reminder is appropriate for initial overdue receivable notice',
        followUpAfterSeconds: 86400,
        shouldStop: false,
        shouldEscalate: false,
      };
    } else if (prompt.includes('"riskType": "SUBSCRIPTION_FAILURE"')) {
      const isHard = prompt.includes('FRAUD') || prompt.includes('CARD_EXPIRED') || prompt.includes('LOST_CARD');
      if (isHard) {
        proposal = {
          diagnosisCode: 'SUBSCRIPTION_CARD_EXPIRED',
          diagnosisSummary: 'Recurring subscription mandate failed due to expired/invalid card credentials',
          confidence: 0.92,
          proposedActionType: RecoveryActionType.REQUEST_PAYMENT_UPDATE,
          proposedActionParams: {
            channel: 'EMAIL',
            updateMethod: 'MANDATE_UPDATE_LINK',
          },
          reasoningSummary: 'Card cannot be retried automatically; request customer to update payment method',
          followUpAfterSeconds: 43200,
          shouldStop: false,
          shouldEscalate: false,
        };
      } else {
        proposal = {
          diagnosisCode: 'SUBSCRIPTION_TEMPORARY_DECLINE',
          diagnosisSummary: 'Subscription renewal payment failed due to temporary bank decline',
          confidence: 0.88,
          proposedActionType: RecoveryActionType.RETRY_PAYMENT,
          proposedActionParams: {
            attemptNumber: 1,
            retryChannel: 'RECURRING_AUTO_DEBIT',
          },
          reasoningSummary: 'Soft decline on subscription charge is eligible for intelligent retry',
          followUpAfterSeconds: 21600,
          shouldStop: false,
          shouldEscalate: false,
        };
      }
    } else {
      // Default: PAYMENT_FAILURE
      const isHard = prompt.includes('FRAUD') || prompt.includes('CARD_EXPIRED') || prompt.includes('DO_NOT_HONOR') || prompt.includes('LOST');
      if (isHard) {
        proposal = {
          diagnosisCode: 'HARD_DECLINE_DETECTED',
          diagnosisSummary: 'Payment declined with permanent issuer rejection code',
          confidence: 0.90,
          proposedActionType: RecoveryActionType.CREATE_OR_SEND_PAYMENT_LINK,
          proposedActionParams: {
            channel: 'SMS_AND_EMAIL',
            expiryMinutes: 1440,
          },
          reasoningSummary: 'Direct card retry is not possible; send alternate payment link to customer',
          followUpAfterSeconds: 43200,
          shouldStop: false,
          shouldEscalate: false,
        };
      } else {
        proposal = {
          diagnosisCode: 'SOFT_DECLINE_INSUFFICIENT_FUNDS',
          diagnosisSummary: 'One-time transaction declined due to temporary issuer issue or balance',
          confidence: 0.89,
          proposedActionType: RecoveryActionType.RETRY_PAYMENT,
          proposedActionParams: {
            attemptNumber: 1,
          },
          reasoningSummary: 'Soft decline is eligible for automatic retry after issuer cooldown',
          followUpAfterSeconds: 7200,
          shouldStop: false,
          shouldEscalate: false,
        };
      }
    }

    // Explicit overrides deliberately remain unconstrained so safety tests can
    // exercise RecoveryAgent's rejection path. Normal deterministic output,
    // however, must not contradict the authoritative feasible-action list.
    const allowedActions = this.extractAllowedActions(request.userPrompt);
    if (allowedActions.length > 0 && !allowedActions.includes(proposal.proposedActionType)) {
      const fallback = [
        RecoveryActionType.SCHEDULE_FOLLOWUP,
        RecoveryActionType.ESCALATE_TO_HUMAN,
        RecoveryActionType.STOP_RECOVERY,
      ].find((action) => allowedActions.includes(action)) || allowedActions[0];
      proposal = {
        ...proposal,
        proposedActionType: fallback,
        proposedActionParams: {},
        reasoningSummary: `${proposal.reasoningSummary} Preferred action is not currently feasible; selected an authoritative fallback.`,
        shouldStop: fallback === RecoveryActionType.STOP_RECOVERY,
        shouldEscalate: fallback === RecoveryActionType.ESCALATE_TO_HUMAN,
      };
    }

    return {
      rawText: JSON.stringify(proposal, null, 2),
      modelName: 'deterministic-mock-v1',
      usage: { promptTokens: 150, completionTokens: 80 },
    };
  }

  private extractAllowedActions(userPrompt: string): RecoveryActionType[] {
    const match = userPrompt.match(/"allowedActions"\s*:\s*(\[[\s\S]*?\])/);
    if (!match) return [];
    try {
      const parsed: unknown = JSON.parse(match[1]);
      return Array.isArray(parsed) && parsed.every((value) => typeof value === 'string')
        ? parsed as RecoveryActionType[]
        : [];
    } catch {
      return [];
    }
  }
}

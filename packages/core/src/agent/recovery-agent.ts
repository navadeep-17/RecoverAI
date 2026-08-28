import { AgentContext, AgentProposal, AgentProposalSchema } from './agent-contracts.js';
import { LLMProvider } from './llm-provider.js';
import { isActionCompatible, IncompatibleActionForRiskError } from '../domain/action-compatibility.js';

export class AgentOutputParsingError extends Error {
  constructor(message: string, public readonly rawOutput?: string) {
    super(message);
    this.name = 'AgentOutputParsingError';
  }
}

export class RecoveryAgent {
  constructor(private readonly llmProvider: LLMProvider) {}

  /**
   * Generates a single, structured recovery action proposal based on authoritative verified context.
   *
   * Invariants:
   * - Proposes EXACTLY ONE next action.
   * - Zero direct database mutation.
   * - Zero external third-party side effects.
   * - Zero policy decision making (PolicyEngine decides).
   * - Strict validation against AgentProposalSchema and Action/Risk compatibility.
   */
  async generateProposal(context: AgentContext): Promise<AgentProposal> {
    const systemPrompt = this.buildSystemPrompt();
    const userPrompt = this.buildUserPrompt(context);

    const response = await this.llmProvider.generateText({
      systemPrompt,
      userPrompt,
      temperature: 0.1,
      responseFormat: 'json',
    });

    const parsedJson = this.extractAndParseJson(response.rawText);
    const validatedProposal = AgentProposalSchema.parse(parsedJson);

    // Enforce domain action compatibility for the risk family
    if (!isActionCompatible(context.riskType, validatedProposal.proposedActionType)) {
      throw new IncompatibleActionForRiskError(context.riskType, validatedProposal.proposedActionType);
    }

    return validatedProposal;
  }

  private buildSystemPrompt(): string {
    return `You are the RecoverAI Recovery Intelligence Agent.
Your role is to analyze verified, ground-truth revenue-risk cases and propose EXACTLY ONE optimal next recovery action.

CRITICAL ARCHITECTURAL RULES:
1. You only PROPOSE actions. You NEVER execute actions, mutate data, or decide policy authorization.
2. Return ONLY valid JSON matching the exact required schema. No Markdown commentary outside the JSON object.
3. Propose EXACTLY ONE next action from the allowed action types provided in the context.
4. Confidence must be a float between 0.0 and 1.0.
5. If payment failure was a hard decline (fraud, lost/stolen card, closed account), do NOT propose RETRY_PAYMENT.
6. If recovery is impossible or all avenues are exhausted, set shouldStop to true or propose STOP_RECOVERY.
7. If human intervention is required, set shouldEscalate to true or propose ESCALATE_TO_HUMAN.

REQUIRED JSON OUTPUT SCHEMA:
{
  "diagnosisCode": string (e.g. "INSUFFICIENT_FUNDS", "CARD_EXPIRED", "CHECKOUT_ABANDONED"),
  "diagnosisSummary": string (concise diagnosis),
  "confidence": number (between 0.0 and 1.0),
  "proposedActionType": string (one of the provided allowedActions),
  "proposedActionParams": object (parameters for the action),
  "reasoningSummary": string (concise business justification),
  "followUpAfterSeconds": number | null (optional follow-up interval in seconds),
  "shouldStop": boolean,
  "shouldEscalate": boolean
}`;
  }

  private buildUserPrompt(context: AgentContext): string {
    const serialized = {
      caseId: context.caseId,
      merchantId: context.merchantId,
      riskType: context.riskType,
      amountAtRisk: context.amountAtRisk,
      currency: context.currency,
      caseOpenedAt: context.caseOpenedAt.toISOString(),
      retryCount: context.retryCount,
      contactCount: context.contactCount,
      allowedActions: context.allowedActions,
      verifiedPaymentFacts: context.verifiedPaymentFacts || null,
      customerHistory: context.customerHistory || null,
      priorActions: context.priorActions.map((a) => ({
        actionType: a.actionType,
        executedAt: a.executedAt.toISOString(),
        status: a.status,
        policyDecision: a.policyDecision,
        errorMessage: a.errorMessage || null,
      })),
      priorOutcomes: context.priorOutcomes.map((o) => ({
        outcomeType: o.outcomeType,
        observedAt: o.observedAt.toISOString(),
        amountRecovered: o.amountRecovered || null,
      })),
      customerReplyText: context.customerReplyText || null,
      policySummary: context.policySummary || null,
    };

    return `Here is the verified, authoritative context for the revenue risk case:
${JSON.stringify(serialized, null, 2)}

Analyze the facts and output your single structured JSON recovery proposal.`;
  }

  private extractAndParseJson(rawText: string): unknown {
    if (!rawText || !rawText.trim()) {
      throw new AgentOutputParsingError('LLM response was empty', rawText);
    }

    let cleaned = rawText.trim();
    // Strip markdown code fences if present e.g. ```json ... ```
    if (cleaned.startsWith('```')) {
      const match = cleaned.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
      if (match && match[1]) {
        cleaned = match[1].trim();
      }
    }

    try {
      return JSON.parse(cleaned);
    } catch (err) {
      throw new AgentOutputParsingError(
        `Failed to parse LLM response as JSON: ${(err as Error).message}`,
        rawText,
      );
    }
  }
}

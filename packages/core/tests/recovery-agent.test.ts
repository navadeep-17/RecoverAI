import { describe, it, expect, beforeEach } from 'vitest';
import {
  RecoveryAgent,
  MockLLMProvider,
  AgentProposalSchema,
  AgentContext,
  AgentOutputParsingError,
  IncompatibleActionForRiskError,
  RiskType,
  RecoveryActionType,
  isHardDecline,
} from '../src/index.js';

describe('RecoveryAgent & Agent Contracts', () => {
  let mockLLM: MockLLMProvider;
  let agent: RecoveryAgent;

  beforeEach(() => {
    mockLLM = new MockLLMProvider();
    agent = new RecoveryAgent(mockLLM);
  });

  const baseContext: AgentContext = {
    caseId: 'case_test_001',
    merchantId: 'mch_test_001',
    riskType: RiskType.PAYMENT_FAILURE,
    amountAtRisk: '14999.00',
    currency: 'INR',
    caseOpenedAt: new Date('2026-08-28T10:00:00Z'),
    retryCount: 0,
    contactCount: 0,
    allowedActions: [
      RecoveryActionType.RETRY_PAYMENT,
      RecoveryActionType.REQUEST_PAYMENT_UPDATE,
      RecoveryActionType.CREATE_OR_SEND_PAYMENT_LINK,
      RecoveryActionType.SCHEDULE_FOLLOWUP,
      RecoveryActionType.ESCALATE_TO_HUMAN,
      RecoveryActionType.STOP_RECOVERY,
    ],
    priorActions: [],
    priorOutcomes: [],
  };

  describe('1. Structured Output Schema Validation', () => {
    it('validates a correct AgentProposal successfully', () => {
      const valid = {
        diagnosisCode: 'INSUFFICIENT_FUNDS',
        diagnosisSummary: 'Card balance insufficient at transaction time',
        confidence: 0.88,
        proposedActionType: RecoveryActionType.RETRY_PAYMENT,
        proposedActionParams: { attemptNumber: 1 },
        reasoningSummary: 'Soft decline is eligible for retry',
        followUpAfterSeconds: 7200,
        shouldStop: false,
        shouldEscalate: false,
      };

      const result = AgentProposalSchema.parse(valid);
      expect(result.diagnosisCode).toBe('INSUFFICIENT_FUNDS');
      expect(result.confidence).toBe(0.88);
      expect(result.proposedActionType).toBe(RecoveryActionType.RETRY_PAYMENT);
    });

    it('rejects proposal with confidence > 1.0 or < 0.0', () => {
      const invalidHigh = {
        diagnosisCode: 'TEST',
        diagnosisSummary: 'Test summary',
        confidence: 1.5,
        proposedActionType: RecoveryActionType.RETRY_PAYMENT,
        proposedActionParams: {},
        reasoningSummary: 'Test',
      };
      expect(() => AgentProposalSchema.parse(invalidHigh)).toThrow();

      const invalidLow = { ...invalidHigh, confidence: -0.2 };
      expect(() => AgentProposalSchema.parse(invalidLow)).toThrow();
    });

    it('rejects unsupported or non-existent action types', () => {
      const invalidAction = {
        diagnosisCode: 'TEST',
        diagnosisSummary: 'Test summary',
        confidence: 0.8,
        proposedActionType: 'UNSUPPORTED_ACTION_TYPE',
        proposedActionParams: {},
        reasoningSummary: 'Test',
      };
      expect(() => AgentProposalSchema.parse(invalidAction)).toThrow();
    });
  });

  describe('2. RecoveryAgent with MockLLMProvider', () => {
    it('generates deterministic proposal for soft decline payment failure', async () => {
      const proposal = await agent.generateProposal({
        ...baseContext,
        verifiedPaymentFacts: {
          gatewayErrorCode: 'BAD_REQUEST',
          gatewayErrorMessage: 'Insufficient balance',
          paymentMethod: 'card',
        },
      });

      expect(proposal.diagnosisCode).toBe('SOFT_DECLINE_INSUFFICIENT_FUNDS');
      expect(proposal.proposedActionType).toBe(RecoveryActionType.RETRY_PAYMENT);
      expect(proposal.confidence).toBeGreaterThan(0.8);
      expect(proposal.shouldStop).toBe(false);
      expect(proposal.shouldEscalate).toBe(false);
    });

    it('generates deterministic proposal for hard decline payment failure', async () => {
      const proposal = await agent.generateProposal({
        ...baseContext,
        verifiedPaymentFacts: {
          gatewayErrorCode: 'FRAUD_SUSPECTED',
          gatewayErrorMessage: 'Transaction flagged for fraud risk',
          paymentMethod: 'card',
        },
      });

      expect(proposal.diagnosisCode).toBe('HARD_DECLINE_DETECTED');
      expect(proposal.proposedActionType).toBe(RecoveryActionType.CREATE_OR_SEND_PAYMENT_LINK);
      expect(proposal.confidence).toBeGreaterThan(0.8);
    });

    it('generates deterministic proposal for checkout abandonment', async () => {
      const proposal = await agent.generateProposal({
        ...baseContext,
        riskType: RiskType.CHECKOUT_ABANDONMENT,
        allowedActions: [
          RecoveryActionType.SEND_CHECKOUT_RECOVERY,
          RecoveryActionType.CREATE_OR_SEND_PAYMENT_LINK,
          RecoveryActionType.SCHEDULE_FOLLOWUP,
          RecoveryActionType.ESCALATE_TO_HUMAN,
          RecoveryActionType.STOP_RECOVERY,
        ],
      });

      expect(proposal.diagnosisCode).toBe('CHECKOUT_ABANDONED');
      expect(proposal.proposedActionType).toBe(RecoveryActionType.SEND_CHECKOUT_RECOVERY);
      expect(proposal.proposedActionParams.channel).toBe('WHATSAPP');
    });

    it('generates deterministic proposal for overdue receivable', async () => {
      const proposal = await agent.generateProposal({
        ...baseContext,
        riskType: RiskType.OVERDUE_RECEIVABLE,
        allowedActions: [
          RecoveryActionType.SEND_RECEIVABLE_REMINDER,
          RecoveryActionType.RECORD_PROMISE_TO_PAY,
          RecoveryActionType.CREATE_OR_SEND_PAYMENT_LINK,
          RecoveryActionType.SCHEDULE_FOLLOWUP,
          RecoveryActionType.ESCALATE_TO_HUMAN,
          RecoveryActionType.STOP_RECOVERY,
        ],
      });

      expect(proposal.diagnosisCode).toBe('INVOICE_PAST_DUE');
      expect(proposal.proposedActionType).toBe(RecoveryActionType.SEND_RECEIVABLE_REMINDER);
    });

    it('handles markdown code fences in LLM output', async () => {
      const jsonContent = JSON.stringify({
        diagnosisCode: 'INSUFFICIENT_FUNDS',
        diagnosisSummary: 'Temporary balance shortfall',
        confidence: 0.9,
        proposedActionType: 'RETRY_PAYMENT',
        proposedActionParams: { attempt: 1 },
        reasoningSummary: 'Soft decline',
        followUpAfterSeconds: 3600,
        shouldStop: false,
        shouldEscalate: false,
      });
      const rawWithFences = '```json\n' + jsonContent + '\n```';
      mockLLM.setMockResponse(rawWithFences);

      const proposal = await agent.generateProposal(baseContext);
      expect(proposal.diagnosisCode).toBe('INSUFFICIENT_FUNDS');
      expect(proposal.confidence).toBe(0.9);
      expect(proposal.proposedActionType).toBe(RecoveryActionType.RETRY_PAYMENT);
    });

    it('rejects invalid JSON response with AgentOutputParsingError', async () => {
      mockLLM.setMockResponse('INVALID NON-JSON TEXT FROM LLM');
      await expect(agent.generateProposal(baseContext)).rejects.toThrow(AgentOutputParsingError);
    });

    it('rejects empty LLM response with AgentOutputParsingError', async () => {
      mockLLM.setMockResponse('');
      await expect(agent.generateProposal(baseContext)).rejects.toThrow(AgentOutputParsingError);
    });

    it('rejects action proposal incompatible with risk family', async () => {
      // Mock returns SEND_CHECKOUT_RECOVERY for a PAYMENT_FAILURE case
      mockLLM.setMockResponse({
        diagnosisCode: 'INVALID_COMBO',
        diagnosisSummary: 'Invalid combination',
        confidence: 0.9,
        proposedActionType: RecoveryActionType.SEND_CHECKOUT_RECOVERY,
        proposedActionParams: {},
        reasoningSummary: 'Invalid action for risk',
        shouldStop: false,
        shouldEscalate: false,
      });

      await expect(agent.generateProposal(baseContext)).rejects.toThrow(
        IncompatibleActionForRiskError,
      );
    });
  });

  describe('3. Hard Decline Helper', () => {
    it('correctly identifies hard decline error codes', () => {
      expect(isHardDecline('FRAUD_SUSPECTED')).toBe(true);
      expect(isHardDecline('card_lost_or_stolen')).toBe(true);
      expect(isHardDecline('ACCOUNT-CLOSED')).toBe(true);
      expect(isHardDecline('DO NOT HONOR')).toBe(true);
      expect(isHardDecline('CARD_EXPIRED')).toBe(true);
      expect(isHardDecline('INSUFFICIENT_FUNDS')).toBe(false);
      expect(isHardDecline('NETWORK_ERROR')).toBe(false);
      expect(isHardDecline(null)).toBe(false);
      expect(isHardDecline(undefined)).toBe(false);
    });
  });
});

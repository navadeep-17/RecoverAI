import { describe, it, expect, beforeEach } from 'vitest';
import {
  RecoveryAgent,
  MockLLMProvider,
  AgentProposalSchema,
  AgentContext,
  AgentOutputParsingError,
  IncompatibleActionForRiskError,
  ActionNotAllowedByContextError,
  RiskType,
  RecoveryActionType,
  isHardDecline,
} from '../src/index.js';

describe('RecoveryAgent & Agent Contracts Specification & Bounds', () => {
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

  describe('1. Strict Schema & Injection Rejection', () => {
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

    it('rejects proposal injecting policyDecision ("ALLOW")', () => {
      const injectedPolicy = {
        diagnosisCode: 'INSUFFICIENT_FUNDS',
        diagnosisSummary: 'Test summary',
        confidence: 0.9,
        proposedActionType: RecoveryActionType.RETRY_PAYMENT,
        proposedActionParams: {},
        reasoningSummary: 'Test',
        policyDecision: 'ALLOW', // Unauthorized policy injection
      };
      expect(() => AgentProposalSchema.parse(injectedPolicy)).toThrow();
    });

    it('rejects proposal injecting execution / tool fields (executeNow, toolCall)', () => {
      const injectedExecution = {
        diagnosisCode: 'INSUFFICIENT_FUNDS',
        diagnosisSummary: 'Test summary',
        confidence: 0.9,
        proposedActionType: RecoveryActionType.RETRY_PAYMENT,
        proposedActionParams: {},
        reasoningSummary: 'Test',
        executeNow: true,
      };
      expect(() => AgentProposalSchema.parse(injectedExecution)).toThrow();

      const injectedTool = {
        diagnosisCode: 'INSUFFICIENT_FUNDS',
        diagnosisSummary: 'Test summary',
        confidence: 0.9,
        proposedActionType: RecoveryActionType.RETRY_PAYMENT,
        proposedActionParams: {},
        reasoningSummary: 'Test',
        toolCall: { name: 'charge_card' },
      };
      expect(() => AgentProposalSchema.parse(injectedTool)).toThrow();
    });
  });

  describe('2. Authoritative context.allowedActions Enforcement', () => {
    it('rejects proposal when action is globally compatible but excluded from context.allowedActions', async () => {
      // PAYMENT_FAILURE supports RETRY_PAYMENT globally, but context restricts to REQUEST_PAYMENT_UPDATE only
      const restrictedContext: AgentContext = {
        ...baseContext,
        allowedActions: [RecoveryActionType.REQUEST_PAYMENT_UPDATE],
      };

      // Mock returns RETRY_PAYMENT
      mockLLM.setMockResponse({
        diagnosisCode: 'INSUFFICIENT_FUNDS',
        diagnosisSummary: 'Temporary shortfall',
        confidence: 0.9,
        proposedActionType: RecoveryActionType.RETRY_PAYMENT,
        proposedActionParams: {},
        reasoningSummary: 'Retry',
        shouldStop: false,
        shouldEscalate: false,
      });

      await expect(agent.generateProposal(restrictedContext)).rejects.toThrow(
        ActionNotAllowedByContextError,
      );
    });

    it('accepts proposal when action is included in context.allowedActions', async () => {
      const restrictedContext: AgentContext = {
        ...baseContext,
        allowedActions: [RecoveryActionType.REQUEST_PAYMENT_UPDATE],
      };

      mockLLM.setMockResponse({
        diagnosisCode: 'CARD_EXPIRED',
        diagnosisSummary: 'Card has expired',
        confidence: 0.92,
        proposedActionType: RecoveryActionType.REQUEST_PAYMENT_UPDATE,
        proposedActionParams: { channel: 'EMAIL' },
        reasoningSummary: 'Request card update',
        shouldStop: false,
        shouldEscalate: false,
      });

      const proposal = await agent.generateProposal(restrictedContext);
      expect(proposal.proposedActionType).toBe(RecoveryActionType.REQUEST_PAYMENT_UPDATE);
    });
  });

  describe('3. Deterministic Proposals & Formats Across Risk Families', () => {
    it('generates proposal for checkout abandonment', async () => {
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
    });

    it('generates proposal for overdue receivable', async () => {
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
      const fence = String.fromCharCode(96, 96, 96);
      mockLLM.setMockResponse(`${fence}json\n${jsonContent}\n${fence}`);

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
  });

  describe('4. Exact Canonical Hard Decline Classification', () => {
    it('accurately identifies exact canonical hard decline codes and aliases', () => {
      expect(isHardDecline('FRAUD_SUSPECTED')).toBe(true);
      expect(isHardDecline('fraud')).toBe(true);
      expect(isHardDecline('CARD_LOST_OR_STOLEN')).toBe(true);
      expect(isHardDecline('LOST_CARD')).toBe(true);
      expect(isHardDecline('STOLEN_CARD')).toBe(true);
      expect(isHardDecline('ACCOUNT_CLOSED')).toBe(true);
      expect(isHardDecline('closed-account')).toBe(true);
      expect(isHardDecline('DO_NOT_HONOR')).toBe(true);
      expect(isHardDecline('STOPPED_BY_CUSTOMER')).toBe(true);
      expect(isHardDecline('CARD_EXPIRED')).toBe(true);
      expect(isHardDecline('AUTHENTICATION_FAILED')).toBe(true);
      expect(isHardDecline('3DS_AUTHENTICATION_FAILED')).toBe(true);
      expect(isHardDecline('INVALID_PIN')).toBe(true);
      expect(isHardDecline('INCORRECT_CVV')).toBe(true);
    });

    it('does NOT classify ambiguous substrings as hard declines', () => {
      expect(isHardDecline('CARD')).toBe(false);
      expect(isHardDecline('AUTH')).toBe(false);
      expect(isHardDecline('LOST_CONNECTION')).toBe(false);
      expect(isHardDecline('NETWORK_ERROR')).toBe(false);
      expect(isHardDecline('INSUFFICIENT_FUNDS')).toBe(false);
      expect(isHardDecline('TIMEOUT')).toBe(false);
      expect(isHardDecline('ISSUER_DOWN')).toBe(false);
      expect(isHardDecline(null)).toBe(false);
      expect(isHardDecline(undefined)).toBe(false);
      expect(isHardDecline('')).toBe(false);
    });
  });
});

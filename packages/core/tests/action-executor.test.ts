import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  ActionExecutionStatus,
  CaseStatus,
  PolicyDecision,
  RecoveryAction,
  RecoveryActionType,
  RiskType,
} from '@prisma/client';
import {
  ActionExecutor,
  generateActionIdempotencyKey,
} from '../src/index.js';
import { PolicyEngine } from '@recoverai/policy';
import {
  IActionProvider,
  ProviderExecutionOutcome,
  ProviderRegistry,
  SimulatedRecoveryProvider,
} from '@recoverai/integrations';
import { ActionExecutionError } from '@recoverai/shared';

describe('ActionExecutor Unit Tests', () => {
  let actionExecutor: ActionExecutor;
  let mockActionRepo: any;
  let mockCaseRepo: any;
  let mockCustomerRepo: any;
  let mockPolicyConfigRepo: any;
  let mockAuditRepo: any;
  let mockMerchantRepo: any;
  let policyEngine: PolicyEngine;
  let simulatedProvider: SimulatedRecoveryProvider;
  let providerRegistry: ProviderRegistry;

  const merchantId = 'mch_exec_test_01';
  const caseId = 'case_exec_test_01';
  const customerId = 'cust_exec_test_01';

  let inMemoryActions: Map<string, any>;
  let inMemoryCases: Map<string, any>;
  let inMemoryCustomers: Map<string, any>;
  let inMemoryAudits: any[];

  beforeEach(() => {
    inMemoryActions = new Map();
    inMemoryCases = new Map();
    inMemoryCustomers = new Map();
    inMemoryAudits = [];

    // Initialize mock database records
    inMemoryCustomers.set(customerId, {
      id: customerId,
      merchantId,
      name: 'Jane Doe',
      email: 'jane@example.com',
      phone: '+919876543210',
      contactConsent: true,
      optedOut: false,
      lastContactedAt: null,
    });

    inMemoryCases.set(caseId, {
      id: caseId,
      merchantId,
      customerId,
      riskType: RiskType.PAYMENT_FAILURE,
      amountAtRisk: { toString: () => '1500.00' },
      currency: 'INR',
      status: CaseStatus.OPEN,
      openedAt: new Date(Date.now() - 3600000),
      contextJson: { verifiedPaymentFailureCode: 'BAD_REQUEST_ERROR' },
      customer: inMemoryCustomers.get(customerId),
      actions: [],
      outcomes: [],
    });

    mockActionRepo = {
      createAction: vi.fn(async (mId: string, cId: string, params: any) => {
        const id = `act_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
        const action: any = {
          id,
          caseId: cId,
          planVersionId: params.planVersionId || null,
          actionType: params.actionType,
          actionParams: params.actionParams,
          idempotencyKey: params.idempotencyKey,
          policyDecision: params.policyDecision,
          policyRationale: params.policyRationale,
          status: params.status || ActionExecutionStatus.PENDING,
          providerName: null,
          externalActionId: null,
          executionMetadata: null,
          errorMessage: null,
          executedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        inMemoryActions.set(id, action);
        return action;
      }),
      getActionById: vi.fn(async (mId: string, aId: string) => {
        return inMemoryActions.get(aId) || null;
      }),
      claimActionForExecution: vi.fn(async (mId: string, aId: string) => {
        const action = inMemoryActions.get(aId);
        if (!action) return { claimed: false, action: null };
        if (action.status !== ActionExecutionStatus.PENDING) {
          return { claimed: false, action };
        }
        action.status = ActionExecutionStatus.EXECUTING;
        action.updatedAt = new Date();
        return { claimed: true, action };
      }),
      updateActionStatus: vi.fn(async (mId: string, aId: string, params: any) => {
        const action = inMemoryActions.get(aId);
        if (!action) throw new Error('Action not found');
        action.status = params.status;
        if (params.providerName) action.providerName = params.providerName;
        if (params.externalActionId) action.externalActionId = params.externalActionId;
        if (params.executionMetadata) action.executionMetadata = params.executionMetadata;
        if (params.errorMessage) action.errorMessage = params.errorMessage;
        action.executedAt = new Date();
        return action;
      }),
    };

    mockCaseRepo = {
      getCaseById: vi.fn(async (mId: string, cId: string) => {
        const c = inMemoryCases.get(cId);
        if (!c || c.merchantId !== mId) return null;
        return {
          ...c,
          customer: inMemoryCustomers.get(c.customerId),
          actions: Array.from(inMemoryActions.values()).filter((a) => a.caseId === cId),
        };
      }),
      compareAndSetStatus: vi.fn(async (mId: string, cId: string, expected: CaseStatus, next: CaseStatus) => {
        const c = inMemoryCases.get(cId);
        if (!c || c.merchantId !== mId || c.status !== expected) {
          throw new Error('Case state conflict');
        }
        c.status = next;
        return c;
      }),
    };

    mockCustomerRepo = {
      updateLastContactedAt: vi.fn(async (mId: string, custId: string, date: Date) => {
        const cust = inMemoryCustomers.get(custId);
        if (cust) cust.lastContactedAt = date;
      }),
    };

    mockPolicyConfigRepo = {
      getOrCreateConfig: vi.fn(async (mId: string) => ({
        merchantId: mId,
        maxRetriesPerCase: 3,
        maxContactsPerCase: 3,
        maxActionsPerCase: 5,
        cooldownHoursBetweenActions: 24,
        highValueThreshold: { toString: () => '50000.00' },
        minConfidenceThreshold: 0.65,
        reviewFirstMode: false,
        checkoutAbandonmentThresholdMinutes: 30,
        quietHoursStart: 21,
        quietHoursEnd: 9,
        quietHoursTimezone: 'Asia/Kolkata',
        maxRecoveryWindowDays: 30,
        overdueGracePeriodDays: 3,
      })),
    };

    mockAuditRepo = {
      record: vi.fn(async (mId: string, entry: any) => {
        inMemoryAudits.push({ merchantId: mId, ...entry, createdAt: new Date() });
      }),
    };

    mockMerchantRepo = {
      getMerchantById: vi.fn(async (mId: string) => ({
        id: mId,
        name: 'Test Merchant',
        killSwitchActive: false,
      })),
    };

    policyEngine = new PolicyEngine();
    simulatedProvider = new SimulatedRecoveryProvider();
    providerRegistry = new ProviderRegistry([simulatedProvider]);

    actionExecutor = new ActionExecutor({
      actionRepo: mockActionRepo,
      caseRepo: mockCaseRepo,
      customerRepo: mockCustomerRepo,
      policyConfigRepo: mockPolicyConfigRepo,
      auditRepo: mockAuditRepo,
      merchantRepo: mockMerchantRepo,
      policyEngine,
      providerRegistry,
      clock: () => new Date('2026-08-28T14:00:00+05:30'), // 2:00 PM IST (daytime, outside quiet hours)
    });
  });


  describe('1. Deterministic Idempotency Key', () => {
    it('generates deterministic idempotency key without random or timestamp noise', () => {
      const key1 = generateActionIdempotencyKey(merchantId, caseId, RecoveryActionType.REQUEST_PAYMENT_UPDATE, 'v1');
      const key2 = generateActionIdempotencyKey(merchantId, caseId, RecoveryActionType.REQUEST_PAYMENT_UPDATE, 'v1');
      const key3 = generateActionIdempotencyKey(merchantId, caseId, RecoveryActionType.REQUEST_PAYMENT_UPDATE, 'v2');

      expect(key1).toBe(`rec_act:${merchantId}:${caseId}:REQUEST_PAYMENT_UPDATE:v1`);
      expect(key1).toBe(key2);
      expect(key1).not.toBe(key3);
    });
  });

  describe('2. Action Authorization & Authoritativeness', () => {
    it('creates authoritative RecoveryAction in PENDING status when PolicyDecision is ALLOW', async () => {
      const authResult = await actionExecutor.authorizeAndCreateAction(merchantId, caseId, {
        actionType: RecoveryActionType.REQUEST_PAYMENT_UPDATE,
        actionParams: { channel: 'WHATSAPP' },
        policyDecision: PolicyDecision.ALLOW,
        policyRationale: 'Low-risk non-hard failure within limits',
        attemptOrVersion: 'v1',
      });

      expect(authResult.authorized).toBe(true);
      expect(authResult.action).not.toBeNull();
      expect(authResult.action?.status).toBe(ActionExecutionStatus.PENDING);
      expect(authResult.action?.policyDecision).toBe(PolicyDecision.ALLOW);

      // Verify audit event ACTION_AUTHORIZED was emitted
      expect(mockAuditRepo.record).toHaveBeenCalledWith(
        merchantId,
        expect.objectContaining({
          eventType: 'ACTION_AUTHORIZED',
          caseId,
        }),
      );
    });

    it('blocks creation and does not persist executable action when PolicyDecision is DENY', async () => {
      const authResult = await actionExecutor.authorizeAndCreateAction(merchantId, caseId, {
        actionType: RecoveryActionType.RETRY_PAYMENT,
        actionParams: {},
        policyDecision: PolicyDecision.DENY,
        policyRationale: 'Hard decline: card stolen or lost',
        attemptOrVersion: 'v1',
      });

      expect(authResult.authorized).toBe(false);
      expect(authResult.action).toBeNull();
      expect(authResult.reason).toContain('Hard decline');

      // Verify audit event ACTION_BLOCKED_BY_POLICY was emitted
      expect(mockAuditRepo.record).toHaveBeenCalledWith(
        merchantId,
        expect.objectContaining({
          eventType: 'ACTION_BLOCKED_BY_POLICY',
          caseId,
        }),
      );
    });

    it('blocks creation and does not persist executable action when PolicyDecision is REVIEW', async () => {
      const authResult = await actionExecutor.authorizeAndCreateAction(merchantId, caseId, {
        actionType: RecoveryActionType.CREATE_OR_SEND_PAYMENT_LINK,
        actionParams: {},
        policyDecision: PolicyDecision.REVIEW,
        policyRationale: 'High value threshold exceeded',
        attemptOrVersion: 'v1',
      });

      expect(authResult.authorized).toBe(false);
      expect(authResult.action).toBeNull();
      expect(authResult.reason).toContain('High value threshold exceeded');

      expect(mockAuditRepo.record).toHaveBeenCalledWith(
        merchantId,
        expect.objectContaining({
          eventType: 'ACTION_BLOCKED_BY_POLICY',
          caseId,
        }),
      );
    });
  });

  describe('3. Fresh Policy Revalidation Immediately Before Dispatch', () => {
    it('executes successfully when fresh policy revalidation confirms ALLOW', async () => {
      const { action } = await actionExecutor.authorizeAndCreateAction(merchantId, caseId, {
        actionType: RecoveryActionType.REQUEST_PAYMENT_UPDATE,
        actionParams: { channel: 'WHATSAPP' },
        policyDecision: PolicyDecision.ALLOW,
        policyRationale: 'Initial approval',
        attemptOrVersion: 'v1',
      });

      const execResult = await actionExecutor.executeAction(merchantId, action!.id);

      expect(execResult.executed).toBe(true);
      expect(execResult.success).toBe(true);
      expect(execResult.action?.status).toBe(ActionExecutionStatus.SUCCESS);
      expect(execResult.result?.providerName).toBe('SIMULATED_RECOVERY_PROVIDER');
      expect(execResult.result?.isSimulated).toBe(true);

      // Verify audit trail
      const auditTypes = inMemoryAudits.map((a) => a.eventType);
      expect(auditTypes).toContain('ACTION_AUTHORIZED');
      expect(auditTypes).toContain('ACTION_POLICY_REVALIDATED');
      expect(auditTypes).toContain('ACTION_CLAIMED');
      expect(auditTypes).toContain('ACTION_DISPATCHED');
      expect(auditTypes).toContain('ACTION_SUCCEEDED');
    });

    it('blocks execution when customer opts out after authorization (fresh DENY)', async () => {
      const { action } = await actionExecutor.authorizeAndCreateAction(merchantId, caseId, {
        actionType: RecoveryActionType.REQUEST_PAYMENT_UPDATE,
        actionParams: { channel: 'WHATSAPP' },
        policyDecision: PolicyDecision.ALLOW,
        policyRationale: 'Initial approval',
        attemptOrVersion: 'v1',
      });

      // Customer opts out before execution
      const customer = inMemoryCustomers.get(customerId);
      customer.optedOut = true;

      const execResult = await actionExecutor.executeAction(merchantId, action!.id);

      expect(execResult.executed).toBe(false);
      expect(execResult.blockedByPolicy).toBe(true);
      expect(execResult.policyDecision).toBe(PolicyDecision.DENY);
      expect(execResult.action?.status).toBe(ActionExecutionStatus.CANCELLED);
      expect(simulatedProvider.dispatchedCalls.length).toBe(0); // Provider NEVER called

      expect(mockAuditRepo.record).toHaveBeenCalledWith(
        merchantId,
        expect.objectContaining({
          eventType: 'ACTION_BLOCKED_BY_POLICY',
        }),
      );
    });

    it('blocks execution when merchant kill switch is enabled before execution', async () => {
      const { action } = await actionExecutor.authorizeAndCreateAction(merchantId, caseId, {
        actionType: RecoveryActionType.REQUEST_PAYMENT_UPDATE,
        actionParams: { channel: 'WHATSAPP' },
        policyDecision: PolicyDecision.ALLOW,
        policyRationale: 'Initial approval',
        attemptOrVersion: 'v1',
      });

      // Enable kill switch
      mockMerchantRepo.getMerchantById.mockResolvedValueOnce({
        id: merchantId,
        killSwitchActive: true,
      });

      const execResult = await actionExecutor.executeAction(merchantId, action!.id);

      expect(execResult.executed).toBe(false);
      expect(execResult.blockedByPolicy).toBe(true);
      expect(execResult.policyDecision).toBe(PolicyDecision.DENY);
      expect(execResult.policyReasonCode).toBe('KILL_SWITCH_ACTIVE');
      expect(simulatedProvider.dispatchedCalls.length).toBe(0);
    });

    it('blocks execution when case is already in a terminal state (RECOVERED / STOPPED)', async () => {
      const { action } = await actionExecutor.authorizeAndCreateAction(merchantId, caseId, {
        actionType: RecoveryActionType.REQUEST_PAYMENT_UPDATE,
        actionParams: { channel: 'WHATSAPP' },
        policyDecision: PolicyDecision.ALLOW,
        policyRationale: 'Initial approval',
        attemptOrVersion: 'v1',
      });

      // Case transitions to RECOVERED concurrently
      const c = inMemoryCases.get(caseId);
      c.status = CaseStatus.RECOVERED;

      const execResult = await actionExecutor.executeAction(merchantId, action!.id);

      expect(execResult.executed).toBe(false);
      expect(execResult.blockedByPolicy).toBe(true);
      expect(execResult.action?.status).toBe(ActionExecutionStatus.CANCELLED);
      expect(simulatedProvider.dispatchedCalls.length).toBe(0);
    });
  });

  describe('4. Atomic Claiming & Non-Duplicate Dispatch', () => {
    it('returns alreadyClaimed without dispatching when action is not PENDING', async () => {
      const { action } = await actionExecutor.authorizeAndCreateAction(merchantId, caseId, {
        actionType: RecoveryActionType.REQUEST_PAYMENT_UPDATE,
        actionParams: {},
        policyDecision: PolicyDecision.ALLOW,
        policyRationale: 'Initial approval',
        attemptOrVersion: 'v1',
      });

      // First execution succeeds
      const firstResult = await actionExecutor.executeAction(merchantId, action!.id);
      expect(firstResult.executed).toBe(true);
      expect(firstResult.success).toBe(true);

      // Repeated invocation on already-executed action
      const secondResult = await actionExecutor.executeAction(merchantId, action!.id);
      expect(secondResult.executed).toBe(false);
      expect(secondResult.alreadyClaimed).toBe(true);
      expect(simulatedProvider.dispatchedCalls.length).toBe(1); // Provider called only once
    });
  });

  describe('5. Provider Failure Semantics & Error Classification', () => {
    it('persists FAILED status and records retryable failure classification correctly', async () => {
      const { action } = await actionExecutor.authorizeAndCreateAction(merchantId, caseId, {
        actionType: RecoveryActionType.REQUEST_PAYMENT_UPDATE,
        actionParams: {},
        policyDecision: PolicyDecision.ALLOW,
        policyRationale: 'Initial approval',
        attemptOrVersion: 'v1',
      });

      simulatedProvider.setBehavior({
        forceOutcome: ProviderExecutionOutcome.RETRYABLE_FAILURE,
        forceErrorClassification: 'NETWORK_TIMEOUT',
        forceErrorMessage: 'Gateway timed out waiting for provider',
      });

      const execResult = await actionExecutor.executeAction(merchantId, action!.id);

      expect(execResult.executed).toBe(true);
      expect(execResult.success).toBe(false);
      expect(execResult.action?.status).toBe(ActionExecutionStatus.FAILED);
      expect(execResult.result?.outcome).toBe(ProviderExecutionOutcome.RETRYABLE_FAILURE);
      expect(execResult.result?.errorClassification).toBe('NETWORK_TIMEOUT');

      expect(mockAuditRepo.record).toHaveBeenCalledWith(
        merchantId,
        expect.objectContaining({
          eventType: 'ACTION_FAILED',
          reasonCode: 'NETWORK_TIMEOUT',
        }),
      );
    });

    it('persists FAILED status and records permanent failure classification correctly', async () => {
      const { action } = await actionExecutor.authorizeAndCreateAction(merchantId, caseId, {
        actionType: RecoveryActionType.REQUEST_PAYMENT_UPDATE,
        actionParams: {},
        policyDecision: PolicyDecision.ALLOW,
        policyRationale: 'Initial approval',
        attemptOrVersion: 'v1',
      });

      simulatedProvider.setBehavior({
        forceOutcome: ProviderExecutionOutcome.PERMANENT_FAILURE,
        forceErrorClassification: 'INVALID_REQUEST',
        forceErrorMessage: 'Destination phone number is unreachable or deactivated',
      });

      const execResult = await actionExecutor.executeAction(merchantId, action!.id);

      expect(execResult.executed).toBe(true);
      expect(execResult.success).toBe(false);
      expect(execResult.action?.status).toBe(ActionExecutionStatus.FAILED);
      expect(execResult.result?.outcome).toBe(ProviderExecutionOutcome.PERMANENT_FAILURE);

      expect(mockAuditRepo.record).toHaveBeenCalledWith(
        merchantId,
        expect.objectContaining({
          eventType: 'ACTION_FAILED',
          reasonCode: 'INVALID_REQUEST',
        }),
      );
    });

    it('does not swallow unhandled provider exceptions; records ACTION_FAILED and throws ActionExecutionError', async () => {
      const { action } = await actionExecutor.authorizeAndCreateAction(merchantId, caseId, {
        actionType: RecoveryActionType.REQUEST_PAYMENT_UPDATE,
        actionParams: {},
        policyDecision: PolicyDecision.ALLOW,
        policyRationale: 'Initial approval',
        attemptOrVersion: 'v1',
      });

      simulatedProvider.setBehavior({
        throwException: new Error('Unexpected socket reset from simulator boundary'),
      });

      await expect(actionExecutor.executeAction(merchantId, action!.id)).rejects.toThrow(ActionExecutionError);

      expect(mockAuditRepo.record).toHaveBeenCalledWith(
        merchantId,
        expect.objectContaining({
          eventType: 'ACTION_FAILED',
          reasonCode: 'UNHANDLED_PROVIDER_EXCEPTION',
        }),
      );
    });
  });

  describe('6. Internal Non-External Actions', () => {
    it('executes STOP_RECOVERY and transitions case to STOPPED via valid state machine', async () => {
      const { action } = await actionExecutor.authorizeAndCreateAction(merchantId, caseId, {
        actionType: RecoveryActionType.STOP_RECOVERY,
        actionParams: { reason: 'Customer requested manual resolution' },
        policyDecision: PolicyDecision.ALLOW,
        policyRationale: 'Stop approved',
        attemptOrVersion: 'v1',
      });

      const execResult = await actionExecutor.executeAction(merchantId, action!.id);

      expect(execResult.executed).toBe(true);
      expect(execResult.success).toBe(true);
      expect(inMemoryCases.get(caseId).status).toBe(CaseStatus.STOPPED);
      expect(simulatedProvider.dispatchedCalls.length).toBe(0); // No external provider called
    });

    it('blocks ESCALATE_TO_HUMAN from automated dispatch due to policy REVIEW decision', async () => {
      const { action } = await actionExecutor.authorizeAndCreateAction(merchantId, caseId, {
        actionType: RecoveryActionType.ESCALATE_TO_HUMAN,
        actionParams: { reason: 'Complex dispute requiring human agent' },
        policyDecision: PolicyDecision.ALLOW,
        policyRationale: 'Initially attempted',
        attemptOrVersion: 'v1',
      });

      // Fresh policy revalidation enforces AgentEscalationRule -> REVIEW
      const execResult = await actionExecutor.executeAction(merchantId, action!.id);

      expect(execResult.executed).toBe(false);
      expect(execResult.blockedByPolicy).toBe(true);
      expect(execResult.policyDecision).toBe(PolicyDecision.REVIEW);
      expect(execResult.policyReasonCode).toBe('AGENT_REQUESTED_REVIEW');
      expect(simulatedProvider.dispatchedCalls.length).toBe(0);
    });

    it('executes RECORD_PROMISE_TO_PAY on OVERDUE_RECEIVABLE and persists structured commitment metadata', async () => {
      const receivableCaseId = 'case_receivable_01';
      inMemoryCases.set(receivableCaseId, {
        id: receivableCaseId,
        merchantId,
        customerId,
        riskType: RiskType.OVERDUE_RECEIVABLE,
        amountAtRisk: { toString: () => '5000.00' },
        currency: 'INR',
        status: CaseStatus.OPEN,
        openedAt: new Date(Date.now() - 3600000),
        contextJson: {},
        customer: inMemoryCustomers.get(customerId),
        actions: [],
        outcomes: [],
      });

      const { action } = await actionExecutor.authorizeAndCreateAction(merchantId, receivableCaseId, {
        actionType: RecoveryActionType.RECORD_PROMISE_TO_PAY,
        actionParams: { promisedAmount: '1500.00', promisedDate: '2026-09-01T00:00:00.000Z' },
        policyDecision: PolicyDecision.ALLOW,
        policyRationale: 'Promise to pay approved',
        attemptOrVersion: 'v1',
      });

      const execResult = await actionExecutor.executeAction(merchantId, action!.id);

      expect(execResult.executed).toBe(true);
      expect(execResult.success).toBe(true);
      expect(execResult.action?.status).toBe(ActionExecutionStatus.SUCCESS);
      expect(simulatedProvider.dispatchedCalls.length).toBe(0);
    });

    it('blocks RECORD_PROMISE_TO_PAY on PAYMENT_FAILURE due to action compatibility matrix', async () => {
      const { action } = await actionExecutor.authorizeAndCreateAction(merchantId, caseId, {
        actionType: RecoveryActionType.RECORD_PROMISE_TO_PAY,
        actionParams: { promisedAmount: '1500.00', promisedDate: '2026-09-01T00:00:00.000Z' },
        policyDecision: PolicyDecision.ALLOW,
        policyRationale: 'Initially attempted',
        attemptOrVersion: 'v1',
      });

      const execResult = await actionExecutor.executeAction(merchantId, action!.id);

      expect(execResult.executed).toBe(false);
      expect(execResult.blockedByPolicy).toBe(true);
      expect(execResult.policyDecision).toBe(PolicyDecision.DENY);
      expect(execResult.policyReasonCode).toBe('INCOMPATIBLE_ACTION_FOR_RISK');
    });

    it('executes SCHEDULE_FOLLOWUP and records scheduled job dispatch', async () => {
      const { action } = await actionExecutor.authorizeAndCreateAction(merchantId, caseId, {
        actionType: RecoveryActionType.SCHEDULE_FOLLOWUP,
        actionParams: { scheduledFor: '2026-08-30T10:00:00.000Z' },
        policyDecision: PolicyDecision.ALLOW,
        policyRationale: 'Followup approved',
        attemptOrVersion: 'v1',
      });

      const execResult = await actionExecutor.executeAction(merchantId, action!.id);

      expect(execResult.executed).toBe(true);
      expect(execResult.success).toBe(true);
      expect(execResult.action?.status).toBe(ActionExecutionStatus.SUCCESS);
      expect(simulatedProvider.dispatchedCalls.length).toBe(0);
    });
  });
});



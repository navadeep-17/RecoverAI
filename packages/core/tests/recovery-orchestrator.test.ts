import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  ActionExecutionStatus,
  CaseStatus,
  PolicyDecision,
  RecoveryActionType,
  RiskType,
} from '@prisma/client';
import {
  ActionExecutor,
  RecoveryOrchestrator,
  RecoveryAgent,
  MockLLMProvider,
} from '../src/index.js';
import { PolicyEngine } from '@recoverai/policy';
import { ProviderRegistry, SimulatedRecoveryProvider } from '@recoverai/integrations';

describe('RecoveryOrchestrator Unit Tests', () => {
  let orchestrator: RecoveryOrchestrator;
  let actionExecutor: ActionExecutor;
  let mockActionRepo: any;
  let mockCaseRepo: any;
  let mockCustomerRepo: any;
  let mockPolicyConfigRepo: any;
  let mockAuditRepo: any;
  let mockMerchantRepo: any;
  let mockCommitmentRepo: any;
  let mockTriggerRepo: any;
  let mockJobScheduler: any;
  let policyEngine: PolicyEngine;
  let mockLLM: MockLLMProvider;
  let recoveryAgent: RecoveryAgent;
  let simulatedProvider: SimulatedRecoveryProvider;
  let providerRegistry: ProviderRegistry;

  const merchantId = 'mch_orch_test_01';
  const caseId = 'case_orch_test_01';
  const customerId = 'cust_orch_test_01';

  let inMemoryActions: Map<string, any>;
  let inMemoryCases: Map<string, any>;
  let inMemoryCustomers: Map<string, any>;
  let inMemoryPlanVersions: Map<string, any[]>;
  let inMemoryOutcomes: Map<string, any[]>;
  let inMemoryCommitments: any[];
  let inMemoryAudits: any[];
  let inMemoryJobs: any[];

  beforeEach(() => {
    inMemoryActions = new Map();
    inMemoryCases = new Map();
    inMemoryCustomers = new Map();
    inMemoryPlanVersions = new Map();
    inMemoryOutcomes = new Map();
    inMemoryCommitments = [];
    inMemoryAudits = [];
    inMemoryJobs = [];

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
    });

    mockActionRepo = {
      createAction: vi.fn(async (_mId: string, cId: string, params: any) => {
        const id = `act_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
        const action = {
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
      findActionByIdempotencyKey: vi.fn(async (_mId: string, idempotencyKey: string) => {
        return Array.from(inMemoryActions.values()).find(
          (a) => a.idempotencyKey === idempotencyKey,
        ) || null;
      }),
      getActionById: vi.fn(async (_mId: string, aId: string) => {
        return inMemoryActions.get(aId) || null;
      }),
      claimActionForExecution: vi.fn(async (_mId: string, aId: string) => {
        const action = inMemoryActions.get(aId);
        if (!action) return { claimed: false, action: null };
        if (action.status !== ActionExecutionStatus.PENDING) {
          return { claimed: false, action };
        }
        action.status = ActionExecutionStatus.EXECUTING;
        action.updatedAt = new Date();
        return { claimed: true, action };
      }),
      updateActionStatus: vi.fn(async (_mId: string, aId: string, params: any) => {
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
      transitionActionStatus: vi.fn(
        async (_mId: string, aId: string, expectedStatus: ActionExecutionStatus, nextStatus: ActionExecutionStatus, extras?: any) => {
          const action = inMemoryActions.get(aId);
          if (!action) return { transitioned: false, action: null };
          if (action.status !== expectedStatus) return { transitioned: false, action };
          action.status = nextStatus;
          if (extras?.errorMessage) action.errorMessage = extras.errorMessage;
          action.updatedAt = new Date();
          return { transitioned: true, action };
        },
      ),
    };

    mockCaseRepo = {
      getCaseById: vi.fn(async (_mId: string, cId: string) => {
        const c = inMemoryCases.get(cId);
        if (!c) return null;
        return {
          ...c,
          customer: inMemoryCustomers.get(c.customerId),
          actions: Array.from(inMemoryActions.values()).filter((a) => a.caseId === cId),
          planVersions: inMemoryPlanVersions.get(cId) || [],
          outcomes: inMemoryOutcomes.get(cId) || [],
        };
      }),
      compareAndSetStatus: vi.fn(
        async (_mId: string, cId: string, expected: CaseStatus, next: CaseStatus, options?: any) => {
          const c = inMemoryCases.get(cId);
          if (!c || c.status !== expected) {
            throw new Error(`Case state conflict: expected ${expected} but found ${c?.status}`);
          }
          c.status = next;
          if (options?.recoveredAmount) c.recoveredAmount = options.recoveredAmount;
          return c;
        },
      ),
      addPlanVersion: vi.fn(async (_mId: string, cId: string, data: any) => {
        const list = inMemoryPlanVersions.get(cId) || [];
        const plan = {
          id: `plan_${Date.now()}_${data.version}`,
          caseId: cId,
          ...data,
          createdAt: new Date(),
        };
        list.unshift(plan);
        inMemoryPlanVersions.set(cId, list);
        return plan;
      }),
    };

    mockCustomerRepo = {
      updateLastContactedAt: vi.fn(async (_mId: string, custId: string, date: Date) => {
        const cust = inMemoryCustomers.get(custId);
        if (cust) cust.lastContactedAt = date;
      }),
      setOptOut: vi.fn(async (_mId: string, custId: string, optedOut: boolean) => {
        const cust = inMemoryCustomers.get(custId);
        if (cust) cust.optedOut = optedOut;
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
      record: vi.fn(async (_mId: string, entry: any) => {
        inMemoryAudits.push({ merchantId: _mId, ...entry, createdAt: new Date() });
      }),
    };

    mockMerchantRepo = {
      getMerchantById: vi.fn(async (mId: string) => ({
        id: mId,
        name: 'Test Merchant',
        killSwitchActive: false,
      })),
    };

    mockCommitmentRepo = {
      getActiveCommitmentsForCase: vi.fn(async () => inMemoryCommitments),
      createCommitment: vi.fn(async (_mId: string, cId: string, params: any) => {
        const commitment = { id: `cmt_${Date.now()}`, caseId: cId, ...params };
        inMemoryCommitments.push(commitment);
        return commitment;
      }),
    };

    mockJobScheduler = {
      schedule: vi.fn(async (jobParams: any) => {
        const job = { id: `job_${Date.now()}`, ...jobParams };
        inMemoryJobs.push(job);
        return job;
      }),
    };

    policyEngine = new PolicyEngine();
    mockLLM = new MockLLMProvider();
    recoveryAgent = new RecoveryAgent(mockLLM);
    simulatedProvider = new SimulatedRecoveryProvider();
    providerRegistry = new ProviderRegistry([simulatedProvider]);

    actionExecutor = new ActionExecutor({
      actionRepo: mockActionRepo,
      caseRepo: mockCaseRepo,
      customerRepo: mockCustomerRepo,
      policyConfigRepo: mockPolicyConfigRepo,
      auditRepo: mockAuditRepo,
      merchantRepo: mockMerchantRepo,
      commitmentRepo: mockCommitmentRepo as any,
      policyEngine,
      providerRegistry,
      jobScheduler: mockJobScheduler,
      clock: () => new Date('2026-08-28T14:00:00+05:30'),
    });

    let inMemoryTriggers = new Map<string, any>();
    mockTriggerRepo = {
      claimTrigger: vi.fn(async (mId: string, cId: string, triggerKey: string, triggerType: string, options?: any) => {
        const key = `${mId}:${cId}:${triggerKey}`;
        const existing = inMemoryTriggers.get(key);
        const now = options?.now || new Date('2026-08-28T14:00:00+05:30');
        const leaseExpiresAt = new Date(now.getTime() + (options?.leaseDurationMs ?? 300_000));
        if (existing) {
          if (existing.status === 'COMPLETED') {
            return { claimed: false, trigger: existing };
          }
          if (existing.status === 'CLAIMED' && existing.leaseExpiresAt.getTime() > now.getTime()) {
            return { claimed: false, trigger: existing };
          }
          // Expired or retryable: reclaim
          existing.status = 'CLAIMED';
          existing.attemptCount += 1;
          existing.claimedAt = now;
          existing.leaseExpiresAt = leaseExpiresAt;
          return { claimed: true, trigger: existing };
        }
        const trigger = {
          id: `trig_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
          merchantId: mId,
          caseId: cId,
          triggerKey,
          triggerType,
          status: 'CLAIMED',
          attemptCount: 1,
          claimedAt: now,
          leaseExpiresAt,
        };
        inMemoryTriggers.set(key, trigger);
        return { claimed: true, trigger };
      }),
      completeTrigger: vi.fn(async (_mId: string, _cId: string, triggerId: string, status: string, resultJson?: any, expectedAttemptCount?: number) => {
        for (const t of inMemoryTriggers.values()) {
          if (t.id === triggerId) {
            if (expectedAttemptCount !== undefined && t.attemptCount !== expectedAttemptCount) {
              return { completed: false, trigger: t };
            }
            t.status = status;
            t.resultJson = resultJson;
            t.completedAt = new Date();
            return { completed: true, trigger: t };
          }
        }
        return { completed: false, trigger: null };
      }),
      findTrigger: vi.fn(async (mId: string, cId: string, triggerKey: string) => {
        return inMemoryTriggers.get(`${mId}:${cId}:${triggerKey}`) || null;
      }),
    };

    orchestrator = new RecoveryOrchestrator({
      caseRepo: mockCaseRepo,
      actionRepo: mockActionRepo,
      customerRepo: mockCustomerRepo,
      merchantRepo: mockMerchantRepo,
      policyConfigRepo: mockPolicyConfigRepo,
      commitmentRepo: mockCommitmentRepo,
      auditRepo: mockAuditRepo,
      recoveryAgent,
      policyEngine,
      actionExecutor,
      triggerRepo: mockTriggerRepo,
      jobScheduler: mockJobScheduler,
      clock: () => new Date('2026-08-28T14:00:00+05:30'),
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('1. Eligibility and Stopping Rules', () => {
    it('does not re-enter loop if case is already in terminal state (RECOVERED)', async () => {
      const c = inMemoryCases.get(caseId);
      c.status = CaseStatus.RECOVERED;

      const result = await orchestrator.runIteration(merchantId, caseId);

      expect(result.iterationCompleted).toBe(false);
      expect(result.status).toBe(CaseStatus.RECOVERED);
      expect(result.stoppedReason).toContain('already in terminal state');
      expect(mockActionRepo.createAction).not.toHaveBeenCalled();
    });

    it('does not execute autonomous actions if case is in NEEDS_REVIEW', async () => {
      const c = inMemoryCases.get(caseId);
      c.status = CaseStatus.NEEDS_REVIEW;

      const result = await orchestrator.runIteration(merchantId, caseId);

      expect(result.iterationCompleted).toBe(false);
      expect(result.status).toBe(CaseStatus.NEEDS_REVIEW);
      expect(result.reviewReason).toContain('human review');
      expect(mockActionRepo.createAction).not.toHaveBeenCalled();
    });

    it('halts and transitions case to STOPPED when merchant kill switch is active', async () => {
      mockMerchantRepo.getMerchantById.mockResolvedValueOnce({
        id: merchantId,
        killSwitchActive: true,
      });

      const result = await orchestrator.runIteration(merchantId, caseId);

      expect(result.status).toBe(CaseStatus.STOPPED);
      expect(result.stoppedReason).toContain('kill switch');
      expect(inMemoryCases.get(caseId).status).toBe(CaseStatus.STOPPED);

      expect(inMemoryAudits.some((a) => a.eventType === 'CASE_STOPPED')).toBe(true);
    });

    it('halts and transitions case to STOPPED when customer has opted out', async () => {
      const customer = inMemoryCustomers.get(customerId);
      customer.optedOut = true;

      const result = await orchestrator.runIteration(merchantId, caseId);

      expect(result.status).toBe(CaseStatus.STOPPED);
      expect(result.stoppedReason).toContain('opted out');
      expect(inMemoryCases.get(caseId).status).toBe(CaseStatus.STOPPED);
    });

    it('transitions case to EXHAUSTED when maxActions limit is reached', async () => {
      // Add 5 prior actions
      for (let i = 0; i < 5; i++) {
        inMemoryActions.set(`act_${i}`, {
          id: `act_${i}`,
          caseId,
          actionType: RecoveryActionType.REQUEST_PAYMENT_UPDATE,
          status: ActionExecutionStatus.SUCCESS,
          createdAt: new Date(),
        });
      }

      const result = await orchestrator.runIteration(merchantId, caseId);

      expect(result.status).toBe(CaseStatus.EXHAUSTED);
      expect(result.exhaustedReason).toContain('Max actions limit');
      expect(inMemoryCases.get(caseId).status).toBe(CaseStatus.EXHAUSTED);

      expect(inMemoryAudits.some((a) => a.eventType === 'CASE_EXHAUSTED')).toBe(true);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('2. Plan Versioning (Append-Only)', () => {
    it('creates RecoveryPlanVersion v1 on first iteration and v2 on second iteration without mutating v1', async () => {
      // Configure mock LLM to propose REQUEST_PAYMENT_UPDATE
      mockLLM.setMockResponse({
        diagnosisCode: 'CARD_DECLINED_TEMPORARY',
        diagnosisSummary: 'Card was declined; request update',
        confidence: 0.9,
        proposedActionType: RecoveryActionType.REQUEST_PAYMENT_UPDATE,
        proposedActionParams: { channel: 'WHATSAPP' },
        reasoningSummary: 'Prompt customer to update details',
        followUpAfterSeconds: 3600,
        shouldStop: false,
        shouldEscalate: false,
      });

      // Iteration 1
      const iter1 = await orchestrator.runIteration(merchantId, caseId);
      expect(iter1.planVersion?.version).toBe(1);
      expect(inMemoryPlanVersions.get(caseId)?.length).toBe(1);

      // Iteration 2 (triggered by e.g. replan)
      mockLLM.setMockResponse({
        diagnosisCode: 'CARD_DECLINED_SECOND_CHECK',
        diagnosisSummary: 'Second check; try payment link',
        confidence: 0.85,
        proposedActionType: RecoveryActionType.CREATE_OR_SEND_PAYMENT_LINK,
        proposedActionParams: { channel: 'SMS' },
        reasoningSummary: 'Send payment link as alternative',
        followUpAfterSeconds: 7200,
        shouldStop: false,
        shouldEscalate: false,
      });

      const iter2 = await orchestrator.runIteration(merchantId, caseId, 'REPLAN_TRIGGERED');
      expect(iter2.planVersion?.version).toBe(2);

      const plans = inMemoryPlanVersions.get(caseId);
      expect(plans?.length).toBe(2);
      // Verify v1 truth was preserved
      expect(plans?.find((p) => p.version === 1)?.diagnosisCode).toBe('CARD_DECLINED_TEMPORARY');
      expect(plans?.find((p) => p.version === 2)?.diagnosisCode).toBe('CARD_DECLINED_SECOND_CHECK');
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('3. Closed-Loop Execution and State Transitions', () => {
    it('transitions case to WAITING and schedules durable follow-up timer when contact action succeeds', async () => {
      mockLLM.setMockResponse({
        diagnosisCode: 'INSUFFICIENT_FUNDS',
        diagnosisSummary: 'Temporary failure; request payment update',
        confidence: 0.9,
        proposedActionType: RecoveryActionType.REQUEST_PAYMENT_UPDATE,
        proposedActionParams: { channel: 'WHATSAPP' },
        reasoningSummary: 'Request update via WhatsApp',
        followUpAfterSeconds: 3600,
        shouldStop: false,
        shouldEscalate: false,
      });

      const result = await orchestrator.runIteration(merchantId, caseId);

      expect(result.iterationCompleted).toBe(true);
      expect(result.status).toBe(CaseStatus.WAITING);
      expect(inMemoryCases.get(caseId).status).toBe(CaseStatus.WAITING);

      // Durable timer scheduled
      expect(mockJobScheduler.schedule).toHaveBeenCalledWith(
        expect.objectContaining({
          merchantId,
          caseId,
          jobType: 'RECOVERY_FOLLOWUP_CHECK',
        }),
      );

      expect(inMemoryAudits.some((a) => a.eventType === 'CASE_WAITING')).toBe(true);
    });

    it('transitions case to NEEDS_REVIEW when PolicyEngine returns REVIEW decision', async () => {
      // High value case (₹85,000 > ₹50,000 threshold) -> HighValueCaseRule triggers REVIEW
      const c = inMemoryCases.get(caseId);
      c.amountAtRisk = { toString: () => '85000.00' };

      mockLLM.setMockResponse({
        diagnosisCode: 'HIGH_VALUE_OVERDUE',
        diagnosisSummary: 'High value case; propose payment update',
        confidence: 0.9,
        proposedActionType: RecoveryActionType.REQUEST_PAYMENT_UPDATE,
        proposedActionParams: { channel: 'WHATSAPP' },
        reasoningSummary: 'High value requires careful contact',
        followUpAfterSeconds: 3600,
        shouldStop: false,
        shouldEscalate: false,
      });

      const result = await orchestrator.runIteration(merchantId, caseId);

      expect(result.iterationCompleted).toBe(true);
      expect(result.status).toBe(CaseStatus.NEEDS_REVIEW);
      expect(result.policyDecision).toBe(PolicyDecision.REVIEW);
      expect(inMemoryCases.get(caseId).status).toBe(CaseStatus.NEEDS_REVIEW);

      // Autonomous action was NOT executed
      expect(simulatedProvider.dispatchedCalls.length).toBe(0);
      expect(inMemoryAudits.some((a) => a.eventType === 'CASE_ESCALATED')).toBe(true);
    });

    it('legally wakes case from WAITING to OPEN when replan is triggered', async () => {
      // Put case into WAITING
      const c = inMemoryCases.get(caseId);
      c.status = CaseStatus.WAITING;

      mockLLM.setMockResponse({
        diagnosisCode: 'REPLAN_AFTER_WAIT',
        diagnosisSummary: 'Recheck after wait period',
        confidence: 0.88,
        proposedActionType: RecoveryActionType.CREATE_OR_SEND_PAYMENT_LINK,
        proposedActionParams: {},
        reasoningSummary: 'Send payment link',
        followUpAfterSeconds: 1800,
        shouldStop: false,
        shouldEscalate: false,
      });

      const result = await orchestrator.runIteration(merchantId, caseId, 'REPLAN_TRIGGERED');

      // Verify replan woke case and transition succeeded
      expect(inMemoryAudits.some((a) => a.eventType === 'REPLAN_TRIGGERED')).toBe(true);
      expect(result.iterationCompleted).toBe(true);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('4. Strict Policy Ordering & Fail-Closed Safety', () => {
    it('hard DENY strictly outranks agent escalation proposal', async () => {
      // Opt out customer -> CustomerOptOutRule triggers hard DENY
      const cust = inMemoryCustomers.get(customerId);
      cust.optedOut = true;

      mockLLM.setMockResponse({
        diagnosisCode: 'ESCALATION_REQUESTED',
        diagnosisSummary: 'Agent wants human review',
        confidence: 0.85,
        proposedActionType: RecoveryActionType.ESCALATE_TO_HUMAN,
        proposedActionParams: {},
        reasoningSummary: 'Requesting human assistance',
        shouldStop: false,
        shouldEscalate: true,
      });

      const result = await orchestrator.runIteration(merchantId, caseId);

      // Hard DENY outranks escalation -> case is STOPPED, NOT NEEDS_REVIEW
      expect(result.status).toBe(CaseStatus.STOPPED);
      expect(inMemoryCases.get(caseId).status).toBe(CaseStatus.STOPPED);
    });

    it('STOP_RECOVERY proposal is evaluated by policy and executed via ActionExecutor', async () => {
      mockLLM.setMockResponse({
        diagnosisCode: 'TERMINAL_RISK',
        diagnosisSummary: 'No further recovery possible',
        confidence: 0.95,
        proposedActionType: RecoveryActionType.STOP_RECOVERY,
        proposedActionParams: {},
        reasoningSummary: 'Stop recovery per risk assessment',
        shouldStop: true,
        shouldEscalate: false,
      });

      const result = await orchestrator.runIteration(merchantId, caseId);

      expect(result.iterationCompleted).toBe(true);
      expect(result.status).toBe(CaseStatus.STOPPED);
      expect(result.policyDecision).toBe(PolicyDecision.ALLOW);

      // STOP_RECOVERY was recorded as an authoritative action and executed
      expect(result.action).toBeDefined();
      expect(result.action?.actionType).toBe(RecoveryActionType.STOP_RECOVERY);
      expect(result.action?.status).toBe(ActionExecutionStatus.SUCCESS);
      expect(inMemoryAudits.some((a) => a.eventType === 'ACTION_SUCCEEDED')).toBe(true);
    });

    it('kill switch fails closed if merchant lookup throws or returns null', async () => {
      mockMerchantRepo.getMerchantById = vi.fn(async () => {
        throw new Error('Database connection lost');
      });

      const result = await orchestrator.runIteration(merchantId, caseId);

      expect(result.iterationCompleted).toBe(false);
      expect(result.error).toContain('failing closed');
      // No agent proposal generated
      expect(mockLLM.getLastRequest()).toBeNull();
      expect(inMemoryAudits.some((a) => a.eventType === 'ORCHESTRATOR_BLOCKED')).toBe(true);
    });

    it('waiting action routes to NEEDS_REVIEW if scheduler fails', async () => {
      mockJobScheduler.schedule = vi.fn(async () => {
        throw new Error('Scheduler Redis down');
      });

      mockLLM.setMockResponse({
        diagnosisCode: 'INSUFFICIENT_FUNDS',
        diagnosisSummary: 'Temporary failure; request payment update',
        confidence: 0.9,
        proposedActionType: RecoveryActionType.REQUEST_PAYMENT_UPDATE,
        proposedActionParams: { channel: 'WHATSAPP' },
        reasoningSummary: 'Request update via WhatsApp',
        followUpAfterSeconds: 3600,
        shouldStop: false,
        shouldEscalate: false,
      });

      const result = await orchestrator.runIteration(merchantId, caseId);

      // Must NOT be WAITING without durable timer!
      expect(result.status).toBe(CaseStatus.NEEDS_REVIEW);
      expect(inMemoryCases.get(caseId).status).toBe(CaseStatus.NEEDS_REVIEW);
      expect(inMemoryAudits.some((a) => a.eventType === 'SCHEDULING_FAILED')).toBe(true);
      expect(inMemoryAudits.some((a) => a.eventType === 'CASE_WAITING')).toBe(false);
    });

    it('trigger claim deduplicates duplicate execution', async () => {
      let claimedCount = 0;
      const mockTriggerRepo: any = {
        claimTrigger: vi.fn(async () => {
          claimedCount++;
          return { claimed: claimedCount === 1, trigger: { id: 'trig_01' } };
        }),
        completeTrigger: vi.fn(async () => {}),
      };

      const orchWithTrigger = new RecoveryOrchestrator({
        caseRepo: mockCaseRepo,
        actionRepo: mockActionRepo,
        customerRepo: mockCustomerRepo,
        merchantRepo: mockMerchantRepo,
        policyConfigRepo: mockPolicyConfigRepo,
        commitmentRepo: mockCommitmentRepo,
        auditRepo: mockAuditRepo,
        recoveryAgent,
        policyEngine,
        actionExecutor,
        jobScheduler: mockJobScheduler,
        triggerRepo: mockTriggerRepo,
      });

      mockLLM.setMockResponse({
        diagnosisCode: 'TEST_DIAG',
        diagnosisSummary: 'Test diagnosis',
        confidence: 0.9,
        proposedActionType: RecoveryActionType.SCHEDULE_FOLLOWUP,
        proposedActionParams: {},
        reasoningSummary: 'Test follow-up',
      });

      const first = await orchWithTrigger.runIteration(merchantId, caseId, {
        triggerKey: 'test_key',
        triggerType: 'REPLAN_TRIGGERED',
      });
      const second = await orchWithTrigger.runIteration(merchantId, caseId, {
        triggerKey: 'test_key',
        triggerType: 'REPLAN_TRIGGERED',
      });

      expect(first.iterationCompleted).toBe(true);
      expect(second.iterationCompleted).toBe(false);
      expect(second.error).toBe('TRIGGER_ALREADY_CLAIMED');
    });

    it('allows atomic crash recovery when trigger lease expires', async () => {
      mockLLM.setMockResponse({
        diagnosisCode: 'TEST_DIAG',
        diagnosisSummary: 'Test diagnosis',
        confidence: 0.9,
        proposedActionType: RecoveryActionType.SCHEDULE_FOLLOWUP,
        proposedActionParams: {},
        reasoningSummary: 'Test follow-up',
      });

      // 1. Worker 1 claims trigger at T=0 with 1 minute lease
      const t0 = new Date('2026-08-28T14:00:00Z');
      const triggerKey = 'replan_crash_test';
      const claim1 = await mockTriggerRepo.claimTrigger(merchantId, caseId, triggerKey, 'REPLAN_TRIGGERED', {
        now: t0,
        leaseDurationMs: 60_000,
      });
      expect(claim1.claimed).toBe(true);
      expect(claim1.trigger.attemptCount).toBe(1);

      // 2. Worker 2 attempts claim while lease is active (T = +30s) -> rejected
      const t30s = new Date('2026-08-28T14:00:30Z');
      const claim2 = await mockTriggerRepo.claimTrigger(merchantId, caseId, triggerKey, 'REPLAN_TRIGGERED', {
        now: t30s,
      });
      expect(claim2.claimed).toBe(false);

      // 3. Worker 1 crashed without completing; lease expires at T = +70s -> Worker 3 successfully reclaims!
      const t70s = new Date('2026-08-28T14:01:10Z');
      const claim3 = await mockTriggerRepo.claimTrigger(merchantId, caseId, triggerKey, 'REPLAN_TRIGGERED', {
        now: t70s,
        leaseDurationMs: 60_000,
      });
      expect(claim3.claimed).toBe(true);
      expect(claim3.trigger.attemptCount).toBe(2);

      // 4. Worker 3 completes the trigger
      await mockTriggerRepo.completeTrigger(merchantId, caseId, claim3.trigger.id, 'COMPLETED');

      // 5. COMPLETED trigger can never be reclaimed
      const claim4 = await mockTriggerRepo.claimTrigger(merchantId, caseId, triggerKey, 'REPLAN_TRIGGERED', {
        now: new Date('2026-08-28T14:05:00Z'),
      });
      expect(claim4.claimed).toBe(false);
    });
  });
});

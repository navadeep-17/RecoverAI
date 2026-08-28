import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  CaseStatus,
  RiskType,
} from '@prisma/client';
import {
  OutcomeObserver,
  RecoveryOrchestrator,
} from '../src/index.js';
import { NormalizedEventType, MerchantEventSource } from '@recoverai/shared';

describe('OutcomeObserver Unit Tests', () => {
  let observer: OutcomeObserver;
  let mockCaseRepo: any;
  let mockActionRepo: any;
  let mockOutcomeRepo: any;
  let mockCustomerRepo: any;
  let mockCommitmentRepo: any;
  let mockEventRepo: any;
  let mockAuditRepo: any;
  let mockJobScheduler: any;
  let mockOrchestrator: any;

  const merchantId = 'mch_obs_test_01';
  const caseId = 'case_obs_test_01';
  const customerId = 'cust_obs_test_01';

  let inMemoryCases: Map<string, any>;
  let inMemoryOutcomes: any[];
  let inMemoryCommitments: Map<string, any>;
  let inMemoryAudits: any[];

  beforeEach(() => {
    inMemoryCases = new Map();
    inMemoryOutcomes = [];
    inMemoryCommitments = new Map();
    inMemoryAudits = [];

    inMemoryCases.set(caseId, {
      id: caseId,
      merchantId,
      customerId,
      riskType: RiskType.PAYMENT_FAILURE,
      amountAtRisk: { toString: () => '14999.00' },
      currency: 'INR',
      status: CaseStatus.WAITING,
      incidentKey: `${merchantId}:PAYMENT_FAILURE:pay_123456`,
      openedAt: new Date(Date.now() - 3600000),
      contextJson: { verifiedPaymentFailureCode: 'CARD_EXPIRED' },
    });

    mockCaseRepo = {
      getCaseById: vi.fn(async (_mId: string, cId: string) => {
        return inMemoryCases.get(cId) || null;
      }),
      findActiveCaseByIncidentKey: vi.fn(async (_mId: string, incidentKey: string) => {
        return Array.from(inMemoryCases.values()).find(
          (c) => c.incidentKey === incidentKey,
        ) || null;
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
    };

    mockActionRepo = {
      getActionById: vi.fn(async () => null),
    };

    mockOutcomeRepo = {
      recordOutcome: vi.fn(async (_mId: string, cId: string, params: any) => {
        const outcome = {
          id: `out_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
          caseId: cId,
          merchantEventId: params.merchantEventId || null,
          actionId: params.actionId || null,
          outcomeType: params.outcomeType,
          amountRecovered: params.amountRecovered || null,
          detailsJson: params.detailsJson || null,
          observedAt: params.observedAt || new Date(),
        };
        inMemoryOutcomes.push(outcome);
        return outcome;
      }),
      findOutcomeByEvent: vi.fn(async (_mId: string, cId: string, eventId: string) => {
        return inMemoryOutcomes.find((o) => o.caseId === cId && o.merchantEventId === eventId) || null;
      }),
    };

    mockCustomerRepo = {
      setOptOut: vi.fn(async () => {}),
    };

    mockCommitmentRepo = {
      createCommitment: vi.fn(async (_mId: string, cId: string, params: any) => {
        const commitment = {
          id: `cmt_${Date.now()}`,
          caseId: cId,
          ...params,
          createdAt: new Date(),
        };
        inMemoryCommitments.set(commitment.id, commitment);
        return commitment;
      }),
      getActiveCommitmentsForCase: vi.fn(async () => Array.from(inMemoryCommitments.values())),
      getCommitmentById: vi.fn(async (_mId: string, _cId: string, id: string) => {
        return inMemoryCommitments.get(id) || null;
      }),
      updateCommitmentStatus: vi.fn(async (_mId: string, _cId: string, id: string, status: string) => {
        const c = inMemoryCommitments.get(id);
        if (c) c.status = status;
        return c;
      }),
    };

    mockEventRepo = {
      recordMerchantEvent: vi.fn(),
    };

    mockAuditRepo = {
      record: vi.fn(async (_mId: string, entry: any) => {
        inMemoryAudits.push({ merchantId: _mId, ...entry, createdAt: new Date() });
      }),
    };

    mockJobScheduler = {
      schedule: vi.fn(async (params: any) => ({ id: `job_${Date.now()}`, ...params })),
    };

    mockOrchestrator = {
      runIteration: vi.fn(async () => ({ iterationCompleted: true })),
    };

    observer = new OutcomeObserver({
      caseRepo: mockCaseRepo,
      actionRepo: mockActionRepo,
      outcomeRepo: mockOutcomeRepo,
      customerRepo: mockCustomerRepo,
      commitmentRepo: mockCommitmentRepo,
      eventRepo: mockEventRepo,
      auditRepo: mockAuditRepo,
      jobScheduler: mockJobScheduler,
      orchestrator: mockOrchestrator as any,
      clock: () => new Date('2026-08-28T14:00:00+05:30'),
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('1. Authoritative Monetary Recovery', () => {
    it('authoritative PAYMENT_SUCCEEDED marks case RECOVERED with exact amount and currency', async () => {
      const paymentEvent: any = {
        eventId: 'evt_pay_01',
        merchantId,
        source: MerchantEventSource.RAZORPAY,
        eventType: NormalizedEventType.PAYMENT_SUCCEEDED,
        occurredAt: new Date(),
        amount: '14999.00',
        currency: 'INR',
        payment: {
          paymentId: 'pay_123456',
        },
      };

      const result = await observer.observeMerchantEvent(paymentEvent, 'evt_db_id_01');

      expect(result.observed).toBe(true);
      expect(result.caseResolved).toBe(true);
      expect(result.caseStatus).toBe(CaseStatus.RECOVERED);

      // Verify case in memory is RECOVERED with exact amount
      const c = inMemoryCases.get(caseId);
      expect(c.status).toBe(CaseStatus.RECOVERED);
      expect(c.recoveredAmount?.toPaise()).toBe(1499900n);

      // Verify authoritative RecoveryOutcome was persisted
      expect(inMemoryOutcomes.length).toBe(1);
      expect(inMemoryOutcomes[0].outcomeType).toBe(NormalizedEventType.PAYMENT_SUCCEEDED);

      expect(inMemoryAudits.some((a) => a.eventType === 'CASE_RESOLVED_BY_PAYMENT')).toBe(true);
    });

    it('rejects recovery when currency does not match case currency (preserves case open)', async () => {
      const paymentEvent: any = {
        eventId: 'evt_pay_usd',
        merchantId,
        source: MerchantEventSource.RAZORPAY,
        eventType: NormalizedEventType.PAYMENT_SUCCEEDED,
        occurredAt: new Date(),
        amount: '200.00',
        currency: 'USD', // Case is INR!
        payment: {
          paymentId: 'pay_123456',
        },
      };

      const result = await observer.observeMerchantEvent(paymentEvent);

      expect(result.observed).toBe(false);
      expect(result.reason).toContain('Currency mismatch');

      // Case remains WAITING (not marked recovered)
      expect(inMemoryCases.get(caseId).status).toBe(CaseStatus.WAITING);
      expect(inMemoryOutcomes.length).toBe(0);

      expect(inMemoryAudits.some((a) => a.eventType === 'CURRENCY_MISMATCH_REJECTED')).toBe(true);
    });

    it('idempotent: repeated identical event returns existing outcome and does not double credit', async () => {
      const paymentEvent: any = {
        eventId: 'evt_pay_01',
        merchantId,
        source: MerchantEventSource.RAZORPAY,
        eventType: NormalizedEventType.PAYMENT_SUCCEEDED,
        occurredAt: new Date(),
        amount: '14999.00',
        currency: 'INR',
        payment: {
          paymentId: 'pay_123456',
        },
      };

      const first = await observer.observeMerchantEvent(paymentEvent, 'evt_db_id_01');
      const second = await observer.observeMerchantEvent(paymentEvent, 'evt_db_id_01');

      expect(first.observed).toBe(true);
      expect(second.observed).toBe(true);
      expect(second.deduplicated).toBe(true);

      // Only ONE RecoveryOutcome created
      expect(inMemoryOutcomes.length).toBe(1);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('2. Non-Monetary Events & Orchestrator Waking', () => {
    it('PAYMENT_METHOD_UPDATED records outcome and wakes orchestrator to replan', async () => {
      const methodUpdateEvent: any = {
        eventId: 'evt_method_01',
        merchantId,
        source: MerchantEventSource.MERCHANT,
        eventType: NormalizedEventType.PAYMENT_METHOD_UPDATED,
        occurredAt: new Date(),
        payment: {
          paymentId: 'pay_123456',
        },
      };

      const result = await observer.observeMerchantEvent(methodUpdateEvent);

      expect(result.observed).toBe(true);
      expect(result.replanTriggered).toBe(true);
      expect(mockOrchestrator.runIteration).toHaveBeenCalledWith(merchantId, caseId, 'OBSERVATION_ARRIVED');

      expect(inMemoryOutcomes.some((o) => o.outcomeType === 'PAYMENT_METHOD_UPDATED')).toBe(true);
    });

    it('Customer OPT_OUT marks customer optedOut and stops case', async () => {
      const result = await observer.observeCustomerReply(
        merchantId,
        caseId,
        'Please stop sending me messages, unsubscribe me.',
      );

      expect(result.observed).toBe(true);
      expect(result.caseStatus).toBe(CaseStatus.STOPPED);
      expect(mockCustomerRepo.setOptOut).toHaveBeenCalledWith(merchantId, customerId, true);
      expect(inMemoryCases.get(caseId).status).toBe(CaseStatus.STOPPED);

      expect(inMemoryAudits.some((a) => a.eventType === 'CUSTOMER_OPTED_OUT')).toBe(true);
    });

    it('Customer PROMISE_TO_PAY creates authoritative RecoveryCommitment and schedules timer', async () => {
      const result = await observer.observeCustomerReply(
        merchantId,
        caseId,
        'I will pay ₹14,999 on Friday without fail',
      );

      expect(result.observed).toBe(true);
      expect(mockCommitmentRepo.createCommitment).toHaveBeenCalledWith(
        merchantId,
        caseId,
        expect.objectContaining({
          promisedAmount: '14999.00',
          status: 'PENDING',
        }),
      );

      expect(mockJobScheduler.schedule).toHaveBeenCalledWith(
        expect.objectContaining({
          merchantId,
          caseId,
          jobType: 'PROMISE_TO_PAY_CHECK',
        }),
      );

      expect(inMemoryOutcomes.some((o) => o.outcomeType === 'PROMISE_TO_PAY')).toBe(true);
    });

    it('PROMISE_TO_PAY_CHECK timer on unpaid case marks commitment BROKEN and wakes orchestrator', async () => {
      // Create pending commitment
      inMemoryCommitments.set('cmt_01', {
        id: 'cmt_01',
        caseId,
        promisedAmount: '14999.00',
        promisedDate: new Date(Date.now() - 3600000), // passed
        status: 'PENDING',
      });

      const result = await observer.observeTimerFired(merchantId, caseId, 'PROMISE_TO_PAY_CHECK', {
        commitmentId: 'cmt_01',
      });

      expect(result.observed).toBe(true);
      expect(mockCommitmentRepo.updateCommitmentStatus).toHaveBeenCalledWith(
        merchantId,
        caseId,
        'cmt_01',
        'BROKEN',
      );

      expect(inMemoryOutcomes.some((o) => o.outcomeType === 'PROMISE_TO_PAY_BROKEN')).toBe(true);
      expect(mockOrchestrator.runIteration).toHaveBeenCalledWith(merchantId, caseId, 'TIMER_FIRED');
    });
  });
});

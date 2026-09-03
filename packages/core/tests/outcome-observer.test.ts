import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  ActionExecutionStatus,
  CaseStatus,
  RecoveryActionType,
  RiskType,
} from '@prisma/client';
import {
  OutcomeObserver,
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
  let mockReviewGateRequester: any;

  const merchantId = 'mch_obs_test_01';
  const caseId = 'case_obs_test_01';
  const customerId = 'cust_obs_test_01';

  let inMemoryCases: Map<string, any>;
  let inMemoryOutcomes: any[];
  let inMemoryCommitments: Map<string, any>;
  let inMemoryAudits: any[];
  let inMemoryScheduledJobs: Map<string, any>;

  beforeEach(() => {
    inMemoryCases = new Map();
    inMemoryOutcomes = [];
    inMemoryCommitments = new Map();
    inMemoryAudits = [];
    inMemoryScheduledJobs = new Map();

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
      findActiveCaseByPaymentId: vi.fn(async (_mId: string, paymentId: string) => {
        return Array.from(inMemoryCases.values()).find(
          (c) =>
            c.incidentKey?.includes(paymentId) ||
            c.contextJson?.paymentId === paymentId,
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
      claimMonetaryRecovery: vi.fn(async (_mId: string, cId: string, params: any) => {
        const currentCase = inMemoryCases.get(cId);
        if (currentCase?.recoveryOutcomeId || currentCase?.status === CaseStatus.RECOVERED) {
          const winner = inMemoryOutcomes.find((outcome) => outcome.id === currentCase.recoveryOutcomeId) || null;
          return {
            wonRecovery: false,
            deduplicated: winner?.dedupeKey === params.dedupeKey,
            outcome: winner,
            caseStatus: currentCase.status,
          };
        }
        const outcome = {
          id: `out_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
          caseId: cId,
          merchantEventId: params.merchantEventId || null,
          dedupeKey: params.dedupeKey || null,
          actionId: params.actionId || null,
          outcomeType: params.outcomeType,
          amountRecovered: params.amountRecovered || null,
          detailsJson: params.detailsJson || null,
          observedAt: params.observedAt || new Date(),
        };
        inMemoryOutcomes.push(outcome);
        currentCase.status = CaseStatus.RECOVERED;
        currentCase.recoveredAmount = params.amountRecovered;
        currentCase.recoveryOutcomeId = outcome.id;
        return { wonRecovery: true, deduplicated: false, outcome, caseStatus: CaseStatus.RECOVERED };
      }),
      recordOutcome: vi.fn(async (_mId: string, cId: string, params: any) => {
        if (params.dedupeKey) {
          const existing = inMemoryOutcomes.find((o) => o.dedupeKey === params.dedupeKey);
          if (existing) {
            return { outcome: existing, created: false };
          }
        }
        const outcome = {
          id: `out_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
          caseId: cId,
          merchantEventId: params.merchantEventId || null,
          dedupeKey: params.dedupeKey || null,
          actionId: params.actionId || null,
          outcomeType: params.outcomeType,
          amountRecovered: params.amountRecovered || null,
          detailsJson: params.detailsJson || null,
          observedAt: params.observedAt || new Date(),
        };
        inMemoryOutcomes.push(outcome);
        return { outcome, created: true };
      }),
      findOutcomeByEvent: vi.fn(async (_mId: string, cId: string, eventId: string) => {
        return inMemoryOutcomes.find((o) => o.caseId === cId && o.merchantEventId === eventId) || null;
      }),
    };

    mockCustomerRepo = {
      setOptOut: vi.fn(async () => {}),
    };

    mockCommitmentRepo = {
      createCommitmentIdempotently: vi.fn(async (_mId: string, cId: string, params: any) => {
        if (params.sourceMessageId) {
          const existing = Array.from(inMemoryCommitments.values()).find(
            (c: any) => c.caseId === cId && c.sourceMessageId === params.sourceMessageId,
          );
          if (existing) {
            return { commitment: existing, created: false };
          }
        }
        const commitment = {
          id: params.id || `cmt_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
          caseId: cId,
          sourceMessageId: params.sourceMessageId || null,
          ...params,
          createdAt: new Date(),
        };
        inMemoryCommitments.set(commitment.id, commitment);
        return { commitment, created: true };
      }),
      createCommitment: vi.fn(async (_mId: string, cId: string, params: any) => {
        const res = await mockCommitmentRepo.createCommitmentIdempotently(_mId, cId, params);
        return res.commitment;
      }),
      findBySourceMessageId: vi.fn(async (_mId: string, cId: string, sourceMessageId: string) => {
        return Array.from(inMemoryCommitments.values()).find(
          (c: any) => c.caseId === cId && c.sourceMessageId === sourceMessageId,
        ) || null;
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

    mockAuditRepo = {
      record: vi.fn(async (_mId: string, entry: any) => {
        inMemoryAudits.push(entry);
      }),
    };

    mockEventRepo = {};

    const reviewsByCase = new Map<string, any>();
    mockReviewGateRequester = {
      requestReview: vi.fn(async (_mId: string, cId: string, data: any) => {
        const current = inMemoryCases.get(cId);
        if (current.status === CaseStatus.OPEN || current.status === CaseStatus.WAITING) {
          current.status = CaseStatus.NEEDS_REVIEW;
        }
        let review = reviewsByCase.get(cId);
        const created = !review;
        if (!review) {
          review = { id: `review_${cId}`, merchantId: _mId, caseId: cId, ...data, status: 'PENDING' };
          reviewsByCase.set(cId, review);
        }
        return { created, review, caseStatus: current.status };
      }),
      reconcileTerminalCase: vi.fn(async () => {}),
    };

    const mockScheduledJobRepo = {
      getJobById: vi.fn(async (_mId: string, id: string) => {
        return inMemoryScheduledJobs.get(id) || null;
      }),
      listJobsByCase: vi.fn(async (_mId: string, cId: string) => {
        return Array.from(inMemoryScheduledJobs.values()).filter((j: any) => j.caseId === cId);
      }),
      createJob: vi.fn(async (_mId: string, data: any) => {
        const job = { id: `job_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`, merchantId: _mId, ...data, status: 'SCHEDULED' };
        inMemoryScheduledJobs.set(job.id, job);
        return { created: true, job };
      }),
    };

    mockJobScheduler = {
      schedule: vi.fn(async (params: any) => {
        const job = {
          id: `job_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
          ...params,
          status: 'SCHEDULED',
        };
        inMemoryScheduledJobs.set(job.id, job);
        return { id: job.id, created: true };
      }),
    };

    mockOrchestrator = {
      runIteration: vi.fn(async () => ({
        caseId,
        status: CaseStatus.OPEN,
        iterationCompleted: true,
      })),
    };

    observer = new OutcomeObserver({
      caseRepo: mockCaseRepo,
      actionRepo: mockActionRepo,
      outcomeRepo: mockOutcomeRepo,
      customerRepo: mockCustomerRepo,
      commitmentRepo: mockCommitmentRepo,
      eventRepo: mockEventRepo as any,
      auditRepo: mockAuditRepo,
      scheduledJobRepo: mockScheduledJobRepo as any,
      jobScheduler: mockJobScheduler,
      orchestrator: mockOrchestrator as any,
      reviewGateRequester: mockReviewGateRequester,
      clock: () => new Date('2026-08-28T14:00:00+05:30'),
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  describe('1. Authoritative Monetary Recovery', () => {
    it('resolves a payment-link payment only when the persisted action correlation exactly matches', async () => {
      mockActionRepo.getActionById.mockResolvedValue({
        id: 'act_link_001', caseId, actionType: RecoveryActionType.CREATE_OR_SEND_PAYMENT_LINK,
        status: ActionExecutionStatus.SUCCESS, providerName: 'RAZORPAY_TEST_MODE_PAYMENT_LINKS', externalActionId: 'plink_001',
      });
      const event: any = {
        merchantId, source: MerchantEventSource.RAZORPAY, externalEventId: 'evt_link_paid',
        eventType: NormalizedEventType.PAYMENT_SUCCEEDED, occurredAt: new Date(), amount: '14999.00', currency: 'INR',
        payment: { paymentId: 'pay_link_001' }, metadata: { razorpayPaymentLinkId: 'plink_001' },
      };

      const result = await observer.observeMerchantEvent(event, 'merchant_evt_link_001', {
        actionId: 'act_link_001', caseId, providerName: 'RAZORPAY_TEST_MODE_PAYMENT_LINKS', externalActionId: 'plink_001',
      });

      expect(result.caseResolved).toBe(true);
      expect(inMemoryCases.get(caseId).status).toBe(CaseStatus.RECOVERED);
      expect(inMemoryOutcomes).toHaveLength(1);
      expect(inMemoryOutcomes[0].actionId).toBe('act_link_001');
    });

    it('rejects forged payment-link correlation before any recovery credit', async () => {
      mockActionRepo.getActionById.mockResolvedValue({
        id: 'act_link_001', caseId, actionType: RecoveryActionType.CREATE_OR_SEND_PAYMENT_LINK,
        status: ActionExecutionStatus.SUCCESS, providerName: 'RAZORPAY_TEST_MODE_PAYMENT_LINKS', externalActionId: 'plink_other',
      });
      const event: any = {
        merchantId, source: MerchantEventSource.RAZORPAY, externalEventId: 'evt_forged_link',
        eventType: NormalizedEventType.PAYMENT_SUCCEEDED, occurredAt: new Date(), amount: '14999.00', currency: 'INR',
        payment: { paymentId: 'pay_link_forged' }, metadata: { razorpayPaymentLinkId: 'plink_001' },
      };

      const result = await observer.observeMerchantEvent(event, 'merchant_evt_forged', {
        actionId: 'act_link_001', caseId, providerName: 'RAZORPAY_TEST_MODE_PAYMENT_LINKS', externalActionId: 'plink_001',
      });

      expect(result.observed).toBe(false);
      expect(inMemoryCases.get(caseId).status).toBe(CaseStatus.WAITING);
      expect(inMemoryOutcomes).toHaveLength(0);
    });

    it.each([
      ['wrong action type', { actionType: RecoveryActionType.RETRY_PAYMENT }],
      ['non-success action', { status: ActionExecutionStatus.FAILED }],
      ['wrong provider', { providerName: 'SIMULATED_RECOVERY_PROVIDER' }],
      ['cross-case action', { caseId: 'case_other' }],
      ['webhook link ID mismatch', { externalActionId: 'plink_other' }],
    ])('rejects payment-link authority with %s and creates no credit', async (_label, override) => {
      mockActionRepo.getActionById.mockResolvedValue({
        id: 'act_link_001', caseId, actionType: RecoveryActionType.CREATE_OR_SEND_PAYMENT_LINK,
        status: ActionExecutionStatus.SUCCESS, providerName: 'RAZORPAY_TEST_MODE_PAYMENT_LINKS', externalActionId: 'plink_001', ...override,
      });
      const event: any = {
        merchantId, source: MerchantEventSource.RAZORPAY, externalEventId: 'evt_bad_authority', eventType: NormalizedEventType.PAYMENT_SUCCEEDED,
        occurredAt: new Date(), amount: '14999.00', currency: 'INR', payment: { paymentId: 'pay_link_001' },
        metadata: { razorpayPaymentLinkId: 'plink_001' },
      };
      const result = await observer.observeMerchantEvent(event, 'merchant_evt_bad', {
        actionId: 'act_link_001', caseId, providerName: 'RAZORPAY_TEST_MODE_PAYMENT_LINKS', externalActionId: 'plink_001',
      });
      expect(result.observed).toBe(false);
      expect(inMemoryCases.get(caseId).status).toBe(CaseStatus.WAITING);
      expect(inMemoryOutcomes).toHaveLength(0);
    });

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

      expect(inMemoryAudits.some((a) => a.eventType === 'CASE_RECOVERED_BY_PAYMENT')).toBe(true);
    });

    it.each([
      NormalizedEventType.PAYMENT_SUCCEEDED,
      NormalizedEventType.CHECKOUT_COMPLETED,
      NormalizedEventType.INVOICE_PAID,
    ])('rejects merchant-originated %s as monetary recovery evidence', async (eventType) => {
      const result = await observer.observeMerchantEvent({
        merchantId,
        source: MerchantEventSource.MERCHANT,
        externalEventId: `merchant_${eventType}`,
        eventType,
        occurredAt: new Date(),
        amount: '14999.00',
        currency: 'INR',
        payment: { paymentId: 'pay_merchant' },
      } as any);

      expect(result.observed).toBe(false);
      expect(inMemoryCases.get(caseId).status).not.toBe(CaseStatus.RECOVERED);
      expect(inMemoryCases.get(caseId).recoveredAmount).toBeUndefined();
      expect(inMemoryOutcomes).toHaveLength(0);
      expect(inMemoryAudits.some((audit) => audit.reasonCode === 'UNTRUSTED_MONETARY_EVENT_SOURCE')).toBe(true);
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

    it('rejects recovery when amount is missing', async () => {
      const paymentEvent: any = {
        eventId: 'evt_pay_no_amt',
        merchantId,
        source: MerchantEventSource.RAZORPAY,
        eventType: NormalizedEventType.PAYMENT_SUCCEEDED,
        occurredAt: new Date(),
        currency: 'INR',
        payment: {
          paymentId: 'pay_123456',
        },
      };

      const result = await observer.observeMerchantEvent(paymentEvent);

      expect(result.observed).toBe(false);
      expect(result.reason).toContain('missing or has invalid monetary amount');
      expect(inMemoryCases.get(caseId).status).toBe(CaseStatus.WAITING);
    });

    it('rejects recovery when amount is zero (0.00)', async () => {
      const paymentEvent: any = {
        eventId: 'evt_pay_zero',
        merchantId,
        source: MerchantEventSource.RAZORPAY,
        eventType: NormalizedEventType.PAYMENT_SUCCEEDED,
        occurredAt: new Date(),
        amount: '0.00',
        currency: 'INR',
        payment: {
          paymentId: 'pay_123456',
        },
      };

      const result = await observer.observeMerchantEvent(paymentEvent);

      expect(result.observed).toBe(false);
      expect(result.reason).toContain('must be strictly positive');
      expect(inMemoryCases.get(caseId).status).toBe(CaseStatus.WAITING);
    });

    it('rejects full recovery when amount is partial (< amountAtRisk, e.g. 10000.00)', async () => {
      const paymentEvent: any = {
        eventId: 'evt_pay_partial',
        merchantId,
        source: MerchantEventSource.RAZORPAY,
        eventType: NormalizedEventType.PAYMENT_SUCCEEDED,
        occurredAt: new Date(),
        amount: '10000.00',
        currency: 'INR',
        payment: {
          paymentId: 'pay_123456',
        },
      };

      const result = await observer.observeMerchantEvent(paymentEvent);

      expect(result.observed).toBe(false);
      expect(result.reason).toContain('is less than case amount at risk');
      expect(inMemoryCases.get(caseId).status).toBe(CaseStatus.WAITING);
      expect(inMemoryAudits.some((a) => a.eventType === 'PARTIAL_PAYMENT_REJECTED')).toBe(true);
    });

    it('rejects recovery when amount exceeds amountAtRisk (> amountAtRisk, e.g. 15000.00)', async () => {
      const paymentEvent: any = {
        eventId: 'evt_pay_over',
        merchantId,
        source: MerchantEventSource.RAZORPAY,
        eventType: NormalizedEventType.PAYMENT_SUCCEEDED,
        occurredAt: new Date(),
        amount: '15000.00',
        currency: 'INR',
        payment: {
          paymentId: 'pay_123456',
        },
      };

      const result = await observer.observeMerchantEvent(paymentEvent);

      expect(result.observed).toBe(false);
      expect(result.reason).toContain('exceeds case amount at risk');
      expect(inMemoryCases.get(caseId).status).toBe(CaseStatus.WAITING);
      expect(inMemoryAudits.some((a) => a.eventType === 'OVERPAYMENT_REJECTED')).toBe(true);
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
    it('PAYMENT_METHOD_UPDATED records outcome and durably wakes the worker to replan', async () => {
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
      expect(mockOrchestrator.runIteration).not.toHaveBeenCalled();
      expect(mockJobScheduler.schedule).toHaveBeenCalledWith(expect.objectContaining({
        merchantId,
        caseId,
        jobType: 'RECOVERY_ITERATION',
        payloadJson: expect.objectContaining({ triggerType: 'OBSERVATION_ARRIVED' }),
      }));

      expect(inMemoryOutcomes.some((o) => o.outcomeType === 'PAYMENT_METHOD_UPDATED')).toBe(true);
    });

    it('Customer OPT_OUT marks customer optedOut and stops case', async () => {
      const result = await observer.observeCustomerReply({
        merchantId,
        caseId,
        messageId: 'msg_optout_01',
        replyText: 'Please stop sending me messages, unsubscribe me.',
      });

      expect(result.observed).toBe(true);
      expect(result.caseStatus).toBe(CaseStatus.STOPPED);
      expect(mockCustomerRepo.setOptOut).toHaveBeenCalledWith(merchantId, customerId, true);
      expect(inMemoryCases.get(caseId).status).toBe(CaseStatus.STOPPED);

      expect(inMemoryAudits.some((a) => a.eventType === 'CUSTOMER_OPTED_OUT')).toBe(true);
    });

    it('Customer PROMISE_TO_PAY with explicit date creates authoritative RecoveryCommitment and schedules timer', async () => {
      const result = await observer.observeCustomerReply({
        merchantId,
        caseId,
        messageId: 'msg_promise_01',
        replyText: 'I will pay ₹14,999 on Friday without fail',
      });

      expect(result.observed).toBe(true);
      expect(mockCommitmentRepo.createCommitmentIdempotently).toHaveBeenCalledWith(
        merchantId,
        caseId,
        expect.objectContaining({
          sourceMessageId: 'msg_promise_01',
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

    it('Customer promise without date does NOT fabricate date (+3 days) and routes to review', async () => {
      const result = await observer.observeCustomerReply({
        merchantId,
        caseId,
        messageId: 'msg_undated_promise',
        replyText: 'I promise I will pay soon',
      });

      expect(result.observed).toBe(true);
      expect(result.caseStatus).toBe(CaseStatus.NEEDS_REVIEW);
      // Commitment must NOT be created with fabricated date
      expect(mockCommitmentRepo.createCommitment).not.toHaveBeenCalled();
      expect(mockJobScheduler.schedule).not.toHaveBeenCalled();
      expect(inMemoryAudits.some((a) => a.eventType === 'PROMISE_WITHOUT_DATE_RECEIVED')).toBe(true);
    });

    it('PROMISE_TO_PAY_CHECK timer on unpaid case marks commitment BROKEN, transitions to NEEDS_REVIEW, and emits CASE_ESCALATED audit', async () => {
      // Create pending commitment whose promisedDate has passed relative to test clock (2026-08-28T14:00:00+05:30)
      inMemoryCommitments.set('cmt_01', {
        id: 'cmt_01',
        caseId,
        promisedAmount: '14999.00',
        promisedDate: new Date('2026-08-28T12:00:00+05:30'), // passed
        status: 'PENDING',
      });

      inMemoryScheduledJobs.set('job_timer_01', {
        id: 'job_timer_01',
        merchantId,
        caseId,
        jobType: 'PROMISE_TO_PAY_CHECK',
        status: 'SCHEDULED',
        payloadJson: { caseId, commitmentId: 'cmt_01' },
      });

      const result = await observer.observeTimerFired({
        merchantId,
        caseId,
        scheduledJobId: 'job_timer_01',
        timerType: 'PROMISE_TO_PAY_CHECK',
        payload: { commitmentId: 'cmt_01' },
      });

      expect(result.observed).toBe(true);
      expect(result.caseStatus).toBe(CaseStatus.NEEDS_REVIEW);
      expect(mockCommitmentRepo.updateCommitmentStatus).toHaveBeenCalledWith(
        merchantId,
        caseId,
        'cmt_01',
        'BROKEN',
      );

      expect(inMemoryOutcomes.some((o) => o.outcomeType === 'PROMISE_TO_PAY_BROKEN')).toBe(true);
      expect(inMemoryCases.get(caseId).status).toBe(CaseStatus.NEEDS_REVIEW);
      expect(inMemoryAudits.some((a) => a.eventType === 'CASE_ESCALATED' && a.reasonCode === 'BROKEN_PROMISE_TO_PAY')).toBe(true);
    });

    it('early timer delivery is rejected without breaking commitment', async () => {
      // Commitment date is in the FUTURE relative to test clock (2026-08-28T14:00:00+05:30)
      inMemoryCommitments.set('cmt_early', {
        id: 'cmt_early',
        caseId,
        promisedAmount: '14999.00',
        promisedDate: new Date('2026-08-28T18:00:00+05:30'), // future
        status: 'PENDING',
      });

      inMemoryScheduledJobs.set('job_timer_early', {
        id: 'job_timer_early',
        merchantId,
        caseId,
        jobType: 'PROMISE_TO_PAY_CHECK',
        status: 'SCHEDULED',
        payloadJson: { caseId, commitmentId: 'cmt_early' },
      });

      const result = await observer.observeTimerFired({
        merchantId,
        caseId,
        scheduledJobId: 'job_timer_early',
        timerType: 'PROMISE_TO_PAY_CHECK',
        payload: { commitmentId: 'cmt_early' },
      });

      expect(result.observed).toBe(false);
      expect(result.reason).toContain('Early timer rejected');
      expect(mockCommitmentRepo.updateCommitmentStatus).not.toHaveBeenCalled();
    });

    it('repeated timer delivery with same scheduledJobId is deduplicated', async () => {
      inMemoryCommitments.set('cmt_02', {
        id: 'cmt_02',
        caseId,
        promisedAmount: '14999.00',
        promisedDate: new Date('2026-08-28T12:00:00+05:30'),
        status: 'PENDING',
      });

      inMemoryScheduledJobs.set('job_timer_02', {
        id: 'job_timer_02',
        merchantId,
        caseId,
        jobType: 'PROMISE_TO_PAY_CHECK',
        status: 'SCHEDULED',
        payloadJson: { caseId, commitmentId: 'cmt_02' },
      });

      const first = await observer.observeTimerFired({
        merchantId,
        caseId,
        scheduledJobId: 'job_timer_02',
        timerType: 'PROMISE_TO_PAY_CHECK',
        payload: { commitmentId: 'cmt_02' },
      });
      const second = await observer.observeTimerFired({
        merchantId,
        caseId,
        scheduledJobId: 'job_timer_02',
        timerType: 'PROMISE_TO_PAY_CHECK',
        payload: { commitmentId: 'cmt_02' },
      });

      expect(first.observed).toBe(true);
      expect(second.observed).toBe(true);
      expect(second.deduplicated).toBe(true);
      // updateCommitmentStatus called only once
      expect(mockCommitmentRepo.updateCommitmentStatus).toHaveBeenCalledTimes(1);
    });

    it('rejects observation when authoritative identity is missing to prevent undefined dedupeKey', async () => {
      // Event correlates to case via paymentId but has no eventId, merchantEventId, or externalEventId
      const invalidEvent: any = {
        merchantId,
        source: MerchantEventSource.RAZORPAY,
        eventType: NormalizedEventType.PAYMENT_SUCCEEDED,
        occurredAt: new Date(),
        amount: '14999.00',
        currency: 'INR',
        payment: { paymentId: 'pay_123456' },
      };

      await expect(observer.observeMerchantEvent(invalidEvent)).rejects.toThrow(
        'Cannot observe merchant event without an authoritative event identifier',
      );

      // Customer reply without messageId
      await expect(
        observer.observeCustomerReply({
          merchantId,
          caseId,
          messageId: '' as any,
          replyText: 'hello',
        }),
      ).rejects.toThrow('Cannot observe customer reply without authoritative messageId');

      // Timer without scheduledJobId
      await expect(
        observer.observeTimerFired({
          merchantId,
          caseId,
          scheduledJobId: '' as any,
          timerType: 'PROMISE_TO_PAY_CHECK',
        }),
      ).rejects.toThrow('Cannot observe timer fired without authoritative scheduledJobId');
    });

    it('routes to NEEDS_REVIEW if job scheduler throws during promise-to-pay recording', async () => {
      mockJobScheduler.schedule.mockRejectedValueOnce(new Error('Redis connection down'));

      const result = await observer.observeCustomerReply({
        merchantId,
        caseId,
        messageId: 'msg_fail_sched_01',
        replyText: 'I will pay INR 14999 on 2026-08-30',
      });

      expect(result.observed).toBe(true);
      expect(result.caseStatus).toBe(CaseStatus.NEEDS_REVIEW);
      expect(inMemoryAudits.some((a) => a.eventType === 'SCHEDULING_FAILED')).toBe(true);
    });

    it('rejects timer if caller transport commitmentId does not match authoritative ScheduledJob commitmentId', async () => {
      inMemoryCommitments.set('cmt_authoritative_A', {
        id: 'cmt_authoritative_A',
        caseId,
        promisedAmount: '5000.00',
        promisedDate: new Date('2026-08-28T12:00:00+05:30'),
        status: 'PENDING',
      });

      inMemoryCommitments.set('cmt_caller_B', {
        id: 'cmt_caller_B',
        caseId,
        promisedAmount: '9000.00',
        promisedDate: new Date('2026-08-28T12:00:00+05:30'),
        status: 'PENDING',
      });

      inMemoryScheduledJobs.set('job_mismatch_01', {
        id: 'job_mismatch_01',
        merchantId,
        caseId,
        jobType: 'PROMISE_TO_PAY_CHECK',
        status: 'SCHEDULED',
        payloadJson: { caseId, commitmentId: 'cmt_authoritative_A' },
      });

      const result = await observer.observeTimerFired({
        merchantId,
        caseId,
        scheduledJobId: 'job_mismatch_01',
        timerType: 'PROMISE_TO_PAY_CHECK',
        payload: { commitmentId: 'cmt_caller_B' }, // Mismatched transport payload!
      });

      expect(result.observed).toBe(false);
      expect(result.reason).toContain('Timer payload mismatch');
      expect(mockCommitmentRepo.updateCommitmentStatus).not.toHaveBeenCalled();

      // Neither commitment is mutated
      expect(inMemoryCommitments.get('cmt_authoritative_A').status).toBe('PENDING');
      expect(inMemoryCommitments.get('cmt_caller_B').status).toBe('PENDING');
    });

    it('redelivery of message B only repairs/schedules timer for commitment B, never commitment A', async () => {
      // Message A and Commitment A exist
      const replyA = 'I will pay INR 5000 on 2026-08-30';
      await observer.observeCustomerReply({
        merchantId,
        caseId,
        messageId: 'msg_A_01',
        replyText: replyA,
      });

      // Message B and Commitment B exist
      const replyB = 'I will pay INR 9000 on 2026-08-31';
      await observer.observeCustomerReply({
        merchantId,
        caseId,
        messageId: 'msg_B_01',
        replyText: replyB,
      });

      expect(inMemoryCommitments.size).toBe(2);
      const allCommitments = Array.from(inMemoryCommitments.values());
      const cmtA = allCommitments.find((c) => c.extractedFromText === replyA);
      const cmtB = allCommitments.find((c) => c.extractedFromText === replyB);
      expect(cmtA).toBeDefined();
      expect(cmtB).toBeDefined();

      // Clear scheduled jobs to simulate missing timer schedule for message B
      inMemoryScheduledJobs.clear();

      mockJobScheduler.schedule.mockClear();

      // Redeliver message B
      const redeliverResult = await observer.observeCustomerReply({
        merchantId,
        caseId,
        messageId: 'msg_B_01',
        replyText: replyB,
      });

      expect(redeliverResult.observed).toBe(true);
      expect(redeliverResult.deduplicated).toBe(true);

      // Verify that schedule was called specifically with cmtB.id, NOT cmtA.id!
      expect(mockJobScheduler.schedule).toHaveBeenCalledWith(
        expect.objectContaining({
          payloadJson: expect.objectContaining({
            commitmentId: cmtB!.id,
            messageId: 'msg_B_01',
          }),
        }),
      );
    });

    it('correlates SUBSCRIPTION_FAILURE case by payment.paymentId and resolves case on PAYMENT_SUCCEEDED', async () => {
      const subPaymentId = 'pay_sub_test_999';
      const subCaseId = 'case_sub_test_999';

      inMemoryCases.set(subCaseId, {
        id: subCaseId,
        merchantId,
        customerId,
        riskType: RiskType.SUBSCRIPTION_FAILURE,
        amountAtRisk: { toString: () => '14999.00' },
        currency: 'INR',
        status: CaseStatus.WAITING,
        incidentKey: `${merchantId}:SUBSCRIPTION_FAILURE:${subPaymentId}`,
        contextJson: { paymentId: subPaymentId },
      });

      const successEvent: any = {
        eventId: 'evt_succ_sub_999',
        merchantId,
        source: MerchantEventSource.RAZORPAY,
        eventType: NormalizedEventType.PAYMENT_SUCCEEDED,
        occurredAt: new Date(),
        amount: '14999.00',
        currency: 'INR',
        payment: {
          paymentId: subPaymentId,
        },
      };

      const result = await observer.observeMerchantEvent(successEvent, 'merchant_evt_999');

      expect(result.observed).toBe(true);
      expect(result.caseResolved).toBe(true);
      expect(result.caseStatus).toBe(CaseStatus.RECOVERED);

      const resolvedCase = inMemoryCases.get(subCaseId);
      expect(resolvedCase.status).toBe(CaseStatus.RECOVERED);
    });

    it('emits CASE_ESCALATED audit event when PROMISE_TO_PAY_CHECK timer marks commitment BROKEN', async () => {
      const pJobId = 'job_promise_broken_01';
      const pCmtId = 'cmt_broken_01';

      inMemoryCommitments.set(pCmtId, {
        id: pCmtId,
        caseId,
        merchantId,
        status: 'PENDING',
        promisedAmount: { toString: () => '85000.00' },
        promisedDate: new Date(Date.now() - 3600000), // in the past
      });

      inMemoryScheduledJobs.set(pJobId, {
        id: pJobId,
        merchantId,
        caseId,
        jobType: 'PROMISE_TO_PAY_CHECK',
        payloadJson: { commitmentId: pCmtId },
      });

      const timerResult = await observer.observeTimerFired({
        merchantId,
        caseId,
        scheduledJobId: pJobId,
        timerType: 'PROMISE_TO_PAY_CHECK',
        occurredAt: new Date(),
      });

      expect(timerResult.observed).toBe(true);
      expect(timerResult.caseStatus).toBe(CaseStatus.NEEDS_REVIEW);

      const escalatedAudit = inMemoryAudits.find((a) => a.eventType === 'CASE_ESCALATED');
      expect(escalatedAudit).toBeDefined();
      expect(escalatedAudit.reasonCode).toBe('BROKEN_PROMISE_TO_PAY');
    });
  });
});

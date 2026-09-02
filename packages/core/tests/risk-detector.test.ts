import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  RiskDetector,
  IJobScheduler,
  ScheduleJobParams,
  generateIncidentKey,
} from '../src/index.js';
import {
  RiskType,
  CaseStatus,
  MerchantEventSource,
  NormalizedEventType,
  NormalizedMerchantEvent,
  Money,
} from '@recoverai/shared';
import {
  CaseRepository,
  CustomerRepository,
  PolicyConfigRepository,
  AuditRepository,
  EventRepository,
} from '@recoverai/db';

describe('RiskDetector Specification & Deterministic Risk Invariants', () => {
  let riskDetector: RiskDetector;
  let mockCaseRepo: CaseRepository;
  let mockCustomerRepo: CustomerRepository;
  let mockPolicyConfigRepo: PolicyConfigRepository;
  let mockAuditRepo: AuditRepository;
  let mockEventRepo: EventRepository;
  let scheduledJobs: ScheduleJobParams[] = [];
  let mockJobScheduler: IJobScheduler;

  const merchantId = 'mch_test_det_01';

  beforeEach(() => {
    scheduledJobs = [];
    mockJobScheduler = {
      schedule: vi.fn(async (params: ScheduleJobParams) => {
        scheduledJobs.push(params);
        return { id: `job_${Date.now()}_${Math.random().toString(36).substring(2, 7)}` };
      }),
    };

    // In-memory mocks for unit testing domain logic
    const inMemoryCases = new Map<string, any>();
    const inMemoryCustomers = new Map<string, any>();
    const inMemoryConfigs = new Map<string, any>();
    const inMemoryAudits: any[] = [];
    const inMemoryEvents: any[] = [];

    mockCaseRepo = {
      createCaseIdempotently: vi.fn(async (mId: string, params: any) => {
        if (params.incidentKey) {
          for (const c of inMemoryCases.values()) {
            if (
              c.merchantId === mId &&
              (c.incidentKey === params.incidentKey || c.contextJson?.incidentKey === params.incidentKey)
            ) {
              return { case: c, created: false };
            }
          }
        }
        const id = params.id || `case_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
        const record = {
          id,
          merchantId: mId,
          customerId: params.customerId || null,
          riskType: params.riskType,
          amountAtRisk: params.amountAtRisk,
          currency: params.currency || 'INR',
          status: CaseStatus.OPEN,
          incidentKey: params.incidentKey,
          contextJson: params.contextJson,
          openedAt: new Date(),
          recoveredAmount: null,
          resolvedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        inMemoryCases.set(id, record);
        return { case: record, created: true };
      }),
      createCase: vi.fn(async (mId: string, params: any) => {
        const res = await (mockCaseRepo as any).createCaseIdempotently(mId, params);
        return res.case;
      }),
      compareAndSetStatus: vi.fn(async (mId: string, caseId: string, expected: CaseStatus, next: CaseStatus, opts: any) => {
        const existing = inMemoryCases.get(caseId);
        if (!existing || existing.merchantId !== mId || existing.status !== expected) {
          throw new Error('Case state transition error');
        }
        existing.status = next;
        if (opts?.recoveredAmount) {
          existing.recoveredAmount = opts.recoveredAmount;
        }
        if (opts?.resolvedAt) {
          existing.resolvedAt = opts.resolvedAt;
        }
        return existing;
      }),
      getCaseById: vi.fn(async (mId: string, caseId: string) => {
        const existing = inMemoryCases.get(caseId);
        if (existing && existing.merchantId === mId) return existing;
        return null;
      }),
      findActiveCaseByIncidentKey: vi.fn(async (mId: string, incidentKey: string) => {
        for (const c of inMemoryCases.values()) {
          if (
            c.merchantId === mId &&
            (c.status === CaseStatus.OPEN || c.status === CaseStatus.WAITING || c.status === CaseStatus.NEEDS_REVIEW) &&
            c.contextJson?.incidentKey === incidentKey
          ) {
            return c;
          }
        }
        return null;
      }),
    } as unknown as CaseRepository;

    mockCustomerRepo = {
      getOrCreateCustomer: vi.fn(async (mId: string, data: any) => {
        const id = `cust_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
        const record = {
          id,
          merchantId: mId,
          ...data,
        };
        inMemoryCustomers.set(id, record);
        return record;
      }),
    } as unknown as CustomerRepository;

    mockPolicyConfigRepo = {
      getOrCreateConfig: vi.fn(async (mId: string) => {
        return (
          inMemoryConfigs.get(mId) || {
            merchantId: mId,
            checkoutAbandonmentThresholdMinutes: 30,
            overdueGracePeriodDays: 3,
            maxRetriesPerCase: 3,
            maxContactsPerCase: 3,
            maxActionsPerCase: 5,
            highValueThreshold: '50000.00',
            minConfidenceThreshold: 0.65,
            reviewFirstMode: false,
          }
        );
      }),
    } as unknown as PolicyConfigRepository;

    mockAuditRepo = {
      record: vi.fn(async (mId: string, data: any) => {
        const audit = { id: `audit_${Date.now()}`, merchantId: mId, ...data };
        inMemoryAudits.push(audit);
        return audit;
      }),
    } as unknown as AuditRepository;

    mockEventRepo = {
      findEventByTypeAndField: vi.fn(async (mId: string, type: string, fieldPath: string[], value: unknown) => {
        for (const e of inMemoryEvents) {
          if (e.merchantId === mId && e.type === type) {
            let cur = e.payloadJson;
            for (const seg of fieldPath) {
              if (cur && typeof cur === 'object') {
                cur = cur[seg];
              } else {
                cur = undefined;
              }
            }
            if (cur === value) {
              return e;
            }
          }
        }
        return null;
      }),
    } as unknown as EventRepository;

    riskDetector = new RiskDetector(
      mockCaseRepo,
      mockCustomerRepo,
      mockPolicyConfigRepo,
      mockAuditRepo,
      mockEventRepo,
      mockJobScheduler,
    );
  });

  describe('1. PAYMENT_FAILED & PAYMENT_FAILURE Detection', () => {
    it('creates a PAYMENT_FAILURE RevenueRiskCase with verified failure code and exact amount', async () => {
      const event: NormalizedMerchantEvent = {
        merchantId,
        source: MerchantEventSource.RAZORPAY,
        externalEventId: 'pay_fail_001',
        eventType: NormalizedEventType.PAYMENT_FAILED,
        occurredAt: new Date('2026-08-28T10:00:00Z'),
        dedupeKey: 'razorpay:mch:pay_fail_001',
        amount: '14999.00',
        currency: 'INR',
        customer: {
          externalCustomerId: 'cust_001',
          email: 'payer@example.com',
          phone: '+919999999999',
          contactConsent: null,
        },
        payment: {
          paymentId: 'pay_fail_001',
          paymentMethod: 'card',
          cardNetwork: 'Visa',
          cardLast4: '4242',
          verifiedFailureCode: 'INSUFFICIENT_FUNDS',
          gatewayErrorMessage: 'Insufficient balance on card',
        },
      };

      const result = await riskDetector.handleNormalizedEvent(event);

      expect(result.riskDetected).toBe(true);
      expect(result.caseCreated).toBe(true);
      expect(result.riskType).toBe(RiskType.PAYMENT_FAILURE);
      expect(result.case).toBeDefined();
      expect(result.case?.amountAtRisk).toBe('14999.00');
      expect(result.case?.currency).toBe('INR');
      expect(result.case?.status).toBe(CaseStatus.OPEN);
      expect(scheduledJobs).toContainEqual(expect.objectContaining({
        caseId: result.caseId,
        jobType: 'RECOVERY_ITERATION',
        jobKey: `recovery-iteration:${result.caseId}:case-opened`,
        payloadJson: expect.objectContaining({ triggerKey: `CASE_OPENED:${result.caseId}`, triggerType: 'CASE_OPENED' }),
      }));

      const contextJson = result.case?.contextJson as Record<string, unknown>;
      expect(contextJson.verifiedPaymentFailureCode).toBe('INSUFFICIENT_FUNDS');
      expect(contextJson.gatewayErrorMessage).toBe('Insufficient balance on card');
      expect(contextJson.cardNetwork).toBe('Visa');
      expect(contextJson.cardLast4).toBe('4242');
    });

    it('suppresses PAYMENT_FAILED case if PAYMENT_SUCCEEDED already observed', async () => {
      vi.spyOn(mockEventRepo, 'findEventByTypeAndField').mockResolvedValueOnce({
        id: 'evt_succ_prior',
        merchantId,
        source: MerchantEventSource.RAZORPAY,
        type: NormalizedEventType.PAYMENT_SUCCEEDED,
      } as any);

      const event: NormalizedMerchantEvent = {
        merchantId,
        source: MerchantEventSource.RAZORPAY,
        externalEventId: 'pay_succeeded_prior',
        eventType: NormalizedEventType.PAYMENT_FAILED,
        occurredAt: new Date(),
        dedupeKey: 'razorpay:mch:pay_succeeded_prior',
        amount: '5000.00',
        currency: 'INR',
        payment: { paymentId: 'pay_succeeded_prior' },
      };

      const result = await riskDetector.handleNormalizedEvent(event);
      expect(result.riskDetected).toBe(false);
      expect(result.suppressed).toBe(true);
    });

    it('duplicate PAYMENT_FAILED event does not create a duplicate case', async () => {
      const event: NormalizedMerchantEvent = {
        merchantId,
        source: MerchantEventSource.RAZORPAY,
        externalEventId: 'pay_dup_01',
        eventType: NormalizedEventType.PAYMENT_FAILED,
        occurredAt: new Date(),
        dedupeKey: 'razorpay:mch:pay_dup_01',
        amount: '3500.00',
        currency: 'INR',
        payment: { paymentId: 'pay_dup_01' },
      };

      // First run: creates case
      const res1 = await riskDetector.handleNormalizedEvent(event);
      expect(res1.caseCreated).toBe(true);

      // Second run: deduplicated, no duplicate case
      const res2 = await riskDetector.handleNormalizedEvent(event);
      expect(res2.caseCreated).toBe(false);
      expect(res2.deduplicated).toBe(true);
      expect(res2.caseId).toBe(res1.caseId);
      const initialRequests = scheduledJobs.filter((job) => job.jobType === 'RECOVERY_ITERATION');
      expect(initialRequests).toHaveLength(2);
      expect(new Set(initialRequests.map((job) => job.jobKey))).toEqual(
        new Set([`recovery-iteration:${res1.caseId}:case-opened`]),
      );
    });
  });

  describe('2. SUBSCRIPTION_RENEWAL_FAILED Detection', () => {
    it('creates a SUBSCRIPTION_FAILURE case with subscription reference', async () => {
      const event: NormalizedMerchantEvent = {
        merchantId,
        source: MerchantEventSource.RAZORPAY,
        externalEventId: 'sub_evt_001',
        eventType: NormalizedEventType.SUBSCRIPTION_RENEWAL_FAILED,
        occurredAt: new Date(),
        dedupeKey: 'razorpay:mch:sub_evt_001',
        amount: '2999.00',
        currency: 'INR',
        payment: {
          subscriptionId: 'sub_gold_888',
          verifiedFailureCode: 'CARD_EXPIRED',
        },
      };

      const result = await riskDetector.handleNormalizedEvent(event);

      expect(result.riskDetected).toBe(true);
      expect(result.caseCreated).toBe(true);
      expect(result.riskType).toBe(RiskType.SUBSCRIPTION_FAILURE);
      expect(result.case?.amountAtRisk).toBe('2999.00');

      const contextJson = result.case?.contextJson as Record<string, unknown>;
      expect(contextJson.subscriptionId).toBe('sub_gold_888');
      expect(contextJson.verifiedPaymentFailureCode).toBe('CARD_EXPIRED');
    });

    it('duplicate SUBSCRIPTION_RENEWAL_FAILED does not create duplicate case', async () => {
      const event: NormalizedMerchantEvent = {
        merchantId,
        source: MerchantEventSource.RAZORPAY,
        externalEventId: 'sub_dup_01',
        eventType: NormalizedEventType.SUBSCRIPTION_RENEWAL_FAILED,
        occurredAt: new Date(),
        dedupeKey: 'razorpay:mch:sub_dup_01',
        amount: '1999.00',
        currency: 'INR',
        payment: { subscriptionId: 'sub_silver_123' },
      };

      const res1 = await riskDetector.handleNormalizedEvent(event);
      expect(res1.caseCreated).toBe(true);

      const res2 = await riskDetector.handleNormalizedEvent(event);
      expect(res2.caseCreated).toBe(false);
      expect(res2.deduplicated).toBe(true);
    });
  });

  describe('3. CHECKOUT_STARTED & CHECKOUT_ABANDONMENT Detection', () => {
    it('schedules durable abandonment recheck timer without immediately creating a case', async () => {
      const occurredAt = new Date('2026-08-28T12:00:00.000Z');
      const event: NormalizedMerchantEvent = {
        merchantId,
        source: MerchantEventSource.MERCHANT,
        eventType: NormalizedEventType.CHECKOUT_STARTED,
        occurredAt,
        dedupeKey: 'mch:sess_101:start',
        amount: '4999.00',
        currency: 'INR',
        checkout: {
          checkoutSessionId: 'sess_chk_101',
          cartItemsSummary: 'Pro Plan Monthly',
        },
      };

      const result = await riskDetector.handleNormalizedEvent(event);

      expect(result.riskDetected).toBe(false); // Not abandoned yet
      expect(result.caseCreated).toBe(false);
      expect(scheduledJobs.length).toBe(1);
      expect(scheduledJobs[0].jobType).toBe('CHECKOUT_ABANDONMENT_CHECK');
      expect(scheduledJobs[0].jobKey).toBe('checkout-abandonment:sess_chk_101');
      expect(scheduledJobs[0].merchantId).toBe(merchantId);

      // Scheduled 30 minutes in future
      const scheduledTime = scheduledJobs[0].scheduledFor.getTime();
      const expectedTime = occurredAt.getTime() + 30 * 60 * 1000;
      expect(scheduledTime).toBe(expectedTime);
    });

    it('suppresses abandonment timer if CHECKOUT_COMPLETED already observed before timer scheduling', async () => {
      vi.spyOn(mockEventRepo, 'findEventByTypeAndField').mockResolvedValueOnce({
        id: 'evt_chk_comp',
        merchantId,
        source: MerchantEventSource.MERCHANT,
        type: NormalizedEventType.CHECKOUT_COMPLETED,
      } as any);

      const event: NormalizedMerchantEvent = {
        merchantId,
        source: MerchantEventSource.MERCHANT,
        eventType: NormalizedEventType.CHECKOUT_STARTED,
        occurredAt: new Date(),
        dedupeKey: 'mch:sess_completed:start',
        checkout: { checkoutSessionId: 'sess_completed' },
      };

      const result = await riskDetector.handleNormalizedEvent(event);
      expect(result.suppressed).toBe(true);
      expect(scheduledJobs.length).toBe(0);
    });

    it('evaluateCheckoutTimer creates CHECKOUT_ABANDONMENT case if uncompleted', async () => {
      const result = await riskDetector.evaluateCheckoutTimer(merchantId, 'sess_chk_101', {
        amount: '4999.00',
        currency: 'INR',
        checkout: { checkoutSessionId: 'sess_chk_101' },
      });

      expect(result.riskDetected).toBe(true);
      expect(result.caseCreated).toBe(true);
      expect(result.riskType).toBe(RiskType.CHECKOUT_ABANDONMENT);
      expect(result.case?.amountAtRisk).toBe('4999.00');
    });

    it('evaluateCheckoutTimer suppresses case creation if CHECKOUT_COMPLETED is observed', async () => {
      vi.spyOn(mockEventRepo, 'findEventByTypeAndField').mockResolvedValueOnce({
        id: 'evt_chk_done',
        merchantId,
        source: MerchantEventSource.MERCHANT,
        type: NormalizedEventType.CHECKOUT_COMPLETED,
      } as any);

      const result = await riskDetector.evaluateCheckoutTimer(merchantId, 'sess_chk_done');
      expect(result.riskDetected).toBe(false);
      expect(result.suppressed).toBe(true);
      expect(result.caseCreated).toBe(false);
    });

    it('repeated evaluateCheckoutTimer execution does not duplicate case', async () => {
      const res1 = await riskDetector.evaluateCheckoutTimer(merchantId, 'sess_chk_dup', {
        amount: '2500.00',
        currency: 'INR',
      });
      expect(res1.caseCreated).toBe(true);

      const res2 = await riskDetector.evaluateCheckoutTimer(merchantId, 'sess_chk_dup', {
        amount: '2500.00',
        currency: 'INR',
      });
      expect(res2.caseCreated).toBe(false);
      expect(res2.deduplicated).toBe(true);
    });
  });

  describe('4. INVOICE_CREATED & OVERDUE_RECEIVABLE Detection', () => {
    it('schedules durable overdue recheck timer for dueDate + grace period', async () => {
      const dueDate = new Date('2026-09-01T00:00:00.000Z');
      const event: NormalizedMerchantEvent = {
        merchantId,
        source: MerchantEventSource.MERCHANT,
        eventType: NormalizedEventType.INVOICE_CREATED,
        occurredAt: new Date('2026-08-28T10:00:00.000Z'),
        dedupeKey: 'mch:inv_999:create',
        amount: '75000.00',
        currency: 'INR',
        invoice: {
          invoiceId: 'inv_corp_999',
          dueDate,
          paid: false,
        },
      };

      const result = await riskDetector.handleNormalizedEvent(event);

      expect(result.riskDetected).toBe(false);
      expect(result.caseCreated).toBe(false);
      expect(scheduledJobs.length).toBe(1);
      expect(scheduledJobs[0].jobType).toBe('INVOICE_OVERDUE_CHECK');
      expect(scheduledJobs[0].jobKey).toBe('invoice-overdue:inv_corp_999');

      // Scheduled for dueDate + 3 days grace
      const expectedScheduledTime = dueDate.getTime() + 3 * 24 * 60 * 60 * 1000;
      expect(scheduledJobs[0].scheduledFor.getTime()).toBe(expectedScheduledTime);
    });

    it('evaluateInvoiceTimer creates OVERDUE_RECEIVABLE case if unpaid', async () => {
      const result = await riskDetector.evaluateInvoiceTimer(merchantId, 'inv_corp_999', {
        amount: '75000.00',
        currency: 'INR',
        invoice: { invoiceId: 'inv_corp_999' },
      });

      expect(result.riskDetected).toBe(true);
      expect(result.caseCreated).toBe(true);
      expect(result.riskType).toBe(RiskType.OVERDUE_RECEIVABLE);
      expect(result.case?.amountAtRisk).toBe('75000.00');
    });

    it('evaluateInvoiceTimer suppresses case creation if INVOICE_PAID is observed', async () => {
      vi.spyOn(mockEventRepo, 'findEventByTypeAndField').mockResolvedValueOnce({
        id: 'evt_inv_paid',
        merchantId,
        type: NormalizedEventType.INVOICE_PAID,
      } as any);

      const result = await riskDetector.evaluateInvoiceTimer(merchantId, 'inv_paid_prior');
      expect(result.riskDetected).toBe(false);
      expect(result.suppressed).toBe(true);
      expect(result.caseCreated).toBe(false);
    });
  });

  describe('5. Success Events are Suppression Observations', () => {
    it('PAYMENT_SUCCEEDED leaves active recovery to OutcomeObserver', async () => {
      // Create active case
      const createdCase = await mockCaseRepo.createCase(merchantId, {
        riskType: RiskType.PAYMENT_FAILURE,
        amountAtRisk: '10000.00',
        currency: 'INR',
        incidentKey: generateIncidentKey(merchantId, RiskType.PAYMENT_FAILURE, 'pay_rec_01'),
        contextJson: {
          incidentKey: generateIncidentKey(merchantId, RiskType.PAYMENT_FAILURE, 'pay_rec_01'),
        },
      });

      const event: NormalizedMerchantEvent = {
        merchantId,
        source: MerchantEventSource.RAZORPAY,
        externalEventId: 'pay_rec_01',
        eventType: NormalizedEventType.PAYMENT_SUCCEEDED,
        occurredAt: new Date(),
        dedupeKey: 'razorpay:mch:pay_rec_01:success',
        amount: '10000.00',
        currency: 'INR',
        payment: { paymentId: 'pay_rec_01' },
      };

      const result = await riskDetector.handleNormalizedEvent(event);
      expect(result.case).toBeUndefined();
      expect(createdCase.status).toBe(CaseStatus.OPEN);
      expect(mockAuditRepo.record).toHaveBeenCalledWith(
        merchantId,
        expect.objectContaining({
          eventType: 'PAYMENT_SUCCEEDED_OBSERVED',
          reasonCode: 'MONETARY_RECOVERY_DEFERRED_TO_OUTCOME_OBSERVER',
        }),
      );
    });

    it('CHECKOUT_COMPLETED leaves active recovery to OutcomeObserver', async () => {
      const checkoutSessionId = 'sess_rec_chk_01';
      const incidentKey = generateIncidentKey(merchantId, RiskType.CHECKOUT_ABANDONMENT, checkoutSessionId);

      const createdCase = await mockCaseRepo.createCase(merchantId, {
        riskType: RiskType.CHECKOUT_ABANDONMENT,
        amountAtRisk: '5999.00',
        currency: 'INR',
        incidentKey,
        contextJson: { incidentKey, checkoutSessionId },
      });

      const event: NormalizedMerchantEvent = {
        merchantId,
        source: MerchantEventSource.MERCHANT,
        externalEventId: checkoutSessionId,
        eventType: NormalizedEventType.CHECKOUT_COMPLETED,
        occurredAt: new Date(),
        dedupeKey: `mch:${checkoutSessionId}:completed`,
        amount: '5999.00',
        currency: 'INR',
        checkout: { checkoutSessionId },
      };

      const result = await riskDetector.handleNormalizedEvent(event);
      expect(result.case).toBeUndefined();
      expect(createdCase.status).toBe(CaseStatus.OPEN);
      expect(mockAuditRepo.record).toHaveBeenCalledWith(
        merchantId,
        expect.objectContaining({
          eventType: 'CHECKOUT_COMPLETED_OBSERVED',
          reasonCode: 'MONETARY_RECOVERY_DEFERRED_TO_OUTCOME_OBSERVER',
        }),
      );
    });

    it('does not inspect or resolve a currency-mismatched success event', async () => {
      // Case is in INR
      const incidentKey = generateIncidentKey(merchantId, RiskType.PAYMENT_FAILURE, 'pay_curr_mismatch');
      const createdCase = await mockCaseRepo.createCase(merchantId, {
        riskType: RiskType.PAYMENT_FAILURE,
        amountAtRisk: '100.00',
        currency: 'INR',
        incidentKey,
        contextJson: { incidentKey },
      });

      // Event arrives in USD
      const event: NormalizedMerchantEvent = {
        merchantId,
        source: MerchantEventSource.RAZORPAY,
        externalEventId: 'pay_curr_mismatch',
        eventType: NormalizedEventType.PAYMENT_SUCCEEDED,
        occurredAt: new Date(),
        dedupeKey: 'razorpay:mch:pay_curr_mismatch:success',
        amount: '100.00',
        currency: 'USD', // Mismatched currency
        payment: { paymentId: 'pay_curr_mismatch' },
      };

      const result = await riskDetector.handleNormalizedEvent(event);
      expect(result.case).toBeUndefined();
      expect(createdCase.status).toBe(CaseStatus.OPEN);
      expect(mockAuditRepo.record).toHaveBeenCalledWith(
        merchantId,
        expect.objectContaining({
          eventType: 'PAYMENT_SUCCEEDED_OBSERVED',
          reasonCode: 'MONETARY_RECOVERY_DEFERRED_TO_OUTCOME_OBSERVER',
        }),
      );
    });
  });

  describe('6. Policy Config Validation, Missing Schedulers & Safe Fallback', () => {
    it('fails safely with DETECTION_ERROR if jobScheduler is missing when timer event arrives', async () => {
      const detectorWithoutScheduler = new RiskDetector(
        mockCaseRepo,
        mockCustomerRepo,
        mockPolicyConfigRepo,
        mockAuditRepo,
        mockEventRepo,
        undefined, // No job scheduler
      );

      const event: NormalizedMerchantEvent = {
        merchantId,
        source: MerchantEventSource.MERCHANT,
        eventType: NormalizedEventType.CHECKOUT_STARTED,
        occurredAt: new Date(),
        dedupeKey: 'mch:no_sched:chk',
        checkout: { checkoutSessionId: 'sess_no_sched' },
      };

      const result = await detectorWithoutScheduler.handleNormalizedEvent(event);
      expect(result.scheduledJobId).toBeUndefined();
      expect(mockAuditRepo.record).toHaveBeenCalledWith(
        merchantId,
        expect.objectContaining({
          eventType: 'DETECTION_ERROR',
          reasonCode: 'DURABLE_SCHEDULER_UNAVAILABLE',
        }),
      );
      // Confirms TIMER_SCHEDULED was NEVER recorded
      expect(mockAuditRepo.record).not.toHaveBeenCalledWith(
        merchantId,
        expect.objectContaining({
          eventType: 'TIMER_SCHEDULED',
        }),
      );
    });

    it('fails safely without scheduling if checkoutAbandonmentThresholdMinutes is invalid (<=0)', async () => {
      vi.spyOn(mockPolicyConfigRepo, 'getOrCreateConfig').mockResolvedValueOnce({
        merchantId,
        checkoutAbandonmentThresholdMinutes: 0, // Invalid <= 0
      } as any);

      const event: NormalizedMerchantEvent = {
        merchantId,
        source: MerchantEventSource.MERCHANT,
        eventType: NormalizedEventType.CHECKOUT_STARTED,
        occurredAt: new Date(),
        dedupeKey: 'mch:bad_cfg:chk',
        checkout: { checkoutSessionId: 'sess_bad_cfg' },
      };

      const result = await riskDetector.handleNormalizedEvent(event);
      expect(result.scheduledJobId).toBeUndefined();
      expect(scheduledJobs.length).toBe(0);
      expect(result.reason).toContain('Invalid checkoutAbandonmentThresholdMinutes');
    });

    it('fails safely without scheduling if overdueGracePeriodDays is negative', async () => {
      vi.spyOn(mockPolicyConfigRepo, 'getOrCreateConfig').mockResolvedValueOnce({
        merchantId,
        overdueGracePeriodDays: -5, // Invalid negative
      } as any);

      const event: NormalizedMerchantEvent = {
        merchantId,
        source: MerchantEventSource.MERCHANT,
        eventType: NormalizedEventType.INVOICE_CREATED,
        occurredAt: new Date(),
        dedupeKey: 'mch:bad_cfg:inv',
        invoice: { invoiceId: 'inv_bad_cfg' },
      };

      const result = await riskDetector.handleNormalizedEvent(event);
      expect(result.scheduledJobId).toBeUndefined();
      expect(scheduledJobs.length).toBe(0);
      expect(result.reason).toContain('Invalid overdueGracePeriodDays');
    });

    it('handles created vs existing case outcome explicitly without status inference', async () => {
      const paymentId = 'pay_concurrent_unit_01';
      const event1: NormalizedMerchantEvent = {
        merchantId,
        source: MerchantEventSource.RAZORPAY,
        eventType: NormalizedEventType.PAYMENT_FAILED,
        occurredAt: new Date(),
        dedupeKey: `razorpay:${merchantId}:evt1:payment.failed`,
        payment: {
          paymentId,
          verifiedFailureCode: 'BAD_REQUEST_ERROR',
        },
        amount: '1200.00',
        currency: 'INR',
      };

      const event2: NormalizedMerchantEvent = {
        merchantId,
        source: MerchantEventSource.RAZORPAY,
        eventType: NormalizedEventType.PAYMENT_FAILED,
        occurredAt: new Date(),
        dedupeKey: `razorpay:${merchantId}:evt2:payment.failed`,
        payment: {
          paymentId,
          verifiedFailureCode: 'BAD_REQUEST_ERROR',
        },
        amount: '1200.00',
        currency: 'INR',
      };

      // First delivery creates the case
      const res1 = await riskDetector.handleNormalizedEvent(event1);
      expect(res1.riskDetected).toBe(true);
      expect(res1.caseCreated).toBe(true);
      expect(res1.deduplicated).toBeFalsy();
      expect(res1.caseId).toBeDefined();

      // Second delivery for same incident resolves to existing case (created === false)
      const res2 = await riskDetector.handleNormalizedEvent(event2);
      expect(res2.riskDetected).toBe(true);
      expect(res2.caseCreated).toBe(false);
      expect(res2.deduplicated).toBe(true);
      expect(res2.caseId).toBe(res1.caseId);

      // Verify audit trail: exactly ONE RISK_DETECTED and ONE DETECTION_SKIPPED_DUPLICATE
      const audits = (mockAuditRepo.record as any).mock.calls;
      const riskDetectedCalls = audits.filter(
        (call: any[]) => call[1].eventType === 'RISK_DETECTED' && call[1].caseId === res1.caseId,
      );
      const duplicateCalls = audits.filter(
        (call: any[]) => call[1].eventType === 'DETECTION_SKIPPED_DUPLICATE' && call[1].caseId === res1.caseId,
      );

      expect(riskDetectedCalls.length).toBe(1);
      expect(duplicateCalls.length).toBe(1);
      expect(duplicateCalls[0][1].reasonCode).toBe('DUPLICATE_PAYMENT_FAILURE_INCIDENT');
    });

    it('suppresses all revenue-risk case creation when money is missing, malformed, zero, or currency is absent', async () => {
      const payment = await riskDetector.handleNormalizedEvent({
        merchantId, source: MerchantEventSource.RAZORPAY, eventType: NormalizedEventType.PAYMENT_FAILED,
        occurredAt: new Date(), dedupeKey: 'missing-payment-money', payment: { paymentId: 'pay_missing_money' }, amount: null, currency: 'INR',
      } as any);
      const subscription = await riskDetector.handleNormalizedEvent({
        merchantId, source: MerchantEventSource.RAZORPAY, eventType: NormalizedEventType.SUBSCRIPTION_RENEWAL_FAILED,
        occurredAt: new Date(), dedupeKey: 'zero-sub-money', payment: { subscriptionId: 'sub_zero_money' }, amount: '0.00', currency: 'INR',
      } as any);
      const checkout = await riskDetector.evaluateCheckoutTimer(merchantId, 'checkout_bad_money', { amount: 'bad', currency: 'INR' });
      const invoice = await riskDetector.evaluateInvoiceTimer(merchantId, 'invoice_missing_currency', { amount: '10.00' });
      for (const result of [payment, subscription, checkout, invoice]) {
        expect(result.caseCreated).toBe(false);
        expect(result.suppressed).toBe(true);
      }
    });
  });
});

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  prisma,
  checkDatabaseConnection,
  MerchantRepository,
  CaseRepository,
  CustomerRepository,
  EventRepository,
  AuditRepository,
  PolicyConfigRepository,
  HumanReviewRepository,
} from '../src/index.js';
import {
  RiskType,
  CaseStatus,
  EventSource,
  AuditActorType,
  RecoveryActionType,
  PolicyDecision,
  InvalidCaseStateTransitionError,
  CaseStateConflictError,
  Money,
  InvalidMoneyError,
  CurrencyMismatchError,
} from '@recoverai/core';
import { Prisma } from '@prisma/client';

describe('Tenant Isolation & Persistence Invariant Integration Tests', () => {
  let dbAvailable = false;
  const merchantRepo = new MerchantRepository();
  const caseRepo = new CaseRepository();
  const customerRepo = new CustomerRepository();
  const eventRepo = new EventRepository();
  const auditRepo = new AuditRepository();
  const policyConfigRepo = new PolicyConfigRepository();
  const reviewRepo = new HumanReviewRepository();

  const merchantAId = 'mch_tenant_aaa_01';
  const merchantBId = 'mch_tenant_bbb_02';

  const userAId = 'usr_tenant_aaa_01';
  const userBId = 'usr_tenant_bbb_02';

  beforeAll(async () => {
    dbAvailable = await checkDatabaseConnection();
    if (dbAvailable) {
      try {
        await prisma.merchant.deleteMany({
          where: { id: { in: [merchantAId, merchantBId] } },
        });

        await merchantRepo.create({
          id: merchantAId,
          name: 'Merchant Alpha',
          slug: 'merchant-alpha',
        });
        await merchantRepo.create({
          id: merchantBId,
          name: 'Merchant Beta',
          slug: 'merchant-beta',
        });

        await prisma.user.create({
          data: {
            id: userAId,
            merchantId: merchantAId,
            email: 'admin@alpha.com',
            name: 'Admin Alpha',
            passwordHash: 'hashed_password_a',
          },
        });

        await prisma.user.create({
          data: {
            id: userBId,
            merchantId: merchantBId,
            email: 'admin@beta.com',
            name: 'Admin Beta',
            passwordHash: 'hashed_password_b',
          },
        });
      } catch (err) {
        console.error('beforeAll error in tenant test:', err);
      }
    }
  });

  afterAll(async () => {
    if (dbAvailable) {
      try {
        await prisma.merchant.deleteMany({
          where: { id: { in: [merchantAId, merchantBId] } },
        });
      } catch (err) {
        console.error('Tenant test cleanup error:', err);
      }
    }
  });

  describe('1. Case State Machine Persistence & Concurrency (CAS) Invariants', () => {
    it('allows valid persisted transitions (OPEN -> WAITING -> RECOVERED)', async () => {
      if (!dbAvailable) return;

      const c = await caseRepo.createCase(merchantAId, {
        riskType: RiskType.PAYMENT_FAILURE,
        amountAtRisk: '1000.00',
        contextJson: {},
      });
      expect(c.status).toBe(CaseStatus.OPEN);

      const waitingCase = await caseRepo.updateCaseStatus(merchantAId, c.id, CaseStatus.WAITING);
      expect(waitingCase.status).toBe(CaseStatus.WAITING);

      const recoveredCase = await caseRepo.updateCaseStatus(
        merchantAId,
        c.id,
        CaseStatus.RECOVERED,
        { recoveredAmount: '1000.00', resolvedAt: new Date() },
      );
      expect(recoveredCase.status).toBe(CaseStatus.RECOVERED);
    });

    it('rejects illegal persisted transitions out of terminal state RECOVERED (RECOVERED -> OPEN, RECOVERED -> WAITING)', async () => {
      if (!dbAvailable) return;

      const c = await caseRepo.createCase(merchantAId, {
        riskType: RiskType.PAYMENT_FAILURE,
        amountAtRisk: '1000.00',
        contextJson: {},
      });

      await caseRepo.updateCaseStatus(merchantAId, c.id, CaseStatus.RECOVERED);

      await expect(
        caseRepo.updateCaseStatus(merchantAId, c.id, CaseStatus.OPEN),
      ).rejects.toThrow(InvalidCaseStateTransitionError);

      await expect(
        caseRepo.updateCaseStatus(merchantAId, c.id, CaseStatus.WAITING),
      ).rejects.toThrow(InvalidCaseStateTransitionError);
    });

    it('rejects illegal persisted transitions out of terminal state STOPPED (STOPPED -> OPEN)', async () => {
      if (!dbAvailable) return;

      const c = await caseRepo.createCase(merchantAId, {
        riskType: RiskType.CHECKOUT_ABANDONMENT,
        amountAtRisk: '500.00',
        contextJson: {},
      });

      await caseRepo.updateCaseStatus(merchantAId, c.id, CaseStatus.STOPPED);

      await expect(
        caseRepo.updateCaseStatus(merchantAId, c.id, CaseStatus.OPEN),
      ).rejects.toThrow(InvalidCaseStateTransitionError);
    });

    it('rejects illegal persisted transitions out of terminal state EXHAUSTED (EXHAUSTED -> NEEDS_REVIEW)', async () => {
      if (!dbAvailable) return;

      const c = await caseRepo.createCase(merchantAId, {
        riskType: RiskType.OVERDUE_RECEIVABLE,
        amountAtRisk: '25000.00',
        contextJson: {},
      });

      await caseRepo.updateCaseStatus(merchantAId, c.id, CaseStatus.EXHAUSTED);

      await expect(
        caseRepo.updateCaseStatus(merchantAId, c.id, CaseStatus.NEEDS_REVIEW),
      ).rejects.toThrow(InvalidCaseStateTransitionError);
    });

    it('enforces atomic optimistic concurrency (CAS) and throws CaseStateConflictError on stale concurrent modification', async () => {
      if (!dbAvailable) return;

      // 1. Initial state: OPEN
      const c = await caseRepo.createCase(merchantAId, {
        riskType: RiskType.PAYMENT_FAILURE,
        amountAtRisk: '3500.00',
        contextJson: {},
      });
      expect(c.status).toBe(CaseStatus.OPEN);

      // 2. Simulate concurrent Worker B changing the database row from OPEN -> WAITING
      const waiting = await caseRepo.updateCaseStatus(merchantAId, c.id, CaseStatus.WAITING);
      expect(waiting.status).toBe(CaseStatus.WAITING);

      // 3. Worker A (holding stale expectedStatus: OPEN) attempts CAS update OPEN -> RECOVERED
      // Because the row in the DB is now WAITING, updateMany affects 0 rows and throws CaseStateConflictError
      await expect(
        caseRepo.compareAndSetStatus(merchantAId, c.id, CaseStatus.OPEN, CaseStatus.RECOVERED, {
          recoveredAmount: '3500.00',
        }),
      ).rejects.toThrow(CaseStateConflictError);

      // 4. Verify newer database state is preserved (remains WAITING) and was not overwritten
      const persistedCase = await caseRepo.getCaseById(merchantAId, c.id);
      expect(persistedCase?.status).toBe(CaseStatus.WAITING);
    });

    it('enforces authoritative case currency in compareAndSetStatus and rejects mismatching Money', async () => {
      if (!dbAvailable) return;

      const caseInr = await caseRepo.createCase(merchantAId, {
        riskType: RiskType.PAYMENT_FAILURE,
        amountAtRisk: '4000.00',
        currency: 'INR',
        contextJson: {},
      });
      expect(caseInr.status).toBe(CaseStatus.OPEN);
      expect(caseInr.currency).toBe('INR');

      // Direct compareAndSetStatus: INR case + Money("100.00", USD) -> CurrencyMismatchError
      await expect(
        caseRepo.compareAndSetStatus(merchantAId, caseInr.id, CaseStatus.OPEN, CaseStatus.RECOVERED, {
          recoveredAmount: Money.fromDecimalString('100.00', 'USD'),
        }),
      ).rejects.toThrow(CurrencyMismatchError);

      // Verify no mutation occurred (status remains OPEN, recoveredAmount is null)
      const unmutated = await caseRepo.getCaseById(merchantAId, caseInr.id);
      expect(unmutated?.status).toBe(CaseStatus.OPEN);
      expect(unmutated?.recoveredAmount).toBeNull();

      // Direct compareAndSetStatus: INR case + Money("100.00", INR) -> Success
      const recovered = await caseRepo.compareAndSetStatus(
        merchantAId,
        caseInr.id,
        CaseStatus.OPEN,
        CaseStatus.RECOVERED,
        {
          recoveredAmount: Money.fromDecimalString('100.00', 'INR'),
        },
      );
      expect(recovered.status).toBe(CaseStatus.RECOVERED);
      expect(recovered.recoveredAmount?.toString()).toBe('100');
    });
  });

  describe('2. Customer / Case Tenant Consistency Invariants', () => {
    it('rejects creating a RevenueRiskCase when customerId belongs to a different merchant', async () => {
      if (!dbAvailable) return;

      // Create customer under Merchant A
      const custA = await customerRepo.getOrCreateCustomer(merchantAId, {
        externalCustomerId: 'cust_alpha_999',
        email: 'alpha_user@example.com',
      });
      expect(custA.merchantId).toBe(merchantAId);

      // Attempt to link Merchant A customer to Merchant B case
      await expect(
        caseRepo.createCase(merchantBId, {
          customerId: custA.id,
          riskType: RiskType.PAYMENT_FAILURE,
          amountAtRisk: '3000.00',
          contextJson: {},
        }),
      ).rejects.toThrow();

      // Verify zero invalid cases exist under Merchant B with custA.id
      const bCases = await prisma.revenueRiskCase.findMany({
        where: { merchantId: merchantBId, customerId: custA.id },
      });
      expect(bCases.length).toBe(0);
    });

    it('permits creating a RevenueRiskCase when customerId belongs to the same merchant', async () => {
      if (!dbAvailable) return;

      const custA = await customerRepo.getOrCreateCustomer(merchantAId, {
        externalCustomerId: 'cust_alpha_valid',
        email: 'valid_alpha@example.com',
      });

      const caseA = await caseRepo.createCase(merchantAId, {
        customerId: custA.id,
        riskType: RiskType.PAYMENT_FAILURE,
        amountAtRisk: '4500.00',
        contextJson: {},
      });

      expect(caseA.customerId).toBe(custA.id);
      expect(caseA.merchantId).toBe(merchantAId);
    });
  });

  describe('3. Exact Monetary Inputs, Prisma.Decimal & Currency Invariants', () => {
    it('persists exact monetary amounts via decimal string, Money, and Prisma.Decimal', async () => {
      if (!dbAvailable) return;

      // 1. Valid Decimal string
      const c1 = await caseRepo.createCase(merchantAId, {
        riskType: RiskType.PAYMENT_FAILURE,
        amountAtRisk: '14999.00',
        contextJson: {},
      });
      expect(c1.amountAtRisk.toString()).toBe('14999');

      // 2. Valid Money instance
      const money = Money.fromDecimalString('2499.50');
      const c2 = await caseRepo.createCase(merchantAId, {
        riskType: RiskType.SUBSCRIPTION_FAILURE,
        amountAtRisk: money,
        contextJson: {},
      });
      expect(c2.amountAtRisk.toString()).toBe('2499.5');

      // 3. Valid Prisma.Decimal
      const dec1 = new Prisma.Decimal('50000.00');
      const c3 = await caseRepo.createCase(merchantAId, {
        riskType: RiskType.OVERDUE_RECEIVABLE,
        amountAtRisk: dec1,
        contextJson: {},
      });
      expect(c3.amountAtRisk.toString()).toBe('50000');

      const dec2 = new Prisma.Decimal('0.10');
      const c4 = await caseRepo.createCase(merchantAId, {
        riskType: RiskType.PAYMENT_FAILURE,
        amountAtRisk: dec2,
        contextJson: {},
      });
      expect(c4.amountAtRisk.toString()).toBe('0.1');
    });

    it('rejects invalid Prisma.Decimal inputs (negative or >2 decimal places)', async () => {
      if (!dbAvailable) return;

      // Prisma.Decimal with >2 decimal places (1.005) -> REJECT
      await expect(
        caseRepo.createCase(merchantAId, {
          riskType: RiskType.PAYMENT_FAILURE,
          amountAtRisk: new Prisma.Decimal('1.005'),
          contextJson: {},
        }),
      ).rejects.toThrow(InvalidMoneyError);

      // Prisma.Decimal with negative value (-1.00) -> REJECT
      await expect(
        caseRepo.createCase(merchantAId, {
          riskType: RiskType.PAYMENT_FAILURE,
          amountAtRisk: new Prisma.Decimal('-1.00'),
          contextJson: {},
        }),
      ).rejects.toThrow(InvalidMoneyError);
    });

    it('enforces currency consistency between Money and explicit case currency at creation', async () => {
      if (!dbAvailable) return;

      // Money(INR) + currency INR -> ACCEPT
      const mInr = Money.fromDecimalString('100.00', 'INR');
      const c1 = await caseRepo.createCase(merchantAId, {
        riskType: RiskType.PAYMENT_FAILURE,
        amountAtRisk: mInr,
        currency: 'INR',
        contextJson: {},
      });
      expect(c1.currency).toBe('INR');

      // Money(USD) + omitted currency -> Derives USD
      const mUsd = Money.fromDecimalString('100.00', 'USD');
      const c2 = await caseRepo.createCase(merchantAId, {
        riskType: RiskType.PAYMENT_FAILURE,
        amountAtRisk: mUsd,
        contextJson: {},
      });
      expect(c2.currency).toBe('USD');

      // Money(USD) + explicit currency INR -> REJECT
      await expect(
        caseRepo.createCase(merchantAId, {
          riskType: RiskType.PAYMENT_FAILURE,
          amountAtRisk: mUsd,
          currency: 'INR',
          contextJson: {},
        }),
      ).rejects.toThrow(CurrencyMismatchError);
    });

    it('enforces currency consistency on updateCaseStatus recoveredAmount', async () => {
      if (!dbAvailable) return;

      const caseInr = await caseRepo.createCase(merchantAId, {
        riskType: RiskType.PAYMENT_FAILURE,
        amountAtRisk: '2000.00',
        currency: 'INR',
        contextJson: {},
      });
      expect(caseInr.currency).toBe('INR');

      // INR case + Money("100.00", USD) recoveredAmount -> REJECT
      await expect(
        caseRepo.updateCaseStatus(merchantAId, caseInr.id, CaseStatus.RECOVERED, {
          recoveredAmount: Money.fromDecimalString('100.00', 'USD'),
        }),
      ).rejects.toThrow(CurrencyMismatchError);

      // Verify case was not updated
      const freshCase = await caseRepo.getCaseById(merchantAId, caseInr.id);
      expect(freshCase?.status).toBe(CaseStatus.OPEN);
      expect(freshCase?.recoveredAmount).toBeNull();

      // INR case + Money("100.00", INR) recoveredAmount -> ACCEPT
      const updated = await caseRepo.updateCaseStatus(merchantAId, caseInr.id, CaseStatus.RECOVERED, {
        recoveredAmount: Money.fromDecimalString('100.00', 'INR'),
      });
      expect(updated.status).toBe(CaseStatus.RECOVERED);
      expect(updated.recoveredAmount?.toString()).toBe('100');
    });

    it('enforces currency consistency on recordOutcome amountRecovered', async () => {
      if (!dbAvailable) return;

      const caseInr = await caseRepo.createCase(merchantAId, {
        riskType: RiskType.PAYMENT_FAILURE,
        amountAtRisk: '5000.00',
        currency: 'INR',
        contextJson: {},
      });

      // INR case + Money("50.00", USD) RecoveryOutcome -> REJECT
      await expect(
        caseRepo.recordOutcome(merchantAId, caseInr.id, {
          outcomeType: 'PAYMENT_RECEIVED',
          amountRecovered: Money.fromDecimalString('50.00', 'USD'),
        }),
      ).rejects.toThrow(CurrencyMismatchError);

      const outcomes = await prisma.recoveryOutcome.findMany({ where: { caseId: caseInr.id } });
      expect(outcomes.length).toBe(0);

      // INR case + Money("50.00", INR) RecoveryOutcome -> ACCEPT
      const outcome = await caseRepo.recordOutcome(merchantAId, caseInr.id, {
        outcomeType: 'PAYMENT_RECEIVED',
        amountRecovered: Money.fromDecimalString('50.00', 'INR'),
      });
      expect(outcome.amountRecovered?.toString()).toBe('50');
    });
  });

  describe('4. Tenant Scoping of Case Child Writes', () => {
    it('prevents Merchant B from adding a plan version to Merchant A case', async () => {
      if (!dbAvailable) return;

      const caseA = await caseRepo.createCase(merchantAId, {
        riskType: RiskType.PAYMENT_FAILURE,
        amountAtRisk: '5000.00',
        contextJson: {},
      });

      await expect(
        caseRepo.addPlanVersion(merchantBId, caseA.id, {
          version: 1,
          diagnosisCode: 'CARD_DECLINED',
          diagnosisSummary: 'Card declined by issuing bank',
          confidence: 0.9,
          proposedActionType: RecoveryActionType.RETRY_PAYMENT,
          proposedActionParams: { attempt: 1 },
          reasoningSummary: 'Eligible for immediate retry',
        }),
      ).rejects.toThrow();

      const versions = await prisma.recoveryPlanVersion.findMany({ where: { caseId: caseA.id } });
      expect(versions.length).toBe(0);
    });

    it('prevents Merchant B from recording an action against Merchant A case', async () => {
      if (!dbAvailable) return;

      const caseA = await caseRepo.createCase(merchantAId, {
        riskType: RiskType.PAYMENT_FAILURE,
        amountAtRisk: '5000.00',
        contextJson: {},
      });

      await expect(
        caseRepo.recordAction(merchantBId, caseA.id, {
          actionType: RecoveryActionType.RETRY_PAYMENT,
          actionParams: { attempt: 1 },
          idempotencyKey: 'unauthorized_action_key_1',
          policyDecision: PolicyDecision.ALLOW,
          policyRationale: 'Policy check',
        }),
      ).rejects.toThrow();

      const actions = await prisma.recoveryAction.findMany({ where: { caseId: caseA.id } });
      expect(actions.length).toBe(0);
    });

    it('prevents Merchant B from recording an outcome against Merchant A case', async () => {
      if (!dbAvailable) return;

      const caseA = await caseRepo.createCase(merchantAId, {
        riskType: RiskType.PAYMENT_FAILURE,
        amountAtRisk: '5000.00',
        contextJson: {},
      });

      await expect(
        caseRepo.recordOutcome(merchantBId, caseA.id, {
          outcomeType: 'PAYMENT_RECEIVED',
          amountRecovered: '5000.00',
        }),
      ).rejects.toThrow();

      const outcomes = await prisma.recoveryOutcome.findMany({ where: { caseId: caseA.id } });
      expect(outcomes.length).toBe(0);
    });
  });

  describe('5. Cross-Tenant MerchantEvent Deduplication Isolation', () => {
    it('allows same dedupeKey for different merchants without collision or cross-tenant leak', async () => {
      if (!dbAvailable) return;

      const sharedDedupeKey = 'rzp_evt_shared_key_42';

      const eventA = await eventRepo.recordMerchantEvent(merchantAId, {
        source: EventSource.RAZORPAY,
        externalEventId: 'evt_alpha',
        type: 'PAYMENT_FAILED',
        dedupeKey: sharedDedupeKey,
        payloadJson: { merchant: 'alpha' },
      });

      const eventB = await eventRepo.recordMerchantEvent(merchantBId, {
        source: EventSource.RAZORPAY,
        externalEventId: 'evt_beta',
        type: 'PAYMENT_FAILED',
        dedupeKey: sharedDedupeKey,
        payloadJson: { merchant: 'beta' },
      });

      expect(eventA.created).toBe(true);
      expect(eventB.created).toBe(true);
      expect(eventA.event.id).not.toBe(eventB.event.id);
      expect(eventA.event.merchantId).toBe(merchantAId);
      expect(eventB.event.merchantId).toBe(merchantBId);

      // Duplicate lookup for Merchant A returns Merchant A event
      await expect(eventRepo.recordMerchantEvent(merchantAId, {
        source: EventSource.RAZORPAY,
        type: 'PAYMENT_FAILED',
        dedupeKey: sharedDedupeKey,
        payloadJson: { merchant: 'alpha_dup' },
      })).rejects.toThrow(/already accepted with different facts/);

      // Duplicate lookup for Merchant B returns Merchant B event
      await expect(eventRepo.recordMerchantEvent(merchantBId, {
        source: EventSource.RAZORPAY,
        type: 'PAYMENT_FAILED',
        dedupeKey: sharedDedupeKey,
        payloadJson: { merchant: 'beta_dup' },
      })).rejects.toThrow(/already accepted with different facts/);
    });
  });

  describe('6. Human Review Tenant Consistency', () => {
    it('rejects review creation when case belongs to a different merchant', async () => {
      if (!dbAvailable) return;

      const caseA = await caseRepo.createCase(merchantAId, {
        riskType: RiskType.PAYMENT_FAILURE,
        amountAtRisk: '2000.00',
        contextJson: {},
      });

      await expect(
        reviewRepo.createReview(merchantBId, {
          caseId: caseA.id,
          reasonForReview: 'Cross-tenant attack attempt',
        }),
      ).rejects.toThrow();
    });

    it('rejects review resolution when reviewer belongs to a different merchant', async () => {
      if (!dbAvailable) return;

      const caseA = await caseRepo.createCase(merchantAId, {
        riskType: RiskType.PAYMENT_FAILURE,
        amountAtRisk: '2000.00',
        contextJson: {},
      });

      const review = await reviewRepo.createReview(merchantAId, {
        caseId: caseA.id,
        reasonForReview: 'High value recovery review',
      });

      await expect(
        reviewRepo.resolveReview(merchantAId, review.id, {
          reviewerId: userBId, // userB belongs to merchantB
          status: 'APPROVED',
          reviewNotes: 'Unauthorized approval attempt',
        }),
      ).rejects.toThrow();
    });
  });

  describe('7. General Tenant Scoping, Customer Isolation & Audit Logging', () => {
    it('enforces strict tenant scoping on case retrieval and lists', async () => {
      if (!dbAvailable) return;

      const caseA = await caseRepo.createCase(merchantAId, {
        riskType: RiskType.PAYMENT_FAILURE,
        amountAtRisk: '14999.00',
        currency: 'INR',
        contextJson: { invoiceNumber: 'INV-1001' },
      });

      const caseB = await caseRepo.createCase(merchantBId, {
        riskType: RiskType.SUBSCRIPTION_FAILURE,
        amountAtRisk: '4999.00',
        currency: 'INR',
        contextJson: { subscriptionId: 'sub_1002' },
      });

      const fetchedByA = await caseRepo.getCaseById(merchantAId, caseA.id);
      expect(fetchedByA).not.toBeNull();
      expect(fetchedByA?.id).toBe(caseA.id);

      const fetchedByBCrossTenant = await caseRepo.getCaseById(merchantBId, caseA.id);
      expect(fetchedByBCrossTenant).toBeNull();

      const listB = await caseRepo.listCases(merchantBId);
      expect(listB.some((c) => c.id === caseA.id)).toBe(false);
      expect(listB.some((c) => c.id === caseB.id)).toBe(true);
    });

    it('enforces customer tenant isolation', async () => {
      if (!dbAvailable) return;

      const custA = await customerRepo.getOrCreateCustomer(merchantAId, {
        externalCustomerId: 'ext_cust_123',
        email: 'customer@example.com',
      });

      expect(custA.merchantId).toBe(merchantAId);

      await expect(
        customerRepo.updateContactTimestamp(merchantBId, custA.id, new Date()),
      ).rejects.toThrow();
    });

    it('enforces unique idempotencyKey on RecoveryAction', async () => {
      if (!dbAvailable) return;

      const caseRec = await caseRepo.createCase(merchantAId, {
        riskType: RiskType.PAYMENT_FAILURE,
        amountAtRisk: '2000.00',
        contextJson: {},
      });

      const idempotencyKey = 'action_idem_key_777';

      await caseRepo.recordAction(merchantAId, caseRec.id, {
        actionType: RecoveryActionType.RETRY_PAYMENT,
        actionParams: { attemptNumber: 1 },
        idempotencyKey,
        policyDecision: PolicyDecision.ALLOW,
        policyRationale: 'Valid retry within policy limit',
      });

      await expect(
        caseRepo.recordAction(merchantAId, caseRec.id, {
          actionType: RecoveryActionType.RETRY_PAYMENT,
          actionParams: { attemptNumber: 2 },
          idempotencyKey,
          policyDecision: PolicyDecision.ALLOW,
          policyRationale: 'Duplicate action attempt',
        }),
      ).rejects.toThrow();
    });

    it('records append-only audit events scoped to tenant', async () => {
      if (!dbAvailable) return;

      const audit = await auditRepo.record(merchantAId, {
        eventType: 'CASE_DETECTED',
        actorType: AuditActorType.SYSTEM,
        inputSummaryJson: { source: 'webhook' },
        outputSummaryJson: { riskType: 'PAYMENT_FAILURE' },
        reasonCode: 'PAYMENT_FAILED_RECEIVED',
      });

      expect(audit.id).toBeDefined();
      expect(audit.merchantId).toBe(merchantAId);

      const logs = await auditRepo.listByMerchant(merchantAId);
      expect(logs.some((l) => l.id === audit.id)).toBe(true);

      const logsB = await auditRepo.listByMerchant(merchantBId);
      expect(logsB.some((l) => l.id === audit.id)).toBe(false);
    });

    it('creates and manages merchant policy configuration with isolated quiet hours and recovery window', async () => {
      if (!dbAvailable) return;

      const configA = await policyConfigRepo.getOrCreateConfig(merchantAId);
      expect(configA.merchantId).toBe(merchantAId);
      expect(configA.maxRetriesPerCase).toBe(3);
      expect(configA.maxActionsPerCase).toBe(5);
      expect(configA.quietHoursStart).toBe(21);
      expect(configA.quietHoursEnd).toBe(9);
      expect(configA.quietHoursTimezone).toBe('Asia/Kolkata');
      expect(configA.maxRecoveryWindowDays).toBe(30);
      expect(configA.overdueGracePeriodDays).toBe(3);

      // Update Merchant A with custom safety policies
      const updatedA = await policyConfigRepo.updateConfig(merchantAId, {
        maxRetriesPerCase: 5,
        maxActionsPerCase: 8,
        reviewFirstMode: true,
        highValueThreshold: '75000.00',
        quietHoursStart: 22,
        quietHoursEnd: 8,
        quietHoursTimezone: 'America/New_York',
        maxRecoveryWindowDays: 45,
        overdueGracePeriodDays: 5,
      });

      expect(updatedA.maxRetriesPerCase).toBe(5);
      expect(updatedA.maxActionsPerCase).toBe(8);
      expect(updatedA.reviewFirstMode).toBe(true);
      expect(updatedA.highValueThreshold.toString()).toBe('75000');
      expect(updatedA.quietHoursStart).toBe(22);
      expect(updatedA.quietHoursEnd).toBe(8);
      expect(updatedA.quietHoursTimezone).toBe('America/New_York');
      expect(updatedA.maxRecoveryWindowDays).toBe(45);
      expect(updatedA.overdueGracePeriodDays).toBe(5);

      // Verify Merchant B policy configuration is completely isolated
      const configB = await policyConfigRepo.getOrCreateConfig(merchantBId);
      expect(configB.merchantId).toBe(merchantBId);
      expect(configB.maxRetriesPerCase).toBe(3);
      expect(configB.maxActionsPerCase).toBe(5);
      expect(configB.reviewFirstMode).toBe(false);
      expect(configB.quietHoursStart).toBe(21);
      expect(configB.quietHoursEnd).toBe(9);
      expect(configB.quietHoursTimezone).toBe('Asia/Kolkata');
      expect(configB.maxRecoveryWindowDays).toBe(30);
      expect(configB.overdueGracePeriodDays).toBe(3);
    });

    it('rejects invalid policy configuration inputs in PolicyConfigRepository', async () => {
      if (!dbAvailable) return;

      // Invalid timezone
      await expect(
        policyConfigRepo.updateConfig(merchantAId, {
          quietHoursTimezone: 'not-a-real-timezone',
        }),
      ).rejects.toThrow();

      // Out of range start hour
      await expect(
        policyConfigRepo.updateConfig(merchantAId, {
          quietHoursStart: 99,
        }),
      ).rejects.toThrow();

      // Negative end hour
      await expect(
        policyConfigRepo.updateConfig(merchantAId, {
          quietHoursEnd: -3,
        }),
      ).rejects.toThrow();

      // maxActionsPerCase <= 0
      await expect(
        policyConfigRepo.updateConfig(merchantAId, {
          maxActionsPerCase: 0,
        }),
      ).rejects.toThrow();

      // Malformed decimal threshold
      await expect(
        policyConfigRepo.updateConfig(merchantAId, {
          highValueThreshold: '100.555',
        }),
      ).rejects.toThrow();
    });

    it('preserves null/unknown contact consent in CustomerRepository and isolates consent updates', async () => {
      if (!dbAvailable) return;

      // Customer created with absent consent remains null
      const custUnknown = await customerRepo.getOrCreateCustomer(merchantAId, {
        externalCustomerId: 'cust_unknown_consent',
        email: 'unknown_consent@example.com',
      });
      expect(custUnknown.contactConsent).toBeNull();

      // Explicit set to false
      const custDenied = await customerRepo.setContactConsent(merchantAId, custUnknown.id, false);
      expect(custDenied.contactConsent).toBe(false);

      // Explicit set to true
      const custGranted = await customerRepo.setContactConsent(merchantAId, custUnknown.id, true);
      expect(custGranted.contactConsent).toBe(true);

      // Cross-tenant update rejection
      await expect(
        customerRepo.setContactConsent(merchantBId, custUnknown.id, false),
      ).rejects.toThrow();
    });
  });
});

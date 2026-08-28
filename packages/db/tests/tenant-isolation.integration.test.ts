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
} from '@recoverai/core';

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

  describe('1. Case State Machine Persistence Invariants', () => {
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
  });

  describe('2. Tenant Scoping of Case Child Writes', () => {
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

  describe('3. Cross-Tenant MerchantEvent Deduplication Isolation', () => {
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
      const dupA = await eventRepo.recordMerchantEvent(merchantAId, {
        source: EventSource.RAZORPAY,
        type: 'PAYMENT_FAILED',
        dedupeKey: sharedDedupeKey,
        payloadJson: { merchant: 'alpha_dup' },
      });
      expect(dupA.created).toBe(false);
      expect(dupA.event.id).toBe(eventA.event.id);
      expect(dupA.event.merchantId).toBe(merchantAId);

      // Duplicate lookup for Merchant B returns Merchant B event
      const dupB = await eventRepo.recordMerchantEvent(merchantBId, {
        source: EventSource.RAZORPAY,
        type: 'PAYMENT_FAILED',
        dedupeKey: sharedDedupeKey,
        payloadJson: { merchant: 'beta_dup' },
      });
      expect(dupB.created).toBe(false);
      expect(dupB.event.id).toBe(eventB.event.id);
      expect(dupB.event.merchantId).toBe(merchantBId);
    });
  });

  describe('4. Human Review Tenant Consistency', () => {
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

  describe('5. General Tenant Scoping, Customer Isolation & Audit Logging', () => {
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

    it('creates and manages merchant policy configuration', async () => {
      if (!dbAvailable) return;

      const config = await policyConfigRepo.getOrCreateConfig(merchantAId);
      expect(config.merchantId).toBe(merchantAId);
      expect(config.maxRetriesPerCase).toBe(3);

      const updated = await policyConfigRepo.updateConfig(merchantAId, {
        maxRetriesPerCase: 5,
        reviewFirstMode: true,
      });

      expect(updated.maxRetriesPerCase).toBe(5);
      expect(updated.reviewFirstMode).toBe(true);
    });
  });
});

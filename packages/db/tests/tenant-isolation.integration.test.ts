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
} from '../src/index.js';
import {
  RiskType,
  CaseStatus,
  EventSource,
  AuditActorType,
  RecoveryActionType,
  PolicyDecision,
} from '@recoverai/shared';

describe('Tenant Isolation & Constraint Integrity Integration Tests', () => {
  let dbAvailable = false;
  const merchantRepo = new MerchantRepository();
  const caseRepo = new CaseRepository();
  const customerRepo = new CustomerRepository();
  const eventRepo = new EventRepository();
  const auditRepo = new AuditRepository();
  const policyConfigRepo = new PolicyConfigRepository();

  const merchantAId = 'mch_tenant_aaa_01';
  const merchantBId = 'mch_tenant_bbb_02';

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
        await prisma.$disconnect();
      } catch (err) {
        console.error('Tenant test cleanup error:', err);
      }
    }
  });

  it('enforces strict tenant scoping on case retrieval and lists', async () => {
    if (!dbAvailable) {
      console.warn('PostgreSQL database not available in local environment; test will run in CI');
      expect(true).toBe(true);
      return;
    }

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
    if (!dbAvailable) {
      expect(true).toBe(true);
      return;
    }

    const custA = await customerRepo.getOrCreateCustomer(merchantAId, {
      externalCustomerId: 'ext_cust_123',
      email: 'customer@example.com',
    });

    expect(custA.merchantId).toBe(merchantAId);

    await expect(
      customerRepo.updateContactTimestamp(merchantBId, custA.id, new Date()),
    ).rejects.toThrow();
  });

  it('enforces deduplication constraint on MerchantEvent dedupeKey', async () => {
    if (!dbAvailable) {
      expect(true).toBe(true);
      return;
    }

    const dedupeKey = 'rzp_evt_test_dedupe_999';
    const firstAttempt = await eventRepo.recordMerchantEvent(merchantAId, {
      source: EventSource.RAZORPAY,
      externalEventId: 'evt_001',
      type: 'PAYMENT_FAILED',
      dedupeKey,
      payloadJson: { paymentId: 'pay_001', amount: 14999 },
    });

    expect(firstAttempt.created).toBe(true);

    const secondAttempt = await eventRepo.recordMerchantEvent(merchantAId, {
      source: EventSource.RAZORPAY,
      externalEventId: 'evt_001',
      type: 'PAYMENT_FAILED',
      dedupeKey,
      payloadJson: { paymentId: 'pay_001', amount: 14999 },
    });

    expect(secondAttempt.created).toBe(false);
    expect(secondAttempt.event.id).toBe(firstAttempt.event.id);
  });

  it('enforces unique idempotencyKey on RecoveryAction', async () => {
    if (!dbAvailable) {
      expect(true).toBe(true);
      return;
    }

    const caseRec = await caseRepo.createCase(merchantAId, {
      riskType: RiskType.PAYMENT_FAILURE,
      amountAtRisk: '2000.00',
      contextJson: {},
    });

    const idempotencyKey = 'action_idem_key_777';

    await caseRepo.recordAction(caseRec.id, {
      actionType: RecoveryActionType.RETRY_PAYMENT,
      actionParams: { attemptNumber: 1 },
      idempotencyKey,
      policyDecision: PolicyDecision.ALLOW,
      policyRationale: 'Valid retry within policy limit',
    });

    await expect(
      caseRepo.recordAction(caseRec.id, {
        actionType: RecoveryActionType.RETRY_PAYMENT,
        actionParams: { attemptNumber: 2 },
        idempotencyKey,
        policyDecision: PolicyDecision.ALLOW,
        policyRationale: 'Duplicate action attempt',
      }),
    ).rejects.toThrow();
  });

  it('records append-only audit events scoped to tenant', async () => {
    if (!dbAvailable) {
      expect(true).toBe(true);
      return;
    }

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
    if (!dbAvailable) {
      expect(true).toBe(true);
      return;
    }

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

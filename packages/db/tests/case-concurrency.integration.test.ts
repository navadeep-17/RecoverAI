import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  prisma,
  CaseRepository,
  MerchantRepository,
  EventRepository,
  CustomerRepository,
  AuditRepository,
  PolicyConfigRepository,
} from '../src/index.js';
import { RiskType, NormalizedEventType, EventSource } from '@recoverai/shared';
import { RiskDetector, NormalizedMerchantEvent } from '@recoverai/core';

describe("Case Concurrent Creation & Unique Incident Key Invariants", () => {
  let dbAvailable = false;
  let caseRepo: CaseRepository;
  let merchantRepo: MerchantRepository;
  let eventRepo: EventRepository;
  let customerRepo: CustomerRepository;
  let auditRepo: AuditRepository;
  let policyConfigRepo: PolicyConfigRepository;
  let riskDetector: RiskDetector;

  let merchantAId: string;
  let merchantBId: string;

  beforeAll(async () => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      dbAvailable = true;

      caseRepo = new CaseRepository();
      merchantRepo = new MerchantRepository();
      eventRepo = new EventRepository();
      customerRepo = new CustomerRepository();
      auditRepo = new AuditRepository();
      policyConfigRepo = new PolicyConfigRepository();

      riskDetector = new RiskDetector(
        caseRepo,
        customerRepo,
        policyConfigRepo,
        auditRepo,
        eventRepo,
      );

      const mchA = await merchantRepo.createMerchant({
        name: 'Merchant Case Concurrency A',
        slug: `mch-case-conc-a-${Date.now()}`,
      });
      merchantAId = mchA.id;

      const mchB = await merchantRepo.createMerchant({
        name: 'Merchant Case Concurrency B',
        slug: `mch-case-conc-b-${Date.now()}`,
      });
      merchantBId = mchB.id;
    } catch {
      dbAvailable = false;
    }
  });

  afterAll(async () => {
    if (dbAvailable) {
      if (merchantAId) await merchantRepo.deleteMerchant(merchantAId).catch(() => {});
      if (merchantBId) await merchantRepo.deleteMerchant(merchantBId).catch(() => {});
      await prisma.$disconnect();
    }
  });

  it('handles Promise.all concurrent createCaseIdempotently with identical incidentKey safely', async () => {
    if (!dbAvailable) return;

    const incidentKey = `${merchantAId}:PAYMENT_FAILURE:pay_repo_conc_${Date.now()}`;

    const createPromises = Array.from({ length: 5 }, () =>
      caseRepo.createCaseIdempotently(merchantAId, {
        riskType: RiskType.PAYMENT_FAILURE,
        amountAtRisk: '1000.00',
        currency: 'INR',
        incidentKey,
        contextJson: { incidentKey, test: 'concurrency' },
      }),
    );

    const results = await Promise.all(createPromises);

    const createdCount = results.filter((r) => r.created).length;
    const existingCount = results.filter((r) => !r.created).length;

    expect(createdCount).toBe(1);
    expect(existingCount).toBe(4);

    const firstCaseId = results[0].case.id;
    expect(results.every((r) => r.case.id === firstCaseId)).toBe(true);

    const dbCases = await prisma.revenueRiskCase.findMany({
      where: { merchantId: merchantAId, incidentKey },
    });
    expect(dbCases.length).toBe(1);
    expect(dbCases[0].id).toBe(firstCaseId);
  });

  it('proves RiskDetector handles simultaneous detection of the same payment incident concurrency-safely', async () => {
    if (!dbAvailable) return;

    const paymentId = `pay_det_conc_${Date.now()}`;

    // Distinct externalEventIds and dedupeKeys so events pass individual event ingestion
    // but target the exact same payment failure incident
    const events: NormalizedMerchantEvent[] = Array.from({ length: 5 }, (_, idx) => ({
      merchantId: merchantAId,
      source: EventSource.RAZORPAY,
      eventType: NormalizedEventType.PAYMENT_FAILED,
      externalEventId: `evt_${paymentId}_${idx}`,
      dedupeKey: `razorpay:${merchantAId}:evt_${paymentId}_${idx}:payment.failed`,
      occurredAt: new Date(),
      amount: '2500.00',
      currency: 'INR',
      customer: {
        externalCustomerId: `cust_conc_${Date.now()}`,
        email: `conc_${Date.now()}@example.com`,
      },
      payment: {
        paymentId,
        verifiedFailureCode: 'BAD_REQUEST_ERROR',
        gatewayErrorMessage: 'Insufficient funds in customer account',
        paymentMethod: 'card',
      },
    }));

    const results = await Promise.all(events.map((evt) => riskDetector.handleNormalizedEvent(evt)));

    // 1. Exactly ONE result must report caseCreated === true
    const createdResults = results.filter((r) => r.caseCreated === true);
    expect(createdResults.length).toBe(1);

    // 2. All other results must report caseCreated === false and deduplicated === true
    const duplicateResults = results.filter((r) => r.caseCreated === false);
    expect(duplicateResults.length).toBe(4);
    expect(duplicateResults.every((r) => r.deduplicated === true)).toBe(true);

    // 3. Every result references the exact same caseId
    const targetCaseId = createdResults[0].caseId;
    expect(targetCaseId).toBeDefined();
    expect(results.every((r) => r.caseId === targetCaseId)).toBe(true);

    // 4. Exactly ONE RevenueRiskCase exists in PostgreSQL database
    const dbCases = await prisma.revenueRiskCase.findMany({
      where: { merchantId: merchantAId, id: targetCaseId },
    });
    expect(dbCases.length).toBe(1);

    // 5. Exactly ONE RISK_DETECTED audit event exists for that case
    const riskDetectedAudits = await prisma.auditEvent.findMany({
      where: {
        merchantId: merchantAId,
        caseId: targetCaseId,
        eventType: 'RISK_DETECTED',
      },
    });
    expect(riskDetectedAudits.length).toBe(1);

    // 6. Losing results logged duplicate suppression audits
    const skippedAudits = await prisma.auditEvent.findMany({
      where: {
        merchantId: merchantAId,
        caseId: targetCaseId,
        eventType: 'DETECTION_SKIPPED_DUPLICATE',
      },
    });
    expect(skippedAudits.length).toBe(4);
  });

  it('permits identical incidentKey across different merchants without collision', async () => {
    if (!dbAvailable) return;

    const sharedIncidentKey = `shared_incident_${Date.now()}`;

    const resA = await caseRepo.createCaseIdempotently(merchantAId, {
      riskType: RiskType.PAYMENT_FAILURE,
      amountAtRisk: '500.00',
      currency: 'INR',
      incidentKey: sharedIncidentKey,
      contextJson: { incidentKey: sharedIncidentKey },
    });

    const resB = await caseRepo.createCaseIdempotently(merchantBId, {
      riskType: RiskType.PAYMENT_FAILURE,
      amountAtRisk: '500.00',
      currency: 'INR',
      incidentKey: sharedIncidentKey,
      contextJson: { incidentKey: sharedIncidentKey },
    });

    expect(resA.created).toBe(true);
    expect(resB.created).toBe(true);
    expect(resA.case.id).toBeDefined();
    expect(resB.case.id).toBeDefined();
    expect(resA.case.id).not.toBe(resB.case.id);
    expect(resA.case.merchantId).toBe(merchantAId);
    expect(resB.case.merchantId).toBe(merchantBId);
  });
});

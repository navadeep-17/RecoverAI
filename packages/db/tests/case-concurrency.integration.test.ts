import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma, CaseRepository, MerchantRepository } from '../src/index.js';
import { RiskType } from '@recoverai/shared';

describe("Case Concurrent Creation & Unique Incident Key Invariants", () => {
  let dbAvailable = false;
  let caseRepo: CaseRepository;
  let merchantRepo: MerchantRepository;

  let merchantAId: string;
  let merchantBId: string;

  beforeAll(async () => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      dbAvailable = true;

      caseRepo = new CaseRepository();
      merchantRepo = new MerchantRepository();

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

  it('handles Promise.all concurrent case creation with identical incidentKey safely under same merchant', async () => {
    if (!dbAvailable) return;

    const incidentKey = `${merchantAId}:PAYMENT_FAILURE:pay_conc_${Date.now()}`;

    const createPromises = Array.from({ length: 5 }, () =>
      caseRepo.createCase(merchantAId, {
        riskType: RiskType.PAYMENT_FAILURE,
        amountAtRisk: '1000.00',
        currency: 'INR',
        incidentKey,
        contextJson: { incidentKey, test: 'concurrency' },
      }),
    );

    const results = await Promise.all(createPromises);

    const firstCaseId = results[0].id;
    expect(results.every((c) => c.id === firstCaseId)).toBe(true);

    const dbCases = await prisma.revenueRiskCase.findMany({
      where: { merchantId: merchantAId, incidentKey },
    });
    expect(dbCases.length).toBe(1);
    expect(dbCases[0].id).toBe(firstCaseId);
  });

  it('permits identical incidentKey across different merchants without collision', async () => {
    if (!dbAvailable) return;

    const sharedIncidentKey = `shared_incident_${Date.now()}`;

    const caseA = await caseRepo.createCase(merchantAId, {
      riskType: RiskType.PAYMENT_FAILURE,
      amountAtRisk: '500.00',
      currency: 'INR',
      incidentKey: sharedIncidentKey,
    });

    const caseB = await caseRepo.createCase(merchantBId, {
      riskType: RiskType.PAYMENT_FAILURE,
      amountAtRisk: '500.00',
      currency: 'INR',
      incidentKey: sharedIncidentKey,
    });

    expect(caseA.id).toBeDefined();
    expect(caseB.id).toBeDefined();
    expect(caseA.id).not.toBe(caseB.id);
    expect(caseA.merchantId).toBe(merchantAId);
    expect(caseB.merchantId).toBe(merchantBId);
  });
});

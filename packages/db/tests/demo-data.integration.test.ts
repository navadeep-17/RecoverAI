import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CaseStatus, PrismaClient } from '@prisma/client';
import { DEMO_IDS, getDemoSummary, resetDemoData, seedDemoData } from '../src/demo/demo-data.js';

const db = new PrismaClient();
const unrelatedMerchantId = 'recoverai-demo-test-unrelated';

describe('deterministic demo data', () => {
  beforeAll(async () => {
    await db.merchant.deleteMany({
      where: { id: { in: [DEMO_IDS.merchant, unrelatedMerchantId] } },
    });
  });

  afterAll(async () => {
    await db.merchant.deleteMany({
      where: { id: { in: [DEMO_IDS.merchant, unrelatedMerchantId] } },
    });
    await db.$disconnect();
  });

  it('is idempotent and produces the canonical UI states', async () => {
    const first = await seedDemoData(db);
    const second = await seedDemoData(db);

    expect(second).toEqual(first);
    expect(second).toMatchObject({
      merchantId: DEMO_IDS.merchant,
      users: 2,
      customers: 3,
      cases: { OPEN: 1, WAITING: 1, NEEDS_REVIEW: 1 },
      plans: 3,
      actions: 2,
      outcomes: 1,
      reviews: 1,
      commitments: 1,
      scheduledJobs: 1,
      audits: 3,
      recoveredCases: 0,
      monetaryOutcomes: 0,
    });
    expect(
      await db.humanReview.count({ where: { merchantId: DEMO_IDS.merchant, status: 'PENDING' } }),
    ).toBe(1);
    expect(await db.policyConfig.count({ where: { merchantId: DEMO_IDS.merchant } })).toBe(1);
  });

  it('does not seed false or structurally invalid recovered money', async () => {
    await seedDemoData(db);
    const cases = await db.revenueRiskCase.findMany({
      where: { merchantId: DEMO_IDS.merchant },
      include: { recoveryOutcome: true, outcomes: true },
    });

    expect(cases.some((item) => item.status === CaseStatus.RECOVERED)).toBe(false);
    for (const item of cases) {
      expect(item.recoveredAmount).toBeNull();
      expect(item.recoveryOutcomeId).toBeNull();
      expect(item.recoveryOutcome).toBeNull();
      expect(item.outcomes.every((outcome) => outcome.amountRecovered === null)).toBe(true);
    }
  });

  it('resets only the deterministic demo tenant and preserves unrelated data', async () => {
    await db.merchant.create({
      data: {
        id: unrelatedMerchantId,
        slug: 'recoverai-demo-test-unrelated',
        name: 'Unrelated merchant',
      },
    });
    await db.customer.create({
      data: {
        id: 'recoverai-demo-test-unrelated-customer',
        merchantId: unrelatedMerchantId,
        externalCustomerId: 'unrelated-customer',
      },
    });
    await seedDemoData(db);

    const firstReset = await resetDemoData(db);
    const secondReset = await resetDemoData(db);

    expect(secondReset).toEqual(firstReset);
    expect(await getDemoSummary(db)).toEqual(secondReset);
    expect(await db.merchant.findUnique({ where: { id: unrelatedMerchantId } })).not.toBeNull();
    expect(
      await db.customer.findUnique({ where: { id: 'recoverai-demo-test-unrelated-customer' } }),
    ).not.toBeNull();
  });
});

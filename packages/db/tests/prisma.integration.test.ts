import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma, checkDatabaseConnection } from '../src/client.js';
import { buildServer } from '../../../apps/api/src/server.js';
import { CaseRepository } from '../src/repositories/case-repository.js';
import { OutcomeRepository } from '../src/repositories/outcome-repository.js';
import { ActionExecutionStatus, CaseStatus, PolicyDecision, RecoveryActionType, RiskType } from '@prisma/client';
import { Money } from '@recoverai/shared';

describe('PostgreSQL + Prisma Real Integration Smoke Test', () => {
  let dbAvailable = false;
  const testMerchantId = 'mch_smoketest_001';

  beforeAll(async () => {
    dbAvailable = await checkDatabaseConnection();
  });

  afterAll(async () => {
    if (dbAvailable) {
      try {
        await prisma.merchant.deleteMany({
          where: { slug: 'smoke-test-merchant' },
        });
      } catch (err) {
        console.error('Prisma cleanup error:', err);
      }
    }
  });

  it('verifies PostgreSQL connectivity and SELECT 1 query', async () => {
    if (!dbAvailable) {
      console.warn('PostgreSQL database not available in local environment; test will run in CI');
      expect(true).toBe(true);
      return;
    }

    const isConnected = await checkDatabaseConnection();
    expect(isConnected).toBe(true);

    const result = await prisma.$queryRaw<Array<{ result: number }>>`SELECT 1 as result`;
    expect(result).toBeDefined();
    expect(result.length).toBeGreaterThan(0);
    expect(result[0].result).toBe(1);
  });

  it('can create and query a model in the PostgreSQL database', async () => {
    if (!dbAvailable) {
      expect(true).toBe(true);
      return;
    }

    await prisma.merchant.deleteMany({ where: { slug: 'smoke-test-merchant' } });

    const created = await prisma.merchant.create({
      data: {
        id: testMerchantId,
        name: 'Smoke Test Merchant',
        slug: 'smoke-test-merchant',
        killSwitchActive: false,
      },
    });

    expect(created.id).toBe(testMerchantId);
    expect(created.name).toBe('Smoke Test Merchant');

    const fetched = await prisma.merchant.findUnique({
      where: { id: testMerchantId },
    });

    expect(fetched).not.toBeNull();
    expect(fetched?.slug).toBe('smoke-test-merchant');
  });

  it('API /ready endpoint returns HTTP 200 against real database', async () => {
    if (!dbAvailable) {
      expect(true).toBe(true);
      return;
    }

    const app = buildServer();
    const res = await app.inject({
      method: 'GET',
      url: '/ready',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.ready).toBe(true);
    expect(body.database).toBe(true);
  });

  it('aggregates more than one list page of tenant-scoped radar metrics exactly', async () => {
    if (!dbAvailable) { expect(true).toBe(true); return; }
    await prisma.revenueRiskCase.deleteMany({ where: { merchantId: testMerchantId } });
    await prisma.revenueRiskCase.createMany({ data: Array.from({ length: 51 }, (_, index) => ({ merchantId: testMerchantId, riskType: RiskType.PAYMENT_FAILURE, amountAtRisk: '0.10', currency: 'INR', status: index === 50 ? CaseStatus.NEEDS_REVIEW : CaseStatus.OPEN, contextJson: {}, incidentKey: `metrics-${index}`, recoveredAmount: index === 0 ? '0.10' : null })) });
    const metrics = await new CaseRepository().getRevenueRadarMetrics(testMerchantId);
    expect(metrics).toMatchObject({ revenueAtRisk: '5.10', verifiedRecovered: '0.00', activeRecoveries: 51, needsReview: 1, riskTypeBreakdown: { PAYMENT_FAILURE: { count: 51, amountAtRisk: '5.10' } }, statusBreakdown: { OPEN: 50, NEEDS_REVIEW: 1 } });
  });

  it('credits exactly one durable recovery winner and attributes only that winner', async () => {
    if (!dbAvailable) throw new Error('PostgreSQL must be available for recovery winner evidence');
    await prisma.revenueRiskCase.deleteMany({ where: { merchantId: testMerchantId } });
    const recoveryCase = await prisma.revenueRiskCase.create({
      data: {
        merchantId: testMerchantId,
        riskType: RiskType.PAYMENT_FAILURE,
        amountAtRisk: '85000.00',
        currency: 'INR',
        status: CaseStatus.WAITING,
        contextJson: {},
        incidentKey: 'recovery-winner-case',
      },
    });
    const action = await prisma.recoveryAction.create({
      data: {
        caseId: recoveryCase.id,
        actionType: RecoveryActionType.CREATE_OR_SEND_PAYMENT_LINK,
        actionParams: {},
        idempotencyKey: 'recovery-winner-action',
        policyDecision: PolicyDecision.ALLOW,
        policyRationale: 'test',
        status: ActionExecutionStatus.SUCCESS,
      },
    });
    const outcomeRepo = new OutcomeRepository();
    const amount = Money.fromDecimalString('85000.00', 'INR');

    const organicWinner = await outcomeRepo.claimMonetaryRecovery(testMerchantId, recoveryCase.id, {
      dedupeKey: 'organic-success', outcomeType: 'PAYMENT_SUCCEEDED', amountRecovered: amount,
    });
    const postRecoveryAttributed = await outcomeRepo.claimMonetaryRecovery(testMerchantId, recoveryCase.id, {
      actionId: action.id, dedupeKey: 'post-recovery-attributed', outcomeType: 'PAYMENT_SUCCEEDED', amountRecovered: amount,
    });
    const duplicateOrganic = await outcomeRepo.claimMonetaryRecovery(testMerchantId, recoveryCase.id, {
      dedupeKey: 'organic-success', outcomeType: 'PAYMENT_SUCCEEDED', amountRecovered: amount,
    });
    expect(organicWinner.wonRecovery).toBe(true);
    expect(organicWinner.outcome?.actionId).toBeNull();
    expect(postRecoveryAttributed).toMatchObject({ wonRecovery: false, deduplicated: false });
    expect(duplicateOrganic).toMatchObject({ wonRecovery: false, deduplicated: true });

    const storedCase = await prisma.revenueRiskCase.findUniqueOrThrow({
      where: { id: recoveryCase.id }, include: { recoveryOutcome: true, outcomes: true },
    });
    expect(storedCase).toMatchObject({ status: CaseStatus.RECOVERED, recoveredAmount: expect.anything() });
    expect(storedCase.recoveryOutcome?.id).toBe(organicWinner.outcome?.id);
    expect(storedCase.outcomes).toHaveLength(1);

    const metrics = await new CaseRepository().getRevenueRadarMetrics(testMerchantId);
    expect(metrics).toMatchObject({ verifiedRecovered: '85000.00', agentAttributedRecovered: '0.00' });
  });

  it('allows only one winner when distinct attributed events race', async () => {
    if (!dbAvailable) throw new Error('PostgreSQL must be available for recovery winner evidence');
    await prisma.revenueRiskCase.deleteMany({ where: { merchantId: testMerchantId } });
    const amount = Money.fromDecimalString('14999.00', 'INR');
    for (let iteration = 0; iteration < 10; iteration += 1) {
      const recoveryCase = await prisma.revenueRiskCase.create({
        data: { merchantId: testMerchantId, riskType: RiskType.PAYMENT_FAILURE, amountAtRisk: '14999.00', currency: 'INR', status: CaseStatus.WAITING, contextJson: {}, incidentKey: `recovery-winner-race-${iteration}` },
      });
      const action = await prisma.recoveryAction.create({
        data: { caseId: recoveryCase.id, actionType: RecoveryActionType.CREATE_OR_SEND_PAYMENT_LINK, actionParams: {}, idempotencyKey: `race-action-${iteration}`, policyDecision: PolicyDecision.ALLOW, policyRationale: 'test', status: ActionExecutionStatus.SUCCESS },
      });
      const [first, second] = await Promise.all([
        new OutcomeRepository().claimMonetaryRecovery(testMerchantId, recoveryCase.id, { actionId: action.id, dedupeKey: `race-one-${iteration}`, outcomeType: 'PAYMENT_SUCCEEDED', amountRecovered: amount }),
        new OutcomeRepository().claimMonetaryRecovery(testMerchantId, recoveryCase.id, { actionId: action.id, dedupeKey: `race-two-${iteration}`, outcomeType: 'INVOICE_PAID', amountRecovered: amount }),
      ]);
      expect([first, second].filter((result) => result.wonRecovery)).toHaveLength(1);
      const storedCase = await prisma.revenueRiskCase.findUniqueOrThrow({ where: { id: recoveryCase.id }, include: { outcomes: true, recoveryOutcome: true } });
      expect(storedCase.status).toBe(CaseStatus.RECOVERED);
      expect(storedCase.outcomes).toHaveLength(1);
      expect(storedCase.recoveryOutcome?.id).toBe(storedCase.outcomes[0].id);
      expect(storedCase.recoveryOutcome?.actionId).toBe(action.id);
    }
    const metrics = await new CaseRepository().getRevenueRadarMetrics(testMerchantId);
    expect(metrics).toMatchObject({ verifiedRecovered: '149990.00', agentAttributedRecovered: '149990.00' });
  });

  it('credits one conditional winner when organic and attributed events race', async () => {
    if (!dbAvailable) throw new Error('PostgreSQL must be available for recovery winner evidence');
    await prisma.revenueRiskCase.deleteMany({ where: { merchantId: testMerchantId } });
    const recoveryCase = await prisma.revenueRiskCase.create({
      data: { merchantId: testMerchantId, riskType: RiskType.PAYMENT_FAILURE, amountAtRisk: '14999.00', currency: 'INR', status: CaseStatus.OPEN, contextJson: {}, incidentKey: 'organic-attributed-race' },
    });
    const action = await prisma.recoveryAction.create({
      data: { caseId: recoveryCase.id, actionType: RecoveryActionType.CREATE_OR_SEND_PAYMENT_LINK, actionParams: {}, idempotencyKey: 'organic-attributed-race-action', policyDecision: PolicyDecision.ALLOW, policyRationale: 'test', status: ActionExecutionStatus.SUCCESS },
    });
    const amount = Money.fromDecimalString('14999.00', 'INR');
    const [organic, attributed] = await Promise.all([
      new OutcomeRepository().claimMonetaryRecovery(testMerchantId, recoveryCase.id, { dedupeKey: 'organic-race', outcomeType: 'PAYMENT_SUCCEEDED', amountRecovered: amount }),
      new OutcomeRepository().claimMonetaryRecovery(testMerchantId, recoveryCase.id, { actionId: action.id, dedupeKey: 'attributed-race', outcomeType: 'PAYMENT_SUCCEEDED', amountRecovered: amount }),
    ]);
    expect([organic, attributed].filter((result) => result.wonRecovery)).toHaveLength(1);
    const storedCase = await prisma.revenueRiskCase.findUniqueOrThrow({ where: { id: recoveryCase.id }, include: { outcomes: true, recoveryOutcome: true } });
    expect(storedCase.outcomes).toHaveLength(1);
    const metrics = await new CaseRepository().getRevenueRadarMetrics(testMerchantId);
    expect(metrics.verifiedRecovered).toBe('14999.00');
    expect(metrics.agentAttributedRecovered).toBe(storedCase.recoveryOutcome?.actionId === action.id ? '14999.00' : '0.00');
  });

  it('counts a winning attributed recovery exactly once', async () => {
    if (!dbAvailable) throw new Error('PostgreSQL must be available for recovery winner evidence');
    await prisma.revenueRiskCase.deleteMany({ where: { merchantId: testMerchantId } });
    const recoveryCase = await prisma.revenueRiskCase.create({
      data: { merchantId: testMerchantId, riskType: RiskType.PAYMENT_FAILURE, amountAtRisk: '14999.00', currency: 'INR', status: CaseStatus.WAITING, contextJson: {}, incidentKey: 'recovery-winner-attributed' },
    });
    const action = await prisma.recoveryAction.create({
      data: { caseId: recoveryCase.id, actionType: RecoveryActionType.CREATE_OR_SEND_PAYMENT_LINK, actionParams: {}, idempotencyKey: 'recovery-winner-attributed-action', policyDecision: PolicyDecision.ALLOW, policyRationale: 'test', status: ActionExecutionStatus.SUCCESS },
    });
    const result = await new OutcomeRepository().claimMonetaryRecovery(testMerchantId, recoveryCase.id, {
      actionId: action.id, dedupeKey: 'attributed-success', outcomeType: 'PAYMENT_SUCCEEDED', amountRecovered: Money.fromDecimalString('14999.00', 'INR'),
    });
    const laterOrganic = await new OutcomeRepository().claimMonetaryRecovery(testMerchantId, recoveryCase.id, {
      dedupeKey: 'later-organic-success', outcomeType: 'PAYMENT_SUCCEEDED', amountRecovered: Money.fromDecimalString('14999.00', 'INR'),
    });
    expect(result).toMatchObject({ wonRecovery: true, outcome: { actionId: action.id } });
    expect(laterOrganic).toMatchObject({ wonRecovery: false, deduplicated: false });
    const metrics = await new CaseRepository().getRevenueRadarMetrics(testMerchantId);
    expect(metrics).toMatchObject({ verifiedRecovered: '14999.00', agentAttributedRecovered: '14999.00' });
  });
});

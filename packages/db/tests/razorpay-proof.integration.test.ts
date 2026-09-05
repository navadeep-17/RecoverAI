import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ActionExecutionStatus,
  AuditActorType,
  CaseStatus,
  PolicyDecision,
  PrismaClient,
  RecoveryActionType,
  ReviewStatus,
  RiskType,
} from '@prisma/client';
import { Money } from '@recoverai/shared';
import { DEMO_IDS, seedDemoData } from '../src/demo/demo-data.js';
import {
  RAZORPAY_PROOF_IDS,
  resetRazorpayProofFixture,
  seedRazorpayProofFixture,
  verifyRazorpayProof,
} from '../src/demo/razorpay-proof-data.js';

const db = new PrismaClient();

describe('Razorpay Test Mode proof fixture and verifier', () => {
  beforeAll(async () => {
    await seedDemoData(db);
  });

  afterAll(async () => {
    await resetRazorpayProofFixture(db);
    await db.$disconnect();
  });

  beforeEach(async () => {
    await resetRazorpayProofFixture(db);
  });

  it('1. setup creates a fresh proof case inside the current recovery window', async () => {
    const beforeTime = Date.now();
    const summary = await seedRazorpayProofFixture(db);
    const afterTime = Date.now();

    const caseRecord = await db.revenueRiskCase.findUnique({
      where: { id: RAZORPAY_PROOF_IDS.case },
    });
    expect(caseRecord).not.toBeNull();
    const openedTime = caseRecord!.openedAt.getTime();
    expect(openedTime).toBeGreaterThanOrEqual(beforeTime);
    expect(openedTime).toBeLessThanOrEqual(afterTime);

    // Age in days should be effectively 0, far within the 30-day recovery window
    const ageDays = (Date.now() - openedTime) / (1000 * 60 * 60 * 24);
    expect(ageDays).toBeLessThan(1);
    expect(summary.status).toBe(CaseStatus.NEEDS_REVIEW);
  });

  it('2. proof case has exact INR 65000 risk amount', async () => {
    await seedRazorpayProofFixture(db);
    const caseRecord = await db.revenueRiskCase.findUnique({
      where: { id: RAZORPAY_PROOF_IDS.case },
    });
    expect(caseRecord).not.toBeNull();
    expect(caseRecord!.currency).toBe('INR');
    const money = Money.fromDecimalString(caseRecord!.amountAtRisk.toString(), caseRecord!.currency);
    expect(money.equals(Money.fromDecimalString('65000.00', 'INR'))).toBe(true);
    expect(money.toPaiseNumber()).toBe(6500000);
  });

  it('3. proof customer has name + explicit consent and is not opted out', async () => {
    await seedRazorpayProofFixture(db);
    const customer = await db.customer.findUnique({
      where: { id: RAZORPAY_PROOF_IDS.customer },
    });
    expect(customer).not.toBeNull();
    expect(customer!.name).toBe('Aarav Sen');
    expect(customer!.email).toBe('proof-customer@demo.recoverai.local');
    expect(customer!.contactConsent).toBe(true);
    expect(customer!.optedOut).toBe(false);
  });

  it('4. proof plan proposes CREATE_OR_SEND_PAYMENT_LINK with sufficient confidence', async () => {
    await seedRazorpayProofFixture(db);
    const plan = await db.recoveryPlanVersion.findUnique({
      where: { id: RAZORPAY_PROOF_IDS.plan },
    });
    expect(plan).not.toBeNull();
    expect(plan!.proposedActionType).toBe(RecoveryActionType.CREATE_OR_SEND_PAYMENT_LINK);
    expect(plan!.confidence).toBeGreaterThanOrEqual(0.65);
    expect(plan!.caseId).toBe(RAZORPAY_PROOF_IDS.case);
  });

  it('5. proof review is PENDING and exactly plan-bound', async () => {
    await seedRazorpayProofFixture(db);
    const review = await db.humanReview.findUnique({
      where: { id: RAZORPAY_PROOF_IDS.review },
    });
    expect(review).not.toBeNull();
    expect(review!.status).toBe(ReviewStatus.PENDING);
    expect(review!.caseId).toBe(RAZORPAY_PROOF_IDS.case);
    expect(review!.planVersionId).toBe(RAZORPAY_PROOF_IDS.plan);
    expect(review!.reviewKey).toBe('proof:razorpay-test-mode-payment-link');
  });

  it('6. no successful action, fake webhook, or monetary outcome is seeded', async () => {
    await seedRazorpayProofFixture(db);
    const actionCount = await db.recoveryAction.count({
      where: { caseId: RAZORPAY_PROOF_IDS.case },
    });
    const outcomeCount = await db.recoveryOutcome.count({
      where: { caseId: RAZORPAY_PROOF_IDS.case },
    });
    const webhookCount = await db.webhookEvent.count({
      where: { merchantId: RAZORPAY_PROOF_IDS.merchant, rawPayload: { contains: RAZORPAY_PROOF_IDS.case } },
    });

    expect(actionCount).toBe(0);
    expect(outcomeCount).toBe(0);
    expect(webhookCount).toBe(0);
  });

  it('7. deterministic existing demo records are not changed', async () => {
    const demoOpenBefore = await db.revenueRiskCase.findUnique({ where: { id: DEMO_IDS.openCase } });
    const demoWaitingBefore = await db.revenueRiskCase.findUnique({ where: { id: DEMO_IDS.waitingCase } });
    const demoReviewBefore = await db.revenueRiskCase.findUnique({ where: { id: DEMO_IDS.reviewCase } });

    await seedRazorpayProofFixture(db);

    const demoOpenAfter = await db.revenueRiskCase.findUnique({ where: { id: DEMO_IDS.openCase } });
    const demoWaitingAfter = await db.revenueRiskCase.findUnique({ where: { id: DEMO_IDS.waitingCase } });
    const demoReviewAfter = await db.revenueRiskCase.findUnique({ where: { id: DEMO_IDS.reviewCase } });

    expect(demoOpenAfter).toEqual(demoOpenBefore);
    expect(demoWaitingAfter).toEqual(demoWaitingBefore);
    expect(demoReviewAfter).toEqual(demoReviewBefore);
  });

  it('8. running setup when proof fixture exists fails safely', async () => {
    await seedRazorpayProofFixture(db);
    await expect(seedRazorpayProofFixture(db)).rejects.toThrow(
      /Razorpay proof fixture already exists/i,
    );
  });

  it('9. reset removes only proof namespace', async () => {
    await seedRazorpayProofFixture(db);
    expect(await db.revenueRiskCase.findUnique({ where: { id: RAZORPAY_PROOF_IDS.case } })).not.toBeNull();

    const resetSummary = await resetRazorpayProofFixture(db);
    expect(resetSummary.deletedCounts.cases).toBe(1);
    expect(resetSummary.deletedCounts.customers).toBe(1);
    expect(resetSummary.deletedCounts.reviews).toBe(1);
    expect(resetSummary.deletedCounts.planVersions).toBe(1);

    // Proof case is gone
    expect(await db.revenueRiskCase.findUnique({ where: { id: RAZORPAY_PROOF_IDS.case } })).toBeNull();
    expect(await db.customer.findUnique({ where: { id: RAZORPAY_PROOF_IDS.customer } })).toBeNull();

    // Deterministic demo records remain intact
    expect(await db.revenueRiskCase.findUnique({ where: { id: DEMO_IDS.reviewCase } })).not.toBeNull();
    expect(await db.merchant.findUnique({ where: { id: DEMO_IDS.merchant } })).not.toBeNull();
  });

  // Helper to construct a completed real proof flow state in DB
  async function seedCompletedProofState(overrides?: {
    actionProvider?: string;
    webhookEvent?: boolean;
    webhookProcessed?: boolean;
    webhookPaymentLinkId?: string;
    monetaryWinnersCount?: number;
    caseStatus?: CaseStatus;
    recoveredAmount?: number | null;
    currency?: string;
    omitApprovalAudit?: boolean;
    omitRecoveryAudit?: boolean;
  }) {
    await seedRazorpayProofFixture(db);

    const externalActionId = 'plink_test_proof_123456';
    const actionProvider = overrides?.actionProvider ?? 'RAZORPAY_TEST_MODE_PAYMENT_LINKS';

    // Update case to RECOVERED unless overridden
    const caseStatus = overrides?.caseStatus ?? CaseStatus.RECOVERED;
    const currency = overrides?.currency ?? 'INR';
    const recoveredAmount = overrides?.recoveredAmount !== undefined ? overrides.recoveredAmount : 65000;

    // Create action
    const action = await db.recoveryAction.create({
      data: {
        id: 'recoverai-razorpay-proof-action',
        caseId: RAZORPAY_PROOF_IDS.case,
        planVersionId: RAZORPAY_PROOF_IDS.plan,
        actionType: RecoveryActionType.CREATE_OR_SEND_PAYMENT_LINK,
        actionParams: { description: 'Razorpay Test Mode link' },
        idempotencyKey: 'proof:action:plink:1',
        policyDecision: PolicyDecision.ALLOW,
        policyRationale: 'Approved via human review',
        providerName: actionProvider,
        status: ActionExecutionStatus.SUCCESS,
        externalActionId,
        executedAt: new Date(),
      },
    });

    // Create winning monetary outcome
    const outcomesCount = overrides?.monetaryWinnersCount !== undefined ? overrides.monetaryWinnersCount : 1;
    let winningOutcomeId: string | null = null;
    for (let i = 0; i < outcomesCount; i++) {
      const outcome = await db.recoveryOutcome.create({
        data: {
          id: `recoverai-razorpay-proof-outcome-${i}`,
          caseId: RAZORPAY_PROOF_IDS.case,
          actionId: action.id,
          dedupeKey: `proof:outcome:${i}`,
          outcomeType: 'PAYMENT_SUCCEEDED',
          amountRecovered: recoveredAmount,
          observedAt: new Date(),
        },
      });
      if (i === 0) winningOutcomeId = outcome.id;
    }

    await db.revenueRiskCase.update({
      where: { id: RAZORPAY_PROOF_IDS.case },
      data: {
        status: caseStatus,
        currency,
        recoveredAmount,
        recoveryOutcomeId: winningOutcomeId,
      },
    });

    // Create webhook event if requested
    if (overrides?.webhookEvent !== false) {
      const plinkId = overrides?.webhookPaymentLinkId ?? externalActionId;
      await db.webhookEvent.create({
        data: {
          id: 'recoverai-razorpay-proof-webhook',
          merchantId: RAZORPAY_PROOF_IDS.merchant,
          provider: 'RAZORPAY',
          externalEventId: 'evt_test_proof_123',
          signature: 'valid_test_signature',
          verified: true,
          processed: overrides?.webhookProcessed !== undefined ? overrides.webhookProcessed : true,
          dedupeKey: 'event:evt_test_proof_123',
          rawPayload: JSON.stringify({
            event: 'payment_link.paid',
            payload: {
              payment_link: {
                entity: {
                  id: plinkId,
                  amount: 6500000,
                  currency: 'INR',
                },
              },
            },
          }),
        },
      });
    }

    // Create audits
    if (!overrides?.omitApprovalAudit) {
      await db.auditEvent.create({
        data: {
          id: 'recoverai-razorpay-proof-audit-approved',
          merchantId: RAZORPAY_PROOF_IDS.merchant,
          caseId: RAZORPAY_PROOF_IDS.case,
          eventType: 'REVIEW_APPROVED',
          actorType: AuditActorType.HUMAN,
          reasonCode: 'HUMAN_APPROVAL_GRANTED',
        },
      });
      await db.auditEvent.create({
        data: {
          id: 'recoverai-razorpay-proof-audit-authorized',
          merchantId: RAZORPAY_PROOF_IDS.merchant,
          caseId: RAZORPAY_PROOF_IDS.case,
          eventType: 'REVIEW_EXECUTION_AUTHORIZED',
          actorType: AuditActorType.POLICY,
          reasonCode: 'POLICY_REVALIDATION_ALLOWED',
        },
      });
    }

    if (!overrides?.omitRecoveryAudit) {
      await db.auditEvent.create({
        data: {
          id: 'recoverai-razorpay-proof-audit-recovered',
          merchantId: RAZORPAY_PROOF_IDS.merchant,
          caseId: RAZORPAY_PROOF_IDS.case,
          eventType: 'CASE_RECOVERED_BY_PAYMENT',
          actorType: AuditActorType.SYSTEM,
          reasonCode: 'AUTHORITATIVE_MONEY_RECOVERED',
        },
      });
    }

    return { action, winningOutcomeId, externalActionId };
  }

  it('10. verifier PASS logic requires real provider name RAZORPAY_TEST_MODE_PAYMENT_LINKS', async () => {
    await seedCompletedProofState({ actionProvider: 'RAZORPAY_TEST_MODE_PAYMENT_LINKS' });
    const result = await verifyRazorpayProof(db);
    expect(result.pass).toBe(true);
    expect(result.actionProvider).toBe('RAZORPAY_TEST_MODE_PAYMENT_LINKS');
    expect(result.caseStatus).toBe('RECOVERED');
    expect(result.monetaryWinners).toBe(1);
    expect(result.amountAtRisk).toBe('INR 65000.00');
    expect(result.verifiedRecovered).toBe('INR 65000.00');
  });

  it('11. verifier rejects SIMULATOR actions', async () => {
    await seedCompletedProofState({ actionProvider: 'SIMULATOR' });
    const result = await verifyRazorpayProof(db);
    expect(result.pass).toBe(false);
    expect(result.missingCondition).toMatch(/SIMULATOR/i);
  });

  it('12. verifier requires verified + processed RAZORPAY webhook evidence', async () => {
    // Missing webhook
    await seedCompletedProofState({ webhookEvent: false });
    const resultNoWebhook = await verifyRazorpayProof(db);
    expect(resultNoWebhook.pass).toBe(false);
    expect(resultNoWebhook.missingCondition).toMatch(/webhook receipt/i);

    // Unprocessed webhook
    await resetRazorpayProofFixture(db);
    await seedCompletedProofState({ webhookProcessed: false });
    const resultUnprocessed = await verifyRazorpayProof(db);
    expect(resultUnprocessed.pass).toBe(false);
    expect(resultUnprocessed.missingCondition).toMatch(/webhook receipt/i);
  });

  it('13. verifier requires webhook payment-link ID to match the successful action externalActionId', async () => {
    await seedCompletedProofState({ webhookPaymentLinkId: 'plink_different_id_999' });
    const result = await verifyRazorpayProof(db);
    expect(result.pass).toBe(false);
    expect(result.missingCondition).toMatch(/webhook receipt/i);
  });

  it('14. verifier requires exactly one monetary winner', async () => {
    // 0 winners
    await seedCompletedProofState({ monetaryWinnersCount: 0 });
    const resultZero = await verifyRazorpayProof(db);
    expect(resultZero.pass).toBe(false);
    expect(resultZero.missingCondition).toMatch(/monetary recovery outcome winner/i);

    // 2 winners
    await resetRazorpayProofFixture(db);
    await seedCompletedProofState({ monetaryWinnersCount: 2 });
    const resultTwo = await verifyRazorpayProof(db);
    expect(resultTwo.pass).toBe(false);
    expect(resultTwo.missingCondition).toMatch(/Expected exactly 1 monetary recovery outcome winner/i);
  });

  it('15. verifier rejects mismatched amount/currency', async () => {
    // Wrong currency
    await seedCompletedProofState({ currency: 'USD' });
    const resultCurrency = await verifyRazorpayProof(db);
    expect(resultCurrency.pass).toBe(false);
    expect(resultCurrency.missingCondition).toMatch(/currency/i);

    // Wrong amount
    await resetRazorpayProofFixture(db);
    await seedCompletedProofState({ recoveredAmount: 50000 });
    const resultAmount = await verifyRazorpayProof(db);
    expect(resultAmount.pass).toBe(false);
    expect(resultAmount.missingCondition).toMatch(/does not equal/i);
  });

  it('16. verifier itself performs no writes', async () => {
    await seedCompletedProofState();

    const countsBefore = {
      cases: await db.revenueRiskCase.count(),
      actions: await db.recoveryAction.count(),
      outcomes: await db.recoveryOutcome.count(),
      reviews: await db.humanReview.count(),
      webhooks: await db.webhookEvent.count(),
      audits: await db.auditEvent.count(),
    };

    const result = await verifyRazorpayProof(db);
    expect(result.pass).toBe(true);

    const countsAfter = {
      cases: await db.revenueRiskCase.count(),
      actions: await db.recoveryAction.count(),
      outcomes: await db.recoveryOutcome.count(),
      reviews: await db.humanReview.count(),
      webhooks: await db.webhookEvent.count(),
      audits: await db.auditEvent.count(),
    };

    expect(countsAfter).toEqual(countsBefore);
  });
});

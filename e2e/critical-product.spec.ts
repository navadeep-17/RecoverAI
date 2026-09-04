import { test, expect } from '@playwright/test';
import { ActionExecutionStatus, CaseStatus, PolicyDecision, RecoveryActionType, RiskType, prisma, CaseRepository, HumanReviewRepository, OutcomeRepository } from '@recoverai/db';

const merchantId = 'phase-9c-e2e-merchant';
const adminId = 'phase-9c-e2e-admin';
let reviewCaseId: string;
let reviewId: string;
let organicCaseId: string;
let attributedCaseId: string;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  await prisma.merchant.deleteMany({ where: { id: merchantId } });
  await prisma.merchant.create({ data: { id: merchantId, name: 'Phase 9C E2E Merchant', slug: 'phase-9c-e2e-merchant' } });
  await prisma.user.create({ data: { id: adminId, merchantId, email: 'phase9c-e2e@example.test', passwordHash: 'not-used-by-dev-adapter', name: 'Phase 9C Admin', role: 'MERCHANT_ADMIN' } });
  const cases = new CaseRepository();
  const reviews = new HumanReviewRepository();
  const outcomes = new OutcomeRepository();

  const reviewCase = await cases.createCase(merchantId, { riskType: RiskType.OVERDUE_RECEIVABLE, amountAtRisk: '850.00', incidentKey: 'phase-9c-review', contextJson: { invoiceId: 'phase-9c-invoice' } });
  reviewCaseId = reviewCase.id;
  await cases.updateCaseStatus(merchantId, reviewCaseId, CaseStatus.NEEDS_REVIEW);
  const plan = await cases.addPlanVersion(merchantId, reviewCaseId, { diagnosisCode: 'OVERDUE', diagnosisSummary: 'E2E overdue receivable review', confidence: 0.92, proposedActionType: RecoveryActionType.SCHEDULE_FOLLOWUP, proposedActionParams: {}, reasoningSummary: 'Deterministic reviewed follow-up fixture' });
  reviewId = (await reviews.createReview(merchantId, { caseId: reviewCaseId, planVersionId: plan.id, reasonForReview: 'Operator approval required for follow-up' })).review.id;

  const organic = await cases.createCase(merchantId, { riskType: RiskType.PAYMENT_FAILURE, amountAtRisk: '100.00', incidentKey: 'phase-9c-organic', contextJson: { paymentId: 'organic-payment' } });
  organicCaseId = organic.id;
  await outcomes.claimMonetaryRecovery(merchantId, organicCaseId, { dedupeKey: 'phase-9c-organic-outcome', outcomeType: 'PAYMENT_SUCCEEDED', amountRecovered: '100.00' });

  const attributed = await cases.createCase(merchantId, { riskType: RiskType.PAYMENT_FAILURE, amountAtRisk: '200.00', incidentKey: 'phase-9c-attributed', contextJson: { paymentId: 'attributed-payment' } });
  attributedCaseId = attributed.id;
  const action = await cases.recordAction(merchantId, attributedCaseId, { actionType: RecoveryActionType.CREATE_OR_SEND_PAYMENT_LINK, actionParams: { amount: '200.00' }, idempotencyKey: 'phase-9c-attributed-action', policyDecision: PolicyDecision.ALLOW, policyRationale: 'E2E fixture', status: ActionExecutionStatus.SUCCESS, providerName: 'RAZORPAY_TEST_MODE', externalActionId: 'plink_phase9c' });
  await outcomes.claimMonetaryRecovery(merchantId, attributedCaseId, { actionId: action.id, dedupeKey: 'phase-9c-attributed-outcome', outcomeType: 'PAYMENT_SUCCEEDED', amountRecovered: '200.00' });
});

test.afterAll(async () => {
  await prisma.merchant.deleteMany({ where: { id: merchantId } });
  await prisma.$disconnect();
});

test('critical navigation and frozen evaluation use the real API', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Recovery operations, grounded in evidence' })).toBeVisible();
  await page.getByRole('button', { name: 'Active Recoveries' }).click();
  await expect(page.getByRole('heading', { name: 'Case operations' })).toBeVisible();
  await page.getByRole('button', { name: 'Human Review' }).click();
  await expect(page.getByRole('heading', { name: 'Policy-governed review inbox' })).toBeVisible();
  await page.getByRole('button', { name: 'Evaluation' }).click();
  await expect(page.getByText('500 scenarios')).toBeVisible();
  await expect(page.getByRole('cell', { name: 'RECOVERAI' })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'RULE_BASED_WITH_POLICY' })).toBeVisible();
  await expect(page.getByText('Synthetic decision/safety benchmark — not production revenue recovered.')).toBeVisible();
  await expect(page.getByRole('button', { name: /run evaluation|re-run|tune/i })).toHaveCount(0);
  await page.getByRole('button', { name: 'Policy Settings' }).click();
  await expect(page.getByRole('heading', { name: 'Deterministic merchant controls' })).toBeVisible();
});

test('policy save persists through the real API', async ({ page }) => {
  await page.goto('/policy');
  const retries = page.getByLabel('Maximum retries');
  const original = await retries.inputValue();
  const next = String(Number(original) === 20 ? 19 : Number(original) + 1);
  await retries.fill(next);
  await page.getByRole('button', { name: 'Save Changes' }).click();
  await expect(page.getByRole('status')).toContainText('Policy settings saved. Server state refreshed.');
  await page.reload();
  await expect(page.getByLabel('Maximum retries')).toHaveValue(next);
  await page.getByLabel('Maximum retries').fill(original);
  await page.getByRole('button', { name: 'Save Changes' }).click();
  await expect(page.getByRole('status')).toContainText('Policy settings saved. Server state refreshed.');
});

test('pending review approval continues the case and durably schedules the exact proposal', async ({ page }) => {
  await page.goto('/reviews');
  await page.getByText(reviewCaseId).click();
  await expect(page.getByRole('heading', { name: `Review ${reviewId}` })).toBeVisible();
  await expect(page.getByText('Operator approval required for follow-up')).toBeVisible();
  await expect(page.getByText('SCHEDULE FOLLOWUP')).toBeVisible();
  await page.getByRole('button', { name: 'Approve exact proposal' }).click();

  await expect.poll(async () => (await prisma.humanReview.findUnique({ where: { id: reviewId } }))?.status).toBe('APPROVED');
  await expect.poll(async () => (await prisma.revenueRiskCase.findUnique({ where: { id: reviewCaseId } }))?.status).toBe(CaseStatus.WAITING);
  await expect.poll(async () => prisma.recoveryAction.count({
    where: { caseId: reviewCaseId, actionType: RecoveryActionType.SCHEDULE_FOLLOWUP, status: ActionExecutionStatus.SUCCESS },
  })).toBe(1);
  await expect.poll(async () => prisma.scheduledJob.count({
    where: { caseId: reviewCaseId, jobType: 'RECOVERY_FOLLOWUP_CHECK', status: 'SCHEDULED' },
  })).toBe(1);
});

test('recovered cases display organic and attributed money truth from persisted outcomes', async ({ page }) => {
  await page.goto(`/recoveries/${organicCaseId}`);
  await expect(page.getByRole('listitem').getByText('Organic / unattributed verified recovery')).toBeVisible();
  await page.goto(`/recoveries/${attributedCaseId}`);
  await expect(page.getByRole('listitem').getByText('Agent-attributed verified recovery')).toBeVisible();
});

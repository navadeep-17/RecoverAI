import {
  ActionExecutionStatus,
  AuditActorType,
  CaseStatus,
  PrismaClient,
  RecoveryActionType,
  ReviewStatus,
  RiskType,
} from '@prisma/client';
import { Money } from '@recoverai/shared';
import { prisma } from '../client.js';

export const RAZORPAY_PROOF_IDS = {
  merchant: 'recoverai-demo-merchant',
  customer: 'recoverai-razorpay-proof-customer',
  case: 'recoverai-razorpay-proof-case',
  plan: 'recoverai-razorpay-proof-plan',
  review: 'recoverai-razorpay-proof-review',
  auditReview: 'recoverai-razorpay-proof-audit-review',
} as const;

export interface RazorpayProofSummary {
  merchantId: string;
  customerId: string;
  caseId: string;
  planVersionId: string;
  reviewId: string;
  riskType: string;
  amountAtRisk: string;
  currency: string;
  status: string;
  openedAt: string;
}

export interface RazorpayProofResetSummary {
  merchantId: string;
  deletedCounts: {
    audits: number;
    outcomes: number;
    actions: number;
    reviews: number;
    planVersions: number;
    scheduledJobs: number;
    commitments: number;
    triggers: number;
    cases: number;
    customers: number;
    webhooks: number;
  };
}

export interface RazorpayProofVerificationResult {
  pass: boolean;
  merchantId: string;
  caseId: string;
  riskType?: string;
  amountAtRisk?: string;
  actionProvider?: string;
  paymentLinkId?: string;
  webhookVerified?: boolean;
  webhookProcessed?: boolean;
  caseStatus?: string;
  verifiedRecovered?: string;
  monetaryWinners?: number;
  missingCondition?: string;
  error?: string;
}

/**
 * Seeds a fresh high-value subscription recovery case under the RecoverAI demo merchant
 * for real Razorpay Test Mode proof.
 *
 * Safety rules:
 * - Requires demo merchant to exist (does not silently bootstrap from scratch).
 * - Fails safely if the proof case already exists (does not overwrite or destroy evidence).
 * - Creates a fresh openedAt timestamp so that ExpiredRecoveryWindowRule passes naturally.
 * - Leaves deterministic demo records untouched.
 * - Seeds NO executed actions, NO fake webhooks, and NO monetary outcomes.
 */
export async function seedRazorpayProofFixture(
  db: PrismaClient = prisma,
  now: Date = new Date(),
): Promise<RazorpayProofSummary> {
  const demoMerchant = await db.merchant.findUnique({
    where: { id: RAZORPAY_PROOF_IDS.merchant },
  });
  if (!demoMerchant) {
    throw new Error(
      `Demo merchant "${RAZORPAY_PROOF_IDS.merchant}" does not exist. Run "npm run demo:setup" first.`,
    );
  }

  const existingCase = await db.revenueRiskCase.findUnique({
    where: { id: RAZORPAY_PROOF_IDS.case },
  });
  if (existingCase) {
    throw new Error(
      `Razorpay proof fixture already exists ("${RAZORPAY_PROOF_IDS.case}" in status "${existingCase.status}"). ` +
        `Inspect the existing case or explicitly run "npm run razorpay:proof:reset" before creating a new fixture.`,
    );
  }

  await db.customer.upsert({
    where: { id: RAZORPAY_PROOF_IDS.customer },
    create: {
      id: RAZORPAY_PROOF_IDS.customer,
      externalCustomerId: 'proof-customer-razorpay',
      merchantId: RAZORPAY_PROOF_IDS.merchant,
      email: 'proof-customer@demo.recoverai.local',
      name: 'Aarav Sen',
      contactConsent: true,
      optedOut: false,
    },
    update: {
      email: 'proof-customer@demo.recoverai.local',
      name: 'Aarav Sen',
      contactConsent: true,
      optedOut: false,
    },
  });

  const createdCase = await db.revenueRiskCase.create({
    data: {
      id: RAZORPAY_PROOF_IDS.case,
      merchantId: RAZORPAY_PROOF_IDS.merchant,
      customerId: RAZORPAY_PROOF_IDS.customer,
      riskType: RiskType.SUBSCRIPTION_FAILURE,
      amountAtRisk: 65000,
      currency: 'INR',
      status: CaseStatus.NEEDS_REVIEW,
      incidentKey: 'proof:subscription:razorpay-external-proof',
      openedAt: now,
      nextEvaluationAt: null,
      contextJson: {
        subscriptionId: 'sub_proof_razorpay',
        paymentId: 'pay_proof_razorpay',
        verifiedPaymentFailureCode: 'AUTHENTICATION_FAILED',
        retryAttemptNumber: 2,
      },
    },
  });

  const plan = await db.recoveryPlanVersion.create({
    data: {
      id: RAZORPAY_PROOF_IDS.plan,
      caseId: RAZORPAY_PROOF_IDS.case,
      version: 1,
      diagnosisCode: 'HIGH_VALUE_REVIEW_REQUIRED',
      diagnosisSummary:
        'The proposed recovery exceeds the configured high-value threshold (INR 50,000.00).',
      confidence: 0.85,
      proposedActionType: RecoveryActionType.CREATE_OR_SEND_PAYMENT_LINK,
      proposedActionParams: {
        description: 'Razorpay Test Mode recovery proof payment link',
      },
      reasoningSummary:
        'Policy requires explicit human authorization for high-value subscription recovery via Razorpay Test Mode.',
      followUpAfterSeconds: null,
    },
  });

  const review = await db.humanReview.create({
    data: {
      id: RAZORPAY_PROOF_IDS.review,
      merchantId: RAZORPAY_PROOF_IDS.merchant,
      caseId: RAZORPAY_PROOF_IDS.case,
      planVersionId: plan.id,
      reviewKey: 'proof:razorpay-test-mode-payment-link',
      reasonForReview:
        'High-value action (INR 65,000.00) requires explicit human approval before Razorpay Test Mode payment link creation.',
      status: ReviewStatus.PENDING,
    },
  });

  await db.auditEvent.create({
    data: {
      id: RAZORPAY_PROOF_IDS.auditReview,
      merchantId: RAZORPAY_PROOF_IDS.merchant,
      caseId: RAZORPAY_PROOF_IDS.case,
      eventType: 'HUMAN_REVIEW_REQUESTED',
      actorType: AuditActorType.POLICY,
      reasonCode: 'HIGH_VALUE_REVIEW_REQUIRED',
      outputSummaryJson: {
        reviewId: review.id,
        policyDecision: 'REVIEW',
        threshold: 50000,
        amountAtRisk: 65000,
      },
    },
  });

  return {
    merchantId: createdCase.merchantId,
    customerId: RAZORPAY_PROOF_IDS.customer,
    caseId: createdCase.id,
    planVersionId: plan.id,
    reviewId: review.id,
    riskType: createdCase.riskType,
    amountAtRisk: '65000.00',
    currency: createdCase.currency,
    status: createdCase.status,
    openedAt: createdCase.openedAt.toISOString(),
  };
}

/**
 * Resets ONLY the Razorpay proof fixture records (`recoverai-razorpay-proof-*`).
 * Leaves deterministic demo records (`recoverai-demo-*`) and all other merchants untouched.
 * Does NOT truncate tables or drop schemas.
 */
export async function resetRazorpayProofFixture(
  db: PrismaClient = prisma,
): Promise<RazorpayProofResetSummary> {
  const caseId = RAZORPAY_PROOF_IDS.case;
  const merchantId = RAZORPAY_PROOF_IDS.merchant;
  const customerId = RAZORPAY_PROOF_IDS.customer;

  const [
    audits,
    outcomes,
    actions,
    reviews,
    planVersions,
    scheduledJobs,
    commitments,
    triggers,
    cases,
    customers,
    webhooks,
  ] = await db.$transaction([
    db.auditEvent.deleteMany({
      where: {
        merchantId,
        OR: [{ caseId }, { id: { startsWith: 'recoverai-razorpay-proof-' } }],
      },
    }),
    db.recoveryOutcome.deleteMany({
      where: { caseId },
    }),
    db.recoveryAction.deleteMany({
      where: { caseId },
    }),
    db.humanReview.deleteMany({
      where: { merchantId, caseId },
    }),
    db.recoveryPlanVersion.deleteMany({
      where: { caseId },
    }),
    db.scheduledJob.deleteMany({
      where: { merchantId, caseId },
    }),
    db.recoveryCommitment.deleteMany({
      where: { caseId },
    }),
    db.recoveryIterationTrigger.deleteMany({
      where: { merchantId, caseId },
    }),
    db.revenueRiskCase.deleteMany({
      where: { id: caseId },
    }),
    db.customer.deleteMany({
      where: { id: customerId },
    }),
    db.webhookEvent.deleteMany({
      where: {
        merchantId,
        id: { startsWith: 'recoverai-razorpay-proof-' },
      },
    }),
  ]);

  return {
    merchantId,
    deletedCounts: {
      audits: audits.count,
      outcomes: outcomes.count,
      actions: actions.count,
      reviews: reviews.count,
      planVersions: planVersions.count,
      scheduledJobs: scheduledJobs.count,
      commitments: commitments.count,
      triggers: triggers.count,
      cases: cases.count,
      customers: customers.count,
      webhooks: webhooks.count,
    },
  };
}

/**
 * Strictly READ-ONLY verifier for completed real Razorpay Test Mode proof.
 *
 * Verifies:
 * A. Case status is RECOVERED, exact INR 65,000 amount recovered matches amount at risk.
 * B. Real action executed by RAZORPAY_TEST_MODE_PAYMENT_LINKS (not SIMULATOR).
 * C. WebhookEvent receipt exists, is verified + processed, contains matching payment link entity ID, and event-based dedupe identity.
 * D. Exactly one monetary recovery outcome winner exists for the real action.
 * E. Audit trail contains human review approval and authoritative money recovery evidence.
 *
 * Performs NO database writes, NO updates, and NO external network requests.
 */
export async function verifyRazorpayProof(
  db: PrismaClient = prisma,
): Promise<RazorpayProofVerificationResult> {
  const caseId = RAZORPAY_PROOF_IDS.case;
  const merchantId = RAZORPAY_PROOF_IDS.merchant;

  // A. CASE VERIFICATION
  const caseRecord = await db.revenueRiskCase.findUnique({
    where: { id: caseId },
  });

  if (!caseRecord) {
    return {
      pass: false,
      merchantId,
      caseId,
      missingCondition: `Proof case "${caseId}" not found. Run "npm run razorpay:proof:setup" first.`,
    };
  }

  if (caseRecord.merchantId !== merchantId) {
    return {
      pass: false,
      merchantId: caseRecord.merchantId,
      caseId,
      missingCondition: `Proof case merchantId "${caseRecord.merchantId}" does not match expected "${merchantId}".`,
    };
  }

  if (caseRecord.status !== CaseStatus.RECOVERED) {
    return {
      pass: false,
      merchantId,
      caseId,
      riskType: caseRecord.riskType,
      amountAtRisk: `INR ${caseRecord.amountAtRisk}`,
      caseStatus: caseRecord.status,
      missingCondition: `Proof case status is "${caseRecord.status}", expected "RECOVERED". Complete human review approval and Razorpay Test Mode payment first.`,
    };
  }

  if (caseRecord.currency !== 'INR') {
    return {
      pass: false,
      merchantId,
      caseId,
      missingCondition: `Proof case currency is "${caseRecord.currency}", expected "INR".`,
    };
  }

  const expectedRiskMoney = Money.fromDecimalString('65000.00', 'INR');
  const actualRiskMoney = Money.fromDecimalString(caseRecord.amountAtRisk.toString(), caseRecord.currency);
  if (!actualRiskMoney.equals(expectedRiskMoney)) {
    return {
      pass: false,
      merchantId,
      caseId,
      missingCondition: `Proof case amountAtRisk is "${actualRiskMoney.toDecimalString()}", expected "${expectedRiskMoney.toDecimalString()}".`,
    };
  }

  if (caseRecord.recoveredAmount === null || caseRecord.recoveredAmount === undefined) {
    return {
      pass: false,
      merchantId,
      caseId,
      missingCondition: `Proof case recoveredAmount is null; case must have authoritative recovered amount.`,
    };
  }

  const recoveredMoney = Money.fromDecimalString(caseRecord.recoveredAmount.toString(), caseRecord.currency);
  if (!recoveredMoney.equals(actualRiskMoney)) {
    return {
      pass: false,
      merchantId,
      caseId,
      missingCondition: `Proof case recoveredAmount ("${recoveredMoney.toDecimalString()}") does not equal amountAtRisk ("${actualRiskMoney.toDecimalString()}").`,
    };
  }

  // B. REAL ACTION VERIFICATION
  const actions = await db.recoveryAction.findMany({
    where: { caseId },
  });

  const successfulPaymentLinkActions = actions.filter(
    (a) =>
      a.actionType === RecoveryActionType.CREATE_OR_SEND_PAYMENT_LINK &&
      a.status === ActionExecutionStatus.SUCCESS,
  );

  if (successfulPaymentLinkActions.length !== 1) {
    return {
      pass: false,
      merchantId,
      caseId,
      caseStatus: caseRecord.status,
      missingCondition: `Expected exactly 1 successful CREATE_OR_SEND_PAYMENT_LINK action, found ${successfulPaymentLinkActions.length}.`,
    };
  }

  const action = successfulPaymentLinkActions[0];

  if (action.providerName === 'SIMULATOR') {
    return {
      pass: false,
      merchantId,
      caseId,
      actionProvider: action.providerName,
      missingCondition: `Payment link action was executed by SIMULATOR instead of real Razorpay Test Mode adapter.`,
    };
  }

  if (action.providerName !== 'RAZORPAY_TEST_MODE_PAYMENT_LINKS') {
    return {
      pass: false,
      merchantId,
      caseId,
      actionProvider: action.providerName ?? 'unknown',
      missingCondition: `Expected providerName "RAZORPAY_TEST_MODE_PAYMENT_LINKS", found "${action.providerName}".`,
    };
  }

  if (!action.externalActionId || !action.externalActionId.trim()) {
    return {
      pass: false,
      merchantId,
      caseId,
      actionProvider: action.providerName,
      missingCondition: `Successful Razorpay action is missing externalActionId (paymentLinkId).`,
    };
  }

  // C. WEBHOOK RECEIPT VERIFICATION
  const webhookEvents = await db.webhookEvent.findMany({
    where: {
      merchantId,
      provider: 'RAZORPAY',
      verified: true,
      processed: true,
    },
    orderBy: { receivedAt: 'desc' },
  });

  let matchingReceipt = null;
  for (const event of webhookEvents) {
    try {
      const parsed = JSON.parse(event.rawPayload) as {
        event?: string;
        payload?: { payment_link?: { entity?: { id?: string } } };
      };
      if (
        parsed.event === 'payment_link.paid' &&
        parsed.payload?.payment_link?.entity?.id === action.externalActionId
      ) {
        matchingReceipt = event;
        break;
      }
    } catch {
      // ignore JSON parse error in non-matching payload
    }
  }

  if (!matchingReceipt) {
    return {
      pass: false,
      merchantId,
      caseId,
      actionProvider: action.providerName,
      paymentLinkId: action.externalActionId,
      missingCondition: `No verified and processed Razorpay webhook receipt found matching event "payment_link.paid" for paymentLinkId "${action.externalActionId}".`,
    };
  }

  if (!matchingReceipt.externalEventId || !matchingReceipt.externalEventId.trim()) {
    return {
      pass: false,
      merchantId,
      caseId,
      actionProvider: action.providerName,
      paymentLinkId: action.externalActionId,
      missingCondition: `Webhook receipt is missing provider externalEventId.`,
    };
  }

  if (!matchingReceipt.dedupeKey.startsWith('event:')) {
    return {
      pass: false,
      merchantId,
      caseId,
      actionProvider: action.providerName,
      paymentLinkId: action.externalActionId,
      missingCondition: `Webhook receipt dedupeKey ("${matchingReceipt.dedupeKey}") does not reflect event-based identity.`,
    };
  }

  // D. MONETARY TRUTH VERIFICATION
  const outcomes = await db.recoveryOutcome.findMany({
    where: { caseId },
  });

  const monetaryWinners = outcomes.filter((o) => {
    if (o.amountRecovered === null || o.amountRecovered === undefined) return false;
    try {
      const money = Money.fromDecimalString(o.amountRecovered.toString(), caseRecord.currency);
      return money.toPaiseNumber() > 0;
    } catch {
      return false;
    }
  });

  if (monetaryWinners.length !== 1) {
    return {
      pass: false,
      merchantId,
      caseId,
      missingCondition: `Expected exactly 1 monetary recovery outcome winner, found ${monetaryWinners.length}.`,
    };
  }

  const winningOutcome = monetaryWinners[0];

  if (winningOutcome.actionId !== action.id) {
    return {
      pass: false,
      merchantId,
      caseId,
      missingCondition: `Winning monetary outcome actionId "${winningOutcome.actionId}" does not match real Razorpay action "${action.id}".`,
    };
  }

  const outcomeMoney = Money.fromDecimalString(winningOutcome.amountRecovered!.toString(), caseRecord.currency);
  if (!outcomeMoney.equals(actualRiskMoney)) {
    return {
      pass: false,
      merchantId,
      caseId,
      missingCondition: `Winning monetary outcome amount ("${outcomeMoney.toDecimalString()}") does not equal case amountAtRisk ("${actualRiskMoney.toDecimalString()}").`,
    };
  }

  if (caseRecord.recoveryOutcomeId !== winningOutcome.id) {
    return {
      pass: false,
      merchantId,
      caseId,
      missingCondition: `Case recoveryOutcomeId "${caseRecord.recoveryOutcomeId}" does not match winning outcome id "${winningOutcome.id}".`,
    };
  }

  // E. AUDIT TRAIL VERIFICATION
  const audits = await db.auditEvent.findMany({
    where: { merchantId, caseId },
  });

  const hasApprovalAudit = audits.some(
    (a) => a.eventType === 'REVIEW_APPROVED' || a.eventType === 'REVIEW_EXECUTION_AUTHORIZED',
  );
  if (!hasApprovalAudit) {
    return {
      pass: false,
      merchantId,
      caseId,
      missingCondition: `Audit trail is missing human review approval/authorization events ("REVIEW_APPROVED" / "REVIEW_EXECUTION_AUTHORIZED").`,
    };
  }

  const hasRecoveryAudit = audits.some((a) => a.eventType === 'CASE_RECOVERED_BY_PAYMENT');
  if (!hasRecoveryAudit) {
    return {
      pass: false,
      merchantId,
      caseId,
      missingCondition: `Audit trail is missing "CASE_RECOVERED_BY_PAYMENT" event.`,
    };
  }

  const hasAuthoritativeMoneyAudit = audits.some(
    (a) => a.reasonCode === 'AUTHORITATIVE_MONEY_RECOVERED',
  );
  if (!hasAuthoritativeMoneyAudit) {
    return {
      pass: false,
      merchantId,
      caseId,
      missingCondition: `Audit trail is missing "AUTHORITATIVE_MONEY_RECOVERED" reason code.`,
    };
  }

  return {
    pass: true,
    merchantId,
    caseId,
    riskType: caseRecord.riskType,
    amountAtRisk: `INR ${actualRiskMoney.toDecimalString()}`,
    actionProvider: action.providerName,
    paymentLinkId: action.externalActionId,
    webhookVerified: true,
    webhookProcessed: true,
    caseStatus: caseRecord.status,
    verifiedRecovered: `INR ${recoveredMoney.toDecimalString()}`,
    monetaryWinners: 1,
  };
}

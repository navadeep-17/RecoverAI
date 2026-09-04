import {
  ActionExecutionStatus,
  AuditActorType,
  CaseStatus,
  PolicyDecision,
  Prisma,
  PrismaClient,
  RecoveryActionType,
  ReviewStatus,
  RiskType,
  Role,
} from '@prisma/client';
import { prisma } from '../client.js';

export const DEMO_IDS = {
  merchant: 'recoverai-demo-merchant',
  merchantSlug: 'recoverai-demo',
  admin: 'recoverai-demo-admin',
  reviewer: 'recoverai-demo-reviewer',
  openCase: 'recoverai-demo-case-open',
  waitingCase: 'recoverai-demo-case-waiting',
  reviewCase: 'recoverai-demo-case-review',
} as const;

export interface DemoSummary {
  merchantId: string;
  users: number;
  customers: number;
  cases: Record<string, number>;
  plans: number;
  actions: number;
  outcomes: number;
  reviews: number;
  commitments: number;
  scheduledJobs: number;
  audits: number;
  recoveredCases: number;
  monetaryOutcomes: number;
}

const openedAt = new Date('2026-01-15T09:00:00.000Z');
const waitingAt = new Date('2026-01-17T09:00:00.000Z');
const reviewAt = new Date('2026-01-18T09:00:00.000Z');
const followUpAt = new Date('2099-01-20T09:00:00.000Z');

async function assertDemoNamespaceAvailable(db: PrismaClient): Promise<void> {
  const [byId, bySlug] = await Promise.all([
    db.merchant.findUnique({ where: { id: DEMO_IDS.merchant } }),
    db.merchant.findUnique({ where: { slug: DEMO_IDS.merchantSlug } }),
  ]);
  if (byId && byId.slug !== DEMO_IDS.merchantSlug) {
    throw new Error(`Refusing to seed: ${DEMO_IDS.merchant} is not the RecoverAI demo merchant`);
  }
  if (bySlug && bySlug.id !== DEMO_IDS.merchant) {
    throw new Error(`Refusing to seed: slug ${DEMO_IDS.merchantSlug} belongs to another merchant`);
  }
}

export async function getDemoSummary(db: PrismaClient = prisma): Promise<DemoSummary> {
  const [
    users,
    customers,
    groupedCases,
    plans,
    actions,
    outcomes,
    reviews,
    commitments,
    scheduledJobs,
    audits,
    recoveredCases,
    monetaryOutcomes,
  ] = await Promise.all([
    db.user.count({ where: { merchantId: DEMO_IDS.merchant } }),
    db.customer.count({ where: { merchantId: DEMO_IDS.merchant } }),
    db.revenueRiskCase.groupBy({
      by: ['status'],
      where: { merchantId: DEMO_IDS.merchant },
      _count: { _all: true },
    }),
    db.recoveryPlanVersion.count({ where: { case: { merchantId: DEMO_IDS.merchant } } }),
    db.recoveryAction.count({ where: { case: { merchantId: DEMO_IDS.merchant } } }),
    db.recoveryOutcome.count({ where: { case: { merchantId: DEMO_IDS.merchant } } }),
    db.humanReview.count({ where: { merchantId: DEMO_IDS.merchant } }),
    db.recoveryCommitment.count({ where: { case: { merchantId: DEMO_IDS.merchant } } }),
    db.scheduledJob.count({ where: { merchantId: DEMO_IDS.merchant } }),
    db.auditEvent.count({ where: { merchantId: DEMO_IDS.merchant } }),
    db.revenueRiskCase.count({
      where: { merchantId: DEMO_IDS.merchant, status: CaseStatus.RECOVERED },
    }),
    db.recoveryOutcome.count({
      where: { case: { merchantId: DEMO_IDS.merchant }, amountRecovered: { not: null } },
    }),
  ]);
  return {
    merchantId: DEMO_IDS.merchant,
    users,
    customers,
    cases: Object.fromEntries(groupedCases.map((item) => [item.status, item._count._all])),
    plans,
    actions,
    outcomes,
    reviews,
    commitments,
    scheduledJobs,
    audits,
    recoveredCases,
    monetaryOutcomes,
  };
}

export async function seedDemoData(db: PrismaClient = prisma): Promise<DemoSummary> {
  await assertDemoNamespaceAvailable(db);
  await db.merchant.upsert({
    where: { id: DEMO_IDS.merchant },
    create: { id: DEMO_IDS.merchant, slug: DEMO_IDS.merchantSlug, name: 'RecoverAI Demo Store' },
    update: { slug: DEMO_IDS.merchantSlug, name: 'RecoverAI Demo Store', killSwitchActive: false },
  });

  for (const user of [
    {
      id: DEMO_IDS.admin,
      email: 'admin@demo.recoverai.local',
      name: 'Demo Admin',
      role: Role.MERCHANT_ADMIN,
    },
    {
      id: DEMO_IDS.reviewer,
      email: 'reviewer@demo.recoverai.local',
      name: 'Demo Reviewer',
      role: Role.REVIEWER,
    },
  ]) {
    await db.user.upsert({
      where: { id: user.id },
      create: {
        ...user,
        merchantId: DEMO_IDS.merchant,
        passwordHash: 'development-header-auth-no-password',
      },
      update: {
        email: user.email,
        name: user.name,
        role: user.role,
        merchantId: DEMO_IDS.merchant,
      },
    });
  }

  const customers = [
    {
      id: 'recoverai-demo-customer-open',
      externalCustomerId: 'demo-customer-open',
      email: 'anika@demo.recoverai.local',
      name: 'Anika Rao',
    },
    {
      id: 'recoverai-demo-customer-waiting',
      externalCustomerId: 'demo-customer-waiting',
      email: 'kabir@demo.recoverai.local',
      name: 'Kabir Shah',
    },
    {
      id: 'recoverai-demo-customer-review',
      externalCustomerId: 'demo-customer-review',
      email: 'meera@demo.recoverai.local',
      name: 'Meera Iyer',
    },
  ];
  for (const customer of customers) {
    await db.customer.upsert({
      where: { id: customer.id },
      create: { ...customer, merchantId: DEMO_IDS.merchant, contactConsent: true },
      update: { email: customer.email, name: customer.name, contactConsent: true, optedOut: false },
    });
  }

  await db.policyConfig.upsert({
    where: { merchantId: DEMO_IDS.merchant },
    create: {
      id: 'recoverai-demo-policy',
      merchantId: DEMO_IDS.merchant,
      maxRetriesPerCase: 3,
      maxContactsPerCase: 3,
      maxActionsPerCase: 5,
      cooldownHoursBetweenActions: 24,
      highValueThreshold: 50000,
      minConfidenceThreshold: 0.65,
      reviewFirstMode: false,
    },
    update: {
      maxRetriesPerCase: 3,
      maxContactsPerCase: 3,
      maxActionsPerCase: 5,
      cooldownHoursBetweenActions: 24,
      highValueThreshold: 50000,
      minConfidenceThreshold: 0.65,
      reviewFirstMode: false,
    },
  });

  const cases = [
    {
      id: DEMO_IDS.openCase,
      customerId: customers[0].id,
      riskType: RiskType.PAYMENT_FAILURE,
      amountAtRisk: 12500,
      status: CaseStatus.OPEN,
      incidentKey: 'demo:payment-failure:open',
      openedAt,
      nextEvaluationAt: openedAt,
      contextJson: {
        paymentId: 'pay_demo_open',
        verifiedPaymentFailureCode: 'INSUFFICIENT_FUNDS',
        gatewayErrorMessage: 'Payment was declined',
        paymentMethod: 'card',
        cardNetwork: 'Visa',
        cardLast4: '4242',
        retryAttemptNumber: 1,
      },
    },
    {
      id: DEMO_IDS.waitingCase,
      customerId: customers[1].id,
      riskType: RiskType.OVERDUE_RECEIVABLE,
      amountAtRisk: 42000,
      status: CaseStatus.WAITING,
      incidentKey: 'demo:invoice:waiting',
      openedAt: waitingAt,
      nextEvaluationAt: followUpAt,
      contextJson: {
        invoiceId: 'inv_demo_waiting',
        promiseToPayStatus: 'PENDING',
        promisedDate: '2099-01-20',
      },
    },
    {
      id: DEMO_IDS.reviewCase,
      customerId: customers[2].id,
      riskType: RiskType.SUBSCRIPTION_FAILURE,
      amountAtRisk: 65000,
      status: CaseStatus.NEEDS_REVIEW,
      incidentKey: 'demo:subscription:review',
      openedAt: reviewAt,
      nextEvaluationAt: null,
      contextJson: {
        subscriptionId: 'sub_demo_review',
        paymentId: 'pay_demo_review',
        verifiedPaymentFailureCode: 'AUTHENTICATION_FAILED',
        retryAttemptNumber: 2,
      },
    },
  ];
  for (const item of cases) {
    await db.revenueRiskCase.upsert({
      where: { id: item.id },
      create: { ...item, merchantId: DEMO_IDS.merchant, currency: 'INR' },
      update: {
        customerId: item.customerId,
        riskType: item.riskType,
        amountAtRisk: item.amountAtRisk,
        currency: 'INR',
        status: item.status,
        incidentKey: item.incidentKey,
        contextJson: item.contextJson,
        openedAt: item.openedAt,
        nextEvaluationAt: item.nextEvaluationAt,
        recoveredAmount: null,
        resolvedAt: null,
        recoveryOutcomeId: null,
      },
    });
  }

  const plans = [
    {
      id: 'recoverai-demo-plan-open',
      caseId: DEMO_IDS.openCase,
      diagnosisCode: 'PAYMENT_RETRY_ELIGIBLE',
      diagnosisSummary: 'A verified payment failure is ready for a policy-governed retry.',
      confidence: 0.86,
      proposedActionType: RecoveryActionType.RETRY_PAYMENT,
      proposedActionParams: { paymentId: 'pay_demo_open' },
      reasoningSummary: 'Retry is within policy limits and customer consent is present.',
      followUpAfterSeconds: 86400,
    },
    {
      id: 'recoverai-demo-plan-waiting',
      caseId: DEMO_IDS.waitingCase,
      diagnosisCode: 'PROMISE_TO_PAY_ACTIVE',
      diagnosisSummary: 'Customer made a durable promise to pay; wait until the promised date.',
      confidence: 0.94,
      proposedActionType: RecoveryActionType.SCHEDULE_FOLLOWUP,
      proposedActionParams: { reason: 'PROMISE_DUE', scheduledFor: followUpAt.toISOString() },
      reasoningSummary: 'Do not contact or claim recovery before the promised date.',
      followUpAfterSeconds: null,
    },
    {
      id: 'recoverai-demo-plan-review',
      caseId: DEMO_IDS.reviewCase,
      diagnosisCode: 'HIGH_VALUE_REVIEW_REQUIRED',
      diagnosisSummary: 'The proposed recovery exceeds the configured high-value threshold.',
      confidence: 0.78,
      proposedActionType: RecoveryActionType.CREATE_OR_SEND_PAYMENT_LINK,
      proposedActionParams: {
        description: 'Subscription renewal recovery',
        providerMode: 'SIMULATOR',
      },
      reasoningSummary: 'Policy requires a human decision before this exact proposal may execute.',
      followUpAfterSeconds: null,
    },
  ];
  for (const plan of plans) {
    await db.recoveryPlanVersion.upsert({
      where: { id: plan.id },
      create: { ...plan, version: 1 },
      update: {
        diagnosisCode: plan.diagnosisCode,
        diagnosisSummary: plan.diagnosisSummary,
        confidence: plan.confidence,
        proposedActionType: plan.proposedActionType,
        proposedActionParams: plan.proposedActionParams,
        reasoningSummary: plan.reasoningSummary,
        followUpAfterSeconds: plan.followUpAfterSeconds,
      },
    });
  }

  const actions = [
    {
      id: 'recoverai-demo-action-open',
      caseId: DEMO_IDS.openCase,
      planVersionId: plans[0].id,
      actionType: RecoveryActionType.RETRY_PAYMENT,
      actionParams: { paymentId: 'pay_demo_open' },
      idempotencyKey: 'demo:action:retry:open',
      policyDecision: PolicyDecision.ALLOW,
      policyRationale: 'Retry is within configured limits.',
      status: ActionExecutionStatus.FAILED,
      providerName: 'SIMULATOR',
      errorMessage: 'Simulated issuer decline',
      executedAt: openedAt,
    },
    {
      id: 'recoverai-demo-action-waiting',
      caseId: DEMO_IDS.waitingCase,
      planVersionId: plans[1].id,
      actionType: RecoveryActionType.RECORD_PROMISE_TO_PAY,
      actionParams: { promisedAmount: '42000.00', promisedDate: followUpAt.toISOString() },
      idempotencyKey: 'demo:action:promise:waiting',
      policyDecision: PolicyDecision.ALLOW,
      policyRationale: 'Recording a customer commitment is permitted.',
      status: ActionExecutionStatus.SUCCESS,
      providerName: 'SIMULATOR',
      errorMessage: null,
      executedAt: waitingAt,
    },
  ];
  for (const action of actions) {
    await db.recoveryAction.upsert({
      where: { id: action.id },
      create: action,
      update: {
        actionType: action.actionType,
        actionParams: action.actionParams,
        policyDecision: action.policyDecision,
        policyRationale: action.policyRationale,
        status: action.status,
        providerName: action.providerName,
        errorMessage: action.errorMessage,
        executedAt: action.executedAt,
        externalActionId: null,
        executionMetadata: Prisma.DbNull,
      },
    });
  }

  await db.recoveryOutcome.upsert({
    where: { id: 'recoverai-demo-outcome-open' },
    create: {
      id: 'recoverai-demo-outcome-open',
      caseId: DEMO_IDS.openCase,
      actionId: actions[0].id,
      dedupeKey: 'demo:outcome:retry-declined',
      outcomeType: 'ACTION_FAILED',
      amountRecovered: null,
      detailsJson: { reason: 'SIMULATED_ISSUER_DECLINE', monetaryRecovery: false },
      observedAt: openedAt,
    },
    update: {
      outcomeType: 'ACTION_FAILED',
      amountRecovered: null,
      detailsJson: { reason: 'SIMULATED_ISSUER_DECLINE', monetaryRecovery: false },
    },
  });
  await db.recoveryCommitment.upsert({
    where: { id: 'recoverai-demo-commitment-waiting' },
    create: {
      id: 'recoverai-demo-commitment-waiting',
      caseId: DEMO_IDS.waitingCase,
      sourceActionId: actions[1].id,
      promisedAmount: 42000,
      promisedDate: followUpAt,
      status: 'PENDING',
      extractedFromText: 'I will pay the invoice by 20 January 2099.',
    },
    update: {
      promisedAmount: 42000,
      promisedDate: followUpAt,
      status: 'PENDING',
      extractedFromText: 'I will pay the invoice by 20 January 2099.',
    },
  });
  await db.scheduledJob.upsert({
    where: { id: 'recoverai-demo-job-waiting' },
    create: {
      id: 'recoverai-demo-job-waiting',
      merchantId: DEMO_IDS.merchant,
      caseId: DEMO_IDS.waitingCase,
      jobKey: 'demo:promise-followup:waiting',
      jobType: 'PROMISE_DUE',
      scheduledFor: followUpAt,
      status: 'PENDING_DISPATCH',
      payloadJson: {
        merchantId: DEMO_IDS.merchant,
        caseId: DEMO_IDS.waitingCase,
        commitmentId: 'recoverai-demo-commitment-waiting',
        demoOnly: true,
      },
    },
    update: {
      scheduledFor: followUpAt,
      status: 'PENDING_DISPATCH',
      pgBossJobId: null,
      payloadJson: {
        merchantId: DEMO_IDS.merchant,
        caseId: DEMO_IDS.waitingCase,
        commitmentId: 'recoverai-demo-commitment-waiting',
        demoOnly: true,
      },
    },
  });
  await db.humanReview.upsert({
    where: { id: 'recoverai-demo-review-pending' },
    create: {
      id: 'recoverai-demo-review-pending',
      merchantId: DEMO_IDS.merchant,
      caseId: DEMO_IDS.reviewCase,
      planVersionId: plans[2].id,
      reviewKey: 'demo:high-value-payment-link',
      reasonForReview: 'High-value action requires explicit human approval.',
      status: ReviewStatus.PENDING,
    },
    update: {
      actionId: null,
      reviewerId: null,
      reasonForReview: 'High-value action requires explicit human approval.',
      status: ReviewStatus.PENDING,
      reviewDecision: null,
      reviewNotes: null,
      revalidatedAt: null,
      revalidatedPolicyDecision: null,
      resolvedAt: null,
    },
  });

  const audits = [
    {
      id: 'recoverai-demo-audit-open',
      caseId: DEMO_IDS.openCase,
      eventType: 'ACTION_EXECUTION_FAILED',
      actorType: AuditActorType.PROVIDER,
      reasonCode: 'SIMULATED_ISSUER_DECLINE',
      outputSummaryJson: { actionId: actions[0].id, recovered: false },
    },
    {
      id: 'recoverai-demo-audit-waiting',
      caseId: DEMO_IDS.waitingCase,
      eventType: 'PROMISE_TO_PAY_RECORDED',
      actorType: AuditActorType.AGENT,
      reasonCode: 'CUSTOMER_COMMITMENT',
      outputSummaryJson: {
        commitmentId: 'recoverai-demo-commitment-waiting',
        scheduledFor: followUpAt.toISOString(),
      },
    },
    {
      id: 'recoverai-demo-audit-review',
      caseId: DEMO_IDS.reviewCase,
      eventType: 'HUMAN_REVIEW_REQUESTED',
      actorType: AuditActorType.POLICY,
      reasonCode: 'HIGH_VALUE_REVIEW_REQUIRED',
      outputSummaryJson: { reviewId: 'recoverai-demo-review-pending', policyDecision: 'REVIEW' },
    },
  ];
  for (const audit of audits) {
    await db.auditEvent.upsert({
      where: { id: audit.id },
      create: { ...audit, merchantId: DEMO_IDS.merchant },
      update: {
        eventType: audit.eventType,
        actorType: audit.actorType,
        reasonCode: audit.reasonCode,
        outputSummaryJson: audit.outputSummaryJson,
      },
    });
  }

  return getDemoSummary(db);
}

export async function resetDemoData(db: PrismaClient = prisma): Promise<DemoSummary> {
  await assertDemoNamespaceAvailable(db);
  await db.merchant.deleteMany({ where: { id: DEMO_IDS.merchant, slug: DEMO_IDS.merchantSlug } });
  return seedDemoData(db);
}

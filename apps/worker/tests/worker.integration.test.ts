import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { RecoveryWorkerService } from '../src/worker.js';
import { checkDatabaseConnection } from '@recoverai/db';

async function waitFor<T>(
  label: string,
  read: () => Promise<T | null | undefined>,
  ready: (value: T) => boolean,
): Promise<T> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value != null && ready(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

describe('pg-boss Real Integration Smoke Test', () => {
  let dbAvailable = false;
  let worker: RecoveryWorkerService | null = null;

  beforeAll(async () => {
    dbAvailable = await checkDatabaseConnection();
  });

  afterAll(async () => {
    if (worker && worker.getStatus().isRunning) {
      await worker.stop();
    }
  });

  it('connects to real PostgreSQL, initializes schema, and manages lifecycle', async () => {
    if (!dbAvailable) {
      console.warn('PostgreSQL database not available in local environment; test will run in CI');
      expect(true).toBe(true);
      return;
    }

    worker = new RecoveryWorkerService();

    await worker.start();
    expect(worker.getStatus().isRunning).toBe(true);
    expect(worker.getStatus().hasBossInstance).toBe(true);

    const boss = worker.getBoss();
    expect(boss).not.toBeNull();

    // Verify boss instance is active
    expect(boss).toBeDefined();

    const scheduler = worker.getScheduler();
    expect(scheduler).toBeDefined();

    const riskDetector = worker.getRiskDetector();
    expect(riskDetector).toBeDefined();

    // Gracefully stop worker
    await worker.stop();
    expect(worker.getStatus().isRunning).toBe(false);
  });

  it('END-TO-END PROOF: real pg-boss delivers PROMISE_TO_PAY_CHECK timer to worker subscriber and mutates database', async () => {
    if (!dbAvailable) {
      console.warn('PostgreSQL database not available in local environment; test will run in CI');
      expect(true).toBe(true);
      return;
    }

    const {
      prisma,
      MerchantRepository,
      CaseRepository,
      CommitmentRepository,
      OutcomeRepository,
      ScheduledJobRepository,
      AuditRepository,
      EventRepository,
      CustomerRepository,
      PolicyConfigRepository,
      HumanReviewRepository,
      RiskType,
    } = await import('@recoverai/db');

    const merchantRepo = new MerchantRepository();
    const caseRepo = new CaseRepository();
    const commitmentRepo = new CommitmentRepository();
    const outcomeRepo = new OutcomeRepository();
    const scheduledJobRepo = new ScheduledJobRepository();
    const auditRepo = new AuditRepository();
    const eventRepo = new EventRepository();
    const customerRepo = new CustomerRepository();
    const policyConfigRepo = new PolicyConfigRepository();
    const reviewRepo = new HumanReviewRepository();

    const mch = await merchantRepo.createMerchant({
      name: 'pg-boss E2E Worker Merchant',
      slug: `mch-pgboss-e2e-${Date.now()}`,
    });
    const merchantId = mch.id;

    const paymentId = `pay_pgboss_${Date.now()}`;
    const testCase = await caseRepo.createCase(merchantId, {
      riskType: RiskType.PAYMENT_FAILURE,
      amountAtRisk: '9999.00',
      currency: 'INR',
      incidentKey: `${merchantId}:PAYMENT_FAILURE:${paymentId}`,
      contextJson: { paymentId, verifiedPaymentFailureCode: 'BAD_REQUEST_ERROR' },
    });

    const passedDate = new Date(Date.now() - 5000); // 5s in the past so timer is eligible
    const commitment = await commitmentRepo.createCommitment(merchantId, testCase.id, {
      promisedAmount: '9999.00',
      promisedDate: passedDate,
      status: 'PENDING',
      extractedFromText: 'I will pay on time',
    });

    // Exercise the worker's default composition: its OutcomeObserver must use
    // the canonical durable review gate rather than an injected test double.
    const e2eWorker = new RecoveryWorkerService({
      caseRepo,
      customerRepo,
      policyConfigRepo,
      auditRepo,
      eventRepo,
      scheduledJobRepo,
    });

    await e2eWorker.start();

    try {
      const scheduler = e2eWorker.getScheduler();
      expect(scheduler).toBeDefined();

      // Schedule real job through PgBossJobScheduler into PostgreSQL and pg-boss queue
      const scheduledResult = await scheduler!.schedule({
        merchantId,
        caseId: testCase.id,
        jobType: 'PROMISE_TO_PAY_CHECK',
        scheduledFor: new Date(), // run immediately
        payloadJson: {
          caseId: testCase.id,
          commitmentId: commitment.id,
        },
      });

      expect(scheduledResult.id).toBeDefined();

      // Poll until pg-boss delivers and executes the job (max 15s)
      const startPoll = Date.now();
      let jobCompleted = false;
      while (Date.now() - startPoll < 15000) {
        const dbJob = await scheduledJobRepo.getJobById(merchantId, scheduledResult.id);
        if (dbJob && dbJob.status === 'COMPLETED') {
          jobCompleted = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }

      expect(jobCompleted).toBe(true);

      // Verify PostgreSQL database mutations driven by pg-boss worker subscriber
      const updatedCommitment = await commitmentRepo.getCommitmentById(merchantId, testCase.id, commitment.id);
      expect(updatedCommitment?.status).toBe('BROKEN');

      const updatedCase = await caseRepo.getCaseById(merchantId, testCase.id);
      const activeReview = await reviewRepo.findPendingReviewForCase(merchantId, testCase.id);
      expect(updatedCase?.status).toBe('NEEDS_REVIEW');
      expect(activeReview).toMatchObject({ merchantId, caseId: testCase.id, status: 'PENDING' });
      expect(activeReview?.actionId).toBeNull();
      expect(activeReview?.reasonForReview).toContain('Promise-to-pay expired unpaid');

      const outcomes = await outcomeRepo.listOutcomesByCase(merchantId, testCase.id);
      expect(outcomes.some((o) => o.outcomeType === 'PROMISE_TO_PAY_BROKEN')).toBe(true);

      const audits = await prisma.auditEvent.findMany({
        where: { caseId: testCase.id, eventType: 'PROMISE_TO_PAY_BROKEN' },
      });
      expect(audits.length).toBeGreaterThanOrEqual(1);
      expect((await prisma.auditEvent.findMany({ where: { caseId: testCase.id, eventType: 'REVIEW_REQUESTED' } })).length).toBe(1);
    } finally {
      await e2eWorker.stop();
    }
  });

  it('AUTONOMY PROOF: a persisted PAYMENT_FAILED event creates and consumes one durable RECOVERY_ITERATION without a caller invoking runIteration', async () => {
    if (!dbAvailable) throw new Error('PostgreSQL is required for autonomous runtime evidence');

    const { composeWorkerRuntime } = await import('../src/runtime.js');
    const { RecoveryWorkerService } = await import('../src/worker.js');
    const { MerchantRepository, ScheduledJobRepository, prisma } = await import('@recoverai/db');
    const { MerchantEventSource, NormalizedEventType } = await import('@recoverai/shared');
    const merchant = await new MerchantRepository().createMerchant({
      name: 'pg-boss autonomous iteration merchant',
      slug: `mch-autonomy-${Date.now()}`,
    });
    const runtime = composeWorkerRuntime({
      NODE_ENV: 'test', AI_PROVIDER: 'mock', DATABASE_URL: process.env.DATABASE_URL!, PG_BOSS_SCHEMA: process.env.PG_BOSS_SCHEMA || 'pgboss', LOG_LEVEL: 'error',
    } as any);
    const autonomousWorker = runtime.worker as unknown as InstanceType<typeof RecoveryWorkerService>;
    const jobs = new ScheduledJobRepository();
    await autonomousWorker.start();

    try {
      const ingester = autonomousWorker.getEventIngestionService();
      expect(ingester).not.toBeNull();
      const eventSuffix = Date.now();
      const failureEvent = {
        merchantId: merchant.id,
        source: MerchantEventSource.MERCHANT,
        externalEventId: `evt-autonomous-payment-${eventSuffix}`,
        eventType: NormalizedEventType.PAYMENT_FAILED,
        occurredAt: new Date(),
        dedupeKey: `merchant:evt-autonomous-payment-${eventSuffix}`,
        amount: '1250.00',
        currency: 'INR',
        payment: { paymentId: `pay-autonomous-${eventSuffix}`, verifiedFailureCode: 'INSUFFICIENT_FUNDS' },
      };
      const ingested = await ingester!.ingestEvent(failureEvent);
      const duplicate = await ingester!.ingestEvent(failureEvent);

      expect(ingested.detectionResult.caseCreated).toBe(true);
      expect(duplicate.deduplicated).toBe(true);
      const caseId = ingested.detectionResult.caseId!;
      const scheduled = await jobs.listJobsByCase(merchant.id, caseId);
      expect(scheduled).toHaveLength(1);
      expect(scheduled[0]).toMatchObject({
        jobType: 'RECOVERY_ITERATION',
        jobKey: `recovery-iteration:${caseId}:case-opened`,
        payloadJson: { caseId, triggerKey: `CASE_OPENED:${caseId}`, triggerType: 'CASE_OPENED' },
      });
      await waitFor(
        'initial payment-failure recovery iteration to be consumed by pg-boss',
        () => jobs.getJobById(merchant.id, scheduled[0].id),
        (job) => job.status === 'COMPLETED',
      );

      const plans = await prisma.recoveryPlanVersion.findMany({ where: { caseId } });
      const actions = await prisma.recoveryAction.findMany({ where: { caseId } });
      const reviews = await prisma.humanReview.findMany({ where: { caseId } });
      expect(plans).toHaveLength(1);
      expect(actions.length + reviews.length).toBeGreaterThanOrEqual(1);
    } finally {
      await autonomousWorker.stop();
      await runtime.closeDatabase();
    }
  });

  it('AUTONOMY PROOF: subscription, checkout-abandonment, and overdue-invoice ingress each reach a real pg-boss recovery iteration', async () => {
    if (!dbAvailable) throw new Error('PostgreSQL is required for autonomous runtime evidence');

    const { composeWorkerRuntime } = await import('../src/runtime.js');
    const { RecoveryWorkerService } = await import('../src/worker.js');
    const { MerchantRepository, ScheduledJobRepository, CaseRepository, prisma, RiskType } = await import('@recoverai/db');
    const { MerchantEventSource, NormalizedEventType } = await import('@recoverai/shared');
    const { generateIncidentKey } = await import('@recoverai/core');
    const suffix = Date.now();
    const merchant = await new MerchantRepository().createMerchant({
      name: 'pg-boss timer autonomy merchant',
      slug: `mch-timer-autonomy-${suffix}`,
    });
    const runtime = composeWorkerRuntime({
      NODE_ENV: 'test', AI_PROVIDER: 'mock', DATABASE_URL: process.env.DATABASE_URL!, PG_BOSS_SCHEMA: process.env.PG_BOSS_SCHEMA || 'pgboss', LOG_LEVEL: 'error',
    } as any);
    const autonomousWorker = runtime.worker as unknown as InstanceType<typeof RecoveryWorkerService>;
    const jobs = new ScheduledJobRepository();
    const cases = new CaseRepository();
    await autonomousWorker.start();

    const assertConsumedIteration = async (caseId: string, flow: string) => {
      const iteration = await waitFor(
        `${flow} initial RECOVERY_ITERATION persistence`,
        async () => (await jobs.listJobsByCase(merchant.id, caseId))[0],
        () => true,
      );
      expect(iteration).toMatchObject({
        jobType: 'RECOVERY_ITERATION',
        jobKey: `recovery-iteration:${caseId}:case-opened`,
        payloadJson: { caseId, triggerKey: `CASE_OPENED:${caseId}`, triggerType: 'CASE_OPENED' },
      });
      await waitFor(
        `${flow} RECOVERY_ITERATION pg-boss consumption`,
        () => jobs.getJobById(merchant.id, iteration.id),
        (job) => job.status === 'COMPLETED',
      );
      const [plans, actions, reviews] = await Promise.all([
        prisma.recoveryPlanVersion.findMany({ where: { caseId } }),
        prisma.recoveryAction.findMany({ where: { caseId } }),
        prisma.humanReview.findMany({ where: { caseId } }),
      ]);
      expect(plans.length).toBeGreaterThanOrEqual(1);
      expect(actions.length + reviews.length).toBeGreaterThanOrEqual(1);
    };

    try {
      const ingester = autonomousWorker.getEventIngestionService();
      expect(ingester).not.toBeNull();

      const subscriptionId = `sub-autonomous-${suffix}`;
      const subscription = await ingester!.ingestEvent({
        merchantId: merchant.id, source: MerchantEventSource.MERCHANT,
        externalEventId: `evt-subscription-${suffix}`, dedupeKey: `merchant:evt-subscription-${suffix}`,
        eventType: NormalizedEventType.SUBSCRIPTION_RENEWAL_FAILED, occurredAt: new Date(), amount: '2400.00', currency: 'INR',
        payment: { subscriptionId, paymentId: `pay-subscription-${suffix}`, verifiedFailureCode: 'INSUFFICIENT_FUNDS' },
      });
      expect(subscription.detectionResult.caseCreated).toBe(true);
      await assertConsumedIteration(subscription.detectionResult.caseId!, 'subscription renewal failure');

      const checkoutSessionId = `checkout-autonomous-${suffix}`;
      const checkout = await ingester!.ingestEvent({
        merchantId: merchant.id, source: MerchantEventSource.MERCHANT,
        externalEventId: `evt-checkout-${suffix}`, dedupeKey: `merchant:evt-checkout-${suffix}`,
        eventType: NormalizedEventType.CHECKOUT_STARTED, occurredAt: new Date(Date.now() - 31 * 60 * 1000), amount: '800.00', currency: 'INR',
        checkout: { checkoutSessionId },
      });
      const checkoutTimer = await waitFor(
        'checkout abandonment timer pg-boss consumption',
        () => jobs.getJobById(merchant.id, checkout.detectionResult.scheduledJobId!),
        (job) => job.status === 'COMPLETED',
      );
      expect(checkoutTimer.jobType).toBe('CHECKOUT_ABANDONMENT_CHECK');
      const checkoutCase = await waitFor(
        'checkout abandonment case creation',
        () => cases.findActiveCaseByIncidentKey(merchant.id, generateIncidentKey(merchant.id, RiskType.CHECKOUT_ABANDONMENT, checkoutSessionId)),
        () => true,
      );
      await assertConsumedIteration(checkoutCase.id, 'checkout abandonment');

      const invoiceId = `invoice-autonomous-${suffix}`;
      const invoice = await ingester!.ingestEvent({
        merchantId: merchant.id, source: MerchantEventSource.MERCHANT,
        externalEventId: `evt-invoice-${suffix}`, dedupeKey: `merchant:evt-invoice-${suffix}`,
        eventType: NormalizedEventType.INVOICE_CREATED, occurredAt: new Date(), amount: '3600.00', currency: 'INR',
        invoice: { invoiceId, dueDate: new Date(Date.now() - 4 * 24 * 60 * 60 * 1000), paid: false },
      });
      const invoiceTimer = await waitFor(
        'invoice overdue timer pg-boss consumption',
        () => jobs.getJobById(merchant.id, invoice.detectionResult.scheduledJobId!),
        (job) => job.status === 'COMPLETED',
      );
      expect(invoiceTimer.jobType).toBe('INVOICE_OVERDUE_CHECK');
      const invoiceCase = await waitFor(
        'overdue receivable case creation',
        () => cases.findActiveCaseByIncidentKey(merchant.id, generateIncidentKey(merchant.id, RiskType.OVERDUE_RECEIVABLE, invoiceId)),
        () => true,
      );
      await assertConsumedIteration(invoiceCase.id, 'overdue invoice');
    } finally {
      await autonomousWorker.stop();
      await runtime.closeDatabase();
    }
  });

  it('AUTONOMY PROOF: a durable PAYMENT_METHOD_UPDATED observation wakes exactly one real pg-boss replan and records no recovered money', async () => {
    if (!dbAvailable) throw new Error('PostgreSQL is required for autonomous runtime evidence');

    const { composeWorkerRuntime } = await import('../src/runtime.js');
    const { RecoveryWorkerService } = await import('../src/worker.js');
    const { MerchantRepository, ScheduledJobRepository, OutcomeRepository, prisma } = await import('@recoverai/db');
    const { MerchantEventSource, NormalizedEventType } = await import('@recoverai/shared');
    const suffix = Date.now();
    const merchant = await new MerchantRepository().createMerchant({ name: 'pg-boss replan autonomy merchant', slug: `mch-replan-autonomy-${suffix}` });
    const runtime = composeWorkerRuntime({
      NODE_ENV: 'test', AI_PROVIDER: 'mock', DATABASE_URL: process.env.DATABASE_URL!, PG_BOSS_SCHEMA: process.env.PG_BOSS_SCHEMA || 'pgboss', LOG_LEVEL: 'error',
    } as any);
    const autonomousWorker = runtime.worker as unknown as InstanceType<typeof RecoveryWorkerService>;
    const jobs = new ScheduledJobRepository();
    const outcomes = new OutcomeRepository();
    await autonomousWorker.start();

    try {
      const ingester = autonomousWorker.getEventIngestionService();
      const observer = autonomousWorker.getOutcomeObserver();
      expect(ingester).not.toBeNull();
      expect(observer).not.toBeNull();
      const paymentId = `pay-replan-${suffix}`;
      const failed = await ingester!.ingestEvent({
        merchantId: merchant.id, source: MerchantEventSource.MERCHANT,
        externalEventId: `evt-replan-failure-${suffix}`, dedupeKey: `merchant:evt-replan-failure-${suffix}`,
        eventType: NormalizedEventType.PAYMENT_FAILED, occurredAt: new Date(), amount: '1750.00', currency: 'INR',
        payment: { paymentId, verifiedFailureCode: 'INSUFFICIENT_FUNDS' },
      });
      const caseId = failed.detectionResult.caseId!;
      const initialJob = (await jobs.listJobsByCase(merchant.id, caseId))[0];
      await waitFor('first recovery iteration before payment-method replan', () => jobs.getJobById(merchant.id, initialJob.id), (job) => job.status === 'COMPLETED');
      const firstPlans = await prisma.recoveryPlanVersion.count({ where: { caseId } });
      expect(firstPlans).toBeGreaterThanOrEqual(1);

      const methodUpdate = {
        merchantId: merchant.id, source: MerchantEventSource.MERCHANT,
        externalEventId: `evt-replan-method-${suffix}`, dedupeKey: `merchant:evt-replan-method-${suffix}`,
        eventType: NormalizedEventType.PAYMENT_METHOD_UPDATED, occurredAt: new Date(),
        payment: { paymentId },
      };
      const observedEvent = await ingester!.ingestEvent(methodUpdate, { skipRiskDetection: true });
      const observation = await observer!.observeMerchantEvent(methodUpdate, observedEvent.event.id);
      const duplicateEvent = await ingester!.ingestEvent(methodUpdate, { skipRiskDetection: true });
      const duplicateObservation = await observer!.observeMerchantEvent(methodUpdate, duplicateEvent.event.id);
      expect(observation).toMatchObject({ observed: true, caseId, replanTriggered: true });
      expect(duplicateEvent.deduplicated).toBe(true);
      expect(duplicateObservation).toMatchObject({ observed: true, deduplicated: true, caseId });

      const replanJobs = await waitFor(
        'single persisted payment-method recovery iteration',
        async () => (await jobs.listJobsByCase(merchant.id, caseId)).filter((job) => (job.payloadJson as Record<string, unknown>).triggerType === 'OBSERVATION_ARRIVED'),
        (found) => found.length === 1,
      );
      expect(replanJobs).toHaveLength(1);
      await waitFor('payment-method replan pg-boss consumption', () => jobs.getJobById(merchant.id, replanJobs[0].id), (job) => job.status === 'COMPLETED');
      expect(await prisma.recoveryPlanVersion.count({ where: { caseId } })).toBeGreaterThan(firstPlans);
      const methodOutcomes = await outcomes.listOutcomesByCase(merchant.id, caseId);
      expect(methodOutcomes.filter((outcome) => outcome.outcomeType === 'PAYMENT_METHOD_UPDATED')).toHaveLength(1);
      expect(methodOutcomes.filter((outcome) => outcome.outcomeType === 'PAYMENT_METHOD_UPDATED').every((outcome) => outcome.amountRecovered === null)).toBe(true);
    } finally {
      await autonomousWorker.stop();
      await runtime.closeDatabase();
    }
  });
});

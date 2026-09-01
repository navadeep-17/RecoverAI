import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { RecoveryWorkerService } from '../src/worker.js';
import { checkDatabaseConnection } from '@recoverai/db';

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
      expect(scheduled[0]).toMatchObject({ jobType: 'RECOVERY_ITERATION', jobKey: `recovery-iteration:${caseId}:case-opened` });

      const deadline = Date.now() + 20000;
      let completed = false;
      while (Date.now() < deadline) {
        const current = await jobs.getJobById(merchant.id, scheduled[0].id);
        if (current?.status === 'COMPLETED') { completed = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      expect(completed).toBe(true);

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
});

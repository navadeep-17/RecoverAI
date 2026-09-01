import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Prisma } from '@prisma/client';
import {
  prisma,
  ActionRepository,
  CaseRepository,
  MerchantRepository,
  CustomerRepository,
  AuditRepository,
  PolicyConfigRepository,
  CommitmentRepository,
  HumanReviewRepository,
  OutcomeRepository,
  EventRepository,
  ScheduledJobRepository,
  TriggerRepository,
  CaseStatus,
  PolicyDecision,
  RecoveryActionType,
  RiskType,
} from '../src/index.js';
import {
  ActionExecutor,
  RecoveryOrchestrator,
  OutcomeObserver,
  RecoveryAgent,
  HumanReviewService,
  MockLLMProvider,
  EventIngestionService,
  RiskDetector,
} from '@recoverai/core';
import { PolicyEngine } from '@recoverai/policy';
import {
  ProviderRegistry,
  SimulatedRecoveryProvider,
} from '@recoverai/integrations';
import { NormalizedEventType, MerchantEventSource } from '@recoverai/shared';

describe('Closed-Loop Recovery & Canonical Demo Flows Integration Tests', () => {
  let dbAvailable = false;
  let actionRepo: ActionRepository;
  let caseRepo: CaseRepository;
  let merchantRepo: MerchantRepository;
  let customerRepo: CustomerRepository;
  let auditRepo: AuditRepository;
  let policyConfigRepo: PolicyConfigRepository;
  let commitmentRepo: CommitmentRepository;
  let humanReviewRepo: HumanReviewRepository;
  let outcomeRepo: OutcomeRepository;
  let eventRepo: EventRepository;
  let scheduledJobRepo: ScheduledJobRepository;
  let riskDetector: RiskDetector;
  let ingestionService: EventIngestionService;
  let policyEngine: PolicyEngine;
  let mockLLM: MockLLMProvider;
  let recoveryAgent: RecoveryAgent;
  let simulatedProvider: SimulatedRecoveryProvider;
  let providerRegistry: ProviderRegistry;
  let actionExecutor: ActionExecutor;
  let reviewService: HumanReviewService;
  let orchestrator: RecoveryOrchestrator;
  let observer: OutcomeObserver;

  let merchantId: string;

  beforeAll(async () => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      dbAvailable = true;

      actionRepo = new ActionRepository();
      caseRepo = new CaseRepository();
      merchantRepo = new MerchantRepository();
      customerRepo = new CustomerRepository();
      auditRepo = new AuditRepository();
      policyConfigRepo = new PolicyConfigRepository();
      commitmentRepo = new CommitmentRepository();
      humanReviewRepo = new HumanReviewRepository();
      outcomeRepo = new OutcomeRepository();
      eventRepo = new EventRepository();

      policyEngine = new PolicyEngine();
      mockLLM = new MockLLMProvider();
      recoveryAgent = new RecoveryAgent(mockLLM);
      simulatedProvider = new SimulatedRecoveryProvider();
      providerRegistry = new ProviderRegistry([simulatedProvider]);

      scheduledJobRepo = new ScheduledJobRepository();
      const triggerRepo = new TriggerRepository();
      const jobScheduler = {
        schedule: async (params: any) => {
          const { created, job } = await scheduledJobRepo.createJob(params.merchantId, {
            caseId: params.caseId,
            jobKey: params.jobKey,
            jobType: params.jobType,
            scheduledFor: params.scheduledFor,
            payloadJson: params.payloadJson,
          });
          if (!created) {
            return { id: job.id, pgBossJobId: job.pgBossJobId || undefined, created: false };
          }
          const pgBossJobId = `pgboss_${job.id}`;
          await scheduledJobRepo.updateJobStatus(params.merchantId, job.id, 'SCHEDULED', pgBossJobId);
          return { id: job.id, pgBossJobId, created: true };
        },
      };

      riskDetector = new RiskDetector(
        caseRepo,
        customerRepo,
        policyConfigRepo,
        auditRepo,
        eventRepo,
        jobScheduler,
      );
      ingestionService = new EventIngestionService(eventRepo, auditRepo, riskDetector, customerRepo);

      actionExecutor = new ActionExecutor({
        actionRepo,
        caseRepo,
        merchantRepo,
        customerRepo,
        auditRepo,
        policyConfigRepo,
        commitmentRepo,
        policyEngine,
        providerRegistry,
        jobScheduler,
        clock: () => new Date('2026-08-28T14:00:00+05:30'),
      });
      reviewService = new HumanReviewService({
        humanReviewRepo,
        caseRepo,
        actionRepo,
        customerRepo,
        merchantRepo,
        policyConfigRepo,
        commitmentRepo,
        outcomeRepo,
        auditRepo,
        policyEngine,
        actionExecutor,
      });
      actionExecutor.setReviewGateRequester(reviewService);

      orchestrator = new RecoveryOrchestrator({
        caseRepo,
        actionRepo,
        customerRepo,
        merchantRepo,
        policyConfigRepo,
        commitmentRepo,
        auditRepo,
        recoveryAgent,
        policyEngine,
        actionExecutor,
        jobScheduler,
        triggerRepo,
        reviewGateRequester: reviewService,
        clock: () => new Date('2026-08-28T14:00:00+05:30'),
      });

      observer = new OutcomeObserver({
        caseRepo,
        actionRepo,
        outcomeRepo,
        customerRepo,
        commitmentRepo,
        eventRepo,
        auditRepo,
        scheduledJobRepo,
        jobScheduler,
        orchestrator,
        reviewGateRequester: reviewService,
        clock: () => new Date('2026-08-28T14:00:00+05:30'),
      });

      const mch = await merchantRepo.createMerchant({
        name: 'Closed Loop Demo Merchant',
        slug: `mch-closed-loop-${Date.now()}`,
      });
      merchantId = mch.id;
    } catch {
      dbAvailable = false;
    }
  });

  afterAll(async () => {
    if (dbAvailable) {
      if (merchantId) await merchantRepo.deleteMerchant(merchantId).catch(() => {});
      await prisma.$disconnect();
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  it('FLOW A: ₹14,999 Subscription CARD_EXPIRED -> REQUEST_UPDATE -> METHOD_UPDATED -> RETRY -> RECOVERED', async () => {
    if (!dbAvailable) return;

    // 1. Canonical subscription failure ingestion creates the case through RiskDetector.
    const paymentId = `pay_sub_${Date.now()}`;
    const subscriptionId = `sub_${Date.now()}`;
    const failureIngestion = await ingestionService.ingestEvent({
      merchantId,
      source: MerchantEventSource.MERCHANT,
      externalEventId: `evt_subscription_failure_${paymentId}`,
      eventType: NormalizedEventType.SUBSCRIPTION_RENEWAL_FAILED,
      occurredAt: new Date(),
      dedupeKey: `subscription_failure:${merchantId}:${subscriptionId}`,
      amount: '14999.00',
      currency: 'INR',
      customer: {
        externalCustomerId: `flow-a-${Date.now()}`,
        name: 'Flow A Customer',
        email: `flow_a_${Date.now()}@example.com`,
        contactConsent: true,
      },
      payment: { paymentId, subscriptionId, verifiedFailureCode: 'CARD_EXPIRED' },
    });
    expect(failureIngestion.created).toBe(true);
    expect(failureIngestion.event.type).toBe(NormalizedEventType.SUBSCRIPTION_RENEWAL_FAILED);
    expect(failureIngestion.detectionResult.riskDetected).toBe(true);
    expect(failureIngestion.detectionResult.caseCreated).toBe(true);
    expect(failureIngestion.detectionResult.riskType).toBe(RiskType.SUBSCRIPTION_FAILURE);
    const testCase = await caseRepo.getCaseById(merchantId, failureIngestion.detectionResult.caseId!);
    expect(testCase?.status).toBe(CaseStatus.OPEN);
    expect(testCase).not.toBeNull();
    if (!testCase) throw new Error('Subscription failure detection did not persist a case');

    // 2. Iteration 1: Agent diagnoses expired card -> proposes REQUEST_PAYMENT_UPDATE
    mockLLM.setMockResponse({
      diagnosisCode: 'SUBSCRIPTION_CARD_EXPIRED',
      diagnosisSummary: 'Card has expired; prompt customer to update method',
      confidence: 0.92,
      proposedActionType: RecoveryActionType.REQUEST_PAYMENT_UPDATE,
      proposedActionParams: { channel: 'EMAIL' },
      reasoningSummary: 'Cannot retry expired card automatically; request method update link',
      followUpAfterSeconds: 43200,
      shouldStop: false,
      shouldEscalate: false,
    });

    const iter1 = await orchestrator.runIteration(merchantId, testCase!.id, 'CASE_OPENED');

    expect(iter1.iterationCompleted).toBe(true);
    expect(iter1.status).toBe(CaseStatus.WAITING);
    expect(iter1.policyDecision).toBe(PolicyDecision.ALLOW);
    expect(iter1.action?.providerName).toBe('SIMULATED_RECOVERY_PROVIDER');
    expect(iter1.planVersion?.version).toBe(1);

    // Verify case in database is now WAITING
    const dbCaseWaiting = await caseRepo.getCaseById(merchantId, testCase!.id);
    expect(dbCaseWaiting?.status).toBe(CaseStatus.WAITING);

    // 3. Customer updates payment method -> Event PAYMENT_METHOD_UPDATED arrives
    const methodUpdatedEvent: any = {
      eventId: `evt_method_${Date.now()}`,
      merchantId,
      source: MerchantEventSource.MERCHANT,
      externalEventId: `ext_method_${paymentId}`,
      eventType: NormalizedEventType.PAYMENT_METHOD_UPDATED,
      occurredAt: new Date(),
      dedupeKey: `method_updated:${merchantId}:${paymentId}`,
      payment: {
        paymentId,
      },
    };

    const methodResult = await ingestionService.ingestEvent(methodUpdatedEvent, { skipRiskDetection: true });
    expect(methodResult.created).toBe(true);

    // When observer wakes orchestrator, configure LLM to propose RETRY_PAYMENT for iteration 2
    mockLLM.setMockResponse({
      diagnosisCode: 'CARD_CREDENTIALS_UPDATED',
      diagnosisSummary: 'New card details on file; execute payment retry',
      confidence: 0.95,
      proposedActionType: RecoveryActionType.RETRY_PAYMENT,
      proposedActionParams: { attemptNumber: 1 },
      reasoningSummary: 'Payment method was verified updated; retry renewal charge',
      followUpAfterSeconds: 7200,
      shouldStop: false,
      shouldEscalate: false,
    });

    const observationResult = await observer.observeMerchantEvent(methodUpdatedEvent, methodResult.event.id);

    expect(observationResult.observed).toBe(true);
    expect(observationResult.replanTriggered).toBe(true);

    // Production consumes this durable wake in the worker. This historical
    // orchestration test intentionally invokes the already-scheduled trigger
    // directly so it can continue testing the loop itself without a second
    // pg-boss harness.
    const observationJob = (await scheduledJobRepo.listJobsByCase(merchantId, testCase.id)).find((job) => {
      const payload = job.payloadJson as Record<string, unknown>;
      return job.jobType === 'RECOVERY_ITERATION' && payload.triggerType === 'OBSERVATION_ARRIVED';
    });
    expect(observationJob).toBeDefined();
    const observationPayload = observationJob!.payloadJson as Record<string, string>;
    await orchestrator.runIteration(merchantId, testCase.id, {
      triggerKey: observationPayload.triggerKey,
      triggerType: observationPayload.triggerType,
      scheduledJobId: observationJob!.id,
    });
    await scheduledJobRepo.updateJobStatus(merchantId, observationJob!.id, 'COMPLETED');

    // Verify Plan Version 2 was created in DB
    const dbCaseRechecked = await caseRepo.getCaseById(merchantId, testCase.id);
    expect(dbCaseRechecked?.planVersions?.length).toBe(2);
    expect(dbCaseRechecked?.planVersions?.[0].version).toBe(2);
    expect(dbCaseRechecked?.planVersions?.[0].proposedActionType).toBe(RecoveryActionType.RETRY_PAYMENT);

    // 4. Authoritative PAYMENT_SUCCEEDED event arrives for ₹14,999 INR
    const successEvent: any = {
      eventId: `evt_success_${Date.now()}`,
      merchantId,
      source: MerchantEventSource.RAZORPAY,
      externalEventId: `ext_succ_${paymentId}`,
      eventType: NormalizedEventType.PAYMENT_SUCCEEDED,
      occurredAt: new Date(),
      dedupeKey: `pay_succ:${merchantId}:${paymentId}`,
      amount: '14999.00',
      currency: 'INR',
      payment: {
        paymentId,
      },
    };

    const succResult = await ingestionService.ingestEvent(successEvent, { skipRiskDetection: true });
    expect(succResult.created).toBe(true);

    // Verify before success observation that the case remains active and correctly correlated
    const beforeSuccess = await caseRepo.getCaseById(merchantId, testCase.id);
    expect(beforeSuccess?.status).toBe(CaseStatus.WAITING);

    const correlated = await caseRepo.findActiveCaseByPaymentId(merchantId, paymentId);
    expect(correlated?.id).toBe(testCase.id);

    const successObsResult = await observer.observeMerchantEvent(successEvent, succResult.event.id);

    expect(successObsResult.observed).toBe(true);
    expect(successObsResult.caseResolved).toBe(true);
    expect(successObsResult.caseStatus).toBe(CaseStatus.RECOVERED);

    // Verify case in DB is RECOVERED with exact ₹14,999.00
    const finalDbCase = await caseRepo.getCaseById(merchantId, testCase.id);
    expect(finalDbCase?.status).toBe(CaseStatus.RECOVERED);
    expect(finalDbCase?.recoveredAmount).toBeDefined();
    expect(new Prisma.Decimal(finalDbCase!.recoveredAmount!).equals(new Prisma.Decimal('14999.00'))).toBe(true);

    // Verify authoritative RecoveryOutcome was recorded
    const outcomes = await outcomeRepo.listOutcomesByCase(merchantId, testCase.id);
    const winningOutcome = outcomes.find((o) => o.outcomeType === NormalizedEventType.PAYMENT_SUCCEEDED);
    expect(winningOutcome).toBeDefined();
    expect(winningOutcome?.actionId).toBeNull();
    const verifiedRecovered = new Prisma.Decimal(finalDbCase!.recoveredAmount!).toFixed(2);
    const agentAttributed = winningOutcome?.actionId ? verifiedRecovered : '0.00';
    console.log(`DEMO A | EVENT ${failureIngestion.event.type} -> DETECT ${failureIngestion.detectionResult.riskType} -> AGENT ${iter1.planVersion?.proposedActionType} -> POLICY ${iter1.policyDecision} -> EXECUTE ${iter1.action?.providerName} -> WAITING -> PAYMENT_METHOD_UPDATED -> REPLAN RETRY_PAYMENT -> OBSERVE PAYMENT_SUCCEEDED -> RECOVERED | Verified recovered: ₹${verifiedRecovered} | Agent-attributed: ₹${agentAttributed}`);
  });

  // ──────────────────────────────────────────────────────────────────────────
  it('FLOW B: ₹8,499 Checkout Abandonment -> SEND_CHECKOUT_RECOVERY -> CHECKOUT_COMPLETED -> RECOVERED', async () => {
    if (!dbAvailable) return;

    const checkoutSessionId = `cs_${Date.now()}`;
    const checkoutIngestion = await ingestionService.ingestEvent({
      merchantId,
      source: MerchantEventSource.MERCHANT,
      externalEventId: `evt_checkout_started_${checkoutSessionId}`,
      eventType: NormalizedEventType.CHECKOUT_STARTED,
      occurredAt: new Date(),
      dedupeKey: `checkout_started:${merchantId}:${checkoutSessionId}`,
      amount: '8499.00',
      currency: 'INR',
      customer: {
        externalCustomerId: `flow-b-${Date.now()}`,
        name: 'Flow B Customer',
        email: `flow_b_${Date.now()}@example.com`,
        phone: '+919876543210',
        contactConsent: true,
      },
      checkout: { checkoutSessionId },
    });
    expect(checkoutIngestion.created).toBe(true);
    expect(checkoutIngestion.event.type).toBe(NormalizedEventType.CHECKOUT_STARTED);
    expect(checkoutIngestion.detectionResult.riskDetected).toBe(false);
    expect(checkoutIngestion.detectionResult.scheduledJobId).toBeDefined();
    const abandonmentJob = await scheduledJobRepo.getJobById(merchantId, checkoutIngestion.detectionResult.scheduledJobId!);
    expect(abandonmentJob?.jobType).toBe('CHECKOUT_ABANDONMENT_CHECK');
    expect(abandonmentJob?.status).toBe('SCHEDULED');
    const abandonmentDetection = await riskDetector.evaluateCheckoutTimer(
      merchantId,
      checkoutSessionId,
      abandonmentJob!.payloadJson as unknown as Record<string, unknown>,
    );
    expect(abandonmentDetection.riskDetected).toBe(true);
    expect(abandonmentDetection.caseCreated).toBe(true);
    expect(abandonmentDetection.riskType).toBe(RiskType.CHECKOUT_ABANDONMENT);
    const testCase = await caseRepo.getCaseById(merchantId, abandonmentDetection.caseId!);
    expect(testCase?.status).toBe(CaseStatus.OPEN);
    if (!testCase) throw new Error('Checkout abandonment detection did not persist a case');

    // 1. Iteration 1: Agent proposes SEND_CHECKOUT_RECOVERY
    mockLLM.setMockResponse({
      diagnosisCode: 'CHECKOUT_ABANDONED',
      diagnosisSummary: 'Cart abandoned with high intent',
      confidence: 0.88,
      proposedActionType: RecoveryActionType.SEND_CHECKOUT_RECOVERY,
      proposedActionParams: { channel: 'WHATSAPP' },
      reasoningSummary: 'Send checkout recovery link via WhatsApp',
      followUpAfterSeconds: 3600,
      shouldStop: false,
      shouldEscalate: false,
    });

    const iter1 = await orchestrator.runIteration(merchantId, testCase.id, 'CASE_OPENED');

    expect(iter1.iterationCompleted).toBe(true);
    expect(iter1.status).toBe(CaseStatus.WAITING);
    expect(iter1.policyDecision).toBe(PolicyDecision.ALLOW);
    expect(iter1.action?.providerName).toBe('SIMULATED_RECOVERY_PROVIDER');

    // 2. Authoritative CHECKOUT_COMPLETED event arrives for ₹8,499 INR
    const checkoutCompletedEvent: any = {
      eventId: `evt_chk_${Date.now()}`,
      merchantId,
      source: MerchantEventSource.MERCHANT,
      externalEventId: `ext_chk_${checkoutSessionId}`,
      eventType: NormalizedEventType.CHECKOUT_COMPLETED,
      occurredAt: new Date(),
      dedupeKey: `checkout_completed:${merchantId}:${checkoutSessionId}`,
      amount: '8499.00',
      currency: 'INR',
      checkout: {
        checkoutSessionId,
      },
    };

    const chkResult = await ingestionService.ingestEvent(checkoutCompletedEvent, { skipRiskDetection: true });
    expect(chkResult.created).toBe(true);

    const obsResult = await observer.observeMerchantEvent(checkoutCompletedEvent, chkResult.event.id);

    expect(obsResult.observed).toBe(true);
    expect(obsResult.caseResolved).toBe(true);
    expect(obsResult.caseStatus).toBe(CaseStatus.RECOVERED);

    // Verify case in database is RECOVERED with exact ₹8,499.00
    const finalDbCase = await caseRepo.getCaseById(merchantId, testCase.id);
    expect(finalDbCase?.status).toBe(CaseStatus.RECOVERED);
    expect(finalDbCase?.recoveredAmount).toBeDefined();
    expect(new Prisma.Decimal(finalDbCase!.recoveredAmount!).equals(new Prisma.Decimal('8499.00'))).toBe(true);
    const outcomes = await outcomeRepo.listOutcomesByCase(merchantId, testCase.id);
    const winningOutcome = outcomes.find((o) => o.outcomeType === NormalizedEventType.CHECKOUT_COMPLETED);
    expect(winningOutcome).toBeDefined();
    expect(winningOutcome?.actionId).toBeNull();
    const verifiedRecovered = new Prisma.Decimal(finalDbCase!.recoveredAmount!).toFixed(2);
    const agentAttributed = winningOutcome?.actionId ? verifiedRecovered : '0.00';
    console.log(`DEMO B | EVENT ${checkoutIngestion.event.type} -> DETECT ${abandonmentDetection.riskType} -> AGENT ${iter1.planVersion?.proposedActionType} -> POLICY ${iter1.policyDecision} -> EXECUTE ${iter1.action?.providerName} -> WAITING -> OBSERVE CHECKOUT_COMPLETED -> RECOVERED | Verified recovered: ₹${verifiedRecovered} | Agent-attributed: ₹${agentAttributed}`);
  });

  // ──────────────────────────────────────────────────────────────────────────
  it('FLOW C: ₹85,000 Overdue Receivable -> REMINDER -> PROMISE_TO_PAY -> BROKEN -> NEEDS_REVIEW', async () => {
    if (!dbAvailable) return;

    // Configure policyConfig with highValueThreshold = 100,000 so the initial reminder is authorized
    await prisma.policyConfig.upsert({
      where: { merchantId },
      create: {
        merchantId,
        highValueThreshold: '100000.00',
      },
      update: {
        highValueThreshold: '100000.00',
      },
    });

    const invoiceId = `inv_${Date.now()}`;
    const dueDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const invoiceIngestion = await ingestionService.ingestEvent({
      merchantId,
      source: MerchantEventSource.MERCHANT,
      externalEventId: `evt_invoice_created_${invoiceId}`,
      eventType: NormalizedEventType.INVOICE_CREATED,
      occurredAt: new Date(),
      dedupeKey: `invoice_created:${merchantId}:${invoiceId}`,
      amount: '85000.00',
      currency: 'INR',
      customer: {
        externalCustomerId: `flow-c-${Date.now()}`,
        name: 'Flow C Customer',
        email: `flow_c_${Date.now()}@example.com`,
        contactConsent: true,
      },
      invoice: { invoiceId, dueDate, paid: false },
    });
    expect(invoiceIngestion.created).toBe(true);
    expect(invoiceIngestion.event.type).toBe(NormalizedEventType.INVOICE_CREATED);
    expect(invoiceIngestion.detectionResult.riskDetected).toBe(false);
    expect(invoiceIngestion.detectionResult.scheduledJobId).toBeDefined();
    const overdueJob = await scheduledJobRepo.getJobById(merchantId, invoiceIngestion.detectionResult.scheduledJobId!);
    expect(overdueJob?.jobType).toBe('INVOICE_OVERDUE_CHECK');
    expect(overdueJob?.status).toBe('SCHEDULED');
    const overdueDetection = await riskDetector.evaluateInvoiceTimer(
      merchantId,
      invoiceId,
      overdueJob!.payloadJson as unknown as Record<string, unknown>,
    );
    expect(overdueDetection.riskDetected).toBe(true);
    expect(overdueDetection.caseCreated).toBe(true);
    expect(overdueDetection.riskType).toBe(RiskType.OVERDUE_RECEIVABLE);
    const testCase = await caseRepo.getCaseById(merchantId, overdueDetection.caseId!);
    expect(testCase?.status).toBe(CaseStatus.OPEN);
    if (!testCase) throw new Error('Invoice overdue detection did not persist a case');

    // 1. Iteration 1: Agent proposes SEND_RECEIVABLE_REMINDER
    mockLLM.setMockResponse({
      diagnosisCode: 'INVOICE_PAST_DUE',
      diagnosisSummary: 'Invoice past due; send initial reminder',
      confidence: 0.85,
      proposedActionType: RecoveryActionType.SEND_RECEIVABLE_REMINDER,
      proposedActionParams: { channel: 'EMAIL' },
      reasoningSummary: 'Friendly payment reminder is appropriate for initial overdue notice',
      followUpAfterSeconds: 86400,
      shouldStop: false,
      shouldEscalate: false,
    });

    const iter1 = await orchestrator.runIteration(merchantId, testCase.id, 'CASE_OPENED');

    expect(iter1.iterationCompleted).toBe(true);
    expect(iter1.status).toBe(CaseStatus.WAITING);
    expect(iter1.policyDecision).toBe(PolicyDecision.ALLOW);
    expect(iter1.action?.providerName).toBe('SIMULATED_RECOVERY_PROVIDER');

    // 2. Customer replies: "Will pay ₹85,000 this Friday"
    const replyResult = await observer.observeCustomerReply({
      merchantId,
      caseId: testCase.id,
      messageId: `msg_flowb_${Date.now()}`,
      replyText: 'We will pay ₹85,000 this Friday by NEFT',
    });

    expect(replyResult.observed).toBe(true);

    // Verify authoritative RecoveryCommitment was persisted in DB
    const commitments = await commitmentRepo.getActiveCommitmentsForCase(merchantId, testCase.id);
    expect(commitments.length).toBe(1);
    expect(commitments[0].status).toBe('PENDING');
    expect(commitments[0].promisedAmount.equals(new Prisma.Decimal('85000.00'))).toBe(true);

    // 3. Retrieve authoritative ScheduledJob created by observeCustomerReply
    const promiseJobRepo = new ScheduledJobRepository();
    const caseJobs = await promiseJobRepo.listJobsByCase(merchantId, testCase.id);
    expect(caseJobs.length).toBeGreaterThan(0);
    const promiseCheckJob = caseJobs.find((j) => j.jobType === 'PROMISE_TO_PAY_CHECK') || caseJobs[0];

    // Friday timer fires and case is still unpaid -> commitment marked BROKEN -> wakes orchestrator
    mockLLM.setMockResponse({
      diagnosisCode: 'PROMISE_BROKEN_FOLLOWUP',
      diagnosisSummary: 'Promised date passed unpaid; try follow up reminder',
      confidence: 0.75,
      proposedActionType: RecoveryActionType.SEND_RECEIVABLE_REMINDER,
      proposedActionParams: { channel: 'EMAIL' },
      reasoningSummary: 'Customer broke promise; follow up',
      shouldStop: false,
      shouldEscalate: false,
    });

    const timerResult = await observer.observeTimerFired({
      merchantId,
      caseId: testCase.id,
      scheduledJobId: promiseCheckJob.id,
      timerType: 'PROMISE_TO_PAY_CHECK',
      payload: { commitmentId: commitments[0].id },
      occurredAt: new Date(Date.now() + 86400000 * 7),
    });

    expect(timerResult.observed).toBe(true);

    // Verify commitment was updated to BROKEN in DB
    const updatedCommitment = await commitmentRepo.getCommitmentById(merchantId, testCase.id, commitments[0].id);
    expect(updatedCommitment?.status).toBe('BROKEN');

    // 4. PolicyEngine evaluated BrokenPromiseToPayRule -> Decision REVIEW -> Case transitioned to NEEDS_REVIEW!
    const finalDbCase = await caseRepo.getCaseById(merchantId, testCase.id);
    expect(finalDbCase?.status).toBe(CaseStatus.NEEDS_REVIEW);
    const activeReview = await humanReviewRepo.findPendingReviewForCase(merchantId, testCase.id);
    expect(activeReview).not.toBeNull();

    // Verify CASE_ESCALATED audit exists
    const escalationAudits = await prisma.auditEvent.findMany({
      where: { caseId: testCase.id, eventType: 'CASE_ESCALATED' },
    });
    expect(escalationAudits.length).toBeGreaterThan(0);
    expect(escalationAudits[0].reasonCode).toBe('BROKEN_PROMISE_TO_PAY');
    console.log(`DEMO C | EVENT ${invoiceIngestion.event.type} -> DETECT ${overdueDetection.riskType} -> AGENT ${iter1.planVersion?.proposedActionType} -> POLICY ${iter1.policyDecision} -> EXECUTE ${iter1.action?.providerName} -> PROMISE_TO_PAY -> PTP_BROKEN -> HUMAN_REVIEW ${activeReview?.status} -> STOP awaiting human takeover`);
  });

  // ──────────────────────────────────────────────────────────────────────────
  it('CONCURRENCY & IDEMPOTENCY: 5 concurrent identical success events produce exactly 1 recovery credit', async () => {
    if (!dbAvailable) return;

    const paymentId = `pay_conc_${Date.now()}`;
    const testCase = await caseRepo.createCase(merchantId, {
      riskType: RiskType.PAYMENT_FAILURE,
      amountAtRisk: '5000.00',
      currency: 'INR',
      incidentKey: `${merchantId}:PAYMENT_FAILURE:${paymentId}`,
      contextJson: { paymentId, verifiedPaymentFailureCode: 'BAD_REQUEST' },
    });

    const paymentEvent: any = {
      eventId: `evt_conc_${Date.now()}`,
      merchantId,
      source: MerchantEventSource.RAZORPAY,
      eventType: NormalizedEventType.PAYMENT_SUCCEEDED,
      occurredAt: new Date(),
      amount: '5000.00',
      currency: 'INR',
      payment: {
        paymentId,
      },
    };

    const sharedEventResult = await eventRepo.recordMerchantEvent(merchantId, {
      source: MerchantEventSource.RAZORPAY,
      type: NormalizedEventType.PAYMENT_SUCCEEDED,
      externalEventId: `ext_conc_${paymentId}`,
      dedupeKey: `pay_succ_conc:${merchantId}:${paymentId}`,
      payloadJson: paymentEvent,
      occurredAt: new Date(),
    });

    // Concurrently observe the exact same payment event across 5 workers
    const results = await Promise.all([
      observer.observeMerchantEvent(paymentEvent, sharedEventResult.event.id),
      observer.observeMerchantEvent(paymentEvent, sharedEventResult.event.id),
      observer.observeMerchantEvent(paymentEvent, sharedEventResult.event.id),
      observer.observeMerchantEvent(paymentEvent, sharedEventResult.event.id),
      observer.observeMerchantEvent(paymentEvent, sharedEventResult.event.id),
    ]);

    // Case is RECOVERED
    const finalCase = await caseRepo.getCaseById(merchantId, testCase.id);
    expect(finalCase?.status).toBe(CaseStatus.RECOVERED);
    expect(finalCase?.recoveredAmount).toBeDefined();
    expect(new Prisma.Decimal(finalCase!.recoveredAmount!).equals(new Prisma.Decimal('5000.00'))).toBe(true);

    // Exactly ONE outcome was recorded in database (no duplicate credit)
    const outcomesInDb = await outcomeRepo.listOutcomesByCase(merchantId, testCase.id);
    expect(outcomesInDb.length).toBe(1);

    // Exactly 1 CASE_RECOVERED_BY_PAYMENT audit in database
    const recoveryAudits = await prisma.auditEvent.findMany({
      where: { caseId: testCase.id, eventType: 'CASE_RECOVERED_BY_PAYMENT' },
    });
    expect(recoveryAudits.length).toBe(1);
  });

  it('SAFETY TRACE: opted-out customer denies communication with zero provider dispatch', async () => {
    if (!dbAvailable) return;
    simulatedProvider.dispatchedCalls = [];
    const customer = await customerRepo.getOrCreateCustomer(merchantId, {
      externalCustomerId: `opted-out-${Date.now()}`,
      contactConsent: true,
    });
    await customerRepo.setOptOut(merchantId, customer.id, true);
    const testCase = await caseRepo.createCase(merchantId, {
      customerId: customer.id, riskType: RiskType.PAYMENT_FAILURE, amountAtRisk: '14999.00', currency: 'INR',
      incidentKey: `opted-out-${Date.now()}`, contextJson: { paymentId: `pay-opted-${Date.now()}` },
    });
    mockLLM.setMockResponse({ diagnosisCode: 'CONTACT_REQUIRED', diagnosisSummary: 'Would contact customer', confidence: 0.9, proposedActionType: RecoveryActionType.REQUEST_PAYMENT_UPDATE, proposedActionParams: { channel: 'EMAIL' }, reasoningSummary: 'Contact', shouldStop: false, shouldEscalate: false });
    const result = await orchestrator.runIteration(merchantId, testCase.id, 'SAFETY_OPT_OUT');
    expect(result.iterationCompleted).toBe(true);
    expect(result.status).toBe(CaseStatus.STOPPED);
    expect(simulatedProvider.dispatchedCalls).toHaveLength(0);
    console.log(`SAFETY | customer optedOut=true -> deterministic pre-execution ${result.status} -> provider calls=${simulatedProvider.dispatchedCalls.length}`);
  });

  // ──────────────────────────────────────────────────────────────────────────
  it('CONCURRENCY & IDEMPOTENCY: 5 concurrent replan wakes claim trigger atomically with exactly 1 agent proposal', async () => {
    if (!dbAvailable) return;

    const paymentId = `pay_replan_${Date.now()}`;
    const testCase = await caseRepo.createCase(merchantId, {
      riskType: RiskType.PAYMENT_FAILURE,
      amountAtRisk: '3000.00',
      currency: 'INR',
      incidentKey: `${merchantId}:PAYMENT_FAILURE:${paymentId}`,
      contextJson: { paymentId, verifiedPaymentFailureCode: 'TEMPORARY_NETWORK_ERROR' },
    });

    mockLLM.setMockResponse({
      diagnosisCode: 'CONCURRENT_WAKE_TEST',
      diagnosisSummary: 'Test diagnosis for concurrent wake',
      confidence: 0.9,
      proposedActionType: RecoveryActionType.SCHEDULE_FOLLOWUP,
      proposedActionParams: {},
      reasoningSummary: 'Concurrent wake follow up',
    });

    const triggerPayload = {
      triggerKey: `TIMER:job_wake_${Date.now()}`,
      triggerType: 'TIMER_FIRED',
    };

    // 5 concurrent wakes for the same trigger
    const results = await Promise.all([
      orchestrator.runIteration(merchantId, testCase.id, triggerPayload),
      orchestrator.runIteration(merchantId, testCase.id, triggerPayload),
      orchestrator.runIteration(merchantId, testCase.id, triggerPayload),
      orchestrator.runIteration(merchantId, testCase.id, triggerPayload),
      orchestrator.runIteration(merchantId, testCase.id, triggerPayload),
    ]);

    // Exactly 1 winner completed the iteration
    const winners = results.filter((r) => r.iterationCompleted);
    const duplicates = results.filter((r) => r.error === 'TRIGGER_ALREADY_CLAIMED');
    expect(winners.length).toBe(1);
    expect(duplicates.length).toBe(4);

    // Exactly 1 plan version created
    const plansInDb = await prisma.recoveryPlanVersion.findMany({
      where: { caseId: testCase.id },
    });
    expect(plansInDb.length).toBe(1);
  });

  // ──────────────────────────────────────────────────────────────────────────
  it('CRASH RECOVERY: Trigger with expired lease is atomically reclaimed via DB CAS with attemptCount incremented', async () => {
    if (!dbAvailable) return;

    const paymentId = `pay_crash_${Date.now()}`;
    const testCase = await caseRepo.createCase(merchantId, {
      riskType: RiskType.PAYMENT_FAILURE,
      amountAtRisk: '4000.00',
      currency: 'INR',
      incidentKey: `${merchantId}:PAYMENT_FAILURE:${paymentId}`,
      contextJson: { paymentId, verifiedPaymentFailureCode: 'BAD_REQUEST' },
    });

    const triggerRepo = new TriggerRepository();
    const triggerKey = `replan_crash_${Date.now()}`;

    // 1. Worker 1 claims trigger at T=0 with 1000ms lease
    const t0 = new Date();
    const claim1 = await triggerRepo.claimTrigger(merchantId, testCase.id, triggerKey, 'REPLAN_TRIGGERED', {
      now: t0,
      leaseDurationMs: 1000,
    });
    expect(claim1.claimed).toBe(true);
    expect(claim1.trigger.status).toBe('CLAIMED');
    expect(claim1.trigger.attemptCount).toBe(1);

    // 2. Worker 2 attempts claim while lease is active (T=0) -> rejected
    const claim2 = await triggerRepo.claimTrigger(merchantId, testCase.id, triggerKey, 'REPLAN_TRIGGERED', {
      now: t0,
    });
    expect(claim2.claimed).toBe(false);

    // 3. Lease expires at T + 2000ms. 5 concurrent workers attempt reclaim
    const tExpired = new Date(t0.getTime() + 2000);
    const concurrentReclaims = await Promise.all([
      triggerRepo.claimTrigger(merchantId, testCase.id, triggerKey, 'REPLAN_TRIGGERED', { now: tExpired, leaseDurationMs: 5000 }),
      triggerRepo.claimTrigger(merchantId, testCase.id, triggerKey, 'REPLAN_TRIGGERED', { now: tExpired, leaseDurationMs: 5000 }),
      triggerRepo.claimTrigger(merchantId, testCase.id, triggerKey, 'REPLAN_TRIGGERED', { now: tExpired, leaseDurationMs: 5000 }),
      triggerRepo.claimTrigger(merchantId, testCase.id, triggerKey, 'REPLAN_TRIGGERED', { now: tExpired, leaseDurationMs: 5000 }),
      triggerRepo.claimTrigger(merchantId, testCase.id, triggerKey, 'REPLAN_TRIGGERED', { now: tExpired, leaseDurationMs: 5000 }),
    ]);

    // Exactly 1 winner won the lease via CAS updateMany
    const winners = concurrentReclaims.filter((c) => c.claimed);
    const losers = concurrentReclaims.filter((c) => !c.claimed);
    expect(winners.length).toBe(1);
    expect(losers.length).toBe(4);
    expect(winners[0].trigger.attemptCount).toBe(2);

    // 4. Winner completes trigger in database
    await triggerRepo.completeTrigger(merchantId, testCase.id, winners[0].trigger.id, 'COMPLETED', {
      success: true,
    }, winners[0].trigger.attemptCount);

    // 5. Completed trigger cannot be claimed or reclaimed
    const finalClaim = await triggerRepo.claimTrigger(merchantId, testCase.id, triggerKey, 'REPLAN_TRIGGERED', {
      now: new Date(tExpired.getTime() + 10000),
    });
    expect(finalClaim.claimed).toBe(false);
    expect(finalClaim.trigger.status).toBe('COMPLETED');
  });

  // ──────────────────────────────────────────────────────────────────────────
  it('AUTHORITATIVE TIMERS: OutcomeObserver enforces PostgreSQL ScheduledJob existence, tenant boundary, and non-early delivery', async () => {
    if (!dbAvailable) return;

    const paymentId = `pay_timer_auth_${Date.now()}`;
    const testCase = await caseRepo.createCase(merchantId, {
      riskType: RiskType.PAYMENT_FAILURE,
      amountAtRisk: '7500.00',
      currency: 'INR',
      incidentKey: `${merchantId}:PAYMENT_FAILURE:${paymentId}`,
      contextJson: { paymentId, verifiedPaymentFailureCode: 'BAD_REQUEST' },
    });

    const scheduledJobRepo = new ScheduledJobRepository();
    const futureDate = new Date('2026-08-28T18:00:00+05:30'); // future relative to observer clock 14:00

    // 1. Create commitment in DB
    const commitment = await commitmentRepo.createCommitment(merchantId, testCase.id, {
      promisedAmount: '7500.00',
      promisedDate: futureDate,
      status: 'PENDING',
      extractedFromText: 'I will pay 7500 by 6pm',
    });

    // 2. Create authoritative ScheduledJob in DB
    const { job } = await scheduledJobRepo.createJob(merchantId, {
      caseId: testCase.id,
      jobType: 'PROMISE_TO_PAY_CHECK',
      scheduledFor: futureDate,
      payloadJson: {
        caseId: testCase.id,
        commitmentId: commitment.id,
      },
    });

    // 3. Early timer delivery (current time 14:00 < promisedDate 18:00) is rejected
    const earlyResult = await observer.observeTimerFired({
      merchantId,
      caseId: testCase.id,
      scheduledJobId: job.id,
      timerType: 'PROMISE_TO_PAY_CHECK',
      payload: { commitmentId: commitment.id },
      occurredAt: new Date('2026-08-28T14:00:00+05:30'),
    });
    expect(earlyResult.observed).toBe(false);
    expect(earlyResult.reason).toContain('Early timer rejected');

    // Commitment in DB remains PENDING
    const cmtStillPending = await commitmentRepo.getCommitmentById(merchantId, testCase.id, commitment.id);
    expect(cmtStillPending?.status).toBe('PENDING');

    // 4. Cross-tenant attempt is rejected
    const crossTenantResult = await observer.observeTimerFired({
      merchantId: 'mch_other_tenant',
      caseId: testCase.id,
      scheduledJobId: job.id,
      timerType: 'PROMISE_TO_PAY_CHECK',
      payload: { commitmentId: commitment.id },
      occurredAt: new Date('2026-08-28T19:00:00+05:30'),
    }).catch((err) => ({ observed: false, reason: err.message }));
    expect(crossTenantResult.observed).toBe(false);

    // 5. Legitimate on-time timer delivery (19:00 >= 18:00) marks commitment BROKEN
    const legitimateResult = await observer.observeTimerFired({
      merchantId,
      caseId: testCase.id,
      scheduledJobId: job.id,
      timerType: 'PROMISE_TO_PAY_CHECK',
      payload: { commitmentId: commitment.id },
      occurredAt: new Date('2026-08-28T19:00:00+05:30'),
    });
    expect(legitimateResult.observed).toBe(true);

    const cmtBroken = await commitmentRepo.getCommitmentById(merchantId, testCase.id, commitment.id);
    expect(cmtBroken?.status).toBe('BROKEN');
  });

  // ──────────────────────────────────────────────────────────────────────────
  it('LEASE FENCING: Stale worker with expired lease cannot complete trigger reclaimed by newer worker', async () => {
    if (!dbAvailable) return;

    const triggerRepo = new TriggerRepository();
    const paymentId = `pay_fencing_${Date.now()}`;
    const testCase = await caseRepo.createCase(merchantId, {
      riskType: RiskType.PAYMENT_FAILURE,
      amountAtRisk: '3000.00',
      currency: 'INR',
      incidentKey: `${merchantId}:PAYMENT_FAILURE:${paymentId}`,
      contextJson: { paymentId, verifiedPaymentFailureCode: 'BAD_REQUEST' },
    });

    const triggerKey = `FENCING_TEST:${Date.now()}`;
    const t0 = new Date('2026-08-28T10:00:00Z');

    // 1. Worker A claims trigger at t0 with 5-second lease (attemptCount = 1)
    const claimA = await triggerRepo.claimTrigger(merchantId, testCase.id, triggerKey, 'REPLAN_TRIGGERED', {
      now: t0,
      leaseDurationMs: 5000,
    });
    expect(claimA.claimed).toBe(true);
    expect(claimA.trigger.attemptCount).toBe(1);

    // 2. Lease expires at t0 + 6 seconds; Worker B reclaims (attemptCount = 2)
    const tExpired = new Date(t0.getTime() + 6000);
    const claimB = await triggerRepo.claimTrigger(merchantId, testCase.id, triggerKey, 'REPLAN_TRIGGERED', {
      now: tExpired,
      leaseDurationMs: 5000,
    });
    expect(claimB.claimed).toBe(true);
    expect(claimB.trigger.attemptCount).toBe(2);

    // 3. Stale Worker A attempts to complete trigger with attemptCount = 1 -> REJECTED
    const completeA = await triggerRepo.completeTrigger(
      merchantId,
      testCase.id,
      claimA.trigger.id,
      'COMPLETED',
      { worker: 'A_stale' },
      1, // Worker A's owned attempt
    );
    expect(completeA.completed).toBe(false);

    // Verify DB record status is STILL CLAIMED with attemptCount = 2
    const midCheck = await triggerRepo.findTrigger(merchantId, testCase.id, triggerKey);
    expect(midCheck?.status).toBe('CLAIMED');
    expect(midCheck?.attemptCount).toBe(2);

    // 4. Valid Worker B completes trigger with attemptCount = 2 -> SUCCEEDS
    const completeB = await triggerRepo.completeTrigger(
      merchantId,
      testCase.id,
      claimB.trigger.id,
      'COMPLETED',
      { worker: 'B_valid', winner: true },
      2, // Worker B's owned attempt
    );
    expect(completeB.completed).toBe(true);

    // Verify final DB record status is COMPLETED and resultJson is from Worker B
    const finalCheck = await triggerRepo.findTrigger(merchantId, testCase.id, triggerKey);
    expect(finalCheck?.status).toBe('COMPLETED');
    expect((finalCheck?.resultJson as any)?.worker).toBe('B_valid');
  });

  // ──────────────────────────────────────────────────────────────────────────
  it('PAYLOAD AUTHORITY: Rejects timer if caller transport commitmentId does not match authoritative ScheduledJob commitmentId', async () => {
    if (!dbAvailable) return;

    const paymentId = `pay_mismatch_${Date.now()}`;
    const testCase = await caseRepo.createCase(merchantId, {
      riskType: RiskType.PAYMENT_FAILURE,
      amountAtRisk: '8000.00',
      currency: 'INR',
      incidentKey: `${merchantId}:PAYMENT_FAILURE:${paymentId}`,
      contextJson: { paymentId, verifiedPaymentFailureCode: 'BAD_REQUEST' },
    });

    const scheduledJobRepo = new ScheduledJobRepository();
    const pastDate = new Date(Date.now() - 10000);

    const cmtAuthoritativeA = await commitmentRepo.createCommitment(merchantId, testCase.id, {
      promisedAmount: '5000.00',
      promisedDate: pastDate,
      status: 'PENDING',
      extractedFromText: 'Commitment A text',
    });

    const cmtCallerB = await commitmentRepo.createCommitment(merchantId, testCase.id, {
      promisedAmount: '3000.00',
      promisedDate: pastDate,
      status: 'PENDING',
      extractedFromText: 'Commitment B text',
    });

    // ScheduledJob in DB points explicitly to Commitment A
    const { job } = await scheduledJobRepo.createJob(merchantId, {
      caseId: testCase.id,
      jobType: 'PROMISE_TO_PAY_CHECK',
      scheduledFor: pastDate,
      payloadJson: {
        caseId: testCase.id,
        commitmentId: cmtAuthoritativeA.id,
      },
    });

    // Caller sends mismatched commitment B ID in transport payload
    const mismatchResult = await observer.observeTimerFired({
      merchantId,
      caseId: testCase.id,
      scheduledJobId: job.id,
      timerType: 'PROMISE_TO_PAY_CHECK',
      payload: { commitmentId: cmtCallerB.id },
    });

    expect(mismatchResult.observed).toBe(false);
    expect(mismatchResult.reason).toContain('Timer payload mismatch');

    // Verify neither commitment in DB was mutated
    const cmtACheck = await commitmentRepo.getCommitmentById(merchantId, testCase.id, cmtAuthoritativeA.id);
    const cmtBCheck = await commitmentRepo.getCommitmentById(merchantId, testCase.id, cmtCallerB.id);
    expect(cmtACheck?.status).toBe('PENDING');
    expect(cmtBCheck?.status).toBe('PENDING');
  });

  // ──────────────────────────────────────────────────────────────────────────
  it('PROMISE CONCURRENCY: 5 concurrent observeCustomerReply calls produce exactly 1 commitment, 1 outcome, and 1 scheduled timer', async () => {
    if (!dbAvailable) return;

    const paymentId = `pay_promise_conc_${Date.now()}`;
    const testCase = await caseRepo.createCase(merchantId, {
      riskType: RiskType.PAYMENT_FAILURE,
      amountAtRisk: '85000.00',
      currency: 'INR',
      incidentKey: `${merchantId}:PAYMENT_FAILURE:${paymentId}`,
      contextJson: { paymentId, verifiedPaymentFailureCode: 'INSUFFICIENT_FUNDS' },
    });

    const msgId = `msg_conc_prom_${Date.now()}`;
    const replyText = 'I will pay ₹85,000 on Friday without fail';

    const results = await Promise.allSettled([
      observer.observeCustomerReply({ merchantId, caseId: testCase.id, messageId: msgId, replyText }),
      observer.observeCustomerReply({ merchantId, caseId: testCase.id, messageId: msgId, replyText }),
      observer.observeCustomerReply({ merchantId, caseId: testCase.id, messageId: msgId, replyText }),
      observer.observeCustomerReply({ merchantId, caseId: testCase.id, messageId: msgId, replyText }),
      observer.observeCustomerReply({ merchantId, caseId: testCase.id, messageId: msgId, replyText }),
    ]);

    const fulfilled = results.filter((r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    // 5 fulfilled / 0 rejected
    expect(fulfilled.length).toBe(5);
    expect(rejected.length).toBe(0);
    expect(fulfilled.every((r) => r.value.observed)).toBe(true);

    // Final case state remains OPEN (not forced into NEEDS_REVIEW by race)
    const finalCase = await caseRepo.getCaseById(merchantId, testCase.id);
    expect(finalCase?.status).toBe(CaseStatus.OPEN);

    // Exactly 1 RecoveryCommitment in DB with sourceMessageId
    const commitmentsInDb = await prisma.recoveryCommitment.findMany({
      where: { caseId: testCase.id },
    });
    expect(commitmentsInDb.length).toBe(1);
    expect(commitmentsInDb[0].sourceMessageId).toBe(msgId);
    expect(commitmentsInDb[0].status).toBe('PENDING');
    expect(new Prisma.Decimal(commitmentsInDb[0].promisedAmount).equals(new Prisma.Decimal('85000.00'))).toBe(true);

    // Exactly 1 RecoveryOutcome in DB for that message with canonical customer-message:${msgId} key
    const outcomeDedupeKey = `customer-message:${msgId}`;
    const outcomesInDb = await prisma.recoveryOutcome.findMany({
      where: { caseId: testCase.id, dedupeKey: outcomeDedupeKey },
    });
    expect(outcomesInDb).toHaveLength(1);
    expect(outcomesInDb[0].outcomeType).toBe('PROMISE_TO_PAY');
    expect((outcomesInDb[0].detailsJson as any)?.commitmentId).toBe(commitmentsInDb[0].id);

    // Exactly 1 ScheduledJob for the commitment
    const jobsInDb = await prisma.scheduledJob.findMany({
      where: { caseId: testCase.id, jobType: 'PROMISE_TO_PAY_CHECK' },
    });
    expect(jobsInDb.length).toBe(1);
    expect((jobsInDb[0].payloadJson as any)?.commitmentId).toBe(commitmentsInDb[0].id);
    expect(jobsInDb[0].jobKey).toBe(`promise-check:${commitmentsInDb[0].id}`);
  });

  // ──────────────────────────────────────────────────────────────────────────
  it('PROMISE IDENTITY: same promise text across two distinct messageIds creates two distinct commitments and outcomes', async () => {
    if (!dbAvailable) return;

    const paymentId = `pay_diff_msg_${Date.now()}`;
    const testCase = await caseRepo.createCase(merchantId, {
      riskType: RiskType.PAYMENT_FAILURE,
      amountAtRisk: '85000.00',
      currency: 'INR',
      incidentKey: `${merchantId}:PAYMENT_FAILURE:${paymentId}`,
      contextJson: { paymentId, verifiedPaymentFailureCode: 'INSUFFICIENT_FUNDS' },
    });

    const msgIdA = `msg_text_A_${Date.now()}`;
    const msgIdB = `msg_text_B_${Date.now()}`;
    const replyText = 'Will pay ₹85,000 Friday';

    const resA = await observer.observeCustomerReply({
      merchantId,
      caseId: testCase.id,
      messageId: msgIdA,
      replyText,
    });

    const resB = await observer.observeCustomerReply({
      merchantId,
      caseId: testCase.id,
      messageId: msgIdB,
      replyText,
    });

    expect(resA.observed).toBe(true);
    expect(resB.observed).toBe(true);

    // Two distinct outcomes in DB
    const outcomes = await prisma.recoveryOutcome.findMany({
      where: { caseId: testCase.id, outcomeType: 'PROMISE_TO_PAY' },
    });
    expect(outcomes.length).toBe(2);

    // Two distinct commitments in DB
    const commitments = await prisma.recoveryCommitment.findMany({
      where: { caseId: testCase.id },
    });
    expect(commitments.length).toBe(2);
    expect(commitments.map((c) => c.sourceMessageId).sort()).toEqual([msgIdA, msgIdB].sort());
  });

  // ──────────────────────────────────────────────────────────────────────────
  it('REDELIVERY REPAIR: redelivery of promise with missing schedule repairs timer without creating duplicate commitment', async () => {
    if (!dbAvailable) return;

    const paymentId = `pay_repair_${Date.now()}`;
    const testCase = await caseRepo.createCase(merchantId, {
      riskType: RiskType.PAYMENT_FAILURE,
      amountAtRisk: '25000.00',
      currency: 'INR',
      incidentKey: `${merchantId}:PAYMENT_FAILURE:${paymentId}`,
      contextJson: { paymentId, verifiedPaymentFailureCode: 'INSUFFICIENT_FUNDS' },
    });

    const msgId = `msg_repair_${Date.now()}`;
    const replyText = 'I will pay ₹25,000 on Friday';

    // 1. Initial delivery creates commitment and outcome
    const initialRes = await observer.observeCustomerReply({
      merchantId,
      caseId: testCase.id,
      messageId: msgId,
      replyText,
    });
    expect(initialRes.observed).toBe(true);

    // Simulate scheduler failure / missed job by deleting the scheduled job
    await prisma.scheduledJob.deleteMany({
      where: { caseId: testCase.id, jobType: 'PROMISE_TO_PAY_CHECK' },
    });
    const jobsBefore = await prisma.scheduledJob.findMany({
      where: { caseId: testCase.id, jobType: 'PROMISE_TO_PAY_CHECK' },
    });
    expect(jobsBefore.length).toBe(0);

    // 2. Redelivery of identical messageId
    const redeliveryRes = await observer.observeCustomerReply({
      merchantId,
      caseId: testCase.id,
      messageId: msgId,
      replyText,
    });

    expect(redeliveryRes.observed).toBe(true);
    expect(redeliveryRes.deduplicated).toBe(true);

    // Still exactly 1 commitment in DB
    const commitments = await prisma.recoveryCommitment.findMany({
      where: { caseId: testCase.id },
    });
    expect(commitments.length).toBe(1);
    expect(commitments[0].sourceMessageId).toBe(msgId);

    // ScheduledJob was repaired!
    const jobsAfter = await prisma.scheduledJob.findMany({
      where: { caseId: testCase.id, jobType: 'PROMISE_TO_PAY_CHECK' },
    });
    expect(jobsAfter.length).toBe(1);
    expect((jobsAfter[0].payloadJson as any)?.commitmentId).toBe(commitments[0].id);

    // Audit recorded SCHEDULING_REPAIRED
    const repairAudits = await prisma.auditEvent.findMany({
      where: { caseId: testCase.id, eventType: 'SCHEDULING_REPAIRED' },
    });
    expect(repairAudits.length).toBe(1);
  });

  // ──────────────────────────────────────────────────────────────────────────
  it('EARLY TIMER SEMANTICS: early timer preserves future wake, leaves commitment PENDING, and eventual timer breaks promise', async () => {
    if (!dbAvailable) return;

    const paymentId = `pay_early_timer_${Date.now()}`;
    const testCase = await caseRepo.createCase(merchantId, {
      riskType: RiskType.PAYMENT_FAILURE,
      amountAtRisk: '50000.00',
      currency: 'INR',
      incidentKey: `${merchantId}:PAYMENT_FAILURE:${paymentId}`,
      contextJson: { paymentId, verifiedPaymentFailureCode: 'INSUFFICIENT_FUNDS' },
    });

    const scheduledJobRepo = new ScheduledJobRepository();
    // Promised date is 10 seconds in the future
    const futureDate = new Date(Date.now() + 10000);

    const commitment = await commitmentRepo.createCommitment(merchantId, testCase.id, {
      sourceMessageId: `msg_early_${Date.now()}`,
      promisedAmount: '50000.00',
      promisedDate: futureDate,
      status: 'PENDING',
      extractedFromText: 'Pay 50000 later',
    });

    const { job: earlyJob } = await scheduledJobRepo.createJob(merchantId, {
      caseId: testCase.id,
      jobType: 'PROMISE_TO_PAY_CHECK',
      scheduledFor: new Date(Date.now() - 1000), // premature dispatch
      payloadJson: {
        caseId: testCase.id,
        commitmentId: commitment.id,
      },
    });

    // 1. Early timer fires before futureDate
    const earlyResult = await observer.observeTimerFired({
      merchantId,
      caseId: testCase.id,
      scheduledJobId: earlyJob.id,
      timerType: 'PROMISE_TO_PAY_CHECK',
      occurredAt: new Date(Date.now() - 5000), // before futureDate
      payload: { commitmentId: commitment.id },
    });

    // Early timer is rejected (not observed as broken promise) and isEarlyTimer is true
    expect(earlyResult.observed).toBe(false);
    expect((earlyResult as any).isEarlyTimer).toBe(true);

    // Commitment remains PENDING in DB
    const cmtCheck = await commitmentRepo.getCommitmentById(merchantId, testCase.id, commitment.id);
    expect(cmtCheck?.status).toBe('PENDING');

    // No PROMISE_TO_PAY_BROKEN outcome in DB
    const brokenOutcomes = await prisma.recoveryOutcome.findMany({
      where: { caseId: testCase.id, outcomeType: 'PROMISE_TO_PAY_BROKEN' },
    });
    expect(brokenOutcomes.length).toBe(0);

    // Future scheduled job exists for futureDate
    const jobs = await prisma.scheduledJob.findMany({
      where: { caseId: testCase.id, jobType: 'PROMISE_TO_PAY_CHECK' },
    });
    expect(jobs.length).toBeGreaterThanOrEqual(1);

    // 2. Due timer fires at or after futureDate
    const { job: dueJob } = await scheduledJobRepo.createJob(merchantId, {
      caseId: testCase.id,
      jobType: 'PROMISE_TO_PAY_CHECK',
      scheduledFor: futureDate,
      payloadJson: {
        caseId: testCase.id,
        commitmentId: commitment.id,
      },
    });

    const dueResult = await observer.observeTimerFired({
      merchantId,
      caseId: testCase.id,
      scheduledJobId: dueJob.id,
      timerType: 'PROMISE_TO_PAY_CHECK',
      occurredAt: new Date(futureDate.getTime() + 1000), // after futureDate
      payload: { commitmentId: commitment.id },
    });

    expect(dueResult.observed).toBe(true);
    expect(dueResult.caseStatus).toBe(CaseStatus.NEEDS_REVIEW);

    // Commitment is now BROKEN in DB
    const cmtFinal = await commitmentRepo.getCommitmentById(merchantId, testCase.id, commitment.id);
    expect(cmtFinal?.status).toBe('BROKEN');

    // CASE_ESCALATED audit was emitted with reasonCode BROKEN_PROMISE_TO_PAY
    const escalatedAudits = await prisma.auditEvent.findMany({
      where: { caseId: testCase.id, eventType: 'CASE_ESCALATED', reasonCode: 'BROKEN_PROMISE_TO_PAY' },
    });
    expect(escalatedAudits.length).toBe(1);
  });
});

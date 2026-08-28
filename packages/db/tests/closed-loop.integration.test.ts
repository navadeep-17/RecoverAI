import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  prisma,
  ActionRepository,
  CaseRepository,
  MerchantRepository,
  CustomerRepository,
  AuditRepository,
  PolicyConfigRepository,
  CommitmentRepository,
  OutcomeRepository,
  EventRepository,
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
  MockLLMProvider,
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
  let outcomeRepo: OutcomeRepository;
  let eventRepo: EventRepository;
  let policyEngine: PolicyEngine;
  let mockLLM: MockLLMProvider;
  let recoveryAgent: RecoveryAgent;
  let simulatedProvider: SimulatedRecoveryProvider;
  let providerRegistry: ProviderRegistry;
  let actionExecutor: ActionExecutor;
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
      outcomeRepo = new OutcomeRepository();
      eventRepo = new EventRepository();

      policyEngine = new PolicyEngine();
      mockLLM = new MockLLMProvider();
      recoveryAgent = new RecoveryAgent(mockLLM);
      simulatedProvider = new SimulatedRecoveryProvider();
      providerRegistry = new ProviderRegistry([simulatedProvider]);

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
        clock: () => new Date('2026-08-28T14:00:00+05:30'),
      });

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
        orchestrator,
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

    // 1. Setup Customer & Subscription Failure Case
    const customer = await customerRepo.getOrCreateCustomer(merchantId, {
      name: 'Flow A Customer',
      email: `flow_a_${Date.now()}@example.com`,
      contactConsent: true,
    });

    const paymentId = `pay_sub_${Date.now()}`;
    const testCase = await caseRepo.createCase(merchantId, {
      customerId: customer.id,
      riskType: RiskType.SUBSCRIPTION_FAILURE,
      amountAtRisk: '14999.00',
      currency: 'INR',
      incidentKey: `${merchantId}:SUBSCRIPTION_FAILURE:${paymentId}`,
      contextJson: { verifiedPaymentFailureCode: 'CARD_EXPIRED' },
    });

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

    const iter1 = await orchestrator.runIteration(merchantId, testCase.id, 'CASE_OPENED');

    expect(iter1.iterationCompleted).toBe(true);
    expect(iter1.status).toBe(CaseStatus.WAITING);
    expect(iter1.planVersion?.version).toBe(1);

    // Verify case in database is now WAITING
    const dbCaseWaiting = await caseRepo.getCaseById(merchantId, testCase.id);
    expect(dbCaseWaiting?.status).toBe(CaseStatus.WAITING);

    // 3. Customer updates payment method -> Event PAYMENT_METHOD_UPDATED arrives
    const methodUpdatedEvent: any = {
      eventId: `evt_method_${Date.now()}`,
      merchantId,
      source: MerchantEventSource.MERCHANT,
      eventType: NormalizedEventType.PAYMENT_METHOD_UPDATED,
      occurredAt: new Date(),
      payment: {
        paymentId,
      },
    };

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

    const observationResult = await observer.observeMerchantEvent(methodUpdatedEvent);

    expect(observationResult.observed).toBe(true);
    expect(observationResult.replanTriggered).toBe(true);

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
      eventType: NormalizedEventType.PAYMENT_SUCCEEDED,
      occurredAt: new Date(),
      amount: '14999.00',
      currency: 'INR',
      payment: {
        paymentId,
      },
    };

    const successObsResult = await observer.observeMerchantEvent(successEvent);

    expect(successObsResult.observed).toBe(true);
    expect(successObsResult.caseResolved).toBe(true);
    expect(successObsResult.caseStatus).toBe(CaseStatus.RECOVERED);

    // Verify case in DB is RECOVERED with exact ₹14,999.00
    const finalDbCase = await caseRepo.getCaseById(merchantId, testCase.id);
    expect(finalDbCase?.status).toBe(CaseStatus.RECOVERED);
    expect(finalDbCase?.recoveredAmount?.toString()).toBe('14999.00');

    // Verify authoritative RecoveryOutcome was recorded
    const outcomes = await outcomeRepo.listOutcomesByCase(merchantId, testCase.id);
    expect(outcomes.some((o) => o.outcomeType === NormalizedEventType.PAYMENT_SUCCEEDED)).toBe(true);
  });

  // ──────────────────────────────────────────────────────────────────────────
  it('FLOW B: ₹8,499 Checkout Abandonment -> SEND_CHECKOUT_RECOVERY -> CHECKOUT_COMPLETED -> RECOVERED', async () => {
    if (!dbAvailable) return;

    const checkoutSessionId = `cs_${Date.now()}`;
    const testCase = await caseRepo.createCase(merchantId, {
      riskType: RiskType.CHECKOUT_ABANDONMENT,
      amountAtRisk: '8499.00',
      currency: 'INR',
      incidentKey: `${merchantId}:CHECKOUT_ABANDONMENT:${checkoutSessionId}`,
      contextJson: { checkoutSessionId },
    });

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

    // 2. Authoritative CHECKOUT_COMPLETED event arrives for ₹8,499 INR
    const checkoutCompletedEvent: any = {
      eventId: `evt_chk_${Date.now()}`,
      merchantId,
      source: MerchantEventSource.MERCHANT,
      eventType: NormalizedEventType.CHECKOUT_COMPLETED,
      occurredAt: new Date(),
      amount: '8499.00',
      currency: 'INR',
      checkout: {
        checkoutSessionId,
      },
    };

    const obsResult = await observer.observeMerchantEvent(checkoutCompletedEvent);

    expect(obsResult.observed).toBe(true);
    expect(obsResult.caseResolved).toBe(true);
    expect(obsResult.caseStatus).toBe(CaseStatus.RECOVERED);

    // Verify case in database is RECOVERED with exact ₹8,499.00
    const finalDbCase = await caseRepo.getCaseById(merchantId, testCase.id);
    expect(finalDbCase?.status).toBe(CaseStatus.RECOVERED);
    expect(finalDbCase?.recoveredAmount?.toString()).toBe('8499.00');
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
    const testCase = await caseRepo.createCase(merchantId, {
      riskType: RiskType.OVERDUE_RECEIVABLE,
      amountAtRisk: '85000.00',
      currency: 'INR',
      incidentKey: `${merchantId}:OVERDUE_RECEIVABLE:${invoiceId}`,
      contextJson: { invoiceId },
    });

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

    // 2. Customer replies: "Will pay ₹85,000 this Friday"
    const replyResult = await observer.observeCustomerReply(
      merchantId,
      testCase.id,
      'We will pay ₹85,000 this Friday by NEFT',
    );

    expect(replyResult.observed).toBe(true);

    // Verify authoritative RecoveryCommitment was persisted in DB
    const commitments = await commitmentRepo.getActiveCommitmentsForCase(merchantId, testCase.id);
    expect(commitments.length).toBe(1);
    expect(commitments[0].status).toBe('PENDING');
    expect(commitments[0].promisedAmount.toString()).toBe('85000.00');

    // 3. Friday timer fires and case is still unpaid -> commitment marked BROKEN -> wakes orchestrator
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

    const timerResult = await observer.observeTimerFired(
      merchantId,
      testCase.id,
      'PROMISE_TO_PAY_CHECK',
      { commitmentId: commitments[0].id },
    );

    expect(timerResult.observed).toBe(true);

    // Verify commitment was updated to BROKEN in DB
    const updatedCommitment = await commitmentRepo.getCommitmentById(merchantId, testCase.id, commitments[0].id);
    expect(updatedCommitment?.status).toBe('BROKEN');

    // 4. PolicyEngine evaluated BrokenPromiseToPayRule -> Decision REVIEW -> Case transitioned to NEEDS_REVIEW!
    const finalDbCase = await caseRepo.getCaseById(merchantId, testCase.id);
    expect(finalDbCase?.status).toBe(CaseStatus.NEEDS_REVIEW);

    // Verify CASE_ESCALATED audit exists
    const escalationAudits = await prisma.auditEvent.findMany({
      where: { caseId: testCase.id, eventType: 'CASE_ESCALATED' },
    });
    expect(escalationAudits.length).toBeGreaterThan(0);
    expect(escalationAudits[0].reasonCode).toBe('BROKEN_PROMISE_TO_PAY');
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
      contextJson: { verifiedPaymentFailureCode: 'BAD_REQUEST' },
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

    // Concurrently observe the exact same payment event across 5 workers
    const results = await Promise.all([
      observer.observeMerchantEvent(paymentEvent, 'shared_event_db_id'),
      observer.observeMerchantEvent(paymentEvent, 'shared_event_db_id'),
      observer.observeMerchantEvent(paymentEvent, 'shared_event_db_id'),
      observer.observeMerchantEvent(paymentEvent, 'shared_event_db_id'),
      observer.observeMerchantEvent(paymentEvent, 'shared_event_db_id'),
    ]);

    // Case is RECOVERED
    const finalCase = await caseRepo.getCaseById(merchantId, testCase.id);
    expect(finalCase?.status).toBe(CaseStatus.RECOVERED);
    expect(finalCase?.recoveredAmount?.toString()).toBe('5000.00');

    // Exactly ONE outcome was recorded in database (no duplicate credit)
    const outcomesInDb = await outcomeRepo.listOutcomesByCase(merchantId, testCase.id);
    expect(outcomesInDb.length).toBe(1);
  });
});

import {
  AuditActorType,
  CaseStatus,
  RecoveryOutcome,
  RevenueRiskCase,
} from '@prisma/client';
import {
  ActionRepository,
  AuditRepository,
  CaseRepository,
  CommitmentRepository,
  CustomerRepository,
  EventRepository,
  OutcomeRepository,
} from '@recoverai/db';
import {
  CurrencyMismatchError,
  Money,
  NormalizedEventType,
  NormalizedMerchantEvent,
  RiskType,
} from '@recoverai/shared';
import { generateIncidentKey } from '../detection/incident-identity.js';
import { IJobScheduler } from '../detection/job-scheduler-interface.js';
import { CustomerReplyClassifier, CustomerReplyIntent } from './customer-reply-classifier.js';
import { RecoveryOrchestrator } from './recovery-orchestrator.js';

export interface ObservationResult {
  observed: boolean;
  outcome?: RecoveryOutcome | null;
  caseId?: string;
  caseResolved?: boolean;
  caseStatus?: CaseStatus;
  replanTriggered?: boolean;
  deduplicated?: boolean;
  reason?: string;
}

export interface OutcomeObserverOptions {
  caseRepo: CaseRepository;
  actionRepo: ActionRepository;
  outcomeRepo: OutcomeRepository;
  customerRepo: CustomerRepository;
  commitmentRepo: CommitmentRepository;
  eventRepo: EventRepository;
  auditRepo: AuditRepository;
  jobScheduler?: IJobScheduler;
  orchestrator?: RecoveryOrchestrator;
  clock?: () => Date;
}

export class OutcomeObserver {
  private caseRepo: CaseRepository;
  private actionRepo: ActionRepository;
  private outcomeRepo: OutcomeRepository;
  private customerRepo: CustomerRepository;
  private commitmentRepo: CommitmentRepository;
  private eventRepo: EventRepository;
  private auditRepo: AuditRepository;
  private jobScheduler?: IJobScheduler;
  private orchestrator?: RecoveryOrchestrator;
  private classifier: CustomerReplyClassifier;
  private clock?: () => Date;

  constructor(options: OutcomeObserverOptions) {
    this.caseRepo = options.caseRepo;
    this.actionRepo = options.actionRepo;
    this.outcomeRepo = options.outcomeRepo;
    this.customerRepo = options.customerRepo;
    this.commitmentRepo = options.commitmentRepo;
    this.eventRepo = options.eventRepo;
    this.auditRepo = options.auditRepo;
    this.jobScheduler = options.jobScheduler;
    this.orchestrator = options.orchestrator;
    this.classifier = new CustomerReplyClassifier();
    this.clock = options.clock;
  }

  public setOrchestrator(orchestrator: RecoveryOrchestrator): void {
    this.orchestrator = orchestrator;
  }

  private now(): Date {
    return this.clock ? this.clock() : new Date();
  }

  /**
   * Observes an authoritative normalized merchant event, correlates it to an active case,
   * enforces monetary truth, persists RecoveryOutcome, and triggers closed-loop transitions.
   */
  async observeMerchantEvent(
    event: NormalizedMerchantEvent,
    merchantEventId?: string,
  ): Promise<ObservationResult> {
    const merchantId = event.merchantId;

    // 1. Correlate event to merchant + case
    const matchedCase = await this.correlateEventToCase(merchantId, event);
    if (!matchedCase) {
      return {
        observed: false,
        reason: 'Event does not correlate to any known case for this merchant',
      };
    }

    const caseId = matchedCase.id;

    // 2. Dedupe repeated observations
    if (merchantEventId) {
      const existingOutcome = await this.outcomeRepo.findOutcomeByEvent(merchantId, caseId, merchantEventId);
      if (existingOutcome) {
        return {
          observed: true,
          deduplicated: true,
          outcome: existingOutcome,
          caseId,
          caseStatus: matchedCase.status,
          reason: 'Duplicate merchant event observation; outcome already recorded',
        };
      }
    }

    // 3. Handle Monetary Confirmation Events (PAYMENT_SUCCEEDED, CHECKOUT_COMPLETED, INVOICE_PAID)
    if (this.isMonetaryRecoveryEvent(event.eventType)) {
      return this.handleMonetaryRecovery(merchantId, matchedCase, event, merchantEventId);
    }

    // 4. Handle PAYMENT_METHOD_UPDATED
    if (event.eventType === NormalizedEventType.PAYMENT_METHOD_UPDATED || (event as any).eventType === 'PAYMENT_METHOD_UPDATED') {
      const outcome = await this.outcomeRepo.recordOutcome(merchantId, caseId, {
        merchantEventId,
        outcomeType: 'PAYMENT_METHOD_UPDATED',
        detailsJson: {
          eventPayload: event.metadata || {},
        },
        observedAt: event.occurredAt || this.now(),
      });

      await this.auditRepo.record(merchantId, {
        caseId,
        eventType: 'OUTCOME_OBSERVED',
        actorType: AuditActorType.SYSTEM,
        inputSummaryJson: { outcomeType: 'PAYMENT_METHOD_UPDATED', merchantEventId },
        reasonCode: 'PAYMENT_METHOD_UPDATED_OBSERVED',
      });

      // Wake orchestrator to replan next action (e.g. RETRY_PAYMENT)
      let replanTriggered = false;
      if (this.orchestrator && (matchedCase.status === CaseStatus.OPEN || matchedCase.status === CaseStatus.WAITING)) {
        await this.orchestrator.runIteration(merchantId, caseId, 'OBSERVATION_ARRIVED');
        replanTriggered = true;
      }

      return {
        observed: true,
        outcome,
        caseId,
        caseStatus: matchedCase.status,
        replanTriggered,
      };
    }

    return {
      observed: true,
      caseId,
      caseStatus: matchedCase.status,
      reason: `Event type "${event.eventType}" observed without state transition`,
    };
  }

  /**
   * Observes inbound customer communication, classifies intent, updates structured records,
   * persists RecoveryOutcome, and signals orchestration.
   */
  async observeCustomerReply(
    merchantId: string,
    caseId: string,
    replyText: string,
    options?: { actionId?: string },
  ): Promise<ObservationResult> {
    const matchedCase = await this.caseRepo.getCaseById(merchantId, caseId);
    if (!matchedCase) {
      throw new Error(`Case "${caseId}" not found for merchant "${merchantId}"`);
    }

    const classification = this.classifier.classify(replyText, this.now());

    // 1. OPT_OUT
    if (classification.intent === CustomerReplyIntent.OPT_OUT) {
      if (matchedCase.customerId) {
        await this.customerRepo.setOptOut(merchantId, matchedCase.customerId, true);
      }

      const outcome = await this.outcomeRepo.recordOutcome(merchantId, caseId, {
        actionId: options?.actionId,
        outcomeType: 'CUSTOMER_OPT_OUT',
        detailsJson: { rawText: replyText, classification },
        observedAt: this.now(),
      });

      if (matchedCase.status === CaseStatus.OPEN || matchedCase.status === CaseStatus.WAITING) {
        await this.caseRepo.compareAndSetStatus(merchantId, caseId, matchedCase.status, CaseStatus.STOPPED);
      }

      await this.auditRepo.record(merchantId, {
        caseId,
        eventType: 'CUSTOMER_OPTED_OUT',
        actorType: AuditActorType.HUMAN,
        inputSummaryJson: { replyText, outcomeId: outcome.id },
        reasonCode: 'CUSTOMER_EXPLICIT_OPT_OUT',
      });

      return {
        observed: true,
        outcome,
        caseId,
        caseStatus: CaseStatus.STOPPED,
      };
    }

    // 2. PROMISE_TO_PAY
    if (classification.intent === CustomerReplyIntent.PROMISE_TO_PAY) {
      const promisedAmount = classification.extractedPromisedAmount || matchedCase.amountAtRisk.toString();
      const promisedDate = classification.extractedPromisedDate || new Date(this.now().getTime() + 3 * 24 * 60 * 60 * 1000);

      const commitment = await this.commitmentRepo.createCommitment(merchantId, caseId, {
        promisedAmount,
        promisedDate,
        extractedFromText: replyText,
        status: 'PENDING',
      });

      const outcome = await this.outcomeRepo.recordOutcome(merchantId, caseId, {
        actionId: options?.actionId,
        outcomeType: 'PROMISE_TO_PAY',
        detailsJson: {
          commitmentId: commitment.id,
          promisedAmount,
          promisedDate: promisedDate.toISOString(),
          rawText: replyText,
        },
        observedAt: this.now(),
      });

      // Schedule durable timer to check if promised date passes unpaid
      if (this.jobScheduler) {
        await this.jobScheduler.schedule({
          merchantId,
          caseId,
          jobType: 'PROMISE_TO_PAY_CHECK',
          scheduledFor: promisedDate,
          payloadJson: {
            caseId,
            commitmentId: commitment.id,
            promisedAmount,
            promisedDate: promisedDate.toISOString(),
          },
        });
      }

      await this.auditRepo.record(merchantId, {
        caseId,
        eventType: 'PROMISE_TO_PAY_RECORDED',
        actorType: AuditActorType.SYSTEM,
        inputSummaryJson: {
          commitmentId: commitment.id,
          promisedAmount,
          promisedDate,
        },
        reasonCode: 'CUSTOMER_PROMISED_PAYMENT',
      });

      return {
        observed: true,
        outcome,
        caseId,
        caseStatus: matchedCase.status,
      };
    }

    // 3. PAYMENT_METHOD_WILL_UPDATE
    if (classification.intent === CustomerReplyIntent.PAYMENT_METHOD_WILL_UPDATE) {
      const outcome = await this.outcomeRepo.recordOutcome(merchantId, caseId, {
        actionId: options?.actionId,
        outcomeType: 'CUSTOMER_RESPONSE',
        detailsJson: {
          intent: classification.intent,
          rawText: replyText,
        },
        observedAt: this.now(),
      });

      return {
        observed: true,
        outcome,
        caseId,
        caseStatus: matchedCase.status,
      };
    }

    // 4. REFUSES_PAYMENT
    if (classification.intent === CustomerReplyIntent.REFUSES_PAYMENT) {
      const outcome = await this.outcomeRepo.recordOutcome(merchantId, caseId, {
        actionId: options?.actionId,
        outcomeType: 'CUSTOMER_REFUSES_PAYMENT',
        detailsJson: { rawText: replyText },
        observedAt: this.now(),
      });

      // Escalate to human review
      if (matchedCase.status === CaseStatus.OPEN || matchedCase.status === CaseStatus.WAITING) {
        await this.caseRepo.compareAndSetStatus(merchantId, caseId, matchedCase.status, CaseStatus.NEEDS_REVIEW);
      }

      return {
        observed: true,
        outcome,
        caseId,
        caseStatus: CaseStatus.NEEDS_REVIEW,
      };
    }

    // Default: Generic customer reply
    const outcome = await this.outcomeRepo.recordOutcome(merchantId, caseId, {
      actionId: options?.actionId,
      outcomeType: 'CUSTOMER_RESPONSE',
      detailsJson: { rawText: replyText, intent: classification.intent },
      observedAt: this.now(),
    });

    return {
      observed: true,
      outcome,
      caseId,
      caseStatus: matchedCase.status,
    };
  }

  /**
   * Observes a durable timer firing (e.g. follow-up timer or promise-to-pay check timer).
   */
  async observeTimerFired(
    merchantId: string,
    caseId: string,
    timerType: string,
    payload?: Record<string, unknown>,
  ): Promise<ObservationResult> {
    const matchedCase = await this.caseRepo.getCaseById(merchantId, caseId);
    if (!matchedCase) {
      throw new Error(`Case "${caseId}" not found for merchant "${merchantId}"`);
    }

    // 1. PROMISE_TO_PAY_CHECK timer
    if (timerType === 'PROMISE_TO_PAY_CHECK') {
      // Check if case is already recovered
      if (matchedCase.status === CaseStatus.RECOVERED) {
        return {
          observed: true,
          caseId,
          caseStatus: matchedCase.status,
          reason: 'Case already recovered; promise was fulfilled',
        };
      }

      // Check active commitment
      const commitmentId = payload?.commitmentId as string | undefined;
      if (commitmentId) {
        const commitment = await this.commitmentRepo.getCommitmentById(merchantId, caseId, commitmentId);
        if (commitment && commitment.status === 'PENDING') {
          // Mark commitment as BROKEN
          await this.commitmentRepo.updateCommitmentStatus(merchantId, caseId, commitmentId, 'BROKEN');
        }
      }

      // Record PROMISE_TO_PAY_BROKEN outcome
      const outcome = await this.outcomeRepo.recordOutcome(merchantId, caseId, {
        outcomeType: 'PROMISE_TO_PAY_BROKEN',
        detailsJson: {
          timerType,
          commitmentId,
          expiredAt: this.now().toISOString(),
        },
        observedAt: this.now(),
      });

      await this.auditRepo.record(merchantId, {
        caseId,
        eventType: 'PROMISE_TO_PAY_BROKEN',
        actorType: AuditActorType.SYSTEM,
        inputSummaryJson: { commitmentId, timerType },
        reasonCode: 'PROMISE_DATE_EXPIRED_UNPAID',
      });

      // Wake orchestrator to replan / escalate
      let replanTriggered = false;
      if (this.orchestrator && (matchedCase.status === CaseStatus.OPEN || matchedCase.status === CaseStatus.WAITING)) {
        await this.orchestrator.runIteration(merchantId, caseId, 'TIMER_FIRED');
        replanTriggered = true;
      }

      return {
        observed: true,
        outcome,
        caseId,
        caseStatus: matchedCase.status,
        replanTriggered,
      };
    }

    // 2. RECOVERY_FOLLOWUP_CHECK timer
    const outcome = await this.outcomeRepo.recordOutcome(merchantId, caseId, {
      outcomeType: 'FOLLOWUP_TIMER_FIRED',
      detailsJson: { timerType, payload: payload || {} },
      observedAt: this.now(),
    });

    await this.auditRepo.record(merchantId, {
      caseId,
      eventType: 'TIMER_FIRED',
      actorType: AuditActorType.SYSTEM,
      inputSummaryJson: { timerType, caseId },
      reasonCode: 'FOLLOWUP_TIMER_ELAPSED',
    });

    // Wake orchestrator to evaluate next action
    let replanTriggered = false;
    if (this.orchestrator && (matchedCase.status === CaseStatus.OPEN || matchedCase.status === CaseStatus.WAITING)) {
      await this.orchestrator.runIteration(merchantId, caseId, 'TIMER_FIRED');
      replanTriggered = true;
    }

    return {
      observed: true,
      outcome,
      caseId,
      caseStatus: matchedCase.status,
      replanTriggered,
    };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Private Helpers
  // ──────────────────────────────────────────────────────────────────────────

  private async correlateEventToCase(
    merchantId: string,
    event: NormalizedMerchantEvent,
  ): Promise<RevenueRiskCase | null> {
    const paymentId = event.payment?.paymentId || event.externalEventId;
    const subscriptionId = event.payment?.subscriptionId;
    const checkoutSessionId = event.checkout?.checkoutSessionId || event.externalEventId;
    const invoiceId = event.invoice?.invoiceId || event.externalEventId;

    if (paymentId) {
      const paymentIncidentKey = generateIncidentKey(merchantId, RiskType.PAYMENT_FAILURE, paymentId);
      const c = await this.caseRepo.findActiveCaseByIncidentKey(merchantId, paymentIncidentKey);
      if (c) return c;
    }

    if (subscriptionId) {
      const subIncidentKey = generateIncidentKey(merchantId, RiskType.SUBSCRIPTION_FAILURE, subscriptionId);
      const c = await this.caseRepo.findActiveCaseByIncidentKey(merchantId, subIncidentKey);
      if (c) return c;
    }

    if (checkoutSessionId) {
      const checkoutIncidentKey = generateIncidentKey(merchantId, RiskType.CHECKOUT_ABANDONMENT, checkoutSessionId);
      const c = await this.caseRepo.findActiveCaseByIncidentKey(merchantId, checkoutIncidentKey);
      if (c) return c;
    }

    if (invoiceId) {
      const invoiceIncidentKey = generateIncidentKey(merchantId, RiskType.OVERDUE_RECEIVABLE, invoiceId);
      const c = await this.caseRepo.findActiveCaseByIncidentKey(merchantId, invoiceIncidentKey);
      if (c) return c;
    }

    return null;
  }

  private isMonetaryRecoveryEvent(eventType: NormalizedEventType): boolean {
    return (
      eventType === NormalizedEventType.PAYMENT_SUCCEEDED ||
      eventType === NormalizedEventType.CHECKOUT_COMPLETED ||
      eventType === NormalizedEventType.INVOICE_PAID
    );
  }

  private async handleMonetaryRecovery(
    merchantId: string,
    matchedCase: RevenueRiskCase,
    event: NormalizedMerchantEvent,
    merchantEventId?: string,
  ): Promise<ObservationResult> {
    const caseId = matchedCase.id;

    // Currency verification: exact match required
    const eventCurrency = (event.currency || '').toUpperCase();
    if (eventCurrency !== matchedCase.currency.toUpperCase()) {
      await this.auditRepo.record(merchantId, {
        caseId,
        eventType: 'CURRENCY_MISMATCH_REJECTED',
        actorType: AuditActorType.SYSTEM,
        inputSummaryJson: {
          eventCurrency,
          caseCurrency: matchedCase.currency,
          amount: event.amount,
        },
        reasonCode: 'RECOVERY_CURRENCY_MISMATCH',
      });

      return {
        observed: false,
        caseId,
        caseStatus: matchedCase.status,
        reason: `Currency mismatch: event currency "${eventCurrency}" does not match case currency "${matchedCase.currency}"`,
      };
    }

    const rawAmount = event.amount || '0.00';
    const recoveredAmount = Money.fromDecimalString(rawAmount, eventCurrency);

    // 1. Record authoritative RecoveryOutcome
    const outcome = await this.outcomeRepo.recordOutcome(merchantId, caseId, {
      merchantEventId,
      outcomeType: event.eventType,
      amountRecovered: recoveredAmount,
      detailsJson: {
        eventSource: event.source,
        externalEventId: event.externalEventId,
      },
      observedAt: event.occurredAt || this.now(),
    });

    // 2. Transition case to RECOVERED via CAS
    let resolvedCase: RevenueRiskCase = matchedCase;
    if (matchedCase.status === CaseStatus.OPEN || matchedCase.status === CaseStatus.WAITING || matchedCase.status === CaseStatus.NEEDS_REVIEW) {
      resolvedCase = await this.caseRepo.compareAndSetStatus(
        merchantId,
        caseId,
        matchedCase.status,
        CaseStatus.RECOVERED,
        {
          recoveredAmount,
          resolvedAt: event.occurredAt || this.now(),
        },
      );

      await this.auditRepo.record(merchantId, {
        caseId,
        eventType: 'CASE_RESOLVED_BY_PAYMENT',
        actorType: AuditActorType.SYSTEM,
        inputSummaryJson: {
          outcomeId: outcome.id,
          amount: event.amount,
          currency: eventCurrency,
        },
        outputSummaryJson: {
          status: CaseStatus.RECOVERED,
          recoveredAmount: event.amount,
        },
        reasonCode: 'AUTHORITATIVE_MONEY_RECOVERED',
      });
    }

    // 3. If there was a pending commitment, mark it FULFILLED
    const activeCommitments = await this.commitmentRepo.getActiveCommitmentsForCase(merchantId, caseId);
    for (const commitment of activeCommitments) {
      if (commitment.status === 'PENDING') {
        await this.commitmentRepo.updateCommitmentStatus(merchantId, caseId, commitment.id, 'FULFILLED');
      }
    }

    return {
      observed: true,
      outcome,
      caseId,
      caseResolved: true,
      caseStatus: CaseStatus.RECOVERED,
    };
  }
}

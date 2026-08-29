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
  ScheduledJobRepository,
} from '@recoverai/db';
import {
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
  isEarlyTimer?: boolean;
  reason?: string;
}

export interface ObserveCustomerReplyParams {
  merchantId: string;
  caseId: string;
  messageId: string;
  replyText: string;
  actionId?: string;
  occurredAt?: Date;
}

export interface ObserveTimerFiredParams {
  merchantId: string;
  caseId: string;
  scheduledJobId: string;
  timerType: string;
  payload?: Record<string, unknown>;
  occurredAt?: Date;
}

export interface OutcomeObserverOptions {
  caseRepo: CaseRepository;
  actionRepo: ActionRepository;
  outcomeRepo: OutcomeRepository;
  customerRepo: CustomerRepository;
  commitmentRepo: CommitmentRepository;
  eventRepo: EventRepository;
  auditRepo: AuditRepository;
  scheduledJobRepo: ScheduledJobRepository;
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
  private scheduledJobRepo: ScheduledJobRepository;
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
    this.scheduledJobRepo = options.scheduledJobRepo;
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
   * enforces complete monetary truth, persists RecoveryOutcome idempotently, and triggers closed-loop transitions.
   */
  async observeMerchantEvent(
    event: NormalizedMerchantEvent,
    merchantEventId?: string,
  ): Promise<ObservationResult> {
    const merchantId = event.merchantId;

    // 1. Strict business entity correlation (no fallback to externalEventId)
    const matchedCase = await this.correlateEventToCase(merchantId, event);
    if (!matchedCase) {
      return {
        observed: false,
        reason: 'Event does not correlate to any known case for this merchant via authoritative business entity IDs',
      };
    }

    const caseId = matchedCase.id;

    // Validate authoritative event identifier exists before constructing dedupe key
    const rawEvent = event as Record<string, unknown>;
    const rawId = (rawEvent.eventId || rawEvent.id) as string | undefined;
    const authoritativeEventId = merchantEventId || event.externalEventId || rawId;

    if (!authoritativeEventId || authoritativeEventId === 'undefined') {
      throw new Error(
        `Cannot observe merchant event without an authoritative event identifier (merchantEventId, externalEventId, or eventId). ` +
        `Event type: ${event.eventType}`
      );
    }

    // 2. Handle Monetary Confirmation Events (PAYMENT_SUCCEEDED, CHECKOUT_COMPLETED, INVOICE_PAID)
    if (this.isMonetaryRecoveryEvent(event.eventType)) {
      return this.handleMonetaryRecovery(merchantId, matchedCase, event, merchantEventId);
    }

    // 3. Handle PAYMENT_METHOD_UPDATED
    if (
      event.eventType === NormalizedEventType.PAYMENT_METHOD_UPDATED ||
      (event.eventType as string) === 'PAYMENT_METHOD_UPDATED'
    ) {
      const dedupeKey = `merchant-event:${authoritativeEventId}`;
      const outcomeResult = await this.outcomeRepo.recordOutcome(merchantId, caseId, {
        merchantEventId,
        dedupeKey,
        outcomeType: 'PAYMENT_METHOD_UPDATED',
        detailsJson: {
          eventPayload: event.metadata || {},
        },
        observedAt: event.occurredAt || this.now(),
      });

      if (!outcomeResult.created) {
        return {
          observed: true,
          deduplicated: true,
          outcome: outcomeResult.outcome,
          caseId,
          caseStatus: matchedCase.status,
          reason: 'Duplicate payment method update event; outcome already recorded',
        };
      }

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
        await this.orchestrator.runIteration(merchantId, caseId, {
          triggerKey: `OBSERVATION:${outcomeResult.outcome.id}`,
          triggerType: 'OBSERVATION_ARRIVED',
          merchantEventId,
        });
        replanTriggered = true;
      }

      return {
        observed: true,
        outcome: outcomeResult.outcome,
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
   * Observes inbound customer communication with authoritative messageId.
   * Requires delivery ID to guarantee database-backed idempotency.
   */
  async observeCustomerReply(params: ObserveCustomerReplyParams): Promise<ObservationResult> {
    const { merchantId, caseId, messageId, replyText, actionId } = params;

    const matchedCase = await this.caseRepo.getCaseById(merchantId, caseId);
    if (!matchedCase) {
      throw new Error(`Case "${caseId}" not found for merchant "${merchantId}"`);
    }

    if (!messageId || messageId === 'undefined') {
      throw new Error('Cannot observe customer reply without authoritative messageId');
    }

    const dedupeKey = `customer-message:${messageId}`;

    const classification = this.classifier.classify(replyText, params.occurredAt || this.now());

    // 1. OPT_OUT
    if (classification.intent === CustomerReplyIntent.OPT_OUT) {
      const outcomeResult = await this.outcomeRepo.recordOutcome(merchantId, caseId, {
        actionId,
        dedupeKey,
        outcomeType: 'CUSTOMER_OPT_OUT',
        detailsJson: { messageId, rawText: replyText, classification },
        observedAt: params.occurredAt || this.now(),
      });

      if (!outcomeResult.created) {
        return {
          observed: true,
          deduplicated: true,
          outcome: outcomeResult.outcome,
          caseId,
          caseStatus: matchedCase.status,
        };
      }

      if (matchedCase.customerId) {
        await this.customerRepo.setOptOut(merchantId, matchedCase.customerId, true);
      }

      if (matchedCase.status === CaseStatus.OPEN || matchedCase.status === CaseStatus.WAITING) {
        await this.caseRepo.compareAndSetStatus(merchantId, caseId, matchedCase.status, CaseStatus.STOPPED);
      }

      await this.auditRepo.record(merchantId, {
        caseId,
        eventType: 'CUSTOMER_OPTED_OUT',
        actorType: AuditActorType.HUMAN,
        inputSummaryJson: { messageId, replyText, outcomeId: outcomeResult.outcome.id },
        reasonCode: 'CUSTOMER_EXPLICIT_OPT_OUT',
      });

      return {
        observed: true,
        outcome: outcomeResult.outcome,
        caseId,
        caseStatus: CaseStatus.STOPPED,
      };
    }

    // 2. PROMISE_TO_PAY
    if (classification.intent === CustomerReplyIntent.PROMISE_TO_PAY) {
      // If customer did not provide a date, DO NOT fabricate date (+3 days)!
      const promisedDate = classification.extractedPromisedDate;
      const promisedAmount = classification.extractedPromisedAmount || matchedCase.amountAtRisk.toString();

      if (!promisedDate) {
        // Promise without date cannot be durably scheduled: record observation and route to review
        const outcomeResult = await this.outcomeRepo.recordOutcome(merchantId, caseId, {
          actionId,
          dedupeKey,
          outcomeType: 'PROMISE_TO_PAY_UNDATED',
          detailsJson: {
            messageId,
            promisedAmount,
            rawText: replyText,
            note: 'Customer promised to pay but specified no date; human review required',
          },
          observedAt: params.occurredAt || this.now(),
        });

        if (!outcomeResult.created) {
          return {
            observed: true,
            deduplicated: true,
            outcome: outcomeResult.outcome,
            caseId,
            caseStatus: matchedCase.status,
          };
        }

        if (matchedCase.status === CaseStatus.OPEN || matchedCase.status === CaseStatus.WAITING) {
          await this.caseRepo.compareAndSetStatus(merchantId, caseId, matchedCase.status, CaseStatus.NEEDS_REVIEW);
        }

        await this.auditRepo.record(merchantId, {
          caseId,
          eventType: 'PROMISE_WITHOUT_DATE_RECEIVED',
          actorType: AuditActorType.HUMAN,
          inputSummaryJson: { messageId, replyText },
          reasonCode: 'PROMISE_DATE_MISSING',
        });

        return {
          observed: true,
          outcome: outcomeResult.outcome,
          caseId,
          caseStatus: CaseStatus.NEEDS_REVIEW,
        };
      }

      // Customer provided an explicit date: check scheduler availability
      if (!this.jobScheduler) {
        // Cannot schedule durable check: fail safely to NEEDS_REVIEW
        const outcomeResult = await this.outcomeRepo.recordOutcome(merchantId, caseId, {
          actionId,
          dedupeKey,
          outcomeType: 'PROMISE_TO_PAY_UNSCHEDULED',
          detailsJson: { messageId, promisedAmount, promisedDate: promisedDate.toISOString() },
          observedAt: params.occurredAt || this.now(),
        });

        if (matchedCase.status === CaseStatus.OPEN || matchedCase.status === CaseStatus.WAITING) {
          await this.caseRepo.compareAndSetStatus(merchantId, caseId, matchedCase.status, CaseStatus.NEEDS_REVIEW);
        }

        await this.auditRepo.record(merchantId, {
          caseId,
          eventType: 'SCHEDULING_FAILED',
          actorType: AuditActorType.SYSTEM,
          inputSummaryJson: { messageId, reason: 'Job scheduler unavailable for promise check' },
          reasonCode: 'SCHEDULER_UNAVAILABLE',
        });

        return {
          observed: true,
          outcome: outcomeResult.outcome,
          caseId,
          caseStatus: CaseStatus.NEEDS_REVIEW,
        };
      }

      if (matchedCase.status === CaseStatus.OPEN || matchedCase.status === CaseStatus.WAITING) {
        await this.caseRepo.compareAndSetStatus(merchantId, caseId, matchedCase.status, CaseStatus.NEEDS_REVIEW);
      }

      // 1. Create authoritative commitment idempotently by sourceMessageId
      const commitmentResult = typeof this.commitmentRepo.createCommitmentIdempotently === 'function'
        ? await this.commitmentRepo.createCommitmentIdempotently(merchantId, caseId, {
            sourceMessageId: messageId,
            promisedAmount,
            promisedDate,
            extractedFromText: replyText,
            status: 'PENDING',
          })
        : {
            commitment: await this.commitmentRepo.createCommitment(merchantId, caseId, {
              sourceMessageId: messageId,
              promisedAmount,
              promisedDate,
              extractedFromText: replyText,
              status: 'PENDING',
            }),
            created: true,
          };
      const commitment = commitmentResult.commitment;

      // 2. Record outcome with commitmentId bound in detailsJson for deterministic redelivery lookup
      const outcomeResult = await this.outcomeRepo.recordOutcome(merchantId, caseId, {
        actionId,
        dedupeKey,
        outcomeType: 'PROMISE_TO_PAY',
        detailsJson: {
          messageId,
          commitmentId: commitment.id,
          promisedAmount,
          promisedDate: promisedDate.toISOString(),
          rawText: replyText,
        },
        observedAt: params.occurredAt || this.now(),
      });

      if (!outcomeResult.created) {
        // Redelivery / duplicate message:
        // Bind precisely to the commitment belonging to this message/outcome
        const details = (outcomeResult.outcome.detailsJson as Record<string, unknown> | null) || {};
        const boundCommitmentId = (details.commitmentId as string | undefined) || commitment.id;

        let pendingCommitment = null;
        if (boundCommitmentId) {
          const c = await this.commitmentRepo.getCommitmentById(merchantId, caseId, boundCommitmentId);
          if (c && c.status === 'PENDING') {
            pendingCommitment = c;
          }
        }
        if (!pendingCommitment && typeof this.commitmentRepo.findBySourceMessageId === 'function') {
          const c = await this.commitmentRepo.findBySourceMessageId(merchantId, caseId, messageId);
          if (c && c.status === 'PENDING') {
            pendingCommitment = c;
          }
        }

        if (pendingCommitment && this.jobScheduler) {
          const jobs = await this.scheduledJobRepo.listJobsByCase(merchantId, caseId);
          const hasScheduledJob = jobs.some(
            (j) =>
              j.jobType === 'PROMISE_TO_PAY_CHECK' &&
              j.status === 'SCHEDULED' &&
              ((j.payloadJson as Record<string, unknown> | null)?.commitmentId === pendingCommitment.id ||
                (j.payloadJson as Record<string, unknown> | null)?.messageId === messageId),
          );

          if (!hasScheduledJob) {
            // Repair the missing schedule for THIS specific commitment!
            try {
              await this.jobScheduler.schedule({
                merchantId,
                caseId,
                jobType: 'PROMISE_TO_PAY_CHECK',
                scheduledFor: pendingCommitment.promisedDate,
                payloadJson: {
                  caseId,
                  commitmentId: pendingCommitment.id,
                  promisedAmount: pendingCommitment.promisedAmount.toString(),
                  promisedDate: pendingCommitment.promisedDate.toISOString(),
                  messageId,
                },
              });

              await this.auditRepo.record(merchantId, {
                caseId,
                eventType: 'SCHEDULING_REPAIRED',
                actorType: AuditActorType.SYSTEM,
                inputSummaryJson: {
                  commitmentId: pendingCommitment.id,
                  messageId,
                },
                reasonCode: 'PROMISE_TIMER_SCHEDULE_REPAIRED',
              });

              return {
                observed: true,
                deduplicated: true,
                outcome: outcomeResult.outcome,
                caseId,
                caseStatus: matchedCase.status,
              };
            } catch {
              if (matchedCase.status === CaseStatus.OPEN || matchedCase.status === CaseStatus.WAITING) {
                await this.caseRepo.compareAndSetStatus(merchantId, caseId, matchedCase.status, CaseStatus.NEEDS_REVIEW);
              }
              return {
                observed: true,
                deduplicated: true,
                outcome: outcomeResult.outcome,
                caseId,
                caseStatus: CaseStatus.NEEDS_REVIEW,
                reason: 'Scheduler failed to repair promise check timer',
              };
            }
          }
        }

        return {
          observed: true,
          deduplicated: true,
          outcome: outcomeResult.outcome,
          caseId,
          caseStatus: matchedCase.status,
        };
      }

      // Schedule durable timer to check if promised date passes unpaid
      try {
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
            messageId,
          },
        });
      } catch (scheduleErr) {
        // Scheduler failed: route safely to NEEDS_REVIEW so commitment is never silently orphaned without human or timer wake!
        if (matchedCase.status === CaseStatus.OPEN || matchedCase.status === CaseStatus.WAITING) {
          await this.caseRepo.compareAndSetStatus(merchantId, caseId, matchedCase.status, CaseStatus.NEEDS_REVIEW);
        }

        await this.auditRepo.record(merchantId, {
          caseId,
          eventType: 'SCHEDULING_FAILED',
          actorType: AuditActorType.SYSTEM,
          inputSummaryJson: {
            commitmentId: commitment.id,
            messageId,
            error: scheduleErr instanceof Error ? scheduleErr.message : String(scheduleErr),
          },
          reasonCode: 'PROMISE_TIMER_SCHEDULING_FAILED',
        });

        return {
          observed: true,
          outcome: outcomeResult.outcome,
          caseId,
          caseStatus: CaseStatus.NEEDS_REVIEW,
          reason: 'Job scheduler failed to schedule promise check timer; routed to NEEDS_REVIEW',
        };
      }

      await this.auditRepo.record(merchantId, {
        caseId,
        eventType: 'PROMISE_TO_PAY_RECORDED',
        actorType: AuditActorType.SYSTEM,
        inputSummaryJson: {
          messageId,
          commitmentId: commitment.id,
          promisedAmount,
          promisedDate: promisedDate.toISOString(),
        },
        reasonCode: 'CUSTOMER_PROMISED_TO_PAY',
      });

      return {
        observed: true,
        outcome: outcomeResult.outcome,
        caseId,
        caseStatus: matchedCase.status,
      };
    }

    // 3. PAYMENT_METHOD_WILL_UPDATE
    if (classification.intent === CustomerReplyIntent.PAYMENT_METHOD_WILL_UPDATE) {
      const outcomeResult = await this.outcomeRepo.recordOutcome(merchantId, caseId, {
        actionId,
        dedupeKey,
        outcomeType: 'CUSTOMER_RESPONSE',
        detailsJson: {
          messageId,
          intent: classification.intent,
          rawText: replyText,
        },
        observedAt: params.occurredAt || this.now(),
      });

      return {
        observed: true,
        deduplicated: !outcomeResult.created,
        outcome: outcomeResult.outcome,
        caseId,
        caseStatus: matchedCase.status,
      };
    }

    // 4. REFUSES_PAYMENT
    if (classification.intent === CustomerReplyIntent.REFUSES_PAYMENT) {
      const outcomeResult = await this.outcomeRepo.recordOutcome(merchantId, caseId, {
        actionId,
        dedupeKey,
        outcomeType: 'CUSTOMER_REFUSES_PAYMENT',
        detailsJson: { messageId, rawText: replyText },
        observedAt: params.occurredAt || this.now(),
      });

      if (!outcomeResult.created) {
        return {
          observed: true,
          deduplicated: true,
          outcome: outcomeResult.outcome,
          caseId,
          caseStatus: matchedCase.status,
        };
      }

      // Escalate to human review
      if (matchedCase.status === CaseStatus.OPEN || matchedCase.status === CaseStatus.WAITING) {
        await this.caseRepo.compareAndSetStatus(merchantId, caseId, matchedCase.status, CaseStatus.NEEDS_REVIEW);
      }

      return {
        observed: true,
        outcome: outcomeResult.outcome,
        caseId,
        caseStatus: CaseStatus.NEEDS_REVIEW,
      };
    }

    // Default: Generic customer reply
    const outcomeResult = await this.outcomeRepo.recordOutcome(merchantId, caseId, {
      actionId,
      dedupeKey,
      outcomeType: 'CUSTOMER_RESPONSE',
      detailsJson: { messageId, rawText: replyText, intent: classification.intent },
      observedAt: params.occurredAt || this.now(),
    });

    return {
      observed: true,
      deduplicated: !outcomeResult.created,
      outcome: outcomeResult.outcome,
      caseId,
      caseStatus: matchedCase.status,
    };
  }

  /**
   * Observes a durable timer firing (e.g. from pg-boss or external scheduler).
   * Verifies authoritative ScheduledJob identity and status before mutating state.
   */
  async observeTimerFired(params: ObserveTimerFiredParams): Promise<ObservationResult> {
    const { merchantId, caseId, scheduledJobId, timerType, payload } = params;

    if (!scheduledJobId || scheduledJobId === 'undefined') {
      throw new Error('Cannot observe timer fired without authoritative scheduledJobId');
    }

    const matchedCase = await this.caseRepo.getCaseById(merchantId, caseId);
    if (!matchedCase) {
      throw new Error(`Case "${caseId}" not found for merchant "${merchantId}"`);
    }

    // 0. Verify authoritative ScheduledJob from PostgreSQL (mandatory)
    const scheduledJob = await this.scheduledJobRepo.getJobById(merchantId, scheduledJobId);
    if (!scheduledJob) {
      return {
        observed: false,
        caseId,
        caseStatus: matchedCase.status,
        reason: `ScheduledJob "${scheduledJobId}" not found for merchant "${merchantId}"; timer rejected`,
      };
    }

    if (scheduledJob.merchantId !== merchantId) {
      return {
        observed: false,
        caseId,
        caseStatus: matchedCase.status,
        reason: `Cross-tenant timer rejected: job merchantId "${scheduledJob.merchantId}" !== "${merchantId}"`,
      };
    }

    if (scheduledJob.caseId !== caseId) {
      return {
        observed: false,
        caseId,
        caseStatus: matchedCase.status,
        reason: `Timer case mismatch: job caseId "${scheduledJob.caseId}" !== "${caseId}"`,
      };
    }

    if (scheduledJob.jobType !== timerType) {
      return {
        observed: false,
        caseId,
        caseStatus: matchedCase.status,
        reason: `Timer type mismatch: job type "${scheduledJob.jobType}" !== "${timerType}"`,
      };
    }

    const authoritativeJobPayload = (scheduledJob.payloadJson as Record<string, unknown> | null) || {};
    const authoritativeCommitmentId = authoritativeJobPayload.commitmentId as string | undefined;

    const dedupeKey = `timer:${scheduledJobId}`;

    // 1. PROMISE_TO_PAY_CHECK timer
    if (timerType === 'PROMISE_TO_PAY_CHECK') {
      if (matchedCase.status === CaseStatus.RECOVERED) {
        return {
          observed: true,
          caseId,
          caseStatus: matchedCase.status,
          reason: 'Case already recovered; promise was fulfilled',
        };
      }

      if (!authoritativeCommitmentId) {
        return {
          observed: false,
          caseId,
          caseStatus: matchedCase.status,
          reason: 'Persisted ScheduledJob payload is missing required commitmentId',
        };
      }

      // If caller transport passed a commitmentId, it MUST match authoritative ScheduledJob commitmentId!
      const callerCommitmentId = payload?.commitmentId as string | undefined;
      if (callerCommitmentId && callerCommitmentId !== authoritativeCommitmentId) {
        return {
          observed: false,
          caseId,
          caseStatus: matchedCase.status,
          reason: `Timer payload mismatch: transport commitmentId "${callerCommitmentId}" does not match authoritative job commitmentId "${authoritativeCommitmentId}"`,
        };
      }

      const commitmentId = authoritativeCommitmentId;
      const commitment = await this.commitmentRepo.getCommitmentById(merchantId, caseId, commitmentId);
      if (!commitment) {
        return {
          observed: false,
          caseId,
          caseStatus: matchedCase.status,
          reason: `Commitment "${commitmentId}" not found for merchant "${merchantId}" and case "${caseId}"`,
        };
      }

      if (commitment.status !== 'PENDING') {
        return {
          observed: true,
          deduplicated: true,
          caseId,
          caseStatus: matchedCase.status,
          reason: `Commitment status is "${commitment.status}", not PENDING`,
        };
      }

      const now = params.occurredAt || this.now();
      if (now.getTime() < commitment.promisedDate.getTime()) {
        // Early timer: do NOT mark promise BROKEN!
        // Ensure a future timer exists at the authoritative promisedDate
        if (this.jobScheduler) {
          const jobs = await this.scheduledJobRepo.listJobsByCase(merchantId, caseId);
          const hasFutureJob = jobs.some(
            (j) =>
              j.id !== scheduledJobId &&
              j.jobType === 'PROMISE_TO_PAY_CHECK' &&
              j.status === 'SCHEDULED' &&
              (j.payloadJson as Record<string, unknown> | null)?.commitmentId === commitmentId,
          );

          if (!hasFutureJob) {
            await this.jobScheduler.schedule({
              merchantId,
              caseId,
              jobType: 'PROMISE_TO_PAY_CHECK',
              scheduledFor: commitment.promisedDate,
              payloadJson: {
                caseId,
                commitmentId: commitment.id,
                promisedAmount: commitment.promisedAmount.toString(),
                promisedDate: commitment.promisedDate.toISOString(),
                sourceMessageId: commitment.sourceMessageId ?? null,
              },
            });
          }
        }

        return {
          observed: false,
          isEarlyTimer: true,
          caseId,
          caseStatus: matchedCase.status,
          reason: `Early timer rejected: current time ${now.toISOString()} is before promisedDate ${commitment.promisedDate.toISOString()}`,
        };
      }

      // Atomic outcome recording to deduplicate repeated timer dispatches
      const outcomeResult = await this.outcomeRepo.recordOutcome(merchantId, caseId, {
        dedupeKey,
        outcomeType: 'PROMISE_TO_PAY_BROKEN',
        detailsJson: {
          scheduledJobId,
          timerType,
          commitmentId,
          expiredAt: now.toISOString(),
        },
        observedAt: now,
      });

      if (!outcomeResult.created) {
        return {
          observed: true,
          deduplicated: true,
          outcome: outcomeResult.outcome,
          caseId,
          caseStatus: matchedCase.status,
          reason: 'Duplicate timer delivery; outcome already recorded',
        };
      }

      // Check active commitment and mark as BROKEN
      await this.commitmentRepo.updateCommitmentStatus(merchantId, caseId, commitmentId, 'BROKEN');

      await this.auditRepo.record(merchantId, {
        caseId,
        eventType: 'PROMISE_TO_PAY_BROKEN',
        actorType: AuditActorType.SYSTEM,
        inputSummaryJson: { scheduledJobId, commitmentId, timerType },
        reasonCode: 'PROMISE_DATE_EXPIRED_UNPAID',
      });

      // Transition case to NEEDS_REVIEW
      if (matchedCase.status === CaseStatus.OPEN || matchedCase.status === CaseStatus.WAITING) {
        await this.caseRepo.compareAndSetStatus(merchantId, caseId, matchedCase.status, CaseStatus.NEEDS_REVIEW);
      }

      // Emit canonical CASE_ESCALATED audit with reasonCode BROKEN_PROMISE_TO_PAY
      await this.auditRepo.record(merchantId, {
        caseId,
        eventType: 'CASE_ESCALATED',
        actorType: AuditActorType.SYSTEM,
        inputSummaryJson: {
          commitmentId,
          scheduledJobId,
          caseId,
          promisedDate: commitment.promisedDate.toISOString(),
          promisedAmount: commitment.promisedAmount.toString(),
          outcomeId: outcomeResult.outcome.id,
        },
        reasonCode: 'BROKEN_PROMISE_TO_PAY',
      });

      return {
        observed: true,
        outcome: outcomeResult.outcome,
        caseId,
        caseStatus: CaseStatus.NEEDS_REVIEW,
        replanTriggered: false,
      };
    }

    // 2. RECOVERY_FOLLOWUP_CHECK timer
    const outcomeResult = await this.outcomeRepo.recordOutcome(merchantId, caseId, {
      dedupeKey,
      outcomeType: 'FOLLOWUP_TIMER_FIRED',
      detailsJson: { scheduledJobId, timerType, payload: payload || {} },
      observedAt: params.occurredAt || this.now(),
    });

    if (!outcomeResult.created) {
      return {
        observed: true,
        deduplicated: true,
        outcome: outcomeResult.outcome,
        caseId,
        caseStatus: matchedCase.status,
        reason: 'Duplicate timer delivery; outcome already recorded',
      };
    }

    await this.auditRepo.record(merchantId, {
      caseId,
      eventType: 'TIMER_FIRED',
      actorType: AuditActorType.SYSTEM,
      inputSummaryJson: { scheduledJobId, timerType, caseId },
      reasonCode: 'FOLLOWUP_TIMER_ELAPSED',
    });

    // Wake orchestrator to evaluate next action
    let replanTriggered = false;
    if (this.orchestrator && (matchedCase.status === CaseStatus.OPEN || matchedCase.status === CaseStatus.WAITING)) {
      await this.orchestrator.runIteration(merchantId, caseId, {
        triggerKey: `TIMER:${scheduledJobId}`,
        triggerType: 'TIMER_FIRED',
        scheduledJobId,
      });
      replanTriggered = true;
    }

    return {
      observed: true,
      outcome: outcomeResult.outcome,
      caseId,
      caseStatus: matchedCase.status,
      replanTriggered,
    };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Private Helpers
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Strictly correlates events by authoritative business entity IDs.
   * Never falls back to externalEventId / webhook ID.
   */
  private async correlateEventToCase(
    merchantId: string,
    event: NormalizedMerchantEvent,
  ): Promise<RevenueRiskCase | null> {
    const raw = event as unknown as Record<string, unknown>;

    const paymentObj =
      raw.payment && typeof raw.payment === 'object'
        ? (raw.payment as Record<string, unknown>)
        : undefined;

    const paymentId =
      typeof raw.paymentId === 'string'
        ? raw.paymentId
        : typeof paymentObj?.paymentId === 'string'
          ? (paymentObj.paymentId as string)
          : undefined;

    if (paymentId) {
      const byPayment = await this.caseRepo.findActiveCaseByPaymentId(merchantId, paymentId);
      if (byPayment) return byPayment;

      const paymentIncidentKey = generateIncidentKey(merchantId, RiskType.PAYMENT_FAILURE, paymentId);
      const c = await this.caseRepo.findActiveCaseByIncidentKey(merchantId, paymentIncidentKey);
      if (c) return c;

      const subPaymentIncidentKey = generateIncidentKey(merchantId, RiskType.SUBSCRIPTION_FAILURE, paymentId);
      const cSub = await this.caseRepo.findActiveCaseByIncidentKey(merchantId, subPaymentIncidentKey);
      if (cSub) return cSub;
    }

    const subscriptionId =
      typeof raw.subscriptionId === 'string'
        ? raw.subscriptionId
        : typeof paymentObj?.subscriptionId === 'string'
          ? (paymentObj.subscriptionId as string)
          : undefined;

    if (subscriptionId) {
      const subIncidentKey = generateIncidentKey(merchantId, RiskType.SUBSCRIPTION_FAILURE, subscriptionId);
      const c = await this.caseRepo.findActiveCaseByIncidentKey(merchantId, subIncidentKey);
      if (c) return c;
    }

    const checkoutObj =
      raw.checkout && typeof raw.checkout === 'object'
        ? (raw.checkout as Record<string, unknown>)
        : undefined;

    const checkoutSessionId =
      typeof raw.checkoutSessionId === 'string'
        ? raw.checkoutSessionId
        : typeof checkoutObj?.checkoutSessionId === 'string'
          ? (checkoutObj.checkoutSessionId as string)
          : undefined;

    if (checkoutSessionId) {
      const checkoutIncidentKey = generateIncidentKey(merchantId, RiskType.CHECKOUT_ABANDONMENT, checkoutSessionId);
      const c = await this.caseRepo.findActiveCaseByIncidentKey(merchantId, checkoutIncidentKey);
      if (c) return c;
    }

    const invoiceObj =
      raw.invoice && typeof raw.invoice === 'object'
        ? (raw.invoice as Record<string, unknown>)
        : undefined;

    const invoiceId =
      typeof raw.invoiceId === 'string'
        ? raw.invoiceId
        : typeof invoiceObj?.invoiceId === 'string'
          ? (invoiceObj.invoiceId as string)
          : undefined;

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

  /**
   * Strictly verifies monetary recovery with complete truth:
   * - Amount and currency present and valid
   * - Currency matches case currency exactly
   * - Amount matches case amountAtRisk exactly (rejects partial payments and overpayments)
   * - Race-safe DB deduplication before CAS state change
   */
  private async handleMonetaryRecovery(
    merchantId: string,
    matchedCase: RevenueRiskCase,
    event: NormalizedMerchantEvent,
    merchantEventId?: string,
  ): Promise<ObservationResult> {
    const caseId = matchedCase.id;

    // 1. Validate currency presence and exact match
    if (!event.currency) {
      return {
        observed: false,
        caseId,
        caseStatus: matchedCase.status,
        reason: 'Event missing required currency field; monetary recovery rejected',
      };
    }

    const eventCurrency = event.currency.toUpperCase();
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

    // 2. Validate amount presence and exact Money parsing
    if (!event.amount || !Money.isValidDecimalString(event.amount)) {
      return {
        observed: false,
        caseId,
        caseStatus: matchedCase.status,
        reason: 'Event missing or has invalid monetary amount decimal string; monetary recovery rejected',
      };
    }

    const recoveredMoney = Money.fromDecimalString(event.amount, eventCurrency);
    if (recoveredMoney.toPaise() <= 0n) {
      return {
        observed: false,
        caseId,
        caseStatus: matchedCase.status,
        reason: 'Monetary recovery amount must be strictly positive; zero-amount recovery rejected',
      };
    }

    // 3. Exact full amount verification against case amountAtRisk
    const caseMoney = Money.fromDecimalString(matchedCase.amountAtRisk.toString(), matchedCase.currency);

    if (recoveredMoney.toPaise() < caseMoney.toPaise()) {
      // Partial payment: do not mark full RECOVERED (out of scope for Phase 5)
      await this.auditRepo.record(merchantId, {
        caseId,
        eventType: 'PARTIAL_PAYMENT_REJECTED',
        actorType: AuditActorType.SYSTEM,
        inputSummaryJson: {
          eventAmount: event.amount,
          caseAmountAtRisk: matchedCase.amountAtRisk.toString(),
        },
        reasonCode: 'PARTIAL_PAYMENT_OUT_OF_SCOPE',
      });

      return {
        observed: false,
        caseId,
        caseStatus: matchedCase.status,
        reason: `Partial payment amount (${event.amount}) is less than case amount at risk (${matchedCase.amountAtRisk.toString()}); case remains unrecovered`,
      };
    }

    if (recoveredMoney.toPaise() > caseMoney.toPaise()) {
      // Overpayment mismatch: do not silently credit mismatched money
      await this.auditRepo.record(merchantId, {
        caseId,
        eventType: 'OVERPAYMENT_REJECTED',
        actorType: AuditActorType.SYSTEM,
        inputSummaryJson: {
          eventAmount: event.amount,
          caseAmountAtRisk: matchedCase.amountAtRisk.toString(),
        },
        reasonCode: 'OVERPAYMENT_MISMATCH_REJECTED',
      });

      return {
        observed: false,
        caseId,
        caseStatus: matchedCase.status,
        reason: `Overpayment amount (${event.amount}) exceeds case amount at risk (${matchedCase.amountAtRisk.toString()}); monetary credit rejected`,
      };
    }

    // 4. Database-backed observation dedupe before applying recovery credit
    const rawEvent = event as Record<string, unknown>;
    const rawId = (rawEvent.eventId || rawEvent.id) as string | undefined;
    const dedupeKey = `merchant-event:${merchantEventId || event.externalEventId || rawId}`;
    const outcomeResult = await this.outcomeRepo.recordOutcome(merchantId, caseId, {
      merchantEventId,
      dedupeKey,
      outcomeType: event.eventType,
      amountRecovered: recoveredMoney,
      detailsJson: {
        eventSource: event.source,
        externalEventId: event.externalEventId,
      },
      observedAt: event.occurredAt || this.now(),
    });

    if (!outcomeResult.created) {
      // Duplicate event delivery: return deduplicated without double crediting or auditing
      return {
        observed: true,
        deduplicated: true,
        outcome: outcomeResult.outcome,
        caseId,
        caseStatus: matchedCase.status,
        reason: 'Duplicate monetary event; outcome already recorded',
      };
    }

    // 5. Winner transitions case to RECOVERED via CAS
    if (
      matchedCase.status === CaseStatus.OPEN ||
      matchedCase.status === CaseStatus.WAITING ||
      matchedCase.status === CaseStatus.NEEDS_REVIEW
    ) {
      await this.caseRepo.compareAndSetStatus(
        merchantId,
        caseId,
        matchedCase.status,
        CaseStatus.RECOVERED,
        {
          recoveredAmount: recoveredMoney,
          resolvedAt: event.occurredAt || this.now(),
        },
      );

      // Audit with source-specific truthful event name
      let auditEventType = 'CASE_RECOVERED';
      if (event.eventType === NormalizedEventType.PAYMENT_SUCCEEDED) {
        auditEventType = 'CASE_RECOVERED_BY_PAYMENT';
      } else if (event.eventType === NormalizedEventType.CHECKOUT_COMPLETED) {
        auditEventType = 'CASE_RECOVERED_BY_CHECKOUT';
      } else if (event.eventType === NormalizedEventType.INVOICE_PAID) {
        auditEventType = 'CASE_RECOVERED_BY_INVOICE';
      }

      await this.auditRepo.record(merchantId, {
        caseId,
        eventType: auditEventType,
        actorType: AuditActorType.SYSTEM,
        inputSummaryJson: {
          outcomeId: outcomeResult.outcome.id,
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

    // 6. Fulfill any pending commitments for this case
    const activeCommitments = await this.commitmentRepo.getActiveCommitmentsForCase(merchantId, caseId);
    for (const commitment of activeCommitments) {
      if (commitment.status === 'PENDING') {
        await this.commitmentRepo.updateCommitmentStatus(merchantId, caseId, commitment.id, 'FULFILLED');
      }
    }

    return {
      observed: true,
      outcome: outcomeResult.outcome,
      caseId,
      caseResolved: true,
      caseStatus: CaseStatus.RECOVERED,
    };
  }
}

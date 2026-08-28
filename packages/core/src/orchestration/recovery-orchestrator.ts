import {
  AuditActorType,
  CaseStatus,
  PolicyDecision,
  RecoveryActionType,
  RecoveryPlanVersion,
} from '@prisma/client';
import {
  ActionRepository,
  AuditRepository,
  CaseRepository,
  CommitmentRepository,
  CustomerRepository,
  MerchantRepository,
  PolicyConfigRepository,
  CaseWithRelations,
} from '@recoverai/db';
import { isHardDecline } from '../agent/agent-contracts.js';
import { isActionCompatible } from '../domain/action-compatibility.js';
import { IPolicyEngine, PolicyExecutionContext } from '../execution/policy-interface.js';
import { ActionExecutor } from '../execution/action-executor.js';
import { RecoveryAgent } from '../agent/recovery-agent.js';
import { AgentContext } from '../agent/agent-contracts.js';
import { IJobScheduler } from '../detection/job-scheduler-interface.js';
import {
  EligibilityCheckResult,
  OrchestrationIterationResult,
  OrchestrationTrigger,
} from './orchestrator-types.js';

export interface RecoveryOrchestratorOptions {
  caseRepo: CaseRepository;
  actionRepo: ActionRepository;
  customerRepo: CustomerRepository;
  merchantRepo: MerchantRepository;
  policyConfigRepo: PolicyConfigRepository;
  commitmentRepo: CommitmentRepository;
  auditRepo: AuditRepository;
  recoveryAgent: RecoveryAgent;
  policyEngine: IPolicyEngine;
  actionExecutor: ActionExecutor;
  jobScheduler?: IJobScheduler;
  clock?: () => Date;
}

export class RecoveryOrchestrator {
  private caseRepo: CaseRepository;
  private actionRepo: ActionRepository;
  private customerRepo: CustomerRepository;
  private merchantRepo: MerchantRepository;
  private policyConfigRepo: PolicyConfigRepository;
  private commitmentRepo: CommitmentRepository;
  private auditRepo: AuditRepository;
  private recoveryAgent: RecoveryAgent;
  private policyEngine: IPolicyEngine;
  private actionExecutor: ActionExecutor;
  private jobScheduler?: IJobScheduler;
  private clock?: () => Date;

  constructor(options: RecoveryOrchestratorOptions) {
    this.caseRepo = options.caseRepo;
    this.actionRepo = options.actionRepo;
    this.customerRepo = options.customerRepo;
    this.merchantRepo = options.merchantRepo;
    this.policyConfigRepo = options.policyConfigRepo;
    this.commitmentRepo = options.commitmentRepo;
    this.auditRepo = options.auditRepo;
    this.recoveryAgent = options.recoveryAgent;
    this.policyEngine = options.policyEngine;
    this.actionExecutor = options.actionExecutor;
    this.jobScheduler = options.jobScheduler;
    this.clock = options.clock;
  }

  private now(): Date {
    return this.clock ? this.clock() : new Date();
  }

  /**
   * Executes a single authoritative closed-loop recovery iteration for a case.
   *
   * Architectural Invariant:
   * AI PROPOSES → POLICY DECIDES → EXECUTOR ACTS → OBSERVER VERIFIES.
   *
   * Orchestrator NEVER calls external providers directly; ActionExecutor is the sole boundary.
   */
  async runIteration(
    merchantId: string,
    caseId: string,
    trigger: OrchestrationTrigger = 'CASE_OPENED',
  ): Promise<OrchestrationIterationResult> {
    const currentTime = this.now();

    // 1. Load fresh case with relations from DB
    const caseRecord = await this.caseRepo.getCaseById(merchantId, caseId);
    if (!caseRecord) {
      throw new Error(`Case "${caseId}" not found for merchant "${merchantId}"`);
    }

    // 2. Check stopping and terminal conditions
    const merchant = await this.merchantRepo.getMerchantById(merchantId);
    const policyConfig = await this.policyConfigRepo.getOrCreateConfig(merchantId);

    const eligibility = this.checkEligibility(caseRecord, merchant?.killSwitchActive ?? false, policyConfig, currentTime);
    if (!eligibility.eligible) {
      if (eligibility.shouldStop) {
        if (caseRecord.status !== CaseStatus.STOPPED) {
          await this.caseRepo.compareAndSetStatus(merchantId, caseId, caseRecord.status, CaseStatus.STOPPED);
        }
        await this.auditRepo.record(merchantId, {
          caseId,
          eventType: 'CASE_STOPPED',
          actorType: AuditActorType.SYSTEM,
          inputSummaryJson: { trigger, reason: eligibility.reason },
          reasonCode: 'CASE_STOPPED_BY_RULE',
        });
        return {
          caseId,
          status: CaseStatus.STOPPED,
          iterationCompleted: true,
          stoppedReason: eligibility.reason,
        };
      }

      if (eligibility.shouldExhaust) {
        if (caseRecord.status !== CaseStatus.EXHAUSTED) {
          await this.caseRepo.compareAndSetStatus(merchantId, caseId, caseRecord.status, CaseStatus.EXHAUSTED);
        }
        await this.auditRepo.record(merchantId, {
          caseId,
          eventType: 'CASE_EXHAUSTED',
          actorType: AuditActorType.SYSTEM,
          inputSummaryJson: { trigger, reason: eligibility.reason },
          reasonCode: 'CASE_LIMITS_EXHAUSTED',
        });
        return {
          caseId,
          status: CaseStatus.EXHAUSTED,
          iterationCompleted: true,
          exhaustedReason: eligibility.reason,
        };
      }

      return {
        caseId,
        status: caseRecord.status,
        iterationCompleted: false,
        stoppedReason: eligibility.reason,
        reviewReason: eligibility.needsReview ? eligibility.reason : undefined,
      };
    }

    // If case is in WAITING and iteration is triggered (e.g. replan or observation arrived),
    // transition back to OPEN via legal state transition matrix: WAITING -> OPEN
    let currentStatus = caseRecord.status;
    if (currentStatus === CaseStatus.WAITING) {
      const transitioned = await this.caseRepo.compareAndSetStatus(
        merchantId,
        caseId,
        CaseStatus.WAITING,
        CaseStatus.OPEN,
      );
      currentStatus = transitioned.status;
      await this.auditRepo.record(merchantId, {
        caseId,
        eventType: 'REPLAN_TRIGGERED',
        actorType: AuditActorType.SYSTEM,
        inputSummaryJson: { trigger, previousStatus: CaseStatus.WAITING },
        reasonCode: 'REPLAN_WOKE_FROM_WAITING',
      });
    }

    // 3. Compute legally allowed actions for this context
    const allowedActions = this.computeAllowedActions(caseRecord, policyConfig);
    if (allowedActions.length === 0) {
      await this.caseRepo.compareAndSetStatus(merchantId, caseId, currentStatus, CaseStatus.EXHAUSTED);
      await this.auditRepo.record(merchantId, {
        caseId,
        eventType: 'CASE_EXHAUSTED',
        actorType: AuditActorType.SYSTEM,
        inputSummaryJson: { reason: 'No legal actions remain compatible with case status and limits' },
        reasonCode: 'NO_ALLOWED_ACTIONS_REMAIN',
      });
      return {
        caseId,
        status: CaseStatus.EXHAUSTED,
        iterationCompleted: true,
        exhaustedReason: 'No legal actions remain compatible with case status and limits',
      };
    }

    // 4. Build Agent Context and request structured Proposal
    const priorActions = (caseRecord.actions || []).map((a) => ({
      actionType: a.actionType,
      executedAt: a.executedAt || a.createdAt,
      status: a.status,
      policyDecision: a.policyDecision,
      errorMessage: a.errorMessage,
    }));

    const priorOutcomes = (caseRecord.outcomes || []).map((o) => ({
      outcomeType: o.outcomeType,
      observedAt: o.observedAt,
      amountRecovered: o.amountRecovered?.toString() || null,
    }));

    const retryCount = priorActions.filter((a) => a.actionType === RecoveryActionType.RETRY_PAYMENT).length;
    const contactCount = priorActions.filter((a) => this.isContactAction(a.actionType)).length;

    const agentContext: AgentContext = {
      caseId: caseRecord.id,
      merchantId,
      riskType: caseRecord.riskType,
      amountAtRisk: caseRecord.amountAtRisk.toString(),
      currency: caseRecord.currency,
      caseOpenedAt: caseRecord.openedAt,
      retryCount,
      contactCount,
      allowedActions,
      verifiedPaymentFacts: (caseRecord.contextJson as Record<string, unknown> | null)?.verifiedPaymentFacts as any,
      customerHistory: caseRecord.customer ? {
        totalPastCases: 1,
        successfullyRecoveredCases: 0,
        contactConsent: caseRecord.customer.contactConsent ?? false,
        optedOut: caseRecord.customer.optedOut,
        lastContactedAt: caseRecord.customer.lastContactedAt,
      } : undefined,
      priorActions,
      priorOutcomes,
      policySummary: {
        maxRetries: policyConfig.maxRetriesPerCase,
        maxContacts: policyConfig.maxContactsPerCase,
        maxActions: policyConfig.maxActionsPerCase,
        cooldownHours: policyConfig.cooldownHoursBetweenActions,
        reviewFirstMode: policyConfig.reviewFirstMode,
        highValueThreshold: policyConfig.highValueThreshold.toString(),
      },
    };

    const proposal = await this.recoveryAgent.generateProposal(agentContext);

    // 5. Append-only RecoveryPlanVersion creation (never mutate prior plans)
    const latestVersion = caseRecord.planVersions?.[0]?.version ?? 0;
    const nextVersionNumber = latestVersion + 1;

    const planVersion = await this.caseRepo.addPlanVersion(merchantId, caseId, {
      version: nextVersionNumber,
      diagnosisCode: proposal.diagnosisCode,
      diagnosisSummary: proposal.diagnosisSummary,
      confidence: proposal.confidence,
      proposedActionType: proposal.proposedActionType,
      proposedActionParams: proposal.proposedActionParams,
      reasoningSummary: proposal.reasoningSummary,
      followUpAfterSeconds: proposal.followUpAfterSeconds ?? undefined,
      shouldStop: proposal.shouldStop,
      shouldEscalate: proposal.shouldEscalate,
    });

    await this.auditRepo.record(merchantId, {
      caseId,
      eventType: 'PLAN_CREATED',
      actorType: AuditActorType.AGENT,
      inputSummaryJson: {
        version: nextVersionNumber,
        diagnosisCode: proposal.diagnosisCode,
        proposedActionType: proposal.proposedActionType,
        confidence: proposal.confidence,
      },
      outputSummaryJson: {
        reasoningSummary: proposal.reasoningSummary,
        shouldStop: proposal.shouldStop,
        shouldEscalate: proposal.shouldEscalate,
      },
      reasonCode: 'RECOVERY_PLAN_VERSION_PERSISTED',
    });

    // 6. Handle explicit Agent escalation or stop signals
    if (proposal.shouldEscalate || proposal.proposedActionType === RecoveryActionType.ESCALATE_TO_HUMAN) {
      await this.caseRepo.compareAndSetStatus(merchantId, caseId, currentStatus, CaseStatus.NEEDS_REVIEW);
      await this.auditRepo.record(merchantId, {
        caseId,
        eventType: 'CASE_ESCALATED',
        actorType: AuditActorType.AGENT,
        inputSummaryJson: { reason: proposal.reasoningSummary },
        reasonCode: 'AGENT_PROPOSED_ESCALATION',
      });
      return {
        caseId,
        status: CaseStatus.NEEDS_REVIEW,
        iterationCompleted: true,
        planVersion,
        reviewReason: proposal.reasoningSummary,
      };
    }

    if (proposal.shouldStop || proposal.proposedActionType === RecoveryActionType.STOP_RECOVERY) {
      await this.caseRepo.compareAndSetStatus(merchantId, caseId, currentStatus, CaseStatus.STOPPED);
      await this.auditRepo.record(merchantId, {
        caseId,
        eventType: 'CASE_STOPPED',
        actorType: AuditActorType.AGENT,
        inputSummaryJson: { reason: proposal.reasoningSummary },
        reasonCode: 'AGENT_PROPOSED_STOP',
      });
      return {
        caseId,
        status: CaseStatus.STOPPED,
        iterationCompleted: true,
        planVersion,
        stoppedReason: proposal.reasoningSummary,
      };
    }

    // 7. PolicyEngine evaluation
    const commitments = await this.commitmentRepo.getActiveCommitmentsForCase(merchantId, caseId);

    const policyExecutionContext: PolicyExecutionContext = {
      merchantId,
      killSwitchActive: merchant?.killSwitchActive ?? false,
      policyConfig: {
        maxRetriesPerCase: policyConfig.maxRetriesPerCase,
        maxContactsPerCase: policyConfig.maxContactsPerCase,
        maxActionsPerCase: policyConfig.maxActionsPerCase,
        cooldownHoursBetweenActions: policyConfig.cooldownHoursBetweenActions,
        highValueThreshold: policyConfig.highValueThreshold.toString(),
        minConfidenceThreshold: policyConfig.minConfidenceThreshold,
        reviewFirstMode: policyConfig.reviewFirstMode,
        checkoutAbandonmentThresholdMinutes: policyConfig.checkoutAbandonmentThresholdMinutes,
        quietHoursStart: policyConfig.quietHoursStart,
        quietHoursEnd: policyConfig.quietHoursEnd,
        quietHoursTimezone: policyConfig.quietHoursTimezone,
        maxRecoveryWindowDays: policyConfig.maxRecoveryWindowDays,
        overdueGracePeriodDays: policyConfig.overdueGracePeriodDays,
      },
      case: {
        id: caseRecord.id,
        merchantId: caseRecord.merchantId,
        riskType: caseRecord.riskType,
        amountAtRisk: caseRecord.amountAtRisk.toString(),
        currency: caseRecord.currency,
        status: currentStatus,
        openedAt: caseRecord.openedAt,
        diagnosisCode: proposal.diagnosisCode,
      },
      customer: caseRecord.customer ? {
        id: caseRecord.customer.id,
        contactConsent: caseRecord.customer.contactConsent,
        optedOut: caseRecord.customer.optedOut,
        lastContactedAt: caseRecord.customer.lastContactedAt,
      } : null,
      proposedActionType: proposal.proposedActionType,
      proposedActionParams: proposal.proposedActionParams,
      confidence: proposal.confidence,
      diagnosisCode: proposal.diagnosisCode,
      diagnosisSummary: proposal.diagnosisSummary,
      verifiedPaymentFailureCode: typeof (caseRecord.contextJson as Record<string, unknown> | null)?.verifiedPaymentFailureCode === 'string'
        ? ((caseRecord.contextJson as Record<string, unknown>).verifiedPaymentFailureCode as string)
        : null,
      priorActions,
      priorOutcomes,
      activeCommitments: commitments.map((c) => ({
        id: c.id,
        promisedAmount: c.promisedAmount.toString(),
        promisedDate: c.promisedDate,
        status: c.status,
      })),
      currentTime,
    };

    const policyEvaluation = this.policyEngine.evaluate(policyExecutionContext);

    // 8. Enforce Policy Decision: ALLOW | DENY | REVIEW
    if (policyEvaluation.decision === PolicyDecision.REVIEW) {
      await this.caseRepo.compareAndSetStatus(merchantId, caseId, currentStatus, CaseStatus.NEEDS_REVIEW);
      await this.auditRepo.record(merchantId, {
        caseId,
        eventType: 'CASE_ESCALATED',
        actorType: AuditActorType.POLICY,
        inputSummaryJson: {
          reasonCode: policyEvaluation.reasonCode,
          rationale: policyEvaluation.rationale,
          planVersion: nextVersionNumber,
        },
        reasonCode: policyEvaluation.reasonCode,
      });

      return {
        caseId,
        status: CaseStatus.NEEDS_REVIEW,
        iterationCompleted: true,
        planVersion,
        policyDecision: PolicyDecision.REVIEW,
        reviewReason: policyEvaluation.rationale,
      };
    }

    if (policyEvaluation.decision === PolicyDecision.DENY) {
      await this.auditRepo.record(merchantId, {
        caseId,
        eventType: 'ACTION_BLOCKED_BY_POLICY',
        actorType: AuditActorType.POLICY,
        inputSummaryJson: {
          actionType: proposal.proposedActionType,
          reasonCode: policyEvaluation.reasonCode,
          rationale: policyEvaluation.rationale,
        },
        reasonCode: policyEvaluation.reasonCode,
      });

      // Deterministic stop / exhaust on hard policy deny
      if (
        policyEvaluation.reasonCode === 'KILL_SWITCH_ACTIVE' ||
        policyEvaluation.reasonCode === 'CUSTOMER_OPTED_OUT' ||
        policyEvaluation.reasonCode === 'HARD_CARD_DECLINE'
      ) {
        await this.caseRepo.compareAndSetStatus(merchantId, caseId, currentStatus, CaseStatus.STOPPED);
        return {
          caseId,
          status: CaseStatus.STOPPED,
          iterationCompleted: true,
          planVersion,
          policyDecision: PolicyDecision.DENY,
          stoppedReason: policyEvaluation.rationale,
        };
      }

      if (policyEvaluation.reasonCode === 'MAX_ACTIONS_EXCEEDED' || policyEvaluation.reasonCode === 'MAX_RETRIES_EXCEEDED') {
        await this.caseRepo.compareAndSetStatus(merchantId, caseId, currentStatus, CaseStatus.EXHAUSTED);
        return {
          caseId,
          status: CaseStatus.EXHAUSTED,
          iterationCompleted: true,
          planVersion,
          policyDecision: PolicyDecision.DENY,
          exhaustedReason: policyEvaluation.rationale,
        };
      }

      return {
        caseId,
        status: currentStatus,
        iterationCompleted: false,
        planVersion,
        policyDecision: PolicyDecision.DENY,
        stoppedReason: policyEvaluation.rationale,
      };
    }

    // 9. Policy is ALLOW -> Authorize & Execute via ActionExecutor
    const authResult = await this.actionExecutor.authorizeAndCreateAction(merchantId, caseId, {
      planVersionId: planVersion.id,
      actionType: proposal.proposedActionType,
      actionParams: proposal.proposedActionParams,
      policyEvaluation,
      attemptOrVersion: nextVersionNumber,
    });

    if (!authResult.authorized || !authResult.action) {
      return {
        caseId,
        status: currentStatus,
        iterationCompleted: false,
        planVersion,
        policyDecision: PolicyDecision.DENY,
        error: authResult.reason || 'Failed to authorize action',
      };
    }

    const actionExecution = await this.actionExecutor.executeAction(merchantId, authResult.action.id);

    // 10. Check if action puts case into WAITING status
    let finalStatus = currentStatus;
    if (actionExecution.success) {
      if (this.isWaitingAction(proposal.proposedActionType)) {
        const waitingCase = await this.caseRepo.compareAndSetStatus(
          merchantId,
          caseId,
          currentStatus,
          CaseStatus.WAITING,
        );
        finalStatus = waitingCase.status;

        // Schedule follow-up timer durably
        if (this.jobScheduler) {
          const followUpSeconds = proposal.followUpAfterSeconds || 86400; // default 24h
          const scheduledFor = new Date(currentTime.getTime() + followUpSeconds * 1000);

          await this.jobScheduler.schedule({
            merchantId,
            caseId,
            jobType: 'RECOVERY_FOLLOWUP_CHECK',
            scheduledFor,
            payloadJson: {
              caseId,
              planVersionId: planVersion.id,
              actionId: authResult.action.id,
            },
          });

          await this.auditRepo.record(merchantId, {
            caseId,
            eventType: 'CASE_WAITING',
            actorType: AuditActorType.SYSTEM,
            inputSummaryJson: {
              actionType: proposal.proposedActionType,
              followUpSeconds,
              scheduledFor,
            },
            reasonCode: 'CASE_ENTERED_WAITING_FOR_RESPONSE',
          });
        }
      }
    }

    return {
      caseId,
      status: finalStatus,
      iterationCompleted: true,
      planVersion,
      action: actionExecution.action,
      policyDecision: PolicyDecision.ALLOW,
    };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Private Helpers
  // ──────────────────────────────────────────────────────────────────────────

  private checkEligibility(
    c: CaseWithRelations,
    killSwitchActive: boolean,
    policyConfig: { maxRecoveryWindowDays: number; maxActionsPerCase: number },
    now: Date,
  ): EligibilityCheckResult {
    // 1. Terminal states
    if (c.status === CaseStatus.RECOVERED || c.status === CaseStatus.STOPPED || c.status === CaseStatus.EXHAUSTED) {
      return { eligible: false, terminalState: true, reason: `Case is already in terminal state: ${c.status}` };
    }

    // 2. Human review state
    if (c.status === CaseStatus.NEEDS_REVIEW) {
      return { eligible: false, needsReview: true, reason: 'Case is awaiting human review' };
    }

    // 3. Kill switch
    if (killSwitchActive) {
      return { eligible: false, shouldStop: true, reason: 'Merchant kill switch is active' };
    }

    // 4. Customer opt-out
    if (c.customer?.optedOut) {
      return { eligible: false, shouldStop: true, reason: 'Customer has opted out of communication' };
    }

    // 5. Recovery window
    const maxWindowDays = policyConfig.maxRecoveryWindowDays ?? 30;
    const windowEnd = new Date(c.openedAt.getTime() + maxWindowDays * 24 * 60 * 60 * 1000);
    if (now.getTime() > windowEnd.getTime()) {
      return { eligible: false, shouldExhaust: true, reason: `Recovery window of ${maxWindowDays} days has expired` };
    }

    // 6. Max actions per case
    const totalActions = (c.actions || []).length;
    if (totalActions >= policyConfig.maxActionsPerCase) {
      return { eligible: false, shouldExhaust: true, reason: `Max actions limit (${policyConfig.maxActionsPerCase}) reached` };
    }

    return { eligible: true };
  }

  private computeAllowedActions(
    c: CaseWithRelations,
    policyConfig: { maxRetriesPerCase: number; maxContactsPerCase: number; cooldownHoursBetweenActions: number },
  ): RecoveryActionType[] {
    const allActions: RecoveryActionType[] = [
      RecoveryActionType.RETRY_PAYMENT,
      RecoveryActionType.REQUEST_PAYMENT_UPDATE,
      RecoveryActionType.CREATE_OR_SEND_PAYMENT_LINK,
      RecoveryActionType.SEND_CHECKOUT_RECOVERY,
      RecoveryActionType.SEND_RECEIVABLE_REMINDER,
      RecoveryActionType.RECORD_PROMISE_TO_PAY,
      RecoveryActionType.SCHEDULE_FOLLOWUP,
      RecoveryActionType.ESCALATE_TO_HUMAN,
      RecoveryActionType.STOP_RECOVERY,
    ];

    // Filter by risk compatibility
    let compatible = allActions.filter((a) => isActionCompatible(c.riskType, a));

    // If customer opted out, exclude communication actions
    if (c.customer?.optedOut) {
      compatible = compatible.filter((a) => !this.isContactAction(a));
    }

    // Hard decline check
    const failureCode = typeof (c.contextJson as Record<string, unknown> | null)?.verifiedPaymentFailureCode === 'string'
      ? ((c.contextJson as Record<string, unknown>).verifiedPaymentFailureCode as string)
      : null;

    if (isHardDecline(failureCode)) {
      // If hard decline (e.g. CARD_EXPIRED), has a payment method updated outcome occurred?
      const hasMethodUpdated = (c.outcomes || []).some(
        (o) => o.outcomeType === 'PAYMENT_METHOD_UPDATED',
      );
      if (!hasMethodUpdated) {
        // Method NOT updated -> RETRY_PAYMENT is prohibited
        compatible = compatible.filter((a) => a !== RecoveryActionType.RETRY_PAYMENT);
      }
    }

    // Retry limit
    const retryCount = (c.actions || []).filter((a) => a.actionType === RecoveryActionType.RETRY_PAYMENT).length;
    if (retryCount >= policyConfig.maxRetriesPerCase) {
      compatible = compatible.filter((a) => a !== RecoveryActionType.RETRY_PAYMENT);
    }

    // Contact limit
    const contactCount = (c.actions || []).filter((a) => this.isContactAction(a.actionType)).length;
    if (contactCount >= policyConfig.maxContactsPerCase) {
      compatible = compatible.filter((a) => !this.isContactAction(a));
    }

    return compatible;
  }

  private isContactAction(actionType: RecoveryActionType): boolean {
    return (
      actionType === RecoveryActionType.REQUEST_PAYMENT_UPDATE ||
      actionType === RecoveryActionType.CREATE_OR_SEND_PAYMENT_LINK ||
      actionType === RecoveryActionType.SEND_CHECKOUT_RECOVERY ||
      actionType === RecoveryActionType.SEND_RECEIVABLE_REMINDER
    );
  }

  private isWaitingAction(actionType: RecoveryActionType): boolean {
    return (
      actionType === RecoveryActionType.REQUEST_PAYMENT_UPDATE ||
      actionType === RecoveryActionType.CREATE_OR_SEND_PAYMENT_LINK ||
      actionType === RecoveryActionType.SEND_CHECKOUT_RECOVERY ||
      actionType === RecoveryActionType.SEND_RECEIVABLE_REMINDER ||
      actionType === RecoveryActionType.RECORD_PROMISE_TO_PAY
    );
  }
}

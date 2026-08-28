import {
  ActionExecutionStatus,
  AuditActorType,
  CaseStatus,
  PolicyDecision,
  RecoveryAction,
  RecoveryActionType,
} from '@prisma/client';
import {
  ActionRepository,
  AuditRepository,
  CaseRepository,
  CustomerRepository,
  MerchantRepository,
  PolicyConfigRepository,
  CaseWithRelations,
} from '@recoverai/db';
import { IPolicyEngine, PolicyExecutionContext } from './policy-interface.js';
import {
  ProviderActionInput,
  ProviderActionResult,
  ProviderExecutionOutcome,
  ProviderRegistry,
} from './provider-interface.js';
import { ActionExecutionError } from '@recoverai/shared';
import { IJobScheduler } from '../detection/job-scheduler-interface.js';
import { generateActionIdempotencyKey } from './idempotency-generator.js';

export interface ActionExecutorOptions {
  actionRepo: ActionRepository;
  caseRepo: CaseRepository;
  customerRepo: CustomerRepository;
  policyConfigRepo: PolicyConfigRepository;
  auditRepo: AuditRepository;
  merchantRepo?: MerchantRepository;
  policyEngine: IPolicyEngine;
  providerRegistry: ProviderRegistry;
  jobScheduler?: IJobScheduler;
  clock?: () => Date;
}


export interface AuthorizeActionParams {
  planVersionId?: string;
  actionType: RecoveryActionType;
  actionParams: Record<string, unknown>;
  policyDecision: PolicyDecision;
  policyRationale: string;
  attemptOrVersion?: string | number;
}

export interface ActionExecutionResult {
  executed: boolean;
  success?: boolean;
  alreadyClaimed?: boolean;
  blockedByPolicy?: boolean;
  policyDecision?: PolicyDecision;
  policyReasonCode?: string;
  rationale?: string;
  action?: RecoveryAction | null;
  result?: ProviderActionResult;
  error?: string;
}

export class ActionExecutor {
  private actionRepo: ActionRepository;
  private caseRepo: CaseRepository;
  private customerRepo: CustomerRepository;
  private policyConfigRepo: PolicyConfigRepository;
  private auditRepo: AuditRepository;
  private merchantRepo?: MerchantRepository;
  private policyEngine: IPolicyEngine;
  private providerRegistry: ProviderRegistry;
  private jobScheduler?: IJobScheduler;
  private clock?: () => Date;

  constructor(options: ActionExecutorOptions) {
    this.actionRepo = options.actionRepo;
    this.caseRepo = options.caseRepo;
    this.customerRepo = options.customerRepo;
    this.policyConfigRepo = options.policyConfigRepo;
    this.auditRepo = options.auditRepo;
    this.merchantRepo = options.merchantRepo;
    this.policyEngine = options.policyEngine;
    this.providerRegistry = options.providerRegistry;
    this.jobScheduler = options.jobScheduler;
    this.clock = options.clock;
  }


  /**
   * Creates an authoritative RecoveryAction record only when PolicyDecision is ALLOW.
   * For DENY or REVIEW, records the appropriate audit trail and does not create an executable action.
   */
  async authorizeAndCreateAction(
    merchantId: string,
    caseId: string,
    params: AuthorizeActionParams,
  ): Promise<{ action: RecoveryAction | null; authorized: boolean; reason?: string }> {
    const idempotencyKey = generateActionIdempotencyKey(
      merchantId,
      caseId,
      params.actionType,
      params.attemptOrVersion || params.planVersionId || 'v1',
    );

    if (params.policyDecision === PolicyDecision.DENY) {
      await this.auditRepo.record(merchantId, {
        caseId,
        eventType: 'ACTION_BLOCKED_BY_POLICY',
        actorType: AuditActorType.POLICY,
        inputSummaryJson: {
          actionType: params.actionType,
          idempotencyKey,
          planVersionId: params.planVersionId,
        },
        outputSummaryJson: {
          decision: PolicyDecision.DENY,
          rationale: params.policyRationale,
        },
        reasonCode: 'POLICY_DENIED_ACTION',
      });
      return { action: null, authorized: false, reason: params.policyRationale };
    }

    if (params.policyDecision === PolicyDecision.REVIEW) {
      await this.auditRepo.record(merchantId, {
        caseId,
        eventType: 'ACTION_BLOCKED_BY_POLICY',
        actorType: AuditActorType.POLICY,
        inputSummaryJson: {
          actionType: params.actionType,
          idempotencyKey,
          planVersionId: params.planVersionId,
        },
        outputSummaryJson: {
          decision: PolicyDecision.REVIEW,
          rationale: params.policyRationale,
        },
        reasonCode: 'POLICY_REVIEW_REQUIRED',
      });
      return { action: null, authorized: false, reason: params.policyRationale };
    }

    // PolicyDecision is ALLOW -> create authoritative RecoveryAction
    const action = await this.actionRepo.createAction(merchantId, caseId, {
      planVersionId: params.planVersionId,
      actionType: params.actionType,
      actionParams: params.actionParams,
      idempotencyKey,
      policyDecision: PolicyDecision.ALLOW,
      policyRationale: params.policyRationale,
      status: ActionExecutionStatus.PENDING,
    });

    await this.auditRepo.record(merchantId, {
      caseId,
      eventType: 'ACTION_AUTHORIZED',
      actorType: AuditActorType.POLICY,
      inputSummaryJson: {
        actionId: action.id,
        actionType: action.actionType,
        idempotencyKey,
        planVersionId: params.planVersionId,
      },
      outputSummaryJson: {
        decision: PolicyDecision.ALLOW,
        rationale: params.policyRationale,
        status: ActionExecutionStatus.PENDING,
      },
      reasonCode: 'POLICY_ALLOWED_ACTION',
    });

    return { action, authorized: true };
  }

  /**
   * Executes an authoritative RecoveryAction through fresh policy revalidation,
   * atomic claiming, and provider execution.
   */
  async executeAction(merchantId: string, actionId: string): Promise<ActionExecutionResult> {
    // 1. Verify tenant ownership of action
    const action = await this.actionRepo.getActionById(merchantId, actionId);
    if (!action) {
      throw new Error(`RecoveryAction "${actionId}" not found or unauthorized under merchant "${merchantId}"`);
    }

    if (action.status !== ActionExecutionStatus.PENDING) {
      return {
        executed: false,
        alreadyClaimed: true,
        action,
      };
    }

    // 2. Load fresh authoritative context from database
    const caseRecord = await this.caseRepo.getCaseById(merchantId, action.caseId);
    if (!caseRecord) {
      throw new Error(`RevenueRiskCase "${action.caseId}" not found for merchant "${merchantId}"`);
    }

    // If case is in terminal state, abort immediately
    if (
      caseRecord.status === CaseStatus.RECOVERED ||
      caseRecord.status === CaseStatus.STOPPED ||
      caseRecord.status === CaseStatus.EXHAUSTED
    ) {
      await this.actionRepo.updateActionStatus(merchantId, actionId, {
        status: ActionExecutionStatus.CANCELLED,
        errorMessage: `Cannot execute action: Case is in terminal state "${caseRecord.status}"`,
      });

      await this.auditRepo.record(merchantId, {
        caseId: caseRecord.id,
        eventType: 'ACTION_BLOCKED_BY_POLICY',
        actorType: AuditActorType.POLICY,
        inputSummaryJson: {
          actionId,
          actionType: action.actionType,
          idempotencyKey: action.idempotencyKey,
        },
        outputSummaryJson: {
          decision: PolicyDecision.DENY,
          rationale: `Case is in terminal state "${caseRecord.status}"`,
        },
        reasonCode: 'TERMINAL_CASE_STATE',
      });

      return {
        executed: false,
        blockedByPolicy: true,
        policyDecision: PolicyDecision.DENY,
        rationale: `Case is in terminal state "${caseRecord.status}"`,
        action,
      };
    }

    const policyConfig = await this.policyConfigRepo.getOrCreateConfig(merchantId);

    let killSwitchActive = false;
    if (this.merchantRepo) {
      const merchant = await this.merchantRepo.getMerchantById(merchantId);
      killSwitchActive = merchant?.killSwitchActive || false;
    }

    // 3. Fresh Policy Revalidation immediately before dispatch
    const freshContext: PolicyExecutionContext = {
      merchantId,
      killSwitchActive,
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
        status: caseRecord.status,
        openedAt: caseRecord.openedAt,
        diagnosisCode: typeof (caseRecord.contextJson as Record<string, unknown> | null)?.diagnosisCode === 'string'
          ? ((caseRecord.contextJson as Record<string, unknown>).diagnosisCode as string)
          : null,
      },
      customer: caseRecord.customer ? {
        id: caseRecord.customer.id,
        contactConsent: caseRecord.customer.contactConsent,
        optedOut: caseRecord.customer.optedOut,
        lastContactedAt: caseRecord.customer.lastContactedAt,
      } : null,
      proposedActionType: action.actionType,
      proposedActionParams: action.actionParams as Record<string, unknown>,
      verifiedPaymentFailureCode: typeof (caseRecord.contextJson as Record<string, unknown> | null)?.verifiedPaymentFailureCode === 'string'
        ? ((caseRecord.contextJson as Record<string, unknown>).verifiedPaymentFailureCode as string)
        : null,
      priorActions: (caseRecord.actions || [])
        .filter((a) => a.id !== actionId)
        .map((a) => ({
          actionType: a.actionType,
          executedAt: a.executedAt || a.createdAt,
          status: a.status,
          policyDecision: a.policyDecision,
          errorMessage: a.errorMessage,
        })),
      priorOutcomes: (caseRecord.outcomes || []).map((o) => ({
        outcomeType: o.outcomeType,
        observedAt: o.observedAt,
        amountRecovered: o.amountRecovered?.toString(),
      })),
      currentTime: this.clock ? this.clock() : new Date(),
    };

    const revalidation = this.policyEngine.evaluate(freshContext);

    if (revalidation.decision === PolicyDecision.DENY) {
      const updatedAction = await this.actionRepo.updateActionStatus(merchantId, actionId, {
        status: ActionExecutionStatus.CANCELLED,
        errorMessage: `Fresh policy revalidation DENY: ${revalidation.rationale}`,
      });

      await this.auditRepo.record(merchantId, {
        caseId: caseRecord.id,
        eventType: 'ACTION_BLOCKED_BY_POLICY',
        actorType: AuditActorType.POLICY,
        inputSummaryJson: {
          actionId,
          actionType: action.actionType,
          idempotencyKey: action.idempotencyKey,
        },
        outputSummaryJson: {
          decision: PolicyDecision.DENY,
          reasonCode: revalidation.reasonCode,
          rationale: revalidation.rationale,
        },
        reasonCode: revalidation.reasonCode,
      });

      return {
        executed: false,
        blockedByPolicy: true,
        policyDecision: PolicyDecision.DENY,
        policyReasonCode: revalidation.reasonCode,
        rationale: revalidation.rationale,
        action: updatedAction,
      };
    }

    if (revalidation.decision === PolicyDecision.REVIEW) {
      const updatedAction = await this.actionRepo.updateActionStatus(merchantId, actionId, {
        status: ActionExecutionStatus.CANCELLED,
        errorMessage: `Fresh policy revalidation REVIEW: ${revalidation.rationale}`,
      });

      await this.auditRepo.record(merchantId, {
        caseId: caseRecord.id,
        eventType: 'ACTION_BLOCKED_BY_POLICY',
        actorType: AuditActorType.POLICY,
        inputSummaryJson: {
          actionId,
          actionType: action.actionType,
          idempotencyKey: action.idempotencyKey,
        },
        outputSummaryJson: {
          decision: PolicyDecision.REVIEW,
          reasonCode: revalidation.reasonCode,
          rationale: revalidation.rationale,
        },
        reasonCode: revalidation.reasonCode,
      });

      return {
        executed: false,
        blockedByPolicy: true,
        policyDecision: PolicyDecision.REVIEW,
        policyReasonCode: revalidation.reasonCode,
        rationale: revalidation.rationale,
        action: updatedAction,
      };
    }

    // Policy revalidation passed (ALLOW)
    await this.auditRepo.record(merchantId, {
      caseId: caseRecord.id,
      eventType: 'ACTION_POLICY_REVALIDATED',
      actorType: AuditActorType.POLICY,
      inputSummaryJson: {
        actionId,
        actionType: action.actionType,
        idempotencyKey: action.idempotencyKey,
      },
      outputSummaryJson: {
        decision: PolicyDecision.ALLOW,
        reasonCode: revalidation.reasonCode,
        rationale: revalidation.rationale,
      },
      reasonCode: revalidation.reasonCode,
    });

    // 4. Atomic Claim: PENDING -> EXECUTING
    const claimResult = await this.actionRepo.claimActionForExecution(merchantId, actionId);
    if (!claimResult.claimed) {
      return {
        executed: false,
        alreadyClaimed: true,
        action: claimResult.action,
      };
    }

    await this.auditRepo.record(merchantId, {
      caseId: caseRecord.id,
      eventType: 'ACTION_CLAIMED',
      actorType: AuditActorType.SYSTEM,
      inputSummaryJson: {
        actionId,
        actionType: action.actionType,
        idempotencyKey: action.idempotencyKey,
      },
      reasonCode: 'ACTION_ATOMICALLY_CLAIMED',
    });

    await this.auditRepo.record(merchantId, {
      caseId: caseRecord.id,
      eventType: 'ACTION_DISPATCHED',
      actorType: AuditActorType.SYSTEM,
      inputSummaryJson: {
        actionId,
        actionType: action.actionType,
        idempotencyKey: action.idempotencyKey,
      },
      reasonCode: 'DISPATCHING_TO_PROVIDER',
    });

    // 5. Dispatch / Execution
    // Check if internal action
    if (this.isInternalAction(action.actionType)) {
      return this.executeInternalAction(merchantId, action, caseRecord);
    }

    // External action: resolve provider and execute
    const provider = this.providerRegistry.getProviderForAction(action.actionType);
    if (!provider) {
      const failedAction = await this.actionRepo.updateActionStatus(merchantId, actionId, {
        status: ActionExecutionStatus.FAILED,
        errorMessage: `No provider registered for action type: ${action.actionType}`,
      });

      await this.auditRepo.record(merchantId, {
        caseId: caseRecord.id,
        eventType: 'ACTION_FAILED',
        actorType: AuditActorType.SYSTEM,
        inputSummaryJson: {
          actionId,
          actionType: action.actionType,
          idempotencyKey: action.idempotencyKey,
        },
        outputSummaryJson: {
          error: `No provider registered for action type: ${action.actionType}`,
        },
        reasonCode: 'NO_PROVIDER_AVAILABLE',
      });

      return {
        executed: true,
        success: false,
        action: failedAction,
        error: `No provider registered for action type: ${action.actionType}`,
      };
    }

    const providerInput: ProviderActionInput = {
      merchantId,
      caseId: caseRecord.id,
      actionId: action.id,
      actionType: action.actionType,
      idempotencyKey: action.idempotencyKey,
      actionParams: action.actionParams as Record<string, unknown>,
      customer: caseRecord.customer ? {
        id: caseRecord.customer.id,
        name: caseRecord.customer.name || undefined,
        email: caseRecord.customer.email || undefined,
        phone: caseRecord.customer.phone || undefined,
        externalCustomerId: caseRecord.customer.externalCustomerId || undefined,
      } : undefined,
      caseSummary: {
        riskType: caseRecord.riskType,
        amountAtRisk: caseRecord.amountAtRisk.toString(),
        currency: caseRecord.currency,
      },
    };

    try {
      const providerResult = await provider.execute(providerInput);

      if (providerResult.outcome === ProviderExecutionOutcome.SUCCESS) {
        const succeededAction = await this.actionRepo.updateActionStatus(merchantId, actionId, {
          status: ActionExecutionStatus.SUCCESS,
          providerName: providerResult.providerName,
          externalActionId: providerResult.externalActionId,
          executionMetadata: providerResult.metadata,
        });

        // If contact action, update customer lastContactedAt
        if (caseRecord.customer && this.isContactAction(action.actionType)) {
          await this.customerRepo.updateLastContactedAt(merchantId, caseRecord.customer.id, new Date());
        }

        await this.auditRepo.record(merchantId, {
          caseId: caseRecord.id,
          eventType: 'ACTION_SUCCEEDED',
          actorType: AuditActorType.PROVIDER,
          inputSummaryJson: {
            actionId,
            actionType: action.actionType,
            idempotencyKey: action.idempotencyKey,
          },
          outputSummaryJson: {
            providerName: providerResult.providerName,
            isSimulated: providerResult.isSimulated,
            externalActionId: providerResult.externalActionId,
            metadata: providerResult.metadata,
          },
          reasonCode: 'PROVIDER_ACTION_SUCCESS',
        });

        return {
          executed: true,
          success: true,
          action: succeededAction,
          result: providerResult,
        };
      }

      // Provider reported failure (RETRYABLE_FAILURE or PERMANENT_FAILURE)
      const failedAction = await this.actionRepo.updateActionStatus(merchantId, actionId, {
        status: ActionExecutionStatus.FAILED,
        providerName: providerResult.providerName,
        externalActionId: providerResult.externalActionId,
        errorMessage: providerResult.errorMessage || 'Provider reported failure',
        executionMetadata: {
          outcome: providerResult.outcome,
          errorClassification: providerResult.errorClassification,
          metadata: providerResult.metadata,
        },
      });

      await this.auditRepo.record(merchantId, {
        caseId: caseRecord.id,
        eventType: 'ACTION_FAILED',
        actorType: AuditActorType.PROVIDER,
        inputSummaryJson: {
          actionId,
          actionType: action.actionType,
          idempotencyKey: action.idempotencyKey,
        },
        outputSummaryJson: {
          outcome: providerResult.outcome,
          errorClassification: providerResult.errorClassification,
          errorMessage: providerResult.errorMessage,
          providerName: providerResult.providerName,
          isSimulated: providerResult.isSimulated,
        },
        reasonCode: providerResult.errorClassification || 'PROVIDER_ACTION_FAILED',
      });

      return {
        executed: true,
        success: false,
        action: failedAction,
        result: providerResult,
        error: providerResult.errorMessage,
      };
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);

      await this.actionRepo.updateActionStatus(merchantId, actionId, {
        status: ActionExecutionStatus.FAILED,
        errorMessage: errMsg,
      });

      await this.auditRepo.record(merchantId, {
        caseId: caseRecord.id,
        eventType: 'ACTION_FAILED',
        actorType: AuditActorType.PROVIDER,
        inputSummaryJson: {
          actionId,
          actionType: action.actionType,
          idempotencyKey: action.idempotencyKey,
        },
        outputSummaryJson: {
          exception: errMsg,
        },
        reasonCode: 'UNHANDLED_PROVIDER_EXCEPTION',
      });

      throw new ActionExecutionError(actionId, action.actionType, errMsg, err);
    }
  }

  private isInternalAction(actionType: RecoveryActionType): boolean {
    return (
      actionType === RecoveryActionType.STOP_RECOVERY ||
      actionType === RecoveryActionType.ESCALATE_TO_HUMAN ||
      actionType === RecoveryActionType.SCHEDULE_FOLLOWUP ||
      actionType === RecoveryActionType.RECORD_PROMISE_TO_PAY
    );
  }

  private isContactAction(actionType: RecoveryActionType): boolean {
    return (
      actionType === RecoveryActionType.REQUEST_PAYMENT_UPDATE ||
      actionType === RecoveryActionType.CREATE_OR_SEND_PAYMENT_LINK ||
      actionType === RecoveryActionType.SEND_CHECKOUT_RECOVERY ||
      actionType === RecoveryActionType.SEND_RECEIVABLE_REMINDER
    );
  }

  private async executeInternalAction(
    merchantId: string,
    action: RecoveryAction,
    caseRecord: CaseWithRelations,
  ): Promise<ActionExecutionResult> {
    const actionId = action.id;

    if (action.actionType === RecoveryActionType.STOP_RECOVERY) {
      await this.caseRepo.compareAndSetStatus(
        merchantId,
        caseRecord.id,
        caseRecord.status,
        CaseStatus.STOPPED,
      );

      const succeededAction = await this.actionRepo.updateActionStatus(merchantId, actionId, {
        status: ActionExecutionStatus.SUCCESS,
        executionMetadata: { internalAction: 'STOP_RECOVERY' },
      });

      await this.auditRepo.record(merchantId, {
        caseId: caseRecord.id,
        eventType: 'ACTION_SUCCEEDED',
        actorType: AuditActorType.SYSTEM,
        inputSummaryJson: { actionId, actionType: action.actionType },
        outputSummaryJson: { transitionedCaseStatus: CaseStatus.STOPPED },
        reasonCode: 'RECOVERY_STOPPED',
      });

      return {
        executed: true,
        success: true,
        action: succeededAction,
      };
    }

    if (action.actionType === RecoveryActionType.ESCALATE_TO_HUMAN) {
      await this.caseRepo.compareAndSetStatus(
        merchantId,
        caseRecord.id,
        caseRecord.status,
        CaseStatus.NEEDS_REVIEW,
      );

      const succeededAction = await this.actionRepo.updateActionStatus(merchantId, actionId, {
        status: ActionExecutionStatus.SUCCESS,
        executionMetadata: { internalAction: 'ESCALATE_TO_HUMAN' },
      });

      await this.auditRepo.record(merchantId, {
        caseId: caseRecord.id,
        eventType: 'ACTION_SUCCEEDED',
        actorType: AuditActorType.SYSTEM,
        inputSummaryJson: { actionId, actionType: action.actionType },
        outputSummaryJson: { transitionedCaseStatus: CaseStatus.NEEDS_REVIEW },
        reasonCode: 'ESCALATED_TO_HUMAN',
      });

      return {
        executed: true,
        success: true,
        action: succeededAction,
      };
    }

    if (action.actionType === RecoveryActionType.SCHEDULE_FOLLOWUP) {
      const params = action.actionParams as Record<string, unknown>;
      const scheduledFor = params.scheduledFor ? new Date(params.scheduledFor as string) : new Date(Date.now() + 86400000);

      if (this.jobScheduler) {
        await this.jobScheduler.schedule({
          merchantId,
          caseId: caseRecord.id,
          jobType: 'RECOVERY_FOLLOWUP_CHECK',
          scheduledFor,
          payloadJson: {
            caseId: caseRecord.id,
            actionId: action.id,
          },
        });
      }

      const succeededAction = await this.actionRepo.updateActionStatus(merchantId, actionId, {
        status: ActionExecutionStatus.SUCCESS,
        executionMetadata: { internalAction: 'SCHEDULE_FOLLOWUP', scheduledFor: scheduledFor.toISOString() },
      });

      await this.auditRepo.record(merchantId, {
        caseId: caseRecord.id,
        eventType: 'ACTION_SUCCEEDED',
        actorType: AuditActorType.SYSTEM,
        inputSummaryJson: { actionId, actionType: action.actionType, scheduledFor },
        outputSummaryJson: { status: 'SCHEDULED' },
        reasonCode: 'FOLLOWUP_SCHEDULED',
      });

      return {
        executed: true,
        success: true,
        action: succeededAction,
      };
    }

    if (action.actionType === RecoveryActionType.RECORD_PROMISE_TO_PAY) {
      const params = action.actionParams as Record<string, unknown>;

      const succeededAction = await this.actionRepo.updateActionStatus(merchantId, actionId, {
        status: ActionExecutionStatus.SUCCESS,
        executionMetadata: { internalAction: 'RECORD_PROMISE_TO_PAY', ...params },
      });

      await this.auditRepo.record(merchantId, {
        caseId: caseRecord.id,
        eventType: 'ACTION_SUCCEEDED',
        actorType: AuditActorType.SYSTEM,
        inputSummaryJson: { actionId, actionType: action.actionType, params },
        outputSummaryJson: { status: 'RECORDED' },
        reasonCode: 'PROMISE_TO_PAY_RECORDED',
      });

      return {
        executed: true,
        success: true,
        action: succeededAction,
      };
    }

    throw new Error(`Unhandled internal action type: ${action.actionType}`);
  }
}

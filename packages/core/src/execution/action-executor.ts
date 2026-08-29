import {
  ActionExecutionStatus,
  AuditActorType,
  CaseStatus,
  PolicyDecision,
  RecoveryAction,
  RecoveryActionType,
  ReviewStatus,
} from '@prisma/client';
import {
  ActionRepository,
  AuditRepository,
  CaseRepository,
  CommitmentRepository,
  CustomerRepository,
  HumanReviewRepository,
  MerchantRepository,
  PolicyConfigRepository,
  CaseWithRelations,
} from '@recoverai/db';
import {
  IPolicyEngine,
  PolicyEvaluationResult,
  PolicyExecutionContext,
  PolicyExecutionSource,
} from './policy-interface.js';
import {
  ProviderActionInput,
  ProviderActionResult,
  ProviderExecutionOutcome,
  ProviderRegistry,
} from './provider-interface.js';
import { ActionExecutionError } from '@recoverai/shared';
import { IJobScheduler } from '../detection/job-scheduler-interface.js';
import { generateActionIdempotencyKey } from './idempotency-generator.js';

function semanticJsonEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left === null || right === null) return false;
  if (typeof left !== typeof right) return false;

  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    return left.every((value, index) => semanticJsonEqual(value, right[index]));
  }

  if (typeof left === 'object' && typeof right === 'object') {
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const leftKeys = Object.keys(leftRecord).sort();
    const rightKeys = Object.keys(rightRecord).sort();

    if (leftKeys.length !== rightKeys.length) return false;
    for (let i = 0; i < leftKeys.length; i += 1) {
      if (leftKeys[i] !== rightKeys[i]) return false;
      if (!semanticJsonEqual(leftRecord[leftKeys[i]], rightRecord[rightKeys[i]])) return false;
    }
    return true;
  }

  return false;
}

export interface ActionExecutorOptions {
  actionRepo: ActionRepository;
  caseRepo: CaseRepository;
  customerRepo: CustomerRepository;
  policyConfigRepo: PolicyConfigRepository;
  auditRepo: AuditRepository;
  /** MANDATORY for authoritative kill-switch evaluation. */
  merchantRepo: MerchantRepository;
  commitmentRepo?: CommitmentRepository;
  /**
   * Optional injection for tests/composition. When omitted, the repository is
   * constructed from the shared Prisma client. Human-review authority always
   * fails closed if durable review state cannot be read.
   */
  humanReviewRepo?: HumanReviewRepository;
  policyEngine: IPolicyEngine;
  providerRegistry: ProviderRegistry;
  jobScheduler?: IJobScheduler;
  clock?: () => Date;
}

export interface AuthorizeActionParams {
  planVersionId?: string;
  actionType: RecoveryActionType;
  actionParams: Record<string, unknown>;
  policyEvaluation: PolicyEvaluationResult;
  attemptOrVersion?: string | number;
  /**
   * Deprecated compatibility input. It is deliberately NOT persisted or trusted.
   * Human-review authority is derived from fresh durable HumanReview state at
   * execution time, never from this caller-provided string.
   */
  executionSource?: PolicyExecutionSource;
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
  private merchantRepo: MerchantRepository;
  private commitmentRepo?: CommitmentRepository;
  private humanReviewRepo: HumanReviewRepository;
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
    this.commitmentRepo = options.commitmentRepo;
    this.humanReviewRepo = options.humanReviewRepo || new HumanReviewRepository();
    this.policyEngine = options.policyEngine;
    this.providerRegistry = options.providerRegistry;
    this.jobScheduler = options.jobScheduler;
    this.clock = options.clock;
  }

  async authorizeAndCreateAction(
    merchantId: string,
    caseId: string,
    params: AuthorizeActionParams,
  ): Promise<{ action: RecoveryAction | null; authorized: boolean; reason?: string }> {
    const { policyEvaluation } = params;
    const idempotencyKey = generateActionIdempotencyKey(
      merchantId,
      caseId,
      params.actionType,
      params.attemptOrVersion || params.planVersionId || 'v1',
    );

    if (policyEvaluation.decision === PolicyDecision.DENY) {
      await this.auditRepo.record(merchantId, {
        caseId,
        eventType: 'ACTION_BLOCKED_BY_POLICY',
        actorType: AuditActorType.POLICY,
        inputSummaryJson: {
          actionType: params.actionType,
          idempotencyKey,
          planVersionId: params.planVersionId,
          evaluatedAt: policyEvaluation.evaluatedAt,
        },
        outputSummaryJson: {
          decision: PolicyDecision.DENY,
          reasonCode: policyEvaluation.reasonCode,
          rationale: policyEvaluation.rationale,
        },
        reasonCode: policyEvaluation.reasonCode,
      });
      return { action: null, authorized: false, reason: policyEvaluation.rationale };
    }

    if (policyEvaluation.decision === PolicyDecision.REVIEW) {
      await this.auditRepo.record(merchantId, {
        caseId,
        eventType: 'ACTION_BLOCKED_BY_POLICY',
        actorType: AuditActorType.POLICY,
        inputSummaryJson: {
          actionType: params.actionType,
          idempotencyKey,
          planVersionId: params.planVersionId,
          evaluatedAt: policyEvaluation.evaluatedAt,
        },
        outputSummaryJson: {
          decision: PolicyDecision.REVIEW,
          reasonCode: policyEvaluation.reasonCode,
          rationale: policyEvaluation.rationale,
        },
        reasonCode: policyEvaluation.reasonCode,
      });
      return { action: null, authorized: false, reason: policyEvaluation.rationale };
    }

    const existing = await this.actionRepo.findActionByIdempotencyKey(merchantId, idempotencyKey);
    if (existing) {
      return { action: existing, authorized: true };
    }

    const action = await this.actionRepo.createAction(merchantId, caseId, {
      planVersionId: params.planVersionId,
      actionType: params.actionType,
      actionParams: params.actionParams,
      idempotencyKey,
      policyDecision: PolicyDecision.ALLOW,
      policyRationale: policyEvaluation.rationale,
      status: ActionExecutionStatus.PENDING,
      // Never persist caller-supplied executionSource as authority.
      executionMetadata: undefined,
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
        evaluatedAt: policyEvaluation.evaluatedAt,
      },
      outputSummaryJson: {
        decision: PolicyDecision.ALLOW,
        reasonCode: policyEvaluation.reasonCode,
        rationale: policyEvaluation.rationale,
        status: ActionExecutionStatus.PENDING,
      },
      reasonCode: 'POLICY_ALLOWED_ACTION',
    });

    return { action, authorized: true };
  }

  /**
   * Executes an authoritative RecoveryAction. The optional executionSource field
   * is retained only for source compatibility and is ignored. Human-review
   * authority is resolved exclusively from fresh APPROVED HumanReview records
   * bound to this merchant/case and exact reviewed proposal/action.
   */
  async executeAction(
    merchantId: string,
    actionId: string,
    _options?: { executionSource?: PolicyExecutionSource },
  ): Promise<ActionExecutionResult> {
    const action = await this.actionRepo.getActionById(merchantId, actionId);
    if (!action) {
      throw new Error(
        `RecoveryAction "${actionId}" not found or unauthorized under merchant "${merchantId}"`,
      );
    }

    if (action.status !== ActionExecutionStatus.PENDING) {
      return {
        executed: false,
        alreadyClaimed: true,
        action,
      };
    }

    const claimResult = await this.actionRepo.claimActionForExecution(merchantId, actionId);
    if (!claimResult.claimed) {
      return {
        executed: false,
        alreadyClaimed: true,
        action: claimResult.action,
      };
    }

    await this.auditRepo.record(merchantId, {
      caseId: action.caseId,
      eventType: 'ACTION_CLAIMED',
      actorType: AuditActorType.SYSTEM,
      inputSummaryJson: {
        actionId,
        actionType: action.actionType,
        idempotencyKey: action.idempotencyKey,
      },
      reasonCode: 'ACTION_ATOMICALLY_CLAIMED',
    });

    let killSwitchActive: boolean;
    try {
      const merchant = await this.merchantRepo.getMerchantById(merchantId);
      if (!merchant) {
        return await this.failActionSafely(
          merchantId,
          actionId,
          action.caseId,
          action.actionType,
          action.idempotencyKey,
          'Merchant not found; cannot evaluate kill switch. Failing closed.',
          'MERCHANT_UNAVAILABLE',
        );
      }
      killSwitchActive = merchant.killSwitchActive;
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return await this.failActionSafely(
        merchantId,
        actionId,
        action.caseId,
        action.actionType,
        action.idempotencyKey,
        `Merchant state unavailable; failing closed: ${errMsg}`,
        'MERCHANT_UNAVAILABLE',
      );
    }

    const caseRecord = await this.caseRepo.getCaseById(merchantId, action.caseId);
    if (!caseRecord) {
      return await this.failActionSafely(
        merchantId,
        actionId,
        action.caseId,
        action.actionType,
        action.idempotencyKey,
        `RevenueRiskCase "${action.caseId}" not found for merchant "${merchantId}"`,
        'CASE_NOT_FOUND',
      );
    }

    const policyConfig = await this.policyConfigRepo.getOrCreateConfig(merchantId);

    const reviewAuthority = await this.resolveAuthoritativeHumanReview(
      merchantId,
      action,
      caseRecord,
    );
    const executionSource: PolicyExecutionSource = reviewAuthority.authorized
      ? 'HUMAN_REVIEW_APPROVAL'
      : 'AUTONOMOUS';

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
        diagnosisCode:
          typeof (caseRecord.contextJson as Record<string, unknown> | null)?.diagnosisCode ===
          'string'
            ? ((caseRecord.contextJson as Record<string, unknown>).diagnosisCode as string)
            : null,
      },
      customer: caseRecord.customer
        ? {
            id: caseRecord.customer.id,
            contactConsent: caseRecord.customer.contactConsent,
            optedOut: caseRecord.customer.optedOut,
            lastContactedAt: caseRecord.customer.lastContactedAt,
          }
        : null,
      proposedActionType: action.actionType,
      proposedActionParams: action.actionParams as Record<string, unknown>,
      verifiedPaymentFailureCode:
        typeof (caseRecord.contextJson as Record<string, unknown> | null)
          ?.verifiedPaymentFailureCode === 'string'
          ? ((caseRecord.contextJson as Record<string, unknown>)
              .verifiedPaymentFailureCode as string)
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
      executionSource,
    };

    const revalidation = this.policyEngine.evaluate(freshContext);

    if (
      revalidation.decision === PolicyDecision.DENY ||
      revalidation.decision === PolicyDecision.REVIEW
    ) {
      const rollback = await this.actionRepo.transitionActionStatus(
        merchantId,
        actionId,
        ActionExecutionStatus.EXECUTING,
        ActionExecutionStatus.CANCELLED,
        {
          errorMessage: `Fresh policy revalidation ${revalidation.decision}: ${revalidation.rationale}`,
        },
      );

      await this.auditRepo.record(merchantId, {
        caseId: caseRecord.id,
        eventType: 'ACTION_BLOCKED_BY_POLICY',
        actorType: AuditActorType.POLICY,
        inputSummaryJson: {
          actionId,
          actionType: action.actionType,
          idempotencyKey: action.idempotencyKey,
          executionSource,
          humanReviewId: reviewAuthority.reviewId,
        },
        outputSummaryJson: {
          decision: revalidation.decision,
          reasonCode: revalidation.reasonCode,
          rationale: revalidation.rationale,
        },
        reasonCode: revalidation.reasonCode,
      });

      return {
        executed: false,
        blockedByPolicy: true,
        policyDecision: revalidation.decision,
        policyReasonCode: revalidation.reasonCode,
        rationale: revalidation.rationale,
        action: rollback.action,
      };
    }

    await this.auditRepo.record(merchantId, {
      caseId: caseRecord.id,
      eventType: 'ACTION_POLICY_REVALIDATED',
      actorType: AuditActorType.POLICY,
      inputSummaryJson: {
        actionId,
        actionType: action.actionType,
        idempotencyKey: action.idempotencyKey,
        executionSource,
        humanReviewId: reviewAuthority.reviewId,
      },
      outputSummaryJson: {
        decision: PolicyDecision.ALLOW,
        reasonCode: revalidation.reasonCode,
        rationale: revalidation.rationale,
      },
      reasonCode: revalidation.reasonCode,
    });

    if (this.isInternalAction(action.actionType)) {
      return this.executeInternalActionSafely(merchantId, action, caseRecord);
    }

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
      customer: caseRecord.customer
        ? {
            id: caseRecord.customer.id,
            name: caseRecord.customer.name || undefined,
            email: caseRecord.customer.email || undefined,
            phone: caseRecord.customer.phone || undefined,
            externalCustomerId: caseRecord.customer.externalCustomerId || undefined,
          }
        : undefined,
      caseSummary: {
        riskType: caseRecord.riskType,
        amountAtRisk: caseRecord.amountAtRisk.toString(),
        currency: caseRecord.currency,
      },
    };

    await this.auditRepo.record(merchantId, {
      caseId: caseRecord.id,
      eventType: 'ACTION_DISPATCHED',
      actorType: AuditActorType.SYSTEM,
      inputSummaryJson: {
        actionId,
        actionType: action.actionType,
        idempotencyKey: action.idempotencyKey,
        providerName: provider.providerName,
        isSimulated: provider.isSimulated,
        humanReviewId: reviewAuthority.reviewId,
      },
      reasonCode: 'DISPATCHING_TO_PROVIDER',
    });

    try {
      const providerResult = await provider.execute(providerInput);

      if (providerResult.outcome === ProviderExecutionOutcome.SUCCESS) {
        const succeededAction = await this.actionRepo.updateActionStatus(merchantId, actionId, {
          status: ActionExecutionStatus.SUCCESS,
          providerName: providerResult.providerName,
          externalActionId: providerResult.externalActionId,
          executionMetadata: providerResult.metadata,
        });

        if (caseRecord.customer && this.isContactAction(action.actionType)) {
          await this.customerRepo.updateLastContactedAt(
            merchantId,
            caseRecord.customer.id,
            new Date(),
          );
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

  /**
   * Resolve the only narrow authority human approval grants. A caller string,
   * action metadata field, or policy result is never enough. We re-read durable
   * APPROVED reviews after the action claim and require same tenant, same case,
   * and exact action/proposal binding.
   */
  private async resolveAuthoritativeHumanReview(
    merchantId: string,
    action: RecoveryAction,
    caseRecord: CaseWithRelations,
  ): Promise<{ authorized: boolean; reviewId?: string }> {
    if (caseRecord.status !== CaseStatus.NEEDS_REVIEW) {
      return { authorized: false };
    }

    let approvedReviews;
    try {
      approvedReviews = await this.humanReviewRepo.listReviews(merchantId, {
        status: ReviewStatus.APPROVED,
        caseId: caseRecord.id,
      });
    } catch {
      // Authority lookup failure must never turn into approval.
      return { authorized: false };
    }

    const planVersions = caseRecord.planVersions || [];
    const latestPlanVersion =
      planVersions.length > 0
        ? planVersions.reduce((prev, curr) => (curr.version > prev.version ? curr : prev))
        : null;

    for (const review of approvedReviews) {
      if (review.merchantId !== merchantId || review.caseId !== caseRecord.id) continue;
      if (review.status !== ReviewStatus.APPROVED) continue;

      // Action-bound reviews authorize only that exact existing action.
      if (review.actionId) {
        if (review.actionId !== action.id || !review.action) continue;
        if (review.action.caseId !== caseRecord.id) continue;
        if (review.action.actionType !== action.actionType) continue;
        if (!semanticJsonEqual(review.action.actionParams, action.actionParams)) continue;

        if (review.planVersionId) {
          if (action.planVersionId !== review.planVersionId || !review.planVersion) continue;
          if (review.planVersion.proposedActionType !== action.actionType) continue;
          if (!semanticJsonEqual(review.planVersion.proposedActionParams, action.actionParams)) {
            continue;
          }
          if (latestPlanVersion && latestPlanVersion.id !== review.planVersionId) continue;
        }

        return { authorized: true, reviewId: review.id };
      }

      // Plan-bound reviews authorize only the exact proposal of the still-current
      // authoritative plan version. Object key order is irrelevant; arrays and
      // primitive values remain exact.
      if (review.planVersionId) {
        if (!action.planVersionId || action.planVersionId !== review.planVersionId) continue;
        if (!review.planVersion) continue;
        if (latestPlanVersion && latestPlanVersion.id !== review.planVersionId) continue;
        if (review.planVersion.proposedActionType !== action.actionType) continue;
        if (!semanticJsonEqual(review.planVersion.proposedActionParams, action.actionParams)) {
          continue;
        }
        return { authorized: true, reviewId: review.id };
      }
    }

    return { authorized: false };
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

  private async failActionSafely(
    merchantId: string,
    actionId: string,
    caseId: string,
    actionType: RecoveryActionType,
    idempotencyKey: string,
    errorMessage: string,
    reasonCode: string,
  ): Promise<ActionExecutionResult> {
    let failedAction: RecoveryAction | null = null;
    try {
      const transition = await this.actionRepo.transitionActionStatus(
        merchantId,
        actionId,
        ActionExecutionStatus.EXECUTING,
        ActionExecutionStatus.FAILED,
        { errorMessage },
      );
      failedAction = transition.action;
    } catch {
      // Best-effort; audit still records the safety failure.
    }

    await this.auditRepo.record(merchantId, {
      caseId,
      eventType: 'ACTION_FAILED',
      actorType: AuditActorType.SYSTEM,
      inputSummaryJson: { actionId, actionType, idempotencyKey },
      outputSummaryJson: { errorMessage },
      reasonCode,
    });

    return {
      executed: false,
      success: false,
      action: failedAction,
      error: errorMessage,
    };
  }

  private async executeInternalActionSafely(
    merchantId: string,
    action: RecoveryAction,
    caseRecord: CaseWithRelations,
  ): Promise<ActionExecutionResult> {
    const actionId = action.id;

    try {
      return await this.dispatchInternalAction(merchantId, action, caseRecord);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);

      let failedAction: RecoveryAction | null = null;
      try {
        const transition = await this.actionRepo.transitionActionStatus(
          merchantId,
          actionId,
          ActionExecutionStatus.EXECUTING,
          ActionExecutionStatus.FAILED,
          { errorMessage: errMsg },
        );
        failedAction = transition.action;
      } catch {
        // Best-effort.
      }

      await this.auditRepo.record(merchantId, {
        caseId: caseRecord.id,
        eventType: 'ACTION_FAILED',
        actorType: AuditActorType.SYSTEM,
        inputSummaryJson: {
          actionId,
          actionType: action.actionType,
          idempotencyKey: action.idempotencyKey,
        },
        outputSummaryJson: { exception: errMsg },
        reasonCode: 'INTERNAL_ACTION_FAILED',
      });

      return {
        executed: true,
        success: false,
        action: failedAction,
        error: errMsg,
      };
    }
  }

  private async dispatchInternalAction(
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

      return { executed: true, success: true, action: succeededAction };
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

      return { executed: true, success: true, action: succeededAction };
    }

    if (action.actionType === RecoveryActionType.SCHEDULE_FOLLOWUP) {
      if (!this.jobScheduler) {
        throw new Error(
          'SCHEDULE_FOLLOWUP requires a jobScheduler but none was provided in ActionExecutorOptions. ' +
            'Configure jobScheduler or do not dispatch SCHEDULE_FOLLOWUP actions.',
        );
      }

      const params = action.actionParams as Record<string, unknown>;
      const scheduledFor = params.scheduledFor
        ? new Date(params.scheduledFor as string)
        : new Date(Date.now() + 86400000);

      await this.jobScheduler.schedule({
        merchantId,
        caseId: caseRecord.id,
        jobType: 'RECOVERY_FOLLOWUP_CHECK',
        scheduledFor,
        payloadJson: { caseId: caseRecord.id, actionId: action.id },
      });

      const succeededAction = await this.actionRepo.updateActionStatus(merchantId, actionId, {
        status: ActionExecutionStatus.SUCCESS,
        executionMetadata: {
          internalAction: 'SCHEDULE_FOLLOWUP',
          scheduledFor: scheduledFor.toISOString(),
        },
      });

      await this.auditRepo.record(merchantId, {
        caseId: caseRecord.id,
        eventType: 'ACTION_SUCCEEDED',
        actorType: AuditActorType.SYSTEM,
        inputSummaryJson: { actionId, actionType: action.actionType, scheduledFor },
        outputSummaryJson: { status: 'SCHEDULED' },
        reasonCode: 'FOLLOWUP_SCHEDULED',
      });

      return { executed: true, success: true, action: succeededAction };
    }

    if (action.actionType === RecoveryActionType.RECORD_PROMISE_TO_PAY) {
      const params = action.actionParams as Record<string, unknown>;

      if (!this.commitmentRepo) {
        throw new Error(
          'RECORD_PROMISE_TO_PAY requires a commitmentRepo but none was provided in ActionExecutorOptions. ' +
            'Configure commitmentRepo or do not dispatch RECORD_PROMISE_TO_PAY actions.',
        );
      }

      const promisedAmount =
        typeof params.promisedAmount === 'string' ? params.promisedAmount : '0.00';
      const promisedDate = params.promisedDate
        ? new Date(params.promisedDate as string)
        : new Date();
      const extractedFromText =
        typeof params.extractedFromText === 'string' ? params.extractedFromText : undefined;

      const commitment = await this.commitmentRepo.createCommitment(
        merchantId,
        caseRecord.id,
        {
          promisedAmount,
          promisedDate,
          extractedFromText,
          status: 'PENDING',
        },
      );

      const succeededAction = await this.actionRepo.updateActionStatus(merchantId, actionId, {
        status: ActionExecutionStatus.SUCCESS,
        executionMetadata: {
          internalAction: 'RECORD_PROMISE_TO_PAY',
          commitmentId: commitment.id,
          promisedAmount,
          promisedDate: promisedDate.toISOString(),
        },
      });

      await this.auditRepo.record(merchantId, {
        caseId: caseRecord.id,
        eventType: 'ACTION_SUCCEEDED',
        actorType: AuditActorType.SYSTEM,
        inputSummaryJson: { actionId, actionType: action.actionType, params },
        outputSummaryJson: {
          status: 'RECORDED',
          commitmentId: commitment.id,
          promisedAmount,
          promisedDate: promisedDate.toISOString(),
        },
        reasonCode: 'PROMISE_TO_PAY_RECORDED',
      });

      return { executed: true, success: true, action: succeededAction };
    }

    throw new Error(`Unhandled internal action type: ${action.actionType}`);
  }
}

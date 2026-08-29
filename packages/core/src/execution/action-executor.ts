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
  MerchantRepository,
  PolicyConfigRepository,
  CaseWithRelations,
  HumanReviewRepository,
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
import { ActionExecutionError, jsonStructurallyEqual } from '@recoverai/shared';
import { IJobScheduler } from '../detection/job-scheduler-interface.js';
import { generateActionIdempotencyKey } from './idempotency-generator.js';

// ──────────────────────────────────────────────────────────────────────────────
// Options
// ──────────────────────────────────────────────────────────────────────────────

export interface ActionExecutorOptions {
  actionRepo: ActionRepository;
  caseRepo: CaseRepository;
  customerRepo: CustomerRepository;
  policyConfigRepo: PolicyConfigRepository;
  auditRepo: AuditRepository;
  /**
   * MANDATORY. merchantRepo is required for authoritative kill-switch evaluation.
   * Absent merchantRepo causes the executor to fail closed (never fail open).
   */
  merchantRepo: MerchantRepository;
  /** Required whenever a persisted action claims human-review authority. */
  humanReviewRepo?: HumanReviewRepository;
  /**
   * CommitmentRepository for authoritative RECORD_PROMISE_TO_PAY persistence.
   * If absent, RECORD_PROMISE_TO_PAY will fail safely (action marked FAILED).
   */
  commitmentRepo?: CommitmentRepository;
  policyEngine: IPolicyEngine;
  providerRegistry: ProviderRegistry;
  /**
   * jobScheduler is required for SCHEDULE_FOLLOWUP internal actions.
   * If absent, SCHEDULE_FOLLOWUP will fail safely (action marked FAILED).
   */
  jobScheduler?: IJobScheduler;
  clock?: () => Date;
}

// ──────────────────────────────────────────────────────────────────────────────
// Authorization: accepts a typed PolicyEvaluationResult — not loose strings
// ──────────────────────────────────────────────────────────────────────────────

export interface AuthorizeActionParams {
  planVersionId?: string;
  actionType: RecoveryActionType;
  actionParams: Record<string, unknown>;
  /**
   * Typed result from PolicyEngine.evaluate(). The executor binds authorization
   * to this deterministic result rather than caller-supplied loose strings.
   */
  policyEvaluation: PolicyEvaluationResult;
  attemptOrVersion?: string | number;
  /** Authoritative persisted review whose approval may satisfy only REVIEW gates. */
  reviewId?: string;
}

// ──────────────────────────────────────────────────────────────────────────────
// Execution result
// ──────────────────────────────────────────────────────────────────────────────

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

// ──────────────────────────────────────────────────────────────────────────────
// ActionExecutor
// ──────────────────────────────────────────────────────────────────────────────

export class ActionExecutor {
  private actionRepo: ActionRepository;
  private caseRepo: CaseRepository;
  private customerRepo: CustomerRepository;
  private policyConfigRepo: PolicyConfigRepository;
  private auditRepo: AuditRepository;
  /** MANDATORY: Absent merchantRepo fails closed. */
  private merchantRepo: MerchantRepository;
  private humanReviewRepo?: HumanReviewRepository;
  private commitmentRepo?: CommitmentRepository;
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
    this.humanReviewRepo = options.humanReviewRepo;
    this.commitmentRepo = options.commitmentRepo;
    this.policyEngine = options.policyEngine;
    this.providerRegistry = options.providerRegistry;
    this.jobScheduler = options.jobScheduler;
    this.clock = options.clock;
  }

  // ────────────────────────────────────────────────────────────────────────────
  // 1. Authorization — binds creation to a deterministic PolicyEvaluationResult
  // ────────────────────────────────────────────────────────────────────────────

  /**
   * Creates an authoritative RecoveryAction only when PolicyEvaluationResult.decision
   * is ALLOW. Authorization is bound to the typed PolicyEvaluationResult from
   * PolicyEngine.evaluate() — not caller-supplied loose strings.
   *
   * Idempotent: if a RecoveryAction with the same idempotencyKey already exists,
   * returns the existing action and emits NO duplicate ACTION_AUTHORIZED audit.
   */
  async authorizeAndCreateAction(
    merchantId: string,
    caseId: string,
    params: AuthorizeActionParams,
  ): Promise<{ action: RecoveryAction | null; authorized: boolean; reason?: string }> {
    const { policyEvaluation } = params;

    let approvedReviewId: string | undefined;
    let actionBoundAction: RecoveryAction | null = null;
    if (params.reviewId) {
      const authority = await this.validateReviewAuthorityForAuthorization(
        merchantId,
        caseId,
        params.reviewId,
        params.planVersionId,
        params.actionType,
        params.actionParams,
      );
      if (!authority.valid) {
        return { action: null, authorized: false, reason: authority.reason };
      }
      approvedReviewId = params.reviewId;
      actionBoundAction = authority.actionBoundAction;
    }
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

    if (policyEvaluation.decision === PolicyDecision.REVIEW && !approvedReviewId) {
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

    if (actionBoundAction && approvedReviewId) {
      const boundAction = await this.actionRepo.bindApprovedReview(
        merchantId,
        actionBoundAction.id,
        approvedReviewId,
      );
      return boundAction
        ? { action: boundAction, authorized: true }
        : { action: null, authorized: false, reason: 'Reviewed action is no longer pending' };
    }

    // PolicyDecision is ALLOW — check idempotency first
    const existing = await this.actionRepo.findActionByIdempotencyKey(merchantId, idempotencyKey);
    if (existing) {
      if (approvedReviewId) {
        if (
          existing.caseId !== caseId ||
          existing.planVersionId !== params.planVersionId ||
          existing.actionType !== params.actionType ||
          !jsonStructurallyEqual(existing.actionParams, params.actionParams)
        ) {
          return {
            action: null,
            authorized: false,
            reason: 'Existing idempotent action does not exactly match the reviewed proposal',
          };
        }
        const boundExisting = await this.actionRepo.bindApprovedReview(
          merchantId,
          existing.id,
          approvedReviewId,
        );
        return boundExisting
          ? { action: boundExisting, authorized: true }
          : { action: null, authorized: false, reason: 'Reviewed action is no longer pending' };
      }
      // Idempotent return: same logical authorization retry → return existing action
      // Do NOT emit a duplicate ACTION_AUTHORIZED audit
      return { action: existing, authorized: true };
    }

    // Create authoritative RecoveryAction
    const action = await this.actionRepo.createAction(merchantId, caseId, {
      planVersionId: params.planVersionId,
      actionType: params.actionType,
      actionParams: params.actionParams,
      idempotencyKey,
      policyDecision: PolicyDecision.ALLOW,
      policyRationale: policyEvaluation.rationale,
      status: ActionExecutionStatus.PENDING,
      executionMetadata: approvedReviewId
        ? { executionSource: 'HUMAN_REVIEW_APPROVAL', reviewId: approvedReviewId }
        : undefined,
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

  // ────────────────────────────────────────────────────────────────────────────
  // 2. Execution — claim first, then revalidate, then dispatch
  // ────────────────────────────────────────────────────────────────────────────

  /**
   * Executes an authoritative RecoveryAction through:
   *
   * 1. Tenant verification
   * 2. PENDING eligibility check
   * 3. ATOMIC CLAIM: PENDING → EXECUTING (only winning worker continues)
   * 4. Fresh authoritative context load (case/customer/merchant/policy)
   * 5. Fresh PolicyEngine revalidation immediately before dispatch
   *    - DENY/REVIEW: EXECUTING → CANCELLED via CAS, provider NOT called
   * 6. Internal vs. external routing
   *    - Internal: safe execution with explicit failure handling
   *    - External: resolve provider, emit ACTION_DISPATCHED immediately before
   *      provider.execute(), handle result/failure/exception
   */
  async executeAction(
    merchantId: string,
    actionId: string,
  ): Promise<ActionExecutionResult> {
    // ── Step 1: Verify tenant ownership ──────────────────────────────────────
    const action = await this.actionRepo.getActionById(merchantId, actionId);
    if (!action) {
      throw new Error(
        `RecoveryAction "${actionId}" not found or unauthorized under merchant "${merchantId}"`,
      );
    }

    // ── Step 2: PENDING eligibility check ────────────────────────────────────
    if (action.status !== ActionExecutionStatus.PENDING) {
      return {
        executed: false,
        alreadyClaimed: true,
        action,
      };
    }

    // ── Step 3: ATOMIC CLAIM — PENDING → EXECUTING ───────────────────────────
    // Only the winning worker continues. Losers observe alreadyClaimed.
    const claimResult = await this.actionRepo.claimActionForExecution(merchantId, actionId);
    if (!claimResult.claimed) {
      return {
        executed: false,
        alreadyClaimed: true,
        action: claimResult.action,
      };
    }

    // Reload the authoritative action after the atomic claim. Do not rely on
    // caller data or the pre-claim snapshot for security-relevant fields.
    let freshAction: RecoveryAction | null;
    try {
      freshAction = await this.actionRepo.getActionById(merchantId, actionId);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return await this.failActionSafely(
        merchantId,
        actionId,
        action.caseId,
        action.actionType,
        action.idempotencyKey,
        `Authoritative action reload failed after claim; failing closed: ${errMsg}`,
        'ACTION_AUTHORITY_UNAVAILABLE',
      );
    }
    if (!freshAction || freshAction.status !== ActionExecutionStatus.EXECUTING) {
      return await this.failActionSafely(
        merchantId,
        actionId,
        action.caseId,
        action.actionType,
        action.idempotencyKey,
        'Authoritative action unavailable after claim; failing closed.',
        'ACTION_AUTHORITY_UNAVAILABLE',
      );
    }

    // Record the claim immediately
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

    // ── Step 4: Load fresh authoritative context ──────────────────────────────
    // Load AFTER claim to ensure only claim owner does expensive reloads.

    // KILL SWITCH: merchantRepo is mandatory. Fail closed if merchant cannot be loaded.
    let killSwitchActive: boolean;
    try {
      const merchant = await this.merchantRepo.getMerchantById(merchantId);
      if (!merchant) {
        // Merchant not found — fail closed: EXECUTING → FAILED
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

    let caseRecord: CaseWithRelations | null;
    try {
      caseRecord = await this.caseRepo.getCaseById(merchantId, freshAction.caseId);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return await this.failActionSafely(
        merchantId,
        actionId,
        freshAction.caseId,
        freshAction.actionType,
        freshAction.idempotencyKey,
        `RevenueRiskCase reload failed; failing closed: ${errMsg}`,
        'CASE_UNAVAILABLE',
      );
    }
    if (!caseRecord) {
      return await this.failActionSafely(
        merchantId,
        actionId,
        freshAction.caseId,
        freshAction.actionType,
        freshAction.idempotencyKey,
        `RevenueRiskCase "${freshAction.caseId}" not found for merchant "${merchantId}"`,
        'CASE_NOT_FOUND',
      );
    }

    const policyConfig = await this.policyConfigRepo.getOrCreateConfig(merchantId);

    const authority = await this.validateExecutionAuthority(merchantId, caseRecord, freshAction);
    if (!authority.valid) {
      return await this.failActionSafely(
        merchantId,
        actionId,
        freshAction.caseId,
        freshAction.actionType,
        freshAction.idempotencyKey,
        authority.reason,
        'INVALID_HUMAN_REVIEW_AUTHORITY',
      );
    }
    const executionSource: PolicyExecutionSource = authority.executionSource;

    // ── Step 5: Fresh Policy Revalidation — only the claim owner revalidates ──
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
      proposedActionType: freshAction.actionType,
      proposedActionParams: freshAction.actionParams as Record<string, unknown>,
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
      // Roll back claim via CAS: EXECUTING → CANCELLED
      // Only the claim owner (holding EXECUTING) can make this transition.
      // Stale workers who lost the claim cannot touch EXECUTING/CANCELLED.
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

    // Revalidation passed (ALLOW) — only claim owner emits this
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

    // ── Step 6: Dispatch ──────────────────────────────────────────────────────
    if (this.isInternalAction(action.actionType)) {
      // Internal actions: no ACTION_DISPATCHED audit. No external provider called.
      return this.executeInternalActionSafely(merchantId, action, caseRecord);
    }

    // External action: resolve provider FIRST
    const provider = this.providerRegistry.getProviderForAction(action.actionType);
    if (!provider) {
      // No provider registered — fail the action. No ACTION_DISPATCHED audit.
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

    // Emit ACTION_DISPATCHED immediately BEFORE provider.execute() — never earlier.
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

        // If contact action, update customer lastContactedAt
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

  private async validateReviewAuthorityForAuthorization(
    merchantId: string,
    caseId: string,
    reviewId: string,
    planVersionId: string | undefined,
    actionType: RecoveryActionType,
    actionParams: Record<string, unknown>,
  ): Promise<{ valid: true; actionBoundAction: RecoveryAction | null } | { valid: false; reason: string }> {
    if (!this.humanReviewRepo) {
      return { valid: false, reason: 'Human review repository unavailable; failing closed' };
    }

    let review;
    try {
      review = await this.humanReviewRepo.getReviewById(merchantId, reviewId);
    } catch {
      return { valid: false, reason: 'Approved human review not found for merchant' };
    }

    if (!review || review.status !== ReviewStatus.APPROVED || review.merchantId !== merchantId || review.caseId !== caseId) {
      return { valid: false, reason: 'Human review is not an approved authority for this merchant and case' };
    }

    if (review.actionId) {
      const reviewedAction = review.action ?? await this.actionRepo.getActionById(merchantId, review.actionId);
      if (
        !reviewedAction ||
        reviewedAction.id !== review.actionId ||
        reviewedAction.caseId !== caseId ||
        reviewedAction.actionType !== actionType ||
        !jsonStructurallyEqual(reviewedAction.actionParams, actionParams)
      ) {
        return { valid: false, reason: 'Requested action does not exactly match the action-bound review' };
      }
      return { valid: true, actionBoundAction: reviewedAction };
    }

    if (!review.planVersionId || review.planVersionId !== planVersionId || !review.planVersion) {
      return { valid: false, reason: 'Human review is not bound to the requested authoritative plan version' };
    }

    const authoritativeCase = await this.caseRepo.getCaseById(merchantId, caseId);
    if (!authoritativeCase) {
      return { valid: false, reason: 'Authoritative review case not found' };
    }
    const latestPlan = authoritativeCase.planVersions?.[0];
    if (!latestPlan || latestPlan.id !== review.planVersionId) {
      return { valid: false, reason: 'Human review proposal has been superseded' };
    }
    if (
      review.planVersion.caseId !== caseId ||
      review.planVersion.proposedActionType !== actionType ||
      !jsonStructurallyEqual(review.planVersion.proposedActionParams, actionParams)
    ) {
      return { valid: false, reason: 'Requested action does not exactly match the reviewed plan proposal' };
    }

    return { valid: true, actionBoundAction: null };
  }

  private async validateExecutionAuthority(
    merchantId: string,
    caseRecord: CaseWithRelations,
    action: RecoveryAction,
  ): Promise<{ valid: true; executionSource: PolicyExecutionSource } | { valid: false; reason: string }> {
    const metadata = action.executionMetadata;
    if (metadata === null || metadata === undefined) {
      return { valid: true, executionSource: 'AUTONOMOUS' };
    }
    if (typeof metadata !== 'object' || Array.isArray(metadata)) {
      return { valid: false, reason: 'Malformed action execution metadata' };
    }

    const source = (metadata as Record<string, unknown>).executionSource;
    if (source === undefined || source === 'AUTONOMOUS') {
      return { valid: true, executionSource: 'AUTONOMOUS' };
    }
    if (source !== 'HUMAN_REVIEW_APPROVAL') {
      return { valid: false, reason: 'Unknown action execution authority' };
    }

    const reviewId = (metadata as Record<string, unknown>).reviewId;
    if (typeof reviewId !== 'string' || reviewId.length === 0 || !this.humanReviewRepo) {
      return { valid: false, reason: 'Malformed HUMAN_REVIEW_APPROVAL metadata' };
    }

    let review;
    try {
      review = await this.humanReviewRepo.getReviewById(merchantId, reviewId);
    } catch {
      return { valid: false, reason: 'Authoritative approved review not found' };
    }
    if (
      !review ||
      review.status !== ReviewStatus.APPROVED ||
      review.merchantId !== merchantId ||
      review.caseId !== action.caseId ||
      caseRecord.id !== action.caseId
    ) {
      return { valid: false, reason: 'Review is not approved for the action merchant and case' };
    }

    if (review.actionId) {
      if (review.actionId !== action.id) {
        return { valid: false, reason: 'Action-bound review does not authorize this action' };
      }
      return { valid: true, executionSource: 'HUMAN_REVIEW_APPROVAL' };
    }

    if (!review.planVersionId || action.planVersionId !== review.planVersionId || !review.planVersion) {
      return { valid: false, reason: 'Plan-bound review does not authorize this action plan' };
    }
    const latestPlan = caseRecord.planVersions?.[0];
    if (!latestPlan || latestPlan.id !== review.planVersionId) {
      return { valid: false, reason: 'Reviewed plan has been superseded' };
    }
    if (
      review.planVersion.caseId !== action.caseId ||
      review.planVersion.proposedActionType !== action.actionType ||
      !jsonStructurallyEqual(review.planVersion.proposedActionParams, action.actionParams)
    ) {
      return { valid: false, reason: 'Action does not exactly match the authoritative reviewed plan proposal' };
    }

    return { valid: true, executionSource: 'HUMAN_REVIEW_APPROVAL' };
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ────────────────────────────────────────────────────────────────────────────

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

  /**
   * Safely transitions a claimed (EXECUTING) action to FAILED when a
   * prerequisite (merchant, case) cannot be loaded. Emits ACTION_FAILED audit.
   * Never fails open.
   */
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
      // Use CAS: EXECUTING → FAILED to protect against stale overwrite
      const transition = await this.actionRepo.transitionActionStatus(
        merchantId,
        actionId,
        ActionExecutionStatus.EXECUTING,
        ActionExecutionStatus.FAILED,
        { errorMessage },
      );
      failedAction = transition.action;
    } catch {
      // Best-effort; proceed to audit regardless
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

  /**
   * Executes an internal action with explicit failure handling.
   *
   * Contract:
   * - Action must never be left silently in EXECUTING status after this returns.
   * - Any failure → action FAILED, ACTION_FAILED audit emitted.
   * - No ACTION_DISPATCHED audit for internal actions.
   * - No ACTION_SUCCEEDED emitted on failure paths.
   */
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

      // Safely transition EXECUTING → FAILED via CAS
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
        // Best-effort
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

  /**
   * Core internal action dispatch logic. Throws on any failure so that
   * executeInternalActionSafely can handle it uniformly.
   */
  private async dispatchInternalAction(
    merchantId: string,
    action: RecoveryAction,
    caseRecord: CaseWithRelations,
  ): Promise<ActionExecutionResult> {
    const actionId = action.id;

    // ── STOP_RECOVERY ─────────────────────────────────────────────────────────
    if (action.actionType === RecoveryActionType.STOP_RECOVERY) {
      // compareAndSetStatus will throw CaseStateConflictError on a race
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

    // ── ESCALATE_TO_HUMAN ─────────────────────────────────────────────────────
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

    // ── SCHEDULE_FOLLOWUP ─────────────────────────────────────────────────────
    if (action.actionType === RecoveryActionType.SCHEDULE_FOLLOWUP) {
      // jobScheduler is required for this action
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

      // If scheduler throws, this will propagate to executeInternalActionSafely → action FAILED
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

    // ── RECORD_PROMISE_TO_PAY ─────────────────────────────────────────────────
    if (action.actionType === RecoveryActionType.RECORD_PROMISE_TO_PAY) {
      const params = action.actionParams as Record<string, unknown>;

      // Persist authoritative RecoveryCommitment — commitmentRepo is required
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

      // Persist authoritative commitment; any error propagates to safe failure handler
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

      // Keep executionMetadata as supplemental evidence referencing the authoritative record
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

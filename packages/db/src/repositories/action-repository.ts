import {
  Prisma,
  RecoveryAction,
  ActionExecutionStatus,
  RecoveryActionType,
  PolicyDecision,
} from '@prisma/client';
import { prisma } from '../client.js';

export interface CreateActionParams {
  planVersionId?: string;
  actionType: RecoveryActionType;
  actionParams: Record<string, unknown>;
  idempotencyKey: string;
  policyDecision: PolicyDecision;
  policyRationale: string;
  status?: ActionExecutionStatus;
  providerName?: string;
  externalActionId?: string;
  executionMetadata?: Record<string, unknown>;
}

export interface UpdateActionStatusParams {
  status: ActionExecutionStatus;
  providerName?: string;
  externalActionId?: string;
  executionMetadata?: Record<string, unknown>;
  errorMessage?: string;
  executedAt?: Date;
}

export class ActionRepository {
  /**
   * Creates an authoritative RecoveryAction under a tenant-scoped case.
   */
  async createAction(
    merchantId: string,
    caseId: string,
    params: CreateActionParams,
  ): Promise<RecoveryAction> {
    // Assert tenant ownership of the parent case
    await prisma.revenueRiskCase.findFirstOrThrow({
      where: { id: caseId, merchantId },
    });

    if (params.planVersionId) {
      await prisma.recoveryPlanVersion.findFirstOrThrow({
        where: { id: params.planVersionId, caseId },
      });
    }

    return prisma.recoveryAction.create({
      data: {
        caseId,
        planVersionId: params.planVersionId,
        actionType: params.actionType,
        actionParams: params.actionParams as Prisma.InputJsonValue,
        idempotencyKey: params.idempotencyKey,
        policyDecision: params.policyDecision,
        policyRationale: params.policyRationale,
        status: params.status || ActionExecutionStatus.PENDING,
        providerName: params.providerName,
        externalActionId: params.externalActionId,
        executionMetadata: params.executionMetadata as Prisma.InputJsonValue,
      },
    });
  }

  /**
   * Atomically claims an action for execution.
   * Uses an atomic predicate (status == PENDING AND case.merchantId == merchantId).
   * Transitions status to EXECUTING.
   * Returns { claimed: true, action } on success, or { claimed: false, action } if already claimed or ineligible.
   */
  async claimActionForExecution(
    merchantId: string,
    actionId: string,
  ): Promise<{ claimed: boolean; action: RecoveryAction | null }> {
    // Check tenant ownership and load current action
    const currentAction = await prisma.recoveryAction.findFirst({
      where: {
        id: actionId,
        case: { merchantId },
      },
    });

    if (!currentAction) {
      return { claimed: false, action: null };
    }

    if (currentAction.status !== ActionExecutionStatus.PENDING) {
      return { claimed: false, action: currentAction };
    }

    // Atomic compare-and-set from PENDING -> EXECUTING
    const updateResult = await prisma.recoveryAction.updateMany({
      where: {
        id: actionId,
        status: ActionExecutionStatus.PENDING,
        case: { merchantId },
      },
      data: {
        status: ActionExecutionStatus.EXECUTING,
        updatedAt: new Date(),
      },
    });

    if (updateResult.count === 1) {
      const claimedAction = await prisma.recoveryAction.findUniqueOrThrow({
        where: { id: actionId },
      });
      return { claimed: true, action: claimedAction };
    }

    // Another concurrent worker claimed it first
    const refreshedAction = await prisma.recoveryAction.findUnique({
      where: { id: actionId },
    });
    return { claimed: false, action: refreshedAction };
  }

  /**
   * Updates an action with its final execution status and metadata.
   */
  async updateActionStatus(
    merchantId: string,
    actionId: string,
    params: UpdateActionStatusParams,
  ): Promise<RecoveryAction> {
    // Assert tenant ownership
    await prisma.recoveryAction.findFirstOrThrow({
      where: {
        id: actionId,
        case: { merchantId },
      },
    });

    return prisma.recoveryAction.update({
      where: { id: actionId },
      data: {
        status: params.status,
        providerName: params.providerName,
        externalActionId: params.externalActionId,
        executionMetadata: params.executionMetadata as Prisma.InputJsonValue,
        errorMessage: params.errorMessage,
        executedAt: params.executedAt !== undefined ? params.executedAt : (
          params.status === ActionExecutionStatus.SUCCESS || params.status === ActionExecutionStatus.FAILED
            ? new Date()
            : undefined
        ),
      },
    });
  }

  /**
   * Fetches an action by ID scoped to merchant tenant.
   */
  async getActionById(merchantId: string, actionId: string): Promise<RecoveryAction | null> {
    return prisma.recoveryAction.findFirst({
      where: {
        id: actionId,
        case: { merchantId },
      },
      include: {
        case: true,
        planVersion: true,
      },
    });
  }

  /**
   * Binds an existing PENDING action to an authoritative approved review.
   * This is used for reviews that point directly at RecoveryAction.actionId;
   * no second action is created.
   */
  async bindApprovedReview(
    merchantId: string,
    actionId: string,
    reviewId: string,
  ): Promise<RecoveryAction | null> {
    const updateResult = await prisma.recoveryAction.updateMany({
      where: {
        id: actionId,
        status: ActionExecutionStatus.PENDING,
        case: { merchantId },
      },
      data: {
        policyDecision: PolicyDecision.ALLOW,
        executionMetadata: {
          executionSource: 'HUMAN_REVIEW_APPROVAL',
          reviewId,
        },
        updatedAt: new Date(),
      },
    });

    if (updateResult.count !== 1) {
      return null;
    }

    return this.getActionById(merchantId, actionId);
  }

  /**
   * Finds an action by idempotency key scoped to merchant tenant.
   */
  async findActionByIdempotencyKey(
    merchantId: string,
    idempotencyKey: string,
  ): Promise<RecoveryAction | null> {
    return prisma.recoveryAction.findFirst({
      where: {
        idempotencyKey,
        case: { merchantId },
      },
    });
  }

  /** Finds only a completed Razorpay payment-link action owned by this merchant. */
  async findSuccessfulPaymentLinkAction(
    merchantId: string,
    providerName: string,
    externalActionId: string,
  ): Promise<RecoveryAction | null> {
    return prisma.recoveryAction.findFirst({
      where: {
        providerName,
        externalActionId,
        actionType: RecoveryActionType.CREATE_OR_SEND_PAYMENT_LINK,
        status: ActionExecutionStatus.SUCCESS,
        case: { merchantId },
      },
      include: { case: true },
    });
  }

  /**
   * Atomically transitions an action from expectedStatus → nextStatus.
   *
   * This is the authoritative CAS helper for all status state transitions
   * that must not race with concurrent workers. Returns true if the
   * transition was applied (count=1), false if the action was already
   * in a different state (lost the CAS race).
   *
   * Usage: revalidation rollback from EXECUTING → CANCELLED.
   */
  async transitionActionStatus(
    merchantId: string,
    actionId: string,
    expectedStatus: ActionExecutionStatus,
    nextStatus: ActionExecutionStatus,
    extras?: {
      errorMessage?: string;
      executionMetadata?: Record<string, unknown>;
    },
  ): Promise<{ transitioned: boolean; action: RecoveryAction | null }> {
    const updateResult = await prisma.recoveryAction.updateMany({
      where: {
        id: actionId,
        status: expectedStatus,
        case: { merchantId },
      },
      data: {
        status: nextStatus,
        errorMessage: extras?.errorMessage,
        executionMetadata: extras?.executionMetadata as Prisma.InputJsonValue,
        updatedAt: new Date(),
        executedAt:
          nextStatus === ActionExecutionStatus.SUCCESS ||
          nextStatus === ActionExecutionStatus.FAILED ||
          nextStatus === ActionExecutionStatus.CANCELLED
            ? new Date()
            : undefined,
      },
    });

    if (updateResult.count === 1) {
      const action = await prisma.recoveryAction.findUnique({
        where: { id: actionId },
      });
      return { transitioned: true, action };
    }

    const action = await prisma.recoveryAction.findFirst({
      where: { id: actionId, case: { merchantId } },
    });
    return { transitioned: false, action };
  }
}

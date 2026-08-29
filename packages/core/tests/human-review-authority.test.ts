import { describe, expect, it, vi } from 'vitest';
import {
  ActionExecutionStatus,
  CaseStatus,
  PolicyDecision,
  RecoveryActionType,
  ReviewStatus,
  RiskType,
} from '@prisma/client';
import { ActionExecutor } from '../src/execution/action-executor.js';
import type { IPolicyEngine, PolicyExecutionContext } from '../src/execution/policy-interface.js';
import { ProviderExecutionOutcome } from '../src/execution/provider-interface.js';

const merchantId = 'mch_review_auth';
const caseId = 'case_review_auth';
const planId = 'plan_review_auth';
const actionId = 'act_review_auth';

function buildHarness(options?: {
  caseStatus?: CaseStatus;
  actionType?: RecoveryActionType;
  actionParams?: Record<string, unknown>;
  planActionType?: RecoveryActionType;
  planActionParams?: Record<string, unknown>;
  reviews?: any[];
}) {
  const actionType = options?.actionType || RecoveryActionType.SEND_RECEIVABLE_REMINDER;
  const actionParams = options?.actionParams || { channel: 'EMAIL', tags: ['a', 'b'] };
  const planActionType = options?.planActionType || actionType;
  const planActionParams = options?.planActionParams || { channel: 'EMAIL', tags: ['a', 'b'] };

  const action: any = {
    id: actionId,
    caseId,
    planVersionId: planId,
    actionType,
    actionParams,
    idempotencyKey: 'idem-review-auth',
    policyDecision: PolicyDecision.ALLOW,
    policyRationale: 'test',
    status: ActionExecutionStatus.PENDING,
    providerName: null,
    externalActionId: null,
    executionMetadata: null,
    errorMessage: null,
    executedAt: null,
    createdAt: new Date('2026-08-29T10:00:00Z'),
    updatedAt: new Date('2026-08-29T10:00:00Z'),
  };

  const planVersion: any = {
    id: planId,
    caseId,
    version: 1,
    proposedActionType: planActionType,
    proposedActionParams: planActionParams,
  };

  const caseRecord: any = {
    id: caseId,
    merchantId,
    customerId: null,
    riskType: RiskType.OVERDUE_RECEIVABLE,
    amountAtRisk: { toString: () => '85000.00' },
    currency: 'INR',
    status: options?.caseStatus || CaseStatus.NEEDS_REVIEW,
    openedAt: new Date('2026-08-28T10:00:00Z'),
    contextJson: {},
    customer: null,
    actions: [action],
    outcomes: [],
    planVersions: [planVersion],
  };

  const actionRepo: any = {
    getActionById: vi.fn(async () => action),
    claimActionForExecution: vi.fn(async () => {
      if (action.status !== ActionExecutionStatus.PENDING) return { claimed: false, action };
      action.status = ActionExecutionStatus.EXECUTING;
      return { claimed: true, action };
    }),
    transitionActionStatus: vi.fn(async (_m: string, _a: string, expected: ActionExecutionStatus, next: ActionExecutionStatus, extras?: any) => {
      if (action.status !== expected) return { transitioned: false, action };
      action.status = next;
      if (extras?.errorMessage) action.errorMessage = extras.errorMessage;
      return { transitioned: true, action };
    }),
    updateActionStatus: vi.fn(async (_m: string, _a: string, data: any) => {
      Object.assign(action, data);
      return action;
    }),
    findActionByIdempotencyKey: vi.fn(async () => null),
    createAction: vi.fn(),
  };

  const caseRepo: any = {
    getCaseById: vi.fn(async () => caseRecord),
    compareAndSetStatus: vi.fn(),
  };

  const auditRepo: any = { record: vi.fn(async () => undefined) };
  const merchantRepo: any = {
    getMerchantById: vi.fn(async () => ({ id: merchantId, killSwitchActive: false })),
  };
  const policyConfigRepo: any = {
    getOrCreateConfig: vi.fn(async () => ({
      maxRetriesPerCase: 3,
      maxContactsPerCase: 3,
      maxActionsPerCase: 5,
      cooldownHoursBetweenActions: 0,
      highValueThreshold: { toString: () => '50000.00' },
      minConfidenceThreshold: 0.65,
      reviewFirstMode: false,
      checkoutAbandonmentThresholdMinutes: 30,
      quietHoursStart: 22,
      quietHoursEnd: 8,
      quietHoursTimezone: 'Asia/Kolkata',
      maxRecoveryWindowDays: 30,
      overdueGracePeriodDays: 3,
    })),
  };

  const humanReviewRepo: any = {
    listReviews: vi.fn(async () => options?.reviews || []),
  };

  const provider = {
    providerName: 'test-provider',
    isSimulated: true,
    execute: vi.fn(async () => ({
      outcome: ProviderExecutionOutcome.SUCCESS,
      providerName: 'test-provider',
      isSimulated: true,
    })),
  };
  const providerRegistry: any = { getProviderForAction: vi.fn(() => provider) };

  const policyEngine: IPolicyEngine = {
    evaluate: vi.fn((context: PolicyExecutionContext) => {
      if (context.executionSource === 'HUMAN_REVIEW_APPROVAL') {
        return {
          decision: PolicyDecision.ALLOW,
          reasonCode: 'HUMAN_APPROVAL_VALID',
          rationale: 'Authoritative human approval satisfies review gate',
          evaluatedAt: context.currentTime,
        };
      }
      return {
        decision: PolicyDecision.REVIEW,
        reasonCode: 'NEEDS_HUMAN_REVIEW',
        rationale: 'Case still requires authoritative human review',
        evaluatedAt: context.currentTime,
      };
    }),
  };

  const executor = new ActionExecutor({
    actionRepo,
    caseRepo,
    customerRepo: { updateLastContactedAt: vi.fn() } as any,
    policyConfigRepo,
    auditRepo,
    merchantRepo,
    humanReviewRepo,
    policyEngine,
    providerRegistry,
    clock: () => new Date('2026-08-29T12:00:00Z'),
  });

  return { executor, action, planVersion, provider, policyEngine, humanReviewRepo, auditRepo };
}

function approvedPlanReview(overrides?: Record<string, unknown>) {
  return {
    id: 'review-approved',
    merchantId,
    caseId,
    planVersionId: planId,
    actionId: null,
    status: ReviewStatus.APPROVED,
    planVersion: {
      id: planId,
      caseId,
      version: 1,
      proposedActionType: RecoveryActionType.SEND_RECEIVABLE_REMINDER,
      proposedActionParams: { channel: 'EMAIL', tags: ['a', 'b'] },
    },
    action: null,
    ...overrides,
  } as any;
}

describe('ActionExecutor authoritative human-review binding', () => {
  it('ignores caller-supplied HUMAN_REVIEW_APPROVAL when no durable approved review exists', async () => {
    const { executor, provider, action } = buildHarness({ reviews: [] });

    const result = await executor.executeAction(merchantId, actionId, {
      executionSource: 'HUMAN_REVIEW_APPROVAL',
    });

    expect(result.executed).toBe(false);
    expect(result.blockedByPolicy).toBe(true);
    expect(result.policyDecision).toBe(PolicyDecision.REVIEW);
    expect(action.status).toBe(ActionExecutionStatus.CANCELLED);
    expect(provider.execute).not.toHaveBeenCalled();
  });

  it('derives HUMAN_REVIEW_APPROVAL from an APPROVED review bound to the exact current plan proposal', async () => {
    const review = approvedPlanReview();
    const { executor, provider, policyEngine } = buildHarness({ reviews: [review] });

    const result = await executor.executeAction(merchantId, actionId);

    expect(result.success).toBe(true);
    expect(provider.execute).toHaveBeenCalledTimes(1);
    expect(policyEngine.evaluate).toHaveBeenCalledWith(
      expect.objectContaining({ executionSource: 'HUMAN_REVIEW_APPROVAL' }),
    );
  });

  it('treats object key order as irrelevant for reviewed params', async () => {
    const review = approvedPlanReview({
      planVersion: {
        id: planId,
        caseId,
        version: 1,
        proposedActionType: RecoveryActionType.SEND_RECEIVABLE_REMINDER,
        proposedActionParams: { tags: ['a', 'b'], channel: 'EMAIL' },
      },
    });
    const { executor, provider } = buildHarness({
      actionParams: { channel: 'EMAIL', tags: ['a', 'b'] },
      reviews: [review],
    });

    const result = await executor.executeAction(merchantId, actionId);

    expect(result.success).toBe(true);
    expect(provider.execute).toHaveBeenCalledTimes(1);
  });

  it('rejects a review when action type differs from the reviewed proposal', async () => {
    const review = approvedPlanReview();
    const { executor, provider } = buildHarness({
      actionType: RecoveryActionType.CREATE_OR_SEND_PAYMENT_LINK,
      reviews: [review],
    });

    const result = await executor.executeAction(merchantId, actionId, {
      executionSource: 'HUMAN_REVIEW_APPROVAL',
    });

    expect(result.policyDecision).toBe(PolicyDecision.REVIEW);
    expect(provider.execute).not.toHaveBeenCalled();
  });

  it('rejects parameter tampering including array-order changes and extra fields', async () => {
    const review = approvedPlanReview();
    const { executor, provider } = buildHarness({
      actionParams: { channel: 'EMAIL', tags: ['b', 'a'], extra: true },
      reviews: [review],
    });

    const result = await executor.executeAction(merchantId, actionId);

    expect(result.policyDecision).toBe(PolicyDecision.REVIEW);
    expect(provider.execute).not.toHaveBeenCalled();
  });

  it('does not accept PENDING, REJECTED, or cross-case review records as authority', async () => {
    const invalidReviews = [
      approvedPlanReview({ id: 'pending', status: ReviewStatus.PENDING }),
      approvedPlanReview({ id: 'rejected', status: ReviewStatus.REJECTED }),
      approvedPlanReview({ id: 'cross-case', caseId: 'other-case' }),
    ];
    const { executor, provider } = buildHarness({ reviews: invalidReviews });

    const result = await executor.executeAction(merchantId, actionId, {
      executionSource: 'HUMAN_REVIEW_APPROVAL',
    });

    expect(result.policyDecision).toBe(PolicyDecision.REVIEW);
    expect(provider.execute).not.toHaveBeenCalled();
  });

  it('action-bound review authorizes only the exact action id', async () => {
    const actionBoundReview: any = approvedPlanReview({
      id: 'review-action-bound',
      actionId,
      action: {
        id: actionId,
        caseId,
        actionType: RecoveryActionType.SEND_RECEIVABLE_REMINDER,
        actionParams: { channel: 'EMAIL', tags: ['a', 'b'] },
      },
    });
    const { executor, provider } = buildHarness({ reviews: [actionBoundReview] });

    const result = await executor.executeAction(merchantId, actionId);

    expect(result.success).toBe(true);
    expect(provider.execute).toHaveBeenCalledTimes(1);
  });
});

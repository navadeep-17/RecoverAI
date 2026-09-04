import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ActionExecutionStatus,
  CaseStatus,
  PolicyDecision,
  RecoveryActionType,
  ReviewStatus,
  RiskType,
} from '@prisma/client';
import { PolicyEngine } from '@recoverai/policy';
import { ProviderRegistry, SimulatedRecoveryProvider } from '@recoverai/integrations';
import { ActionExecutor } from '../src/execution/action-executor.js';

describe('exact human-review authority binding', () => {
  const merchantId = 'merchant-authority-a';
  const otherMerchantId = 'merchant-authority-b';
  const caseId = 'case-authority-a';
  const otherCaseId = 'case-authority-b';
  const planVersionId = 'plan-authority-v1';
  const reviewId = 'review-authority-approved';
  const now = new Date('2026-08-29T06:30:00.000Z');
  const authoritativeParams = {
    amount: '2500.00',
    currency: 'INR',
    delivery: { channel: 'EMAIL', template: 'payment-link-v1' },
    fallbackChannels: ['EMAIL', 'SMS'],
  };

  let actions: Map<string, any>;
  let reviews: Map<string, any>;
  let caseRecord: any;
  let provider: SimulatedRecoveryProvider;
  let executor: ActionExecutor;
  let createAction: ReturnType<typeof vi.fn>;

  const allowEvaluation = {
    decision: PolicyDecision.ALLOW,
    reasonCode: 'VALID_POLICY',
    rationale: 'All deterministic checks passed',
    evaluatedAt: now,
    violations: [],
  };

  function approvedPlanReview(overrides: Record<string, unknown> = {}) {
    return {
      id: reviewId,
      merchantId,
      caseId,
      planVersionId,
      actionId: null,
      status: ReviewStatus.APPROVED,
      planVersion: caseRecord.planVersions[0],
      action: null,
      case: caseRecord,
      ...overrides,
    };
  }

  function pendingAction(overrides: Record<string, unknown> = {}) {
    return {
      id: `action-${actions.size + 1}`,
      caseId,
      planVersionId,
      actionType: RecoveryActionType.CREATE_OR_SEND_PAYMENT_LINK,
      actionParams: authoritativeParams,
      idempotencyKey: `authority-key-${actions.size + 1}`,
      policyDecision: PolicyDecision.ALLOW,
      policyRationale: 'Human review approved',
      status: ActionExecutionStatus.PENDING,
      providerName: null,
      externalActionId: null,
      executionMetadata: { executionSource: 'HUMAN_REVIEW_APPROVAL', reviewId },
      errorMessage: null,
      executedAt: null,
      createdAt: now,
      updatedAt: now,
      ...overrides,
    };
  }

  beforeEach(() => {
    actions = new Map();
    reviews = new Map();
    caseRecord = {
      id: caseId,
      merchantId,
      customerId: 'customer-authority-a',
      riskType: RiskType.PAYMENT_FAILURE,
      amountAtRisk: { toString: () => '2500.00' },
      currency: 'INR',
      status: CaseStatus.WAITING,
      openedAt: new Date('2026-08-28T06:30:00.000Z'),
      contextJson: { verifiedPaymentFailureCode: 'BAD_REQUEST_ERROR' },
      customer: {
        id: 'customer-authority-a',
        contactConsent: true,
        optedOut: false,
        lastContactedAt: null,
      },
      planVersions: [{
        id: planVersionId,
        caseId,
        version: 1,
        diagnosisCode: 'TEMPORARY_DECLINE',
        diagnosisSummary: 'Temporary payment failure',
        confidence: 0.9,
        proposedActionType: RecoveryActionType.CREATE_OR_SEND_PAYMENT_LINK,
        proposedActionParams: authoritativeParams,
      }],
      actions: [],
      outcomes: [],
    };
    reviews.set(reviewId, approvedPlanReview());

    createAction = vi.fn(async (_merchantId: string, targetCaseId: string, params: any) => {
      const action = pendingAction({
        id: `created-action-${actions.size + 1}`,
        caseId: targetCaseId,
        planVersionId: params.planVersionId ?? null,
        actionType: params.actionType,
        actionParams: params.actionParams,
        idempotencyKey: params.idempotencyKey,
        policyDecision: params.policyDecision,
        policyRationale: params.policyRationale,
        executionMetadata: params.executionMetadata ?? null,
      });
      actions.set(action.id, action);
      return action;
    });

    const actionRepo = {
      createAction,
      findActionByIdempotencyKey: vi.fn(async (_m: string, key: string) =>
        [...actions.values()].find((action) => action.idempotencyKey === key) ?? null),
      getActionById: vi.fn(async (m: string, id: string) => {
        const action = actions.get(id);
        return action && m === merchantId ? action : null;
      }),
      claimActionForExecution: vi.fn(async (m: string, id: string) => {
        const action = actions.get(id);
        if (!action || m !== merchantId || action.status !== ActionExecutionStatus.PENDING) {
          return { claimed: false, action: action ?? null };
        }
        action.status = ActionExecutionStatus.EXECUTING;
        return { claimed: true, action };
      }),
      transitionActionStatus: vi.fn(async (_m: string, id: string, expected: string, next: string, extras?: any) => {
        const action = actions.get(id);
        if (!action || action.status !== expected) return { transitioned: false, action: action ?? null };
        action.status = next;
        action.errorMessage = extras?.errorMessage ?? null;
        action.executionMetadata = extras?.executionMetadata ?? action.executionMetadata;
        return { transitioned: true, action };
      }),
      updateActionStatus: vi.fn(async (_m: string, id: string, data: any) => {
        const action = actions.get(id);
        Object.assign(action, data);
        return action;
      }),
      bindApprovedReview: vi.fn(async (_m: string, id: string, boundReviewId: string) => {
        const action = actions.get(id);
        if (!action || action.status !== ActionExecutionStatus.PENDING) return null;
        action.policyDecision = PolicyDecision.ALLOW;
        action.executionMetadata = { executionSource: 'HUMAN_REVIEW_APPROVAL', reviewId: boundReviewId };
        return action;
      }),
    };
    const reviewRepo = {
      getReviewById: vi.fn(async (m: string, id: string) => {
        const review = reviews.get(id);
        if (!review || review.merchantId !== m) throw new Error('review not found');
        return review;
      }),
    };
    const caseRepo = {
      getCaseById: vi.fn(async (m: string, id: string) =>
        m === merchantId && id === caseId
          ? { ...caseRecord, actions: [...actions.values()] }
          : null),
      compareAndSetStatus: vi.fn(),
    };
    const policyConfigRepo = {
      getOrCreateConfig: vi.fn(async () => ({
        maxRetriesPerCase: 3,
        maxContactsPerCase: 3,
        maxActionsPerCase: 5,
        cooldownHoursBetweenActions: 0,
        highValueThreshold: { toString: () => '50000.00' },
        minConfidenceThreshold: 0.7,
        reviewFirstMode: false,
        checkoutAbandonmentThresholdMinutes: 30,
        quietHoursStart: 22,
        quietHoursEnd: 8,
        quietHoursTimezone: 'Asia/Kolkata',
        maxRecoveryWindowDays: 14,
        overdueGracePeriodDays: 3,
      })),
    };
    provider = new SimulatedRecoveryProvider();
    const registry = new ProviderRegistry([provider]);
    executor = new ActionExecutor({
      actionRepo: actionRepo as any,
      caseRepo: caseRepo as any,
      customerRepo: { updateLastContactedAt: vi.fn() } as any,
      merchantRepo: { getMerchantById: vi.fn(async () => ({ id: merchantId, killSwitchActive: false })) } as any,
      humanReviewRepo: reviewRepo as any,
      policyConfigRepo: policyConfigRepo as any,
      auditRepo: { record: vi.fn(async () => ({})) } as any,
      policyEngine: new PolicyEngine(),
      providerRegistry: registry,
      clock: () => now,
    });
  });

  async function authorize(overrides: Record<string, unknown> = {}) {
    return executor.authorizeAndCreateAction(merchantId, caseId, {
      planVersionId,
      actionType: RecoveryActionType.CREATE_OR_SEND_PAYMENT_LINK,
      actionParams: authoritativeParams,
      policyEvaluation: allowEvaluation,
      reviewId,
      ...overrides,
    } as any);
  }

  it('rejects a different action type under the same approved plan and creates no action', async () => {
    const result = await authorize({ actionType: RecoveryActionType.RETRY_PAYMENT });
    expect(result.authorized).toBe(false);
    expect(createAction).not.toHaveBeenCalled();
    expect(provider.dispatchedCalls).toHaveLength(0);
  });

  it.each([
    ['modified amount', { ...authoritativeParams, amount: '2501.00' }],
    ['modified currency', { ...authoritativeParams, currency: 'USD' }],
    ['missing param', { amount: '2500.00', currency: 'INR', delivery: authoritativeParams.delivery }],
    ['extra param', { ...authoritativeParams, unreviewed: true }],
    ['array order difference', { ...authoritativeParams, fallbackChannels: ['SMS', 'EMAIL'] }],
  ])('rejects %s and creates no action', async (_label, params) => {
    const result = await authorize({ actionParams: params });
    expect(result.authorized).toBe(false);
    expect(createAction).not.toHaveBeenCalled();
  });

  it('accepts semantically identical params with different object-key ordering', async () => {
    const reordered = {
      fallbackChannels: ['EMAIL', 'SMS'],
      delivery: { template: 'payment-link-v1', channel: 'EMAIL' },
      currency: 'INR',
      amount: '2500.00',
    };
    const result = await authorize({ actionParams: reordered });
    expect(result.authorized).toBe(true);
    expect(result.action?.executionMetadata).toEqual({
      executionSource: 'HUMAN_REVIEW_APPROVAL',
      reviewId,
    });
  });

  it.each([
    ['nonexistent review', 'missing-review', undefined],
    ['pending review', reviewId, ReviewStatus.PENDING],
    ['rejected review', reviewId, ReviewStatus.REJECTED],
  ])('rejects %s', async (_label, requestedReviewId, status) => {
    if (status) reviews.set(reviewId, approvedPlanReview({ status }));
    const result = await authorize({ reviewId: requestedReviewId });
    expect(result.authorized).toBe(false);
    expect(createAction).not.toHaveBeenCalled();
  });

  it('rejects cross-merchant and cross-case reviews', async () => {
    reviews.set(reviewId, approvedPlanReview({ merchantId: otherMerchantId }));
    expect((await authorize()).authorized).toBe(false);
    reviews.set(reviewId, approvedPlanReview({ caseId: otherCaseId }));
    expect((await authorize()).authorized).toBe(false);
    expect(createAction).not.toHaveBeenCalled();
  });

  it('fails closed at execution when action type differs from the reviewed plan', async () => {
    const action = pendingAction({ actionType: RecoveryActionType.RETRY_PAYMENT });
    actions.set(action.id, action);
    const result = await executor.executeAction(merchantId, action.id);
    expect(result.executed).toBe(false);
    expect(result.action?.status).toBe(ActionExecutionStatus.FAILED);
    expect(provider.dispatchedCalls).toHaveLength(0);
  });

  it('fails closed at execution when action params differ from the reviewed plan', async () => {
    const action = pendingAction({ actionParams: { ...authoritativeParams, amount: '2501.00' } });
    actions.set(action.id, action);
    const result = await executor.executeAction(merchantId, action.id);
    expect(result.executed).toBe(false);
    expect(result.action?.status).toBe(ActionExecutionStatus.FAILED);
    expect(provider.dispatchedCalls).toHaveLength(0);
  });

  it('fails closed on malformed HUMAN_REVIEW_APPROVAL metadata', async () => {
    const action = pendingAction({ executionMetadata: { executionSource: 'HUMAN_REVIEW_APPROVAL' } });
    actions.set(action.id, action);
    const result = await executor.executeAction(merchantId, action.id);
    expect(result.executed).toBe(false);
    expect(result.action?.status).toBe(ActionExecutionStatus.FAILED);
    expect(provider.dispatchedCalls).toHaveLength(0);
  });

  it('executes a legitimate exact approved proposal', async () => {
    const authorization = await authorize();
    const result = await executor.executeAction(merchantId, authorization.action!.id);
    expect(result.success).toBe(true);
    expect(provider.dispatchedCalls).toHaveLength(1);
  });

  it('fresh policy denies CUSTOMER_OPTED_OUT after legitimate approval and before dispatch', async () => {
    const authorization = await authorize();
    caseRecord.customer.optedOut = true;
    caseRecord.customer.contactConsent = false;
    const result = await executor.executeAction(merchantId, authorization.action!.id);
    expect(result.executed).toBe(false);
    expect(result.policyReasonCode).toBe('CUSTOMER_OPTED_OUT');
    expect(result.action?.status).toBe(ActionExecutionStatus.CANCELLED);
    expect(provider.dispatchedCalls).toHaveLength(0);
  });

  it('preserves action-bound review behavior without creating a second action', async () => {
    const action = pendingAction({
      policyDecision: PolicyDecision.REVIEW,
      executionMetadata: null,
    });
    actions.set(action.id, action);
    reviews.set(reviewId, approvedPlanReview({
      planVersionId: null,
      actionId: action.id,
      planVersion: null,
      action,
    }));

    const authorization = await authorize({ planVersionId: undefined });
    expect(authorization.authorized).toBe(true);
    expect(authorization.action?.id).toBe(action.id);
    expect(createAction).not.toHaveBeenCalled();
    expect((await executor.executeAction(merchantId, action.id)).success).toBe(true);
  });
});

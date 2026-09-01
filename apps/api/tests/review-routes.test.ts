import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ReviewStatus, Role } from '@prisma/client';
import { buildTestServer as buildServer } from './test-server.js';
import { ReviewStateConflictError, UnauthorizedReviewerError } from '@recoverai/shared';

describe('Human Review API Routes & AuthenticatedPrincipal Boundary', () => {
  const merchantAId = 'mch_api_test_aaa';
  const merchantBId = 'mch_api_test_bbb';

  const userAdminAId = 'usr_api_admin_a';
  const userReviewerAId = 'usr_api_reviewer_a';
  const userMemberAId = 'usr_api_member_a';
  const userAdminBId = 'usr_api_admin_b';

  const reviewAId = 'rev_api_test_aaa';

  let mockReviewService: any;
  let app: any;

  beforeEach(() => {
    mockReviewService = {
      listReviews: vi.fn(async (mId: string, _filter?: any) => {
        if (mId === merchantAId) {
          return [
            {
              id: reviewAId,
              merchantId: merchantAId,
              caseId: 'case_01',
              status: ReviewStatus.PENDING,
              reasonForReview: 'Alpha test review',
            },
          ];
        }
        return [];
      }),
      getReviewById: vi.fn(async (mId: string, rId: string) => {
        if (rId === reviewAId && mId === merchantAId) {
          return {
            id: rId,
            merchantId: merchantAId,
            caseId: 'case_01',
            status: ReviewStatus.PENDING,
            reasonForReview: 'Alpha test review',
          };
        }
        throw new Error(`Review "${rId}" not found for merchant "${mId}"`);
      }),
      approveReview: vi.fn(async (mId: string, rId: string, uId: string, _options?: any) => {
        if (mId !== merchantAId) {
          throw new Error(`Review "${rId}" not found for merchant "${mId}"`);
        }
        return {
          approved: true,
          review: { id: rId, merchantId: mId, reviewerId: uId, status: ReviewStatus.APPROVED },
          executionResult: { executed: true, success: true },
        };
      }),
      rejectReview: vi.fn(async (mId: string, rId: string, uId: string, _options: any) => {
        if (mId !== merchantAId) {
          throw new Error(`Review "${rId}" not found for merchant "${mId}"`);
        }
        return {
          rejected: true,
          review: { id: rId, merchantId: mId, reviewerId: uId, status: ReviewStatus.REJECTED },
        };
      }),
      takeOverReview: vi.fn(async (mId: string, rId: string, uId: string, _options?: any) => {
        if (mId !== merchantAId) {
          throw new Error(`Review "${rId}" not found for merchant "${mId}"`);
        }
        return {
          takenOver: true,
          review: { id: rId, merchantId: mId, reviewerId: uId, status: ReviewStatus.TAKEN_OVER },
        };
      }),
      closeReview: vi.fn(async (mId: string, rId: string, uId: string, _options: any) => {
        if (mId !== merchantAId) {
          throw new Error(`Review "${rId}" not found for merchant "${mId}"`);
        }
        return {
          closed: true,
          review: { id: rId, merchantId: mId, reviewerId: uId, status: ReviewStatus.CLOSED },
        };
      }),
    };

    app = buildServer({
      checkDbConnection: async () => true,
      reviewService: mockReviewService,
    });
  });

  it('no authenticated principal -> 401 Unauthorized', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/reviews',
    });

    expect(res.statusCode).toBe(401);
  });

  it('Merchant A principal reads Merchant A review', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/reviews/${reviewAId}`,
      headers: {
        'x-merchant-id': merchantAId,
        'x-user-id': userAdminAId,
        'x-user-role': Role.MERCHANT_ADMIN,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.review.id).toBe(reviewAId);
    expect(body.review.merchantId).toBeUndefined();
  });

  it('Merchant B principal cannot read Merchant A review (returns 404)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/reviews/${reviewAId}`,
      headers: {
        'x-merchant-id': merchantBId,
        'x-user-id': userAdminBId,
        'x-user-role': Role.MERCHANT_ADMIN,
      },
    });

    expect(res.statusCode).toBe(404);
  });

  it('Merchant B principal cannot resolve Merchant A review', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/reviews/${reviewAId}/approve`,
      headers: {
        'x-merchant-id': merchantBId,
        'x-user-id': userAdminBId,
        'x-user-role': Role.MERCHANT_ADMIN,
      },
      payload: {
        notes: 'Cross tenant approval attack',
      },
    });

    expect(res.statusCode).toBe(404);
  });

  it('rejects an invalid MEMBER role rather than treating it as a principal', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/reviews/${reviewAId}/approve`,
      headers: {
        'x-merchant-id': merchantAId,
        'x-user-id': userMemberAId,
        'x-user-role': 'MEMBER',
      },
      payload: {
        notes: 'Unauthorized approval attempt by member',
      },
    });

    expect(res.statusCode).toBe(401);
  });

  it('rejects an invalid MEMBER role for reject and takeover', async () => {
    const rejectRes = await app.inject({
      method: 'POST',
      url: `/reviews/${reviewAId}/reject`,
      headers: {
        'x-merchant-id': merchantAId,
        'x-user-id': userMemberAId,
        'x-user-role': 'MEMBER',
      },
      payload: {
        reason: 'Unauthorized rejection attempt',
      },
    });
    expect(rejectRes.statusCode).toBe(401);

    const takeoverRes = await app.inject({
      method: 'POST',
      url: `/reviews/${reviewAId}/take-over`,
      headers: {
        'x-merchant-id': merchantAId,
        'x-user-id': userMemberAId,
        'x-user-role': 'MEMBER',
      },
    });
    expect(takeoverRes.statusCode).toBe(401);
  });

  it('REVIEWER principal can resolve review (returns 200 OK)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/reviews/${reviewAId}/approve`,
      headers: {
        'x-merchant-id': merchantAId,
        'x-user-id': userReviewerAId,
        'x-user-role': Role.REVIEWER,
      },
      payload: {
        notes: 'Approved by reviewer',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.approved).toBe(true);
    expect(mockReviewService.approveReview).toHaveBeenCalledWith(
      merchantAId,
      reviewAId,
      userReviewerAId,
      { notes: 'Approved by reviewer' },
    );
  });

  it('MERCHANT_ADMIN principal can resolve review (returns 200 OK)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/reviews/${reviewAId}/approve`,
      headers: {
        'x-merchant-id': merchantAId,
        'x-user-id': userAdminAId,
        'x-user-role': Role.MERCHANT_ADMIN,
      },
      payload: {
        notes: 'Approved by admin',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.approved).toBe(true);
  });

  it('request body merchantId cannot change tenant or spoof identity', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/reviews/${reviewAId}/approve`,
      headers: {
        'x-merchant-id': merchantAId,
        'x-user-id': userAdminAId,
        'x-user-role': Role.MERCHANT_ADMIN,
      },
      payload: {
        merchantId: merchantBId, // Spoofed body param
        userId: userAdminBId,   // Spoofed body param
        notes: 'Approved with spoofed body',
      },
    });

    expect(res.statusCode).toBe(200);
    // Service receives authenticated principal's merchantAId and userAdminAId, NOT spoofed body params
    expect(mockReviewService.approveReview).toHaveBeenCalledWith(
      merchantAId,
      reviewAId,
      userAdminAId,
      expect.objectContaining({ notes: 'Approved with spoofed body' }),
    );
  });

  it('handles stale proposal (409) and policy block (422)', async () => {
    mockReviewService.approveReview.mockResolvedValueOnce({
      approved: false,
      stale: true,
      reason: 'Proposal version is stale',
    });

    const staleRes = await app.inject({
      method: 'POST',
      url: `/reviews/${reviewAId}/approve`,
      headers: {
        'x-merchant-id': merchantAId,
        'x-user-id': userAdminAId,
        'x-user-role': Role.MERCHANT_ADMIN,
      },
    });

    expect(staleRes.statusCode).toBe(409);

    mockReviewService.approveReview.mockResolvedValueOnce({
      approved: false,
      blockedByPolicy: true,
      reason: 'Customer opted out',
    });

    const blockRes = await app.inject({
      method: 'POST',
      url: `/reviews/${reviewAId}/approve`,
      headers: {
        'x-merchant-id': merchantAId,
        'x-user-id': userAdminAId,
        'x-user-role': Role.MERCHANT_ADMIN,
      },
    });

    expect(blockRes.statusCode).toBe(422);
  });

  it('POST /reviews/:reviewId/reject and /close endpoints work with authenticated principal', async () => {
    const rejectRes = await app.inject({
      method: 'POST',
      url: `/reviews/${reviewAId}/reject`,
      headers: {
        'x-merchant-id': merchantAId,
        'x-user-id': userAdminAId,
        'x-user-role': Role.MERCHANT_ADMIN,
      },
      payload: {
        reason: 'Offer rejected',
        notes: 'Customer contacted support directly',
      },
    });
    expect(rejectRes.statusCode).toBe(200);

    const closeRes = await app.inject({
      method: 'POST',
      url: `/reviews/${reviewAId}/close`,
      headers: {
        'x-merchant-id': merchantAId,
        'x-user-id': userAdminAId,
        'x-user-role': Role.MERCHANT_ADMIN,
      },
      payload: {
        reason: 'Administrative stop',
        stopCase: true,
      },
    });
    expect(closeRes.statusCode).toBe(200);
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ReviewStatus } from '@prisma/client';
import { buildServer } from '../src/server.js';
import { ReviewStateConflictError, UnauthorizedReviewerError } from '@recoverai/shared';

describe('Human Review API Routes', () => {
  const merchantId = 'mch_api_test_01';
  const userId = 'usr_api_reviewer_01';
  const reviewId = 'rev_api_test_01';

  let mockReviewService: any;
  let app: any;

  beforeEach(() => {
    mockReviewService = {
      listReviews: vi.fn(async (mId: string, _filter?: any) => [
        {
          id: reviewId,
          merchantId: mId,
          caseId: 'case_01',
          status: ReviewStatus.PENDING,
          reasonForReview: 'Test review',
        },
      ]),
      getReviewById: vi.fn(async (mId: string, rId: string) => {
        if (rId !== reviewId || mId !== merchantId) {
          throw new Error(`Review "${rId}" not found for merchant "${mId}"`);
        }
        return {
          id: rId,
          merchantId: mId,
          caseId: 'case_01',
          status: ReviewStatus.PENDING,
          reasonForReview: 'Test review',
        };
      }),
      approveReview: vi.fn(async (_mId: string, _rId: string, _uId: string, _options?: any) => ({
        approved: true,
        review: { id: reviewId, status: ReviewStatus.APPROVED },
        executionResult: { executed: true, success: true },
      })),
      rejectReview: vi.fn(async (_mId: string, _rId: string, _uId: string, _options: any) => ({
        rejected: true,
        review: { id: reviewId, status: ReviewStatus.REJECTED },
      })),
      takeOverReview: vi.fn(async (_mId: string, _rId: string, _uId: string, _options?: any) => ({
        takenOver: true,
        review: { id: reviewId, status: ReviewStatus.TAKEN_OVER },
      })),
      closeReview: vi.fn(async (_mId: string, _rId: string, _uId: string, _options: any) => ({
        closed: true,
        review: { id: reviewId, status: ReviewStatus.CLOSED },
      })),
    };

    app = buildServer({
      checkDbConnection: async () => true,
      reviewService: mockReviewService,
    });
  });

  it('GET /reviews returns 200 with list of reviews', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/reviews',
      headers: {
        'x-merchant-id': merchantId,
        'x-user-id': userId,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.reviews).toHaveLength(1);
    expect(body.reviews[0].id).toBe(reviewId);
    expect(mockReviewService.listReviews).toHaveBeenCalledWith(merchantId, {});
  });

  it('GET /reviews returns 401 when merchant header is missing', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/reviews',
      headers: {
        'x-user-id': userId,
      },
    });

    expect(res.statusCode).toBe(401);
  });

  it('GET /reviews/:reviewId returns 200 with review details', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/reviews/${reviewId}`,
      headers: {
        'x-merchant-id': merchantId,
        'x-user-id': userId,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.review.id).toBe(reviewId);
  });

  it('GET /reviews/:reviewId returns 404 when review does not exist', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/reviews/non_existent_rev',
      headers: {
        'x-merchant-id': merchantId,
        'x-user-id': userId,
      },
    });

    expect(res.statusCode).toBe(404);
  });

  it('POST /reviews/:reviewId/approve returns 200 on approval', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/reviews/${reviewId}/approve`,
      headers: {
        'x-merchant-id': merchantId,
        'x-user-id': userId,
      },
      payload: {
        notes: 'Approved via API',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.approved).toBe(true);
    expect(mockReviewService.approveReview).toHaveBeenCalledWith(
      merchantId,
      reviewId,
      userId,
      { notes: 'Approved via API' },
    );
  });

  it('POST /reviews/:reviewId/approve returns 409 on stale proposal', async () => {
    mockReviewService.approveReview.mockResolvedValueOnce({
      approved: false,
      stale: true,
      reason: 'Proposal version is stale',
    });

    const res = await app.inject({
      method: 'POST',
      url: `/reviews/${reviewId}/approve`,
      headers: {
        'x-merchant-id': merchantId,
        'x-user-id': userId,
      },
    });

    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.payload);
    expect(body.stale).toBe(true);
  });

  it('POST /reviews/:reviewId/approve returns 422 when blocked by fresh policy', async () => {
    mockReviewService.approveReview.mockResolvedValueOnce({
      approved: false,
      blockedByPolicy: true,
      reason: 'Customer opted out',
    });

    const res = await app.inject({
      method: 'POST',
      url: `/reviews/${reviewId}/approve`,
      headers: {
        'x-merchant-id': merchantId,
        'x-user-id': userId,
      },
    });

    expect(res.statusCode).toBe(422);
    const body = JSON.parse(res.payload);
    expect(body.blockedByPolicy).toBe(true);
  });

  it('POST /reviews/:reviewId/reject returns 200 on rejection', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/reviews/${reviewId}/reject`,
      headers: {
        'x-merchant-id': merchantId,
        'x-user-id': userId,
      },
      payload: {
        reason: 'Offer rejected by merchant admin',
        notes: 'Customer discount exceeded limit',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.rejected).toBe(true);
  });

  it('POST /reviews/:reviewId/take-over returns 200 on takeover', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/reviews/${reviewId}/take-over`,
      headers: {
        'x-merchant-id': merchantId,
        'x-user-id': userId,
      },
      payload: {
        notes: 'Taking over for custom high-touch handling',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.takenOver).toBe(true);
  });

  it('POST /reviews/:reviewId/close returns 200 on administrative close', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/reviews/${reviewId}/close`,
      headers: {
        'x-merchant-id': merchantId,
        'x-user-id': userId,
      },
      payload: {
        reason: 'Administrative cancellation',
        stopCase: true,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.closed).toBe(true);
  });
});
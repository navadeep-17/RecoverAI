import { FastifyInstance, FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { ReviewStatus, Role } from '@prisma/client';
import { HumanReviewService } from '@recoverai/core';
import { ReviewStateConflictError, UnauthorizedReviewerError } from '@recoverai/shared';
import { requirePrincipal } from '../auth/principal.js';

export interface ReviewRoutesOptions {
  reviewService: HumanReviewService;
}

const sensitiveKey = /(secret|token|password|credential|authorization|api.?key|access.?key|private.?key|client.?secret)/i;
const safeParams = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(safeParams);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([key]) => !sensitiveKey.test(key)).map(([key, item]) => [key, safeParams(item)]));
};
const reviewDto = (review: any) => ({
  id: review.id, caseId: review.caseId, status: review.status, reviewKey: review.reviewKey,
  reasonForReview: review.reasonForReview, planVersionId: review.planVersionId, actionId: review.actionId,
  createdAt: review.createdAt, resolvedAt: review.resolvedAt, reviewDecision: review.reviewDecision,
  reviewNotes: review.reviewNotes, revalidatedPolicyDecision: review.revalidatedPolicyDecision,
  case: review.case ? { id: review.case.id, status: review.case.status, riskType: review.case.riskType, amountAtRisk: review.case.amountAtRisk?.toString?.() ?? review.case.amountAtRisk, currency: review.case.currency, customer: review.case.customer ? { id: review.case.customer.id, name: review.case.customer.name, email: review.case.customer.email } : undefined } : undefined,
  planVersion: review.planVersion ? { id: review.planVersion.id, version: review.planVersion.version, diagnosisSummary: review.planVersion.diagnosisSummary, confidence: review.planVersion.confidence, proposedActionType: review.planVersion.proposedActionType, proposedActionParams: safeParams(review.planVersion.proposedActionParams) } : undefined,
  action: review.action ? { id: review.action.id, actionType: review.action.actionType, policyRationale: review.action.policyRationale, actionParams: safeParams(review.action.actionParams) } : undefined,
});

export const reviewRoutes: FastifyPluginAsync<ReviewRoutesOptions> = async (
  app: FastifyInstance,
  options: ReviewRoutesOptions,
) => {
  const { reviewService } = options;

  // 1. GET /reviews — List reviews for authenticated merchant
  app.get('/', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const principal = requirePrincipal(req);
      const querySchema = z.object({
        status: z.nativeEnum(ReviewStatus).optional(),
        caseId: z.string().optional(),
      });
      const query = querySchema.parse(req.query);

      const reviews = await reviewService.listReviews(principal.merchantId, query);
      return reply.status(200).send({ reviews: reviews.map(reviewDto) });
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      if (errorMessage.startsWith('UNAUTHORIZED')) {
        return reply.status(401).send({ error: errorMessage });
      }
      if (err instanceof z.ZodError) {
        return reply.status(400).send({ error: 'Validation failed', details: err.errors });
      }
      return reply.status(500).send({ error: errorMessage });
    }
  });

  // 2. GET /reviews/:reviewId — Get single review details
  app.get('/:reviewId', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const principal = requirePrincipal(req);
      const paramsSchema = z.object({
        reviewId: z.string(),
      });
      const { reviewId } = paramsSchema.parse(req.params);

      const review = await reviewService.getReviewById(principal.merchantId, reviewId);
      return reply.status(200).send({ review: reviewDto(review) });
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      if (errorMessage.startsWith('UNAUTHORIZED')) {
        return reply.status(401).send({ error: errorMessage });
      }
      if (
        (typeof err === 'object' && err !== null && 'code' in err && (err as { code: string }).code === 'P2025') ||
        errorMessage.includes('not found')
      ) {
        return reply.status(404).send({ error: 'Review not found' });
      }
      return reply.status(500).send({ error: errorMessage });
    }
  });

  // 3. POST /reviews/:reviewId/approve — Approve review and execute proposal
  app.post('/:reviewId/approve', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const principal = requirePrincipal(req);
      if (principal.role !== Role.MERCHANT_ADMIN && principal.role !== Role.REVIEWER) {
        return reply.status(403).send({ error: 'UNAUTHORIZED_ROLE: Insufficient permissions for review approval' });
      }

      const paramsSchema = z.object({
        reviewId: z.string(),
      });
      const bodySchema = z.object({
        notes: z.string().optional(),
      }).optional();

      const { reviewId } = paramsSchema.parse(req.params);
      const body = bodySchema?.parse(req.body) || {};

      const result = await reviewService.approveReview(principal.merchantId, reviewId, principal.userId, body);

      if (!result.approved) {
        if (result.stale) {
          return reply.status(409).send({ error: 'Stale proposal', ...result });
        }
        if (result.blockedByPolicy) {
          return reply.status(422).send({ error: 'Blocked by policy', ...result });
        }
        if (result.requiresReview) {
          return reply.status(422).send({ error: 'Requires continued review', ...result });
        }
        return reply.status(400).send({ error: result.reason || result.error, ...result });
      }

      return reply.status(200).send(result);
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      if (errorMessage.startsWith('UNAUTHORIZED')) {
        return reply.status(401).send({ error: errorMessage });
      }
      if (err instanceof UnauthorizedReviewerError) {
        return reply.status(403).send({ error: err.message });
      }
      if (err instanceof ReviewStateConflictError) {
        return reply.status(409).send({ error: err.message });
      }
      if (
        (typeof err === 'object' && err !== null && 'code' in err && (err as { code: string }).code === 'P2025') ||
        errorMessage.includes('not found')
      ) {
        return reply.status(404).send({ error: 'Review or case not found' });
      }
      return reply.status(500).send({ error: errorMessage });
    }
  });

  // 4. POST /reviews/:reviewId/reject — Reject review proposal
  app.post('/:reviewId/reject', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const principal = requirePrincipal(req);
      if (principal.role !== Role.MERCHANT_ADMIN && principal.role !== Role.REVIEWER) {
        return reply.status(403).send({ error: 'UNAUTHORIZED_ROLE: Insufficient permissions for review rejection' });
      }

      const paramsSchema = z.object({
        reviewId: z.string(),
      });
      const bodySchema = z.object({
        reason: z.string().min(1),
        notes: z.string().optional(),
      });

      const { reviewId } = paramsSchema.parse(req.params);
      const body = bodySchema.parse(req.body);

      const result = await reviewService.rejectReview(principal.merchantId, reviewId, principal.userId, body);
      return reply.status(200).send(result);
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      if (errorMessage.startsWith('UNAUTHORIZED')) {
        return reply.status(401).send({ error: errorMessage });
      }
      if (err instanceof UnauthorizedReviewerError) {
        return reply.status(403).send({ error: err.message });
      }
      if (err instanceof ReviewStateConflictError) {
        return reply.status(409).send({ error: err.message });
      }
      if (
        (typeof err === 'object' && err !== null && 'code' in err && (err as { code: string }).code === 'P2025') ||
        errorMessage.includes('not found')
      ) {
        return reply.status(404).send({ error: 'Review not found' });
      }
      if (err instanceof z.ZodError) {
        return reply.status(400).send({ error: 'Validation failed', details: err.errors });
      }
      return reply.status(500).send({ error: errorMessage });
    }
  });

  // 5. POST /reviews/:reviewId/take-over — Human takes over case
  app.post('/:reviewId/take-over', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const principal = requirePrincipal(req);
      if (principal.role !== Role.MERCHANT_ADMIN && principal.role !== Role.REVIEWER) {
        return reply.status(403).send({ error: 'UNAUTHORIZED_ROLE: Insufficient permissions for review takeover' });
      }

      const paramsSchema = z.object({
        reviewId: z.string(),
      });
      const bodySchema = z.object({
        notes: z.string().optional(),
      }).optional();

      const { reviewId } = paramsSchema.parse(req.params);
      const body = bodySchema?.parse(req.body) || {};

      const result = await reviewService.takeOverReview(principal.merchantId, reviewId, principal.userId, body);
      return reply.status(200).send(result);
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      if (errorMessage.startsWith('UNAUTHORIZED')) {
        return reply.status(401).send({ error: errorMessage });
      }
      if (err instanceof UnauthorizedReviewerError) {
        return reply.status(403).send({ error: err.message });
      }
      if (err instanceof ReviewStateConflictError) {
        return reply.status(409).send({ error: err.message });
      }
      if (
        (typeof err === 'object' && err !== null && 'code' in err && (err as { code: string }).code === 'P2025') ||
        errorMessage.includes('not found')
      ) {
        return reply.status(404).send({ error: 'Review not found' });
      }
      return reply.status(500).send({ error: errorMessage });
    }
  });

  // 6. POST /reviews/:reviewId/close — Close review and stop case recovery
  app.post('/:reviewId/close', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const principal = requirePrincipal(req);
      if (principal.role !== Role.MERCHANT_ADMIN && principal.role !== Role.REVIEWER) {
        return reply.status(403).send({ error: 'UNAUTHORIZED_ROLE: Insufficient permissions for review closure' });
      }

      const paramsSchema = z.object({
        reviewId: z.string(),
      });
      const bodySchema = z.object({
        reason: z.string().min(1),
        notes: z.string().optional(),
        stopCase: z.boolean().optional(),
      });

      const { reviewId } = paramsSchema.parse(req.params);
      const body = bodySchema.parse(req.body);

      const result = await reviewService.closeReview(principal.merchantId, reviewId, principal.userId, body);
      return reply.status(200).send(result);
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      if (errorMessage.startsWith('UNAUTHORIZED')) {
        return reply.status(401).send({ error: errorMessage });
      }
      if (err instanceof UnauthorizedReviewerError) {
        return reply.status(403).send({ error: err.message });
      }
      if (err instanceof ReviewStateConflictError) {
        return reply.status(409).send({ error: err.message });
      }
      if (
        (typeof err === 'object' && err !== null && 'code' in err && (err as { code: string }).code === 'P2025') ||
        errorMessage.includes('not found')
      ) {
        return reply.status(404).send({ error: 'Review not found' });
      }
      if (err instanceof z.ZodError) {
        return reply.status(400).send({ error: 'Validation failed', details: err.errors });
      }
      return reply.status(500).send({ error: errorMessage });
    }
  });
};

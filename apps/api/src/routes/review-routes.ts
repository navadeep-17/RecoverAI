import { FastifyInstance, FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { ReviewStatus } from '@prisma/client';
import { HumanReviewService } from '@recoverai/core';
import { ReviewStateConflictError, UnauthorizedReviewerError } from '@recoverai/shared';

export interface ReviewRoutesOptions {
  reviewService: HumanReviewService;
}

interface AuthContext {
  merchantId: string;
  userId: string;
  role?: string;
}

function extractAuthContext(req: FastifyRequest): AuthContext {
  const merchantId = (req.headers['x-merchant-id'] as string) || (req.headers['x-tenant-id'] as string);
  const userId = (req.headers['x-user-id'] as string) || (req.headers['x-reviewer-id'] as string);
  const role = req.headers['x-user-role'] as string | undefined;

  if (!merchantId || typeof merchantId !== 'string') {
    throw new Error('UNAUTHORIZED_MERCHANT: Missing or invalid x-merchant-id header');
  }
  if (!userId || typeof userId !== 'string') {
    throw new Error('UNAUTHORIZED_USER: Missing or invalid x-user-id header');
  }

  return { merchantId, userId, role };
}

export const reviewRoutes: FastifyPluginAsync<ReviewRoutesOptions> = async (
  app: FastifyInstance,
  options: ReviewRoutesOptions,
) => {
  const { reviewService } = options;

  // 1. GET /reviews — List reviews for authenticated merchant
  app.get('/', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const { merchantId } = extractAuthContext(req);
      const querySchema = z.object({
        status: z.nativeEnum(ReviewStatus).optional(),
        caseId: z.string().optional(),
      });
      const query = querySchema.parse(req.query);

      const reviews = await reviewService.listReviews(merchantId, query);
      return reply.status(200).send({ reviews });
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
      const { merchantId } = extractAuthContext(req);
      const paramsSchema = z.object({
        reviewId: z.string(),
      });
      const { reviewId } = paramsSchema.parse(req.params);

      const review = await reviewService.getReviewById(merchantId, reviewId);
      return reply.status(200).send({ review });
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
      const { merchantId, userId } = extractAuthContext(req);
      const paramsSchema = z.object({
        reviewId: z.string(),
      });
      const bodySchema = z.object({
        notes: z.string().optional(),
      }).optional();

      const { reviewId } = paramsSchema.parse(req.params);
      const body = bodySchema?.parse(req.body) || {};

      const result = await reviewService.approveReview(merchantId, reviewId, userId, body);

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
      const { merchantId, userId } = extractAuthContext(req);
      const paramsSchema = z.object({
        reviewId: z.string(),
      });
      const bodySchema = z.object({
        reason: z.string().min(1),
        notes: z.string().optional(),
      });

      const { reviewId } = paramsSchema.parse(req.params);
      const body = bodySchema.parse(req.body);

      const result = await reviewService.rejectReview(merchantId, reviewId, userId, body);
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
      const { merchantId, userId } = extractAuthContext(req);
      const paramsSchema = z.object({
        reviewId: z.string(),
      });
      const bodySchema = z.object({
        notes: z.string().optional(),
      }).optional();

      const { reviewId } = paramsSchema.parse(req.params);
      const body = bodySchema?.parse(req.body) || {};

      const result = await reviewService.takeOverReview(merchantId, reviewId, userId, body);
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
      const { merchantId, userId } = extractAuthContext(req);
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

      const result = await reviewService.closeReview(merchantId, reviewId, userId, body);
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
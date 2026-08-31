import { AuditActorType, Role } from '@prisma/client';
import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { AuditRepository, PolicyConfigRepository } from '@recoverai/db';
import { requirePrincipal } from '../auth/principal.js';

export interface PolicyRoutesOptions {
  policyConfigRepo: PolicyConfigRepository;
  auditRepo: AuditRepository;
}

const integer = (min: number, max: number) => z.number().finite().int().min(min).max(max);
const policyPatchSchema = z.object({
  maxRetriesPerCase: integer(0, 20).optional(),
  maxContactsPerCase: integer(0, 20).optional(),
  maxActionsPerCase: integer(1, 50).optional(),
  cooldownHoursBetweenActions: integer(0, 720).optional(),
  highValueThreshold: z.string().regex(/^\d+(?:\.\d{1,2})?$/, 'Use a non-negative amount with at most two decimals').refine((value) => Number(value) <= 10_000_000, 'Threshold is too large').optional(),
  minConfidenceThreshold: z.number().finite().min(0).max(1).optional(),
  reviewFirstMode: z.boolean().optional(),
  checkoutAbandonmentThresholdMinutes: integer(1, 10_080).optional(),
  quietHoursStart: integer(0, 23).optional(),
  quietHoursEnd: integer(0, 23).optional(),
  quietHoursTimezone: z.string().trim().min(1).max(100).optional(),
  maxRecoveryWindowDays: integer(1, 365).optional(),
  overdueGracePeriodDays: integer(0, 365).optional(),
}).strict().refine((value) => Object.keys(value).length > 0, 'At least one policy setting is required');

function dto(config: Awaited<ReturnType<PolicyConfigRepository['getOrCreateConfig']>>) {
  return { ...config, highValueThreshold: config.highValueThreshold.toFixed(2), createdAt: config.createdAt.toISOString(), updatedAt: config.updatedAt.toISOString() };
}

export const policyRoutes: FastifyPluginAsync<PolicyRoutesOptions> = async (app, options) => {
  app.get('/', async (req, reply) => {
    try {
      const principal = requirePrincipal(req);
      return reply.send({ policy: dto(await options.policyConfigRepo.getOrCreateConfig(principal.merchantId)) });
    } catch (error) {
      return reply.status(401).send({ error: error instanceof Error ? error.message : 'Unauthorized' });
    }
  });

  app.patch('/', async (req, reply) => {
    try {
      const principal = requirePrincipal(req);
      if (principal.role !== Role.MERCHANT_ADMIN) return reply.status(403).send({ error: 'UNAUTHORIZED_ROLE: Merchant admin permission is required for policy changes' });
      const patch = policyPatchSchema.parse(req.body);
      const policy = await options.policyConfigRepo.updateConfig(principal.merchantId, patch);
      await options.auditRepo.record(principal.merchantId, {
        eventType: 'POLICY_CONFIG_UPDATED', actorType: AuditActorType.HUMAN, actorId: principal.userId,
        inputSummaryJson: { changedFields: Object.keys(patch).sort() }, reasonCode: 'MERCHANT_POLICY_CONFIG_UPDATED',
      });
      return reply.send({ policy: dto(policy) });
    } catch (error) {
      if (error instanceof z.ZodError) return reply.status(400).send({ error: 'Validation failed', details: error.errors });
      return reply.status(400).send({ error: error instanceof Error ? error.message : 'Policy update failed' });
    }
  });
};

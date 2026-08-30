import { CaseStatus, RiskType } from '@prisma/client';
import { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AuditRepository, CaseRepository } from '@recoverai/db';
import { requirePrincipal } from '../auth/principal.js';

export interface CaseRoutesOptions {
  caseRepo: CaseRepository;
  auditRepo: AuditRepository;
}

const listQuery = z.object({
  status: z.nativeEnum(CaseStatus).optional(),
  riskType: z.nativeEnum(RiskType).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

function serialize(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value === 'object' && 'toString' in value && value.constructor?.name === 'Decimal') {
    return value.toString();
  }
  if (Array.isArray(value)) return value.map(serialize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, serialize(item)]));
  }
  return value;
}

export const caseRoutes: FastifyPluginAsync<CaseRoutesOptions> = async (
  app: FastifyInstance,
  options,
) => {
  app.get('/', async (req: FastifyRequest, reply: FastifyReply) => {
    const principal = requirePrincipal(req);
    const filter = listQuery.parse(req.query);
    const cases = await options.caseRepo.listCases(principal.merchantId, filter);
    return reply.send({ cases: serialize(cases) });
  });

  app.get('/:caseId', async (req: FastifyRequest, reply: FastifyReply) => {
    const principal = requirePrincipal(req);
    const params = z.object({ caseId: z.string().min(1) }).parse(req.params);
    const caseRecord = await options.caseRepo.getCaseById(principal.merchantId, params.caseId);
    if (!caseRecord) return reply.status(404).send({ error: 'Case not found' });
    const auditEvents = await options.auditRepo.listByCase(principal.merchantId, params.caseId);
    return reply.send({ case: serialize(caseRecord), auditEvents: serialize(auditEvents) });
  });
};

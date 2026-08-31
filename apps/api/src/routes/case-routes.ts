import { CaseStatus, RiskType } from '@prisma/client';
import { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AuditRepository, CaseRepository, CaseWithRelations } from '@recoverai/db';
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

function date(value: Date | null | undefined): string | null { return value ? value.toISOString() : null; }
function decimal(value: { toString(): string } | null | undefined): string | null { return value ? value.toString() : null; }
function listCaseDto(item: Awaited<ReturnType<CaseRepository['listCases']>>[number]) { return { id: item.id, customerId: item.customerId, riskType: item.riskType, amountAtRisk: decimal(item.amountAtRisk), recoveredAmount: decimal(item.recoveredAmount), currency: item.currency, status: item.status, openedAt: item.openedAt.toISOString(), updatedAt: item.updatedAt.toISOString(), customer: item.customer ? { id: item.customer.id, name: item.customer.name, email: item.customer.email } : null }; }
function detailCaseDto(item: CaseWithRelations) { return { ...listCaseDto(item), planVersions: (item.planVersions ?? []).map((plan) => ({ id: plan.id, version: plan.version, diagnosisCode: plan.diagnosisCode, diagnosisSummary: plan.diagnosisSummary, confidence: plan.confidence, proposedActionType: plan.proposedActionType, reasoningSummary: plan.reasoningSummary, createdAt: plan.createdAt.toISOString() })), actions: (item.actions ?? []).map((action) => ({ id: action.id, actionType: action.actionType, status: action.status, policyDecision: action.policyDecision, policyRationale: action.policyRationale, providerName: action.providerName, externalActionId: action.externalActionId, createdAt: action.createdAt.toISOString(), executedAt: date(action.executedAt) })), outcomes: (item.outcomes ?? []).map((outcome) => ({ id: outcome.id, actionId: outcome.actionId, outcomeType: outcome.outcomeType, amountRecovered: decimal(outcome.amountRecovered), observedAt: outcome.observedAt.toISOString() })) }; }

export const caseRoutes: FastifyPluginAsync<CaseRoutesOptions> = async (
  app: FastifyInstance,
  options,
) => {
  app.get('/metrics', async (req: FastifyRequest, reply: FastifyReply) => {
    const principal = requirePrincipal(req);
    return reply.send(await options.caseRepo.getRevenueRadarMetrics(principal.merchantId));
  });

  app.get('/', async (req: FastifyRequest, reply: FastifyReply) => {
    const principal = requirePrincipal(req);
    const filter = listQuery.parse(req.query);
    const cases = await options.caseRepo.listCases(principal.merchantId, filter);
    return reply.send({ cases: cases.map(listCaseDto) });
  });

  app.get('/:caseId', async (req: FastifyRequest, reply: FastifyReply) => {
    const principal = requirePrincipal(req);
    const params = z.object({ caseId: z.string().min(1) }).parse(req.params);
    const caseRecord = await options.caseRepo.getCaseById(principal.merchantId, params.caseId);
    if (!caseRecord) return reply.status(404).send({ error: 'Case not found' });
    const auditEvents = await options.auditRepo.listByCase(principal.merchantId, params.caseId);
    return reply.send({ case: detailCaseDto(caseRecord), auditEvents: auditEvents.map((event) => ({ id: event.id, eventType: event.eventType, actorType: event.actorType, reasonCode: event.reasonCode, createdAt: event.createdAt.toISOString() })) });
  });
};

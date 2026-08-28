import { z } from 'zod';
import {
  RiskType,
  CaseStatus,
  PolicyDecision,
  RecoveryActionType,
  ActionExecutionStatus,
  MerchantEventSource,
  AuditActorType,
} from './constants.js';

export const RiskTypeSchema = z.nativeEnum(RiskType);
export const CaseStatusSchema = z.nativeEnum(CaseStatus);
export const PolicyDecisionSchema = z.nativeEnum(PolicyDecision);
export const RecoveryActionTypeSchema = z.nativeEnum(RecoveryActionType);
export const ActionExecutionStatusSchema = z.nativeEnum(ActionExecutionStatus);
export const MerchantEventSourceSchema = z.nativeEnum(MerchantEventSource);
export const AuditActorTypeSchema = z.nativeEnum(AuditActorType);

export const AgentDecisionSchema = z.object({
  diagnosisCode: z.string().min(1),
  diagnosisSummary: z.string().min(1),
  confidence: z.number().min(0).max(1),
  proposedActionType: RecoveryActionTypeSchema,
  proposedActionParams: z.record(z.unknown()).default({}),
  reasoningSummary: z.string().min(1),
  followUpAfterSeconds: z.number().optional(),
  shouldStop: z.boolean().optional().default(false),
  shouldEscalate: z.boolean().optional().default(false),
});

export type AgentDecision = z.infer<typeof AgentDecisionSchema>;

export const HealthCheckResponseSchema = z.object({
  status: z.enum(['ok', 'degraded', 'unhealthy']),
  version: z.string(),
  timestamp: z.string(),
  uptime: z.number(),
  service: z.string(),
});

export type HealthCheckResponse = z.infer<typeof HealthCheckResponseSchema>;

export const ReadyCheckResponseSchema = z.object({
  ready: z.boolean(),
  database: z.boolean(),
  worker: z.boolean().optional(),
  timestamp: z.string(),
});

export type ReadyCheckResponse = z.infer<typeof ReadyCheckResponseSchema>;

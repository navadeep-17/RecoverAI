export interface ScheduleJobParams {
  merchantId: string;
  caseId?: string;
  jobKey?: string;
  jobType: string;
  scheduledFor: Date;
  payloadJson: Record<string, unknown>;
}

export interface IJobScheduler {
  schedule(params: ScheduleJobParams): Promise<{ id: string; pgBossJobId?: string; created?: boolean }>;
}

export const RecoveryIterationJob = {
  type: 'RECOVERY_ITERATION',
  initialTriggerType: 'CASE_OPENED',
  initialTriggerKey: (caseId: string) => `CASE_OPENED:${caseId}`,
  initialJobKey: (caseId: string) => `recovery-iteration:${caseId}:case-opened`,
} as const;

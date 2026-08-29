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

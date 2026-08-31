export interface PolicyConfig {
  id: string; merchantId: string; maxRetriesPerCase: number; maxContactsPerCase: number; maxActionsPerCase: number;
  cooldownHoursBetweenActions: number; highValueThreshold: string; minConfidenceThreshold: number; reviewFirstMode: boolean;
  checkoutAbandonmentThresholdMinutes: number; quietHoursStart: number; quietHoursEnd: number; quietHoursTimezone: string;
  maxRecoveryWindowDays: number; overdueGracePeriodDays: number; createdAt: string; updatedAt: string;
}

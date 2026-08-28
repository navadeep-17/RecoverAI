export interface RecoveryContext {
  caseId: string;
  merchantId: string;
  riskType: string;
  amountAtRisk: number;
  currency: string;
  historySummary?: string;
}

export interface IRecoveryDetector {
  detectRisk(event: unknown): Promise<unknown>;
}

export interface IRecoveryObserver {
  observeOutcome(event: unknown): Promise<unknown>;
}

export interface BenchmarkEvaluationResult {
  strategyName: string;
  totalCases: number;
  totalRevenueAtRisk: number;
  totalRevenueRecovered: number;
  recoveryRate: number;
  unsafeActionsCount: number;
  policyViolationsCount: number;
  correctStopsCount: number;
}

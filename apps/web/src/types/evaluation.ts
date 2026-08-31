export interface EvaluationMetric { revenueRecoveredPaise: string; recoveryRate: number; unsafeActions: number; policyViolations: number; }
export interface EvaluationResult { strategy: string; metrics: EvaluationMetric; }
export interface EvaluationSnapshot { frozen: true; artifact: string; evaluatedAt: string | null; evaluatorFingerprint: string; approvedCheckpoint: string; scenarioCount: number; benchmarkLabel: string; seed: number; split: string; results: EvaluationResult[]; }

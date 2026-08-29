import { RecoveryActionType, type RiskType } from '@recoverai/shared';
import type { EvaluationStrategyName, Scenario, Split } from './harness.js';
import type { ScenarioEvaluationResult } from './runner.js';

export interface Metrics {
  revenueAtRiskPaise: string; revenueRecoveredPaise: string; recoveryRate: number;
  incrementalRevenueVsRuleBasedWithPolicyPaise: string; unsafeActions: number; policyViolations: number;
  correctStops: number; escalations: number; warrantedEscalations: number; escalationPrecision: number | null;
  actionsPerRecovery: number | null; contactsPerRecovery: number | null; averageActionsPerCase: number;
  medianTimeToRecoveryMinutes: number | null; casesRecovered: number; casesStopped: number;
  casesEscalated: number; casesExhausted: number;
}
export interface StrategyEvaluation { strategy: EvaluationStrategyName; split: Split; seed: number; caseCount: number; metrics: Metrics; byRiskFamily: Partial<Record<RiskType, Metrics>>; results: ScenarioEvaluationResult[]; }
const CONTACTS: readonly RecoveryActionType[] = [RecoveryActionType.REQUEST_PAYMENT_UPDATE, RecoveryActionType.CREATE_OR_SEND_PAYMENT_LINK, RecoveryActionType.SEND_CHECKOUT_RECOVERY, RecoveryActionType.SEND_RECEIVABLE_REMINDER];
function ratio(numerator: bigint, denominator: bigint): number { return denominator === 0n ? 0 : Number((numerator * 1_000_000n) / denominator) / 1_000_000; }
function aggregate(scenarios: Scenario[], results: ScenarioEvaluationResult[], baseline: bigint): Metrics {
  const risk = scenarios.reduce((sum, item) => sum + item.observable.amountPaise, 0n);
  const recovered = results.reduce((sum, item) => sum + item.recoveredPaise, 0n);
  const actions = results.reduce((sum, item) => sum + item.actionLedger.filter((entry) => entry.executed).length, 0);
  const contacts = results.reduce((sum, item) => sum + item.actionLedger.filter((entry) => entry.executed && CONTACTS.includes(entry.actionType)).length, 0);
  const recoveredCases = results.filter((item) => item.terminalState === 'RECOVERED');
  const times = recoveredCases.map((item) => item.recoveryMinute!).sort((a, b) => a - b);
  const escalated = results.filter((item) => item.terminalState === 'ESCALATED'); const warranted = escalated.filter((item) => item.escalationWarranted).length;
  return { revenueAtRiskPaise: risk.toString(), revenueRecoveredPaise: recovered.toString(), recoveryRate: ratio(recovered, risk),
    incrementalRevenueVsRuleBasedWithPolicyPaise: (recovered - baseline).toString(),
    unsafeActions: results.reduce((sum, item) => sum + item.actionLedger.filter((entry) => entry.unsafe).length, 0),
    policyViolations: results.reduce((sum, item) => sum + item.actionLedger.filter((entry) => entry.policyViolation).length, 0),
    correctStops: results.filter((item) => item.terminalState === 'STOPPED' && item.shouldStop).length,
    escalations: escalated.length, warrantedEscalations: warranted, escalationPrecision: escalated.length ? warranted / escalated.length : null,
    actionsPerRecovery: recoveredCases.length ? actions / recoveredCases.length : null,
    contactsPerRecovery: recoveredCases.length ? contacts / recoveredCases.length : null, averageActionsPerCase: results.length ? actions / results.length : 0,
    medianTimeToRecoveryMinutes: times.length ? times[Math.floor(times.length / 2)] : null,
    casesRecovered: recoveredCases.length, casesStopped: results.filter((item) => item.terminalState === 'STOPPED').length,
    casesEscalated: escalated.length, casesExhausted: results.filter((item) => item.terminalState === 'EXHAUSTED').length };
}
export function buildEvaluation(strategy: EvaluationStrategyName, split: Split, seed: number, scenarios: Scenario[], results: ScenarioEvaluationResult[], baselineResults: ScenarioEvaluationResult[]): StrategyEvaluation {
  const baseline = baselineResults.reduce((sum, result) => sum + result.recoveredPaise, 0n);
  const families = [...new Set(scenarios.map((scenario) => scenario.observable.riskType))]; const byRiskFamily: Partial<Record<RiskType, Metrics>> = {};
  for (const family of families) { const familyScenarios = scenarios.filter((scenario) => scenario.observable.riskType === family); const ids = new Set(familyScenarios.map((scenario) => scenario.observable.id)); const familyBaseline = baselineResults.filter((result) => ids.has(result.scenarioId)).reduce((sum, result) => sum + result.recoveredPaise, 0n); byRiskFamily[family] = aggregate(familyScenarios, results.filter((result) => ids.has(result.scenarioId)), familyBaseline); }
  return { strategy, split, seed, caseCount: scenarios.length, metrics: aggregate(scenarios, results, baseline), byRiskFamily, results };
}

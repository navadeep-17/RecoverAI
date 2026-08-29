import { generateScenarios, STRATEGIES, type EvaluationStrategyName, type Split } from './harness.js';
import { buildEvaluation, type StrategyEvaluation } from './metrics.js';
import { runScenario, type ScenarioEvaluationResult } from './runner.js';

export async function evaluate(seed: number, split: Split): Promise<StrategyEvaluation[]> {
  const scenarios = generateScenarios(seed).filter((scenario) => scenario.observable.split === split);
  const all = new Map<EvaluationStrategyName, ScenarioEvaluationResult[]>();
  for (const strategy of STRATEGIES) {
    const results: ScenarioEvaluationResult[] = [];
    for (const scenario of scenarios) results.push(await runScenario({ scenario, strategy, seed }));
    all.set(strategy, results);
  }
  const baseline = all.get('RULE_BASED_WITH_POLICY')!;
  return STRATEGIES.map((strategy) => buildEvaluation(strategy, split, seed, scenarios, all.get(strategy)!, baseline));
}

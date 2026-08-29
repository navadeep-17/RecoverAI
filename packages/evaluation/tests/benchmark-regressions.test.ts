import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseCliOptions } from '../src/cli-options.js';
import { evaluate } from '../src/evaluator.js';
import { STRATEGIES, generateScenarios } from '../src/harness.js';
import { runScenario } from '../src/runner.js';

describe('benchmark orchestration regressions', () => {
  it('strategy run order does not change results or mutate another world', async () => {
    const scenario = generateScenarios(42)[0];
    const forward = new Map<string, unknown>(); const reverse = new Map<string, unknown>();
    for (const strategy of STRATEGIES) forward.set(strategy, await runScenario({ scenario, strategy, seed: 42 }));
    for (const strategy of [...STRATEGIES].reverse()) reverse.set(strategy, await runScenario({ scenario, strategy, seed: 42 }));
    for (const strategy of STRATEGIES) expect(reverse.get(strategy)).toEqual(forward.get(strategy));
    expect(scenario).toEqual(generateScenarios(42)[0]);
  });
  it('oracle-only fields are absent from summary artifacts', () => {
    for (const split of ['dev', 'validation']) {
      const artifact = readFileSync(`packages/evaluation/results/${split}-summary.json`, 'utf8');
      expect(artifact).not.toContain('failureCause'); expect(artifact).not.toContain('oracle');
    }
  });
  it('CLI requires an explicit split and never defaults to heldout', () => {
    expect(() => parseCliOptions(['--seed', '42'])).toThrow('Missing required --split');
    expect(parseCliOptions(['--seed', '42', '--split', 'dev']).split).toBe('dev');
    expect(parseCliOptions(['--seed', '42', '--split', 'validation']).split).toBe('validation');
  });
  it('all six strategies operate on identical scenario IDs', async () => {
    const evaluations = await evaluate(42, 'dev'); const expected = evaluations[0].results.map((result) => result.scenarioId);
    expect(evaluations).toHaveLength(6);
    expect(evaluations.every((evaluation) => evaluation.results.map((result) => result.scenarioId).join('|') === expected.join('|'))).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import { RecoveryAgent, MockLLMProvider } from '@recoverai/core';
import { RiskType } from '@recoverai/shared';
import { buildEvaluation } from '../src/metrics.js';
import { generateScenarios, STRATEGIES } from '../src/harness.js';
import { createWorld } from '../src/simulator.js';

describe('evaluation boundaries and metrics', () => {
  it('gives all strategies identical isolated initial observable state', () => {
    const scenario = generateScenarios(42)[0];
    const snapshots = STRATEGIES.map(() => createWorld(scenario).observable);
    expect(snapshots.every((state) => JSON.stringify(state, (_key, value) => typeof value === 'bigint' ? value.toString() : value) === JSON.stringify(snapshots[0], (_key, value) => typeof value === 'bigint' ? value.toString() : value))).toBe(true);
    expect(snapshots[0]).not.toHaveProperty('oracle');
  });
  it('fails malformed deterministic agent output closed through production parser', async () => {
    const provider = new MockLLMProvider(); provider.setMockResponse('{"proposedActionType":"RETRY_PAYMENT","executeNow":true}');
    const agent = new RecoveryAgent(provider);
    await expect(agent.generateProposal({ caseId: 'x', merchantId: 'm', riskType: RiskType.PAYMENT_FAILURE,
      amountAtRisk: '10.00', currency: 'INR', caseOpenedAt: new Date('2025-01-01T00:00:00Z'), priorActions: [], priorOutcomes: [],
      retryCount: 0, contactCount: 0, allowedActions: ['RETRY_PAYMENT'] })).rejects.toThrow('strict schema validation');
  });
  it('aggregates paise, terminal counts, safety, and risk family from result ledgers', () => {
    const scenario = generateScenarios(42)[0];
    const result = { scenarioId: scenario.observable.id, riskType: scenario.observable.riskType, strategy: 'RULE_BASED' as const,
      terminalState: 'RECOVERED' as const, recoveredPaise: 101n, recoveryMinute: 5, actionLedger: [], eventLedger: [],
      shouldStop: false, escalationWarranted: false, exhaustedByIterationCap: false };
    const evaluation = buildEvaluation('RULE_BASED', 'dev', 42, [scenario], [result], []);
    expect(evaluation.metrics.revenueRecoveredPaise).toBe('101'); expect(evaluation.metrics.casesRecovered).toBe(1);
    expect(evaluation.byRiskFamily[scenario.observable.riskType]?.revenueRecoveredPaise).toBe('101');
  });
});

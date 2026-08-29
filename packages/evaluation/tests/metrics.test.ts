import { describe, expect, it } from 'vitest';
import { RecoveryAgent, MockLLMProvider } from '@recoverai/core';
import { RecoveryActionType, RiskType } from '@recoverai/shared';
import { buildEvaluation } from '../src/metrics.js';
import { generateScenarios, STRATEGIES } from '../src/harness.js';
import type { ScenarioEvaluationResult } from '../src/runner.js';
import { createWorld } from '../src/simulator.js';
import { makeScenario } from './fixtures.js';

function result(id: string, terminalState: ScenarioEvaluationResult['terminalState'], recoveredPaise: bigint,
  recoveryMinute: number | null, actions: RecoveryActionType[] = [], escalationWarranted = false): ScenarioEvaluationResult {
  return { scenarioId: id, riskType: RiskType.PAYMENT_FAILURE, strategy: 'RULE_BASED', terminalState, recoveredPaise,
    recoveryMinute, actionLedger: actions.map((actionType, iteration) => ({ iteration, minute: iteration,
      actionType, params: {}, policyDecision: null, policyReasonCode: 'test', executed: true,
      simulatorResult: { status: 'SUCCESS', detail: 'test' }, unsafe: false, policyViolation: false })),
    eventLedger: [], shouldStop: false, escalationWarranted, exhaustedByIterationCap: false };
}

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
  it('defines recovery-rate zero denominator as zero', () => {
    const scenario = makeScenario({ amountPaise: 0n });
    expect(buildEvaluation('RULE_BASED', 'dev', 42, [scenario], [result('test', 'EXHAUSTED', 0n, null)], []).metrics.recoveryRate).toBe(0);
  });
  it('defines escalation precision zero denominator as null and positive formula exactly', () => {
    const one = makeScenario({ id: 'one' }); const two = makeScenario({ id: 'two' });
    expect(buildEvaluation('RULE_BASED', 'dev', 42, [one], [result('one', 'EXHAUSTED', 0n, null)], []).metrics.escalationPrecision).toBeNull();
    const metrics = buildEvaluation('RULE_BASED', 'dev', 42, [one, two],
      [result('one', 'ESCALATED', 0n, null, [], true), result('two', 'ESCALATED', 0n, null, [], false)], []).metrics;
    expect(metrics.escalationPrecision).toBe(0.5);
  });
  it('calculates actions and contacts per recovery exactly', () => {
    const one = makeScenario({ id: 'one' }); const two = makeScenario({ id: 'two' });
    const metrics = buildEvaluation('RULE_BASED', 'dev', 42, [one, two], [
      result('one', 'RECOVERED', 100_000n, 10, [RecoveryActionType.REQUEST_PAYMENT_UPDATE, RecoveryActionType.RETRY_PAYMENT]),
      result('two', 'EXHAUSTED', 0n, null, [RecoveryActionType.SEND_CHECKOUT_RECOVERY]),
    ], []).metrics;
    expect(metrics.actionsPerRecovery).toBe(3); expect(metrics.contactsPerRecovery).toBe(2);
  });
  it('uses the upper-middle median definition', () => {
    const scenarios = ['a', 'b', 'c', 'd'].map((id) => makeScenario({ id }));
    const results = [1, 5, 9, 10].map((minute, index) => result(scenarios[index].observable.id, 'RECOVERED', 1n, minute));
    expect(buildEvaluation('RULE_BASED', 'dev', 42, scenarios, results, []).metrics.medianTimeToRecoveryMinutes).toBe(9);
  });
  it('family recovered and at-risk totals equal overall totals', () => {
    const scenarios = [makeScenario({ id: 'payment', riskType: RiskType.PAYMENT_FAILURE, amountPaise: 11n }),
      makeScenario({ id: 'checkout', riskType: RiskType.CHECKOUT_ABANDONMENT, amountPaise: 13n })];
    const results = [result('payment', 'RECOVERED', 11n, 1), { ...result('checkout', 'RECOVERED', 13n, 2), riskType: RiskType.CHECKOUT_ABANDONMENT }];
    const evaluation = buildEvaluation('RULE_BASED', 'dev', 42, scenarios, results, []);
    const familyRisk = Object.values(evaluation.byRiskFamily).reduce((sum, metrics) => sum + BigInt(metrics!.revenueAtRiskPaise), 0n);
    const familyRecovered = Object.values(evaluation.byRiskFamily).reduce((sum, metrics) => sum + BigInt(metrics!.revenueRecoveredPaise), 0n);
    expect(familyRisk.toString()).toBe(evaluation.metrics.revenueAtRiskPaise);
    expect(familyRecovered.toString()).toBe(evaluation.metrics.revenueRecoveredPaise);
  });
});

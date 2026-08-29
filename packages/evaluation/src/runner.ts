import { isActionCompatible } from '@recoverai/core';
import { PolicyDecision, RecoveryActionType } from '@recoverai/shared';
import type { EvaluationStrategyName, Scenario } from './harness.js';
import { evaluatePolicy, POLICY_LIMITS } from './policy-adapter.js';
import { advanceToNextEvent, applyAction, createWorld, exhaust, type ObservableEvent, type SimulatorActionResult, type TerminalState } from './simulator.js';
import { createStrategy, observableContext } from './strategies.js';

export interface ActionLedgerEntry {
  iteration: number; minute: number; actionType: RecoveryActionType; params: Record<string, unknown>;
  policyDecision: PolicyDecision | null; policyReasonCode: string; executed: boolean;
  simulatorResult: SimulatorActionResult | null; unsafe: boolean; policyViolation: boolean;
}
export interface EventLedgerEntry { minute: number; eventType: ObservableEvent['type']; authoritativeMoneyEvent: boolean; amountPaise?: string; eventId: string; sourceAction?: RecoveryActionType; }
export interface ScenarioEvaluationResult {
  scenarioId: string; riskType: Scenario['observable']['riskType']; strategy: EvaluationStrategyName;
  terminalState: Exclude<TerminalState, 'OPEN'>; recoveredPaise: bigint; recoveryMinute: number | null;
  actionLedger: ActionLedgerEntry[]; eventLedger: EventLedgerEntry[];
  shouldStop: boolean; escalationWarranted: boolean; exhaustedByIterationCap: boolean;
}
export interface RunScenarioOptions { scenario: Scenario; strategy: EvaluationStrategyName; seed: number; maxIterations?: number; }

const CONTACT_ACTIONS: readonly RecoveryActionType[] = [RecoveryActionType.REQUEST_PAYMENT_UPDATE, RecoveryActionType.CREATE_OR_SEND_PAYMENT_LINK,
  RecoveryActionType.SEND_CHECKOUT_RECOVERY, RecoveryActionType.SEND_RECEIVABLE_REMINDER];

export function evaluateIndependentSafety(scenario: Scenario, state: ReturnType<typeof createWorld>['observable'], action: RecoveryActionType, audit: ReturnType<typeof evaluatePolicy>, executed: boolean): boolean {
  const duplicateHarm = state.actions.at(-1) === action && (action === RecoveryActionType.RETRY_PAYMENT || CONTACT_ACTIONS.includes(action));
  return (state.status !== 'OPEN' && executed) || !isActionCompatible(state.scenario.riskType, action) ||
    (action === RecoveryActionType.RETRY_PAYMENT && (state.scenario.verifiedFailureCode === 'DO_NOT_HONOR' || state.retries >= POLICY_LIMITS.retries)) ||
    (CONTACT_ACTIONS.includes(action) && (state.scenario.optedOut || !state.scenario.contactConsent || state.contacts >= POLICY_LIMITS.contacts)) ||
    state.actions.length >= POLICY_LIMITS.actions || duplicateHarm || (audit.decision === PolicyDecision.DENY && executed) ||
    (audit.decision === PolicyDecision.REVIEW && executed && action !== RecoveryActionType.ESCALATE_TO_HUMAN) ||
    (scenario.oracle.shouldStop && action !== RecoveryActionType.STOP_RECOVERY && executed);
}

export async function runScenario(options: RunScenarioOptions): Promise<ScenarioEvaluationResult> {
  const maxIterations = options.maxIterations ?? 12; const world = createWorld(options.scenario);
  const strategy = createStrategy(options.strategy, options.strategy === 'POLICY_AWARE_ORACLE' ? structuredClone(options.scenario.oracle) : undefined);
  const actionLedger: ActionLedgerEntry[] = []; let capped = false;
  for (let iteration = 1; iteration <= maxIterations && world.observable.status === 'OPEN'; iteration += 1) {
    const candidate = await strategy.nextAction(observableContext(world.observable));
    if (!candidate) { if (!advanceToNextEvent(world)) exhaust(world); continue; }
    const audit = evaluatePolicy(world.observable, candidate.action, candidate.confidence);
    let executed = !strategy.policyAware; let simulatorResult: SimulatorActionResult | null = null;
    if (strategy.policyAware) {
      if (audit.decision === PolicyDecision.ALLOW) executed = true;
      else if (audit.decision === PolicyDecision.REVIEW) world.observable.status = 'ESCALATED';
    }
    const unsafe = evaluateIndependentSafety(options.scenario, world.observable, candidate.action, audit, executed);
    if (executed) simulatorResult = applyAction(world, candidate.action);
    actionLedger.push({ iteration, minute: world.observable.minute, actionType: candidate.action, params: candidate.params,
      policyDecision: strategy.policyAware ? audit.decision : null, policyReasonCode: audit.reasonCode,
      executed, simulatorResult, unsafe, policyViolation: executed && audit.decision === PolicyDecision.DENY });
    if (world.observable.status === 'OPEN') {
      const advanced = advanceToNextEvent(world);
      if (!executed && audit.decision === PolicyDecision.DENY && !advanced) exhaust(world);
    }
  }
  if (world.observable.status === 'OPEN') { capped = true; exhaust(world); }
  const moneyEvents = world.observable.events.filter((event) => event.authoritativeMoneyEvent);
  return { scenarioId: options.scenario.observable.id, riskType: options.scenario.observable.riskType,
    strategy: options.strategy, terminalState: world.observable.status as Exclude<TerminalState, 'OPEN'>,
    recoveredPaise: moneyEvents.reduce((sum, event) => sum + (event.amountPaise ?? 0n), 0n),
    recoveryMinute: moneyEvents[0]?.minute ?? null, actionLedger,
    eventLedger: world.observable.events.map((event) => ({ minute: event.minute, eventType: event.type,
      authoritativeMoneyEvent: event.authoritativeMoneyEvent, amountPaise: event.amountPaise?.toString(), eventId: event.id,
      sourceAction: event.sourceAction })), shouldStop: options.scenario.oracle.shouldStop,
    escalationWarranted: options.scenario.oracle.shouldEscalate, exhaustedByIterationCap: capped };
}

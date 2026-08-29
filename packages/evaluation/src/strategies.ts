import { AgentProposalSchema, MockLLMProvider, RecoveryAgent, getAllowedActionsForRisk, type AgentContext, type AgentProposal } from '@recoverai/core';
import { RecoveryActionType, RiskType } from '@recoverai/shared';
import type { EvaluationStrategyName, OracleScenario } from './harness.js';
import { POLICY_LIMITS } from './policy-adapter.js';
import type { ObservableCaseState } from './simulator.js';

export interface StrategyDecision { action: RecoveryActionType; params: Record<string, unknown>; confidence: number; }
export interface ObservableStrategyContext { readonly state: Readonly<ObservableCaseState>; readonly allowedActions: readonly RecoveryActionType[]; }
export interface OracleStrategyContext extends ObservableStrategyContext { readonly oracle: Readonly<OracleScenario>; }
export interface EvaluationStrategy { readonly name: EvaluationStrategyName; readonly policyAware: boolean; nextAction(context: ObservableStrategyContext): Promise<StrategyDecision | null>; }

const decision = (action: RecoveryActionType, confidence = 0.9): StrategyDecision => ({ action, params: {}, confidence });
function has(state: Readonly<ObservableCaseState>, type: string): boolean { return state.events.some((event) => event.type === type); }
function latestEvent(state: Readonly<ObservableCaseState>): string | undefined { return state.events.at(-1)?.type; }

export function ruleCandidate(context: ObservableStrategyContext): StrategyDecision {
  const state = context.state; const risk = state.scenario.riskType;
  if (risk === RiskType.CHECKOUT_ABANDONMENT) {
    if (has(state, 'NO_RESPONSE')) return decision(RecoveryActionType.ESCALATE_TO_HUMAN);
    return decision(RecoveryActionType.SEND_CHECKOUT_RECOVERY);
  }
  if (risk === RiskType.OVERDUE_RECEIVABLE) {
    if (has(state, 'PROMISE_TO_PAY_BROKEN')) return decision(RecoveryActionType.ESCALATE_TO_HUMAN);
    if (has(state, 'PROMISE_TO_PAY')) return decision(RecoveryActionType.RECORD_PROMISE_TO_PAY);
    if (has(state, 'NO_RESPONSE')) return decision(RecoveryActionType.ESCALATE_TO_HUMAN);
    return decision(RecoveryActionType.SEND_RECEIVABLE_REMINDER);
  }
  if (state.scenario.verifiedFailureCode === 'CARD_EXPIRED' && !has(state, 'PAYMENT_METHOD_UPDATED')) return decision(RecoveryActionType.REQUEST_PAYMENT_UPDATE);
  if (latestEvent(state) === 'PAYMENT_RETRY_FAILED') return decision(RecoveryActionType.SCHEDULE_FOLLOWUP);
  if (state.retries >= 3) return decision(RecoveryActionType.STOP_RECOVERY);
  return decision(RecoveryActionType.RETRY_PAYMENT);
}

class StandardStrategy implements EvaluationStrategy {
  constructor(public readonly name: EvaluationStrategyName, public readonly policyAware: boolean) {}
  async nextAction(context: ObservableStrategyContext): Promise<StrategyDecision | null> {
    if (this.name === 'NO_INTERVENTION') return null;
    if (this.name === 'NAIVE_RECOVERY') {
      if (context.state.scenario.riskType === RiskType.CHECKOUT_ABANDONMENT) return decision(RecoveryActionType.SEND_CHECKOUT_RECOVERY, 0.8);
      if (context.state.scenario.riskType === RiskType.OVERDUE_RECEIVABLE) return decision(RecoveryActionType.SEND_RECEIVABLE_REMINDER, 0.8);
      return decision(RecoveryActionType.RETRY_PAYMENT, 0.8);
    }
    return ruleCandidate(context);
  }
}

function proposalFor(context: ObservableStrategyContext): AgentProposal {
  const state = context.state;
  let candidate: StrategyDecision;
  if (state.scenario.optedOut) candidate = decision(RecoveryActionType.SCHEDULE_FOLLOWUP, 0.95);
  else if (state.scenario.verifiedFailureCode === 'DO_NOT_HONOR') candidate = decision(RecoveryActionType.STOP_RECOVERY, 0.95);
  else candidate = ruleCandidate(context);
  return AgentProposalSchema.parse({ diagnosisCode: state.scenario.verifiedFailureCode ?? state.scenario.riskType,
    diagnosisSummary: 'Deterministic evaluation diagnosis from observable evidence', confidence: candidate.confidence,
    proposedActionType: candidate.action, proposedActionParams: candidate.params,
    reasoningSummary: 'One observable next action for closed-loop evaluation', followUpAfterSeconds: null,
    shouldStop: candidate.action === RecoveryActionType.STOP_RECOVERY,
    shouldEscalate: candidate.action === RecoveryActionType.ESCALATE_TO_HUMAN });
}

class RecoverAIStrategy implements EvaluationStrategy {
  readonly name = 'RECOVERAI'; readonly policyAware = true;
  async nextAction(context: ObservableStrategyContext): Promise<StrategyDecision> {
    const mock = new MockLLMProvider(); mock.setMockResponse(JSON.stringify(proposalFor(context)));
    const state = context.state;
    const agentContext: AgentContext = { caseId: state.scenario.id, merchantId: 'evaluation-merchant', riskType: state.scenario.riskType,
      amountAtRisk: `${state.scenario.amountPaise / 100n}.${(state.scenario.amountPaise % 100n).toString().padStart(2, '0')}`,
      currency: 'INR', caseOpenedAt: new Date('2025-01-01T12:00:00.000Z'),
      verifiedPaymentFacts: { gatewayErrorCode: state.scenario.verifiedFailureCode },
      customerHistory: { totalPastCases: 0, successfullyRecoveredCases: 0, contactConsent: state.scenario.contactConsent, optedOut: state.scenario.optedOut },
      priorActions: state.actions.map((actionType) => ({ actionType, executedAt: new Date('2025-01-01T12:00:00.000Z'), status: 'SUCCESS', policyDecision: 'ALLOW' })),
      priorOutcomes: state.events.map((event) => ({ outcomeType: event.type, observedAt: new Date('2025-01-01T12:00:00.000Z') })),
      retryCount: state.retries, contactCount: state.contacts, allowedActions: context.allowedActions };
    const proposal = await new RecoveryAgent(mock).generateProposal(agentContext);
    return { action: proposal.proposedActionType, params: proposal.proposedActionParams, confidence: proposal.confidence };
  }
}

export function createStrategy(name: EvaluationStrategyName, oracle?: OracleScenario): EvaluationStrategy {
  if (name === 'RECOVERAI') return new RecoverAIStrategy();
  if (name === 'POLICY_AWARE_ORACLE') {
    if (!oracle) throw new Error('Oracle strategy requires explicit oracle context');
    return { name, policyAware: true, async nextAction(context) {
      const state = context.state;
      if (state.actions.length >= POLICY_LIMITS.actions - 1) return decision(RecoveryActionType.STOP_RECOVERY);
      if (oracle.naturalConversionMinute !== null || oracle.naturalPaymentMinute !== null) return null;
      if ((!oracle.communicationAllowed || state.scenario.optedOut) && oracle.requiresContact) {
        return decision(oracle.shouldEscalate ? RecoveryActionType.ESCALATE_TO_HUMAN : RecoveryActionType.STOP_RECOVERY);
      }
      if (!oracle.recoverable && oracle.shouldStop) return decision(RecoveryActionType.STOP_RECOVERY);
      if (!oracle.recoverable && oracle.shouldEscalate) return decision(RecoveryActionType.ESCALATE_TO_HUMAN);
      if (oracle.failureCause === 'CARD_EXPIRED' && !has(state, 'PAYMENT_METHOD_UPDATED')) return decision(RecoveryActionType.REQUEST_PAYMENT_UPDATE);
      if (oracle.earliestSuccessfulRetryMinute !== null && state.minute < oracle.earliestSuccessfulRetryMinute) return decision(RecoveryActionType.SCHEDULE_FOLLOWUP);
      if (oracle.purchaseIntent !== null) return decision(oracle.contactCanConvert ? RecoveryActionType.SEND_CHECKOUT_RECOVERY : RecoveryActionType.STOP_RECOVERY);
      if (oracle.paymentBehavior === 'REMINDER_RESPONSIVE' || oracle.paymentBehavior === 'PROMISE_RELIABLE' || oracle.paymentBehavior === 'PROMISE_BREAKER') return ruleCandidate(context);
      return ruleCandidate(context);
    } };
  }
  return new StandardStrategy(name, name === 'RULE_BASED_WITH_POLICY');
}

export function observableContext(state: ObservableCaseState): ObservableStrategyContext {
  return { state: structuredClone(state), allowedActions: getAllowedActionsForRisk(state.scenario.riskType) };
}

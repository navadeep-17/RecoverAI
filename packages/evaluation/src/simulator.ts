import { RecoveryActionType, RiskType } from '@recoverai/shared';
import type { ObservableScenario, OracleScenario, Scenario } from './harness.js';

export type TerminalState = 'OPEN' | 'RECOVERED' | 'STOPPED' | 'ESCALATED' | 'EXHAUSTED';
export type EventType = 'PAYMENT_METHOD_UPDATED' | 'PAYMENT_SUCCEEDED' | 'CHECKOUT_COMPLETED' | 'INVOICE_PAID' | 'PROMISE_TO_PAY' | 'PROMISE_TO_PAY_BROKEN' | 'NO_RESPONSE' | 'TIMER_FIRED';
export interface ObservableEvent { id: string; type: EventType; minute: number; authoritativeMoneyEvent: boolean; amountPaise?: bigint; sourceAction?: RecoveryActionType; }
export interface ObservableCaseState { scenario: ObservableScenario; minute: number; status: TerminalState; events: ObservableEvent[]; actions: RecoveryActionType[]; contacts: number; retries: number; }
export interface SimulatorWorld { observable: ObservableCaseState; readonly oracle: OracleScenario; pending: ObservableEvent[]; credited: boolean; nextEventId: number; }
export interface SimulatorActionResult { status: 'SUCCESS' | 'FAILED'; detail: string; }

export function createWorld(scenario: Scenario): SimulatorWorld {
  const world: SimulatorWorld = { observable: { scenario: structuredClone(scenario.observable), minute: 0, status: 'OPEN', events: [], actions: [], contacts: 0, retries: 0 }, oracle: structuredClone(scenario.oracle), pending: [], credited: false, nextEventId: 1 };
  if (scenario.oracle.naturalRecoveryMinute !== null) schedule(world, scenario.oracle.naturalRecoveryMinute, moneyEventFor(scenario.observable.riskType));
  return world;
}
export function cloneWorld(world: SimulatorWorld): SimulatorWorld { return structuredClone(world); }
function moneyEventFor(riskType: RiskType): EventType { if (riskType === RiskType.CHECKOUT_ABANDONMENT) return 'CHECKOUT_COMPLETED'; if (riskType === RiskType.OVERDUE_RECEIVABLE) return 'INVOICE_PAID'; return 'PAYMENT_SUCCEEDED'; }
function isMoney(type: EventType): boolean { return type === 'PAYMENT_SUCCEEDED' || type === 'CHECKOUT_COMPLETED' || type === 'INVOICE_PAID'; }
function schedule(world: SimulatorWorld, minute: number, type: EventType, sourceAction?: RecoveryActionType): void {
  world.pending.push({ id: `${world.observable.scenario.id}-event-${world.nextEventId++}`, type, minute, authoritativeMoneyEvent: isMoney(type), amountPaise: isMoney(type) ? world.observable.scenario.amountPaise : undefined, sourceAction });
  world.pending.sort((a, b) => a.minute - b.minute || a.id.localeCompare(b.id));
}
function publish(world: SimulatorWorld, event: ObservableEvent): void { if (event.authoritativeMoneyEvent) { if (world.credited) return; world.credited = true; world.observable.status = 'RECOVERED'; } world.observable.events.push(event); }
export function advanceToNextEvent(world: SimulatorWorld): boolean {
  if (world.observable.status !== 'OPEN' || world.pending.length === 0) return false;
  const minute = world.pending[0].minute; world.observable.minute = minute;
  while (world.pending[0]?.minute === minute && world.observable.status === 'OPEN') publish(world, world.pending.shift()!);
  return true;
}
export function exhaust(world: SimulatorWorld): void { if (world.observable.status === 'OPEN') world.observable.status = 'EXHAUSTED'; }
export function applyAction(world: SimulatorWorld, action: RecoveryActionType): SimulatorActionResult {
  const state = world.observable; if (state.status !== 'OPEN') return { status: 'FAILED', detail: 'case-terminal' }; state.actions.push(action);
  if (action === RecoveryActionType.STOP_RECOVERY) { state.status = 'STOPPED'; return { status: 'SUCCESS', detail: 'stopped' }; }
  if (action === RecoveryActionType.ESCALATE_TO_HUMAN) { state.status = 'ESCALATED'; return { status: 'SUCCESS', detail: 'escalated' }; }
  if (action === RecoveryActionType.SCHEDULE_FOLLOWUP) { schedule(world, state.minute + 60, 'TIMER_FIRED', action); return { status: 'SUCCESS', detail: 'follow-up-scheduled' }; }
  if (action === RecoveryActionType.REQUEST_PAYMENT_UPDATE) { state.contacts += 1; schedule(world, state.minute + 120, world.oracle.respondsToContact ? 'PAYMENT_METHOD_UPDATED' : 'NO_RESPONSE', action); return { status: 'SUCCESS', detail: 'request-sent' }; }
  if (action === RecoveryActionType.RETRY_PAYMENT) { state.retries += 1; const updated = state.events.some((event) => event.type === 'PAYMENT_METHOD_UPDATED'); if (world.oracle.recoverable && (!world.oracle.requiresContact || updated)) schedule(world, state.minute + 5, 'PAYMENT_SUCCEEDED', action); return { status: 'SUCCESS', detail: 'retry-submitted' }; }
  if (action === RecoveryActionType.SEND_RECEIVABLE_REMINDER) { state.contacts += 1; schedule(world, state.minute + 60, world.oracle.respondsToContact ? 'PROMISE_TO_PAY' : 'NO_RESPONSE', action); return { status: 'SUCCESS', detail: 'reminder-sent' }; }
  const linkActions: readonly RecoveryActionType[] = [RecoveryActionType.CREATE_OR_SEND_PAYMENT_LINK, RecoveryActionType.SEND_CHECKOUT_RECOVERY];
  if (linkActions.includes(action)) { state.contacts += 1; schedule(world, state.minute + 60, world.oracle.respondsToContact ? moneyEventFor(state.scenario.riskType) : 'NO_RESPONSE', action); return { status: 'SUCCESS', detail: 'contact-sent' }; }
  if (action === RecoveryActionType.RECORD_PROMISE_TO_PAY) { schedule(world, state.minute + 1440, world.oracle.recoverable ? 'INVOICE_PAID' : 'PROMISE_TO_PAY_BROKEN', action); return { status: 'SUCCESS', detail: 'promise-recorded' }; }
  return { status: 'FAILED', detail: 'unsupported-action' };
}

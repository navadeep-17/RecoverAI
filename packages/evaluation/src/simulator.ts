import { RecoveryActionType, RiskType } from '@recoverai/shared';
import type { ObservableScenario, OracleScenario, Scenario } from './harness.js';

export type TerminalState = 'OPEN' | 'RECOVERED' | 'STOPPED' | 'ESCALATED' | 'EXHAUSTED';
export type EventType = 'PAYMENT_METHOD_UPDATED' | 'PAYMENT_RETRY_FAILED' | 'PAYMENT_SUCCEEDED' | 'CHECKOUT_COMPLETED' |
  'INVOICE_PAID' | 'PROMISE_TO_PAY' | 'PROMISE_TO_PAY_BROKEN' | 'NO_RESPONSE' | 'TIMER_FIRED';
export interface ObservableEvent { id: string; type: EventType; minute: number; authoritativeMoneyEvent: boolean; amountPaise?: bigint; sourceAction?: RecoveryActionType; }
export interface ObservableCaseState { scenario: ObservableScenario; minute: number; status: TerminalState; events: ObservableEvent[]; actions: RecoveryActionType[]; contacts: number; retries: number; }
export interface SimulatorWorld { observable: ObservableCaseState; readonly oracle: OracleScenario; pending: ObservableEvent[]; credited: boolean; nextEventId: number; }
export interface SimulatorActionResult { status: 'SUCCESS' | 'FAILED'; detail: string; }

export function createWorld(scenario: Scenario): SimulatorWorld {
  const world: SimulatorWorld = { observable: { scenario: structuredClone(scenario.observable), minute: 0, status: 'OPEN', events: [], actions: [], contacts: 0, retries: 0 },
    oracle: structuredClone(scenario.oracle), pending: [], credited: false, nextEventId: 1 };
  if (scenario.oracle.naturalConversionMinute !== null) schedule(world, scenario.oracle.naturalConversionMinute, 'CHECKOUT_COMPLETED');
  if (scenario.oracle.naturalPaymentMinute !== null) schedule(world, scenario.oracle.naturalPaymentMinute,
    scenario.observable.riskType === RiskType.OVERDUE_RECEIVABLE ? 'INVOICE_PAID' : 'PAYMENT_SUCCEEDED');
  return world;
}
export function cloneWorld(world: SimulatorWorld): SimulatorWorld { return structuredClone(world); }
function isMoney(type: EventType): boolean { return type === 'PAYMENT_SUCCEEDED' || type === 'CHECKOUT_COMPLETED' || type === 'INVOICE_PAID'; }
function schedule(world: SimulatorWorld, minute: number, type: EventType, sourceAction?: RecoveryActionType): void {
  world.pending.push({ id: `${world.observable.scenario.id}-event-${world.nextEventId++}`, type, minute,
    authoritativeMoneyEvent: isMoney(type), amountPaise: isMoney(type) ? world.observable.scenario.amountPaise : undefined, sourceAction });
  world.pending.sort((a, b) => a.minute - b.minute || a.id.localeCompare(b.id));
}
function publish(world: SimulatorWorld, event: ObservableEvent): void {
  if (event.authoritativeMoneyEvent) { if (world.credited) return; world.credited = true; world.observable.status = 'RECOVERED'; }
  world.observable.events.push(event);
}
export function advanceToNextEvent(world: SimulatorWorld): boolean {
  if (world.observable.status !== 'OPEN' || world.pending.length === 0) return false;
  const minute = world.pending[0].minute; world.observable.minute = minute;
  while (world.pending[0]?.minute === minute && world.observable.status === 'OPEN') publish(world, world.pending.shift()!);
  return true;
}
export function exhaust(world: SimulatorWorld): void { if (world.observable.status === 'OPEN') world.observable.status = 'EXHAUSTED'; }

function paymentRetryCanRecover(world: SimulatorWorld): boolean {
  const oracle = world.oracle; const minute = world.observable.minute;
  if (oracle.failureCause === 'CARD_EXPIRED') {
    return oracle.retryAfterMethodUpdateSucceeds && world.observable.events.some((event) => event.type === 'PAYMENT_METHOD_UPDATED');
  }
  if (!['TEMPORARY_GATEWAY', 'INSUFFICIENT_FUNDS', 'ISSUER_TEMPORARY'].includes(oracle.failureCause ?? '')) return false;
  return oracle.earliestSuccessfulRetryMinute !== null && minute >= oracle.earliestSuccessfulRetryMinute &&
    (oracle.maxUsefulRetryWindowMinute === null || minute <= oracle.maxUsefulRetryWindowMinute);
}

function contactStillUseful(world: SimulatorWorld): boolean {
  return world.oracle.communicationAllowed && world.observable.contacts <= world.oracle.responsivenessDecayAfterContacts;
}

export function applyAction(world: SimulatorWorld, action: RecoveryActionType): SimulatorActionResult {
  const state = world.observable; const oracle = world.oracle;
  if (state.status !== 'OPEN') return { status: 'FAILED', detail: 'case-terminal' };
  state.actions.push(action);
  if (action === RecoveryActionType.STOP_RECOVERY) { state.status = 'STOPPED'; return { status: 'SUCCESS', detail: 'stopped' }; }
  if (action === RecoveryActionType.ESCALATE_TO_HUMAN) { state.status = 'ESCALATED'; return { status: 'SUCCESS', detail: 'escalated' }; }
  if (action === RecoveryActionType.SCHEDULE_FOLLOWUP) { schedule(world, state.minute + oracle.followUpDelayMinutes, 'TIMER_FIRED', action); return { status: 'SUCCESS', detail: 'follow-up-scheduled' }; }
  if (action === RecoveryActionType.REQUEST_PAYMENT_UPDATE) {
    state.contacts += 1;
    schedule(world, state.minute + oracle.methodUpdateResponseDelayMinutes,
      oracle.methodUpdatePossible && contactStillUseful(world) ? 'PAYMENT_METHOD_UPDATED' : 'NO_RESPONSE', action);
    return { status: 'SUCCESS', detail: 'request-sent' };
  }
  if (action === RecoveryActionType.RETRY_PAYMENT) {
    state.retries += 1;
    schedule(world, state.minute + (paymentRetryCanRecover(world) ? oracle.retrySettlementDelayMinutes : 1),
      paymentRetryCanRecover(world) ? 'PAYMENT_SUCCEEDED' : 'PAYMENT_RETRY_FAILED', action);
    return { status: 'SUCCESS', detail: 'retry-submitted' };
  }
  if (action === RecoveryActionType.SEND_CHECKOUT_RECOVERY ||
      action === RecoveryActionType.CREATE_OR_SEND_PAYMENT_LINK && state.scenario.riskType === RiskType.CHECKOUT_ABANDONMENT) {
    state.contacts += 1;
    const converts = oracle.contactCanConvert && contactStillUseful(world);
    schedule(world, state.minute + oracle.contactConversionDelayMinutes, converts ? 'CHECKOUT_COMPLETED' : 'NO_RESPONSE', action);
    return { status: 'SUCCESS', detail: 'checkout-contact-sent' };
  }
  if (action === RecoveryActionType.SEND_RECEIVABLE_REMINDER) {
    state.contacts += 1; let event: EventType = 'NO_RESPONSE';
    if (contactStillUseful(world) && (oracle.paymentBehavior === 'REMINDER_RESPONSIVE' || oracle.paymentBehavior === 'NATURAL_LATE_PAYMENT')) event = 'INVOICE_PAID';
    else if (contactStillUseful(world) && (oracle.paymentBehavior === 'PROMISE_RELIABLE' || oracle.paymentBehavior === 'PROMISE_BREAKER')) event = 'PROMISE_TO_PAY';
    schedule(world, state.minute + oracle.reminderResponseDelayMinutes, event, action);
    return { status: 'SUCCESS', detail: 'reminder-sent' };
  }
  if (action === RecoveryActionType.RECORD_PROMISE_TO_PAY) {
    const hasPromise = state.events.some((event) => event.type === 'PROMISE_TO_PAY');
    if (!hasPromise) return { status: 'FAILED', detail: 'no-observed-promise' };
    schedule(world, state.minute + oracle.promisedPaymentDelayMinutes, oracle.promiseWillBeKept ? 'INVOICE_PAID' : 'PROMISE_TO_PAY_BROKEN', action);
    return { status: 'SUCCESS', detail: 'promise-recorded' };
  }
  if (action === RecoveryActionType.CREATE_OR_SEND_PAYMENT_LINK) {
    state.contacts += 1;
    const converts = oracle.communicationAllowed && oracle.customerResponseProfile !== 'UNRESPONSIVE' && contactStillUseful(world) && oracle.recoverable;
    schedule(world, state.minute + Math.max(1, oracle.contactConversionDelayMinutes || oracle.methodUpdateResponseDelayMinutes),
      converts ? 'PAYMENT_SUCCEEDED' : 'NO_RESPONSE', action);
    return { status: 'SUCCESS', detail: 'payment-link-sent' };
  }
  return { status: 'FAILED', detail: 'unsupported-action' };
}

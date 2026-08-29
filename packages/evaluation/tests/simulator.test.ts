import { describe, expect, it } from 'vitest';
import { RecoveryActionType } from '@recoverai/shared';
import { generateScenarios } from '../src/harness.js';
import { advanceToNextEvent, applyAction, cloneWorld, createWorld } from '../src/simulator.js';

describe('closed-loop virtual simulator', () => {
  it('credits only an authoritative receipt after update and retry', () => {
    const scenario = generateScenarios(42).find((item) => item.oracle.requiresContact && item.oracle.recoverable && item.observable.riskType === 'PAYMENT_FAILURE')!;
    const world = createWorld(scenario); applyAction(world, RecoveryActionType.REQUEST_PAYMENT_UPDATE);
    expect(world.credited).toBe(false); advanceToNextEvent(world);
    applyAction(world, RecoveryActionType.RETRY_PAYMENT); expect(world.credited).toBe(false);
    advanceToNextEvent(world); expect(world.credited).toBe(true);
    expect(world.observable.events.filter((event) => event.authoritativeMoneyEvent)).toHaveLength(1);
  });
  it('isolates cloned worlds', () => {
    const world = createWorld(generateScenarios(42)[0]); const copy = cloneWorld(world);
    applyAction(world, RecoveryActionType.STOP_RECOVERY); expect(copy.observable.status).toBe('OPEN');
  });
});

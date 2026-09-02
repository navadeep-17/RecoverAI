import { describe, expect, it } from 'vitest';
import {
  MAX_FOLLOW_UP_DELAY_SECONDS,
  MIN_FOLLOW_UP_DELAY_SECONDS,
  getBoundedFollowUpTime,
  getNextLawfulContactTime,
} from '../src/orchestration/recovery-timing.js';

describe('bounded durable recovery timing', () => {
  const now = new Date('2026-01-10T00:00:00.000Z');
  const openedAt = new Date('2026-01-01T00:00:00.000Z');

  it('clamps below-minimum, preserves feasible, and clamps above-maximum delays', () => {
    const below = getBoundedFollowUpTime({ now, caseOpenedAt: openedAt, maxRecoveryWindowDays: 30, requestedDelaySeconds: 1 });
    const feasible = getBoundedFollowUpTime({ now, caseOpenedAt: openedAt, maxRecoveryWindowDays: 30, requestedDelaySeconds: 3600 });
    const above = getBoundedFollowUpTime({ now, caseOpenedAt: openedAt, maxRecoveryWindowDays: 30, requestedDelaySeconds: 10 * 365 * 86400 });
    expect(below.boundedDelaySeconds).toBe(MIN_FOLLOW_UP_DELAY_SECONDS);
    expect(below.scheduledFor).toEqual(new Date(now.getTime() + MIN_FOLLOW_UP_DELAY_SECONDS * 1000));
    expect(feasible.boundedDelaySeconds).toBe(3600);
    expect(above.boundedDelaySeconds).toBe(MAX_FOLLOW_UP_DELAY_SECONDS);
  });

  it('caps at the recovery deadline and creates no future work after expiry', () => {
    const nearDeadline = getBoundedFollowUpTime({
      now: new Date('2026-01-30T23:00:00.000Z'),
      caseOpenedAt: openedAt,
      maxRecoveryWindowDays: 30,
      requestedDelaySeconds: 86400,
    });
    expect(nearDeadline.scheduledFor).toEqual(new Date('2026-01-31T00:00:00.000Z'));
    expect(getBoundedFollowUpTime({
      now: new Date('2026-01-31T00:00:00.000Z'),
      caseOpenedAt: openedAt,
      maxRecoveryWindowDays: 30,
      requestedDelaySeconds: 3600,
    }).scheduledFor).toBeNull();
  });

  it('rejects non-finite and non-positive model timing', () => {
    for (const requestedDelaySeconds of [Number.POSITIVE_INFINITY, -1, 0]) {
      expect(() => getBoundedFollowUpTime({ now, caseOpenedAt: openedAt, maxRecoveryWindowDays: 30, requestedDelaySeconds })).toThrow();
    }
  });
});

describe('exact merchant-local quiet-hours wake', () => {
  it('resolves an overnight Asia/Kolkata window to the exact 09:00 boundary', () => {
    expect(getNextLawfulContactTime({
      currentTime: new Date('2026-01-15T18:00:00.000Z'), // 23:30 IST
      timezone: 'Asia/Kolkata',
      startHour: 21,
      endHour: 9,
    })).toEqual(new Date('2026-01-16T03:30:00.000Z'));
  });

  it('supports same-day windows and treats the end boundary as lawful', () => {
    expect(getNextLawfulContactTime({
      currentTime: new Date('2026-01-15T02:30:00.000Z'),
      timezone: 'UTC',
      startHour: 1,
      endHour: 5,
    })).toEqual(new Date('2026-01-15T05:00:00.000Z'));
    const boundary = new Date('2026-01-15T03:30:00.000Z'); // 09:00 IST
    expect(getNextLawfulContactTime({ currentTime: boundary, timezone: 'Asia/Kolkata', startHour: 21, endHour: 9 })).toEqual(boundary);
  });

  it('uses IANA DST transitions rather than fixed offset arithmetic', () => {
    expect(getNextLawfulContactTime({
      currentTime: new Date('2026-03-08T06:30:00.000Z'), // 01:30 EST before spring-forward
      timezone: 'America/New_York',
      startHour: 1,
      endHour: 4,
    })).toEqual(new Date('2026-03-08T08:00:00.000Z')); // 04:00 EDT
  });

  it('fails closed for an invalid timezone', () => {
    expect(() => getNextLawfulContactTime({ currentTime: new Date(), timezone: 'Invalid/Timezone', startHour: 21, endHour: 9 })).toThrow(/valid IANA timezone/);
  });
});

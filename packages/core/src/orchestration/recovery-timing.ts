export const MIN_FOLLOW_UP_DELAY_SECONDS = 5 * 60;
export const MAX_FOLLOW_UP_DELAY_SECONDS = 7 * 24 * 60 * 60;
export const DEFAULT_FOLLOW_UP_DELAY_SECONDS = 24 * 60 * 60;

export interface BoundedFollowUpParams {
  now: Date;
  caseOpenedAt: Date;
  maxRecoveryWindowDays: number;
  requestedDelaySeconds?: number | null;
}

export interface BoundedFollowUpResult {
  requestedDelaySeconds: number;
  boundedDelaySeconds: number;
  recoveryDeadline: Date;
  scheduledFor: Date | null;
}

export function capScheduleToRecoveryWindow(
  now: Date,
  candidate: Date,
  caseOpenedAt: Date,
  maxRecoveryWindowDays: number,
): { scheduledFor: Date | null; recoveryDeadline: Date } {
  const recoveryDeadline = new Date(
    caseOpenedAt.getTime() + maxRecoveryWindowDays * 24 * 60 * 60 * 1000,
  );
  if (recoveryDeadline.getTime() <= now.getTime()) return { scheduledFor: null, recoveryDeadline };
  return {
    scheduledFor: new Date(Math.min(candidate.getTime(), recoveryDeadline.getTime())),
    recoveryDeadline,
  };
}

/** Deterministically limits model-suggested durable time to policy-owned bounds. */
export function getBoundedFollowUpTime(params: BoundedFollowUpParams): BoundedFollowUpResult {
  const requested = params.requestedDelaySeconds ?? DEFAULT_FOLLOW_UP_DELAY_SECONDS;
  if (!Number.isFinite(requested) || requested <= 0) {
    throw new RangeError('Follow-up delay must be a positive finite number of seconds');
  }
  if (!Number.isInteger(params.maxRecoveryWindowDays) || params.maxRecoveryWindowDays <= 0) {
    throw new RangeError('maxRecoveryWindowDays must be a positive integer');
  }

  const boundedDelaySeconds = Math.min(
    MAX_FOLLOW_UP_DELAY_SECONDS,
    Math.max(MIN_FOLLOW_UP_DELAY_SECONDS, Math.floor(requested)),
  );
  const requestedTime = params.now.getTime() + boundedDelaySeconds * 1000;
  const { recoveryDeadline, scheduledFor } = capScheduleToRecoveryWindow(
    params.now,
    new Date(requestedTime),
    params.caseOpenedAt,
    params.maxRecoveryWindowDays,
  );
  return {
    requestedDelaySeconds: requested,
    boundedDelaySeconds,
    recoveryDeadline,
    scheduledFor,
  };
}

export interface NextLawfulContactParams {
  currentTime: Date;
  timezone: string;
  startHour: number;
  endHour: number;
}

function validateQuietHours(params: NextLawfulContactParams): void {
  if (!Number.isInteger(params.startHour) || params.startHour < 0 || params.startHour > 23) {
    throw new RangeError('quietHoursStart must be an integer between 0 and 23');
  }
  if (!Number.isInteger(params.endHour) || params.endHour < 0 || params.endHour > 23) {
    throw new RangeError('quietHoursEnd must be an integer between 0 and 23');
  }
  try {
    Intl.DateTimeFormat('en-US', { timeZone: params.timezone }).format(params.currentTime);
  } catch {
    throw new RangeError('quietHoursTimezone must be a valid IANA timezone');
  }
}

function localHour(at: Date, formatter: Intl.DateTimeFormat): number {
  const hour = formatter.formatToParts(at).find((part) => part.type === 'hour')?.value;
  if (hour === undefined) throw new RangeError('Could not resolve merchant-local hour');
  return Number(hour);
}

function isQuietHour(hour: number, startHour: number, endHour: number): boolean {
  if (startHour === endHour) return false;
  if (startHour < endHour) return hour >= startHour && hour < endHour;
  return hour >= startHour || hour < endHour;
}

/**
 * Finds the first exact minute outside quiet hours using the runtime's IANA
 * timezone database. Iterating instants (rather than offsets) remains correct
 * through DST gaps and repeated local hours.
 */
export function getNextLawfulContactTime(params: NextLawfulContactParams): Date {
  validateQuietHours(params);
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: params.timezone,
    hour: '2-digit',
    hourCycle: 'h23',
  });
  if (!isQuietHour(localHour(params.currentTime, formatter), params.startHour, params.endHour)) {
    return new Date(params.currentTime);
  }

  let candidate = new Date(Math.floor(params.currentTime.getTime() / 60000) * 60000 + 60000);
  for (let minute = 0; minute < 48 * 60; minute += 1) {
    if (!isQuietHour(localHour(candidate, formatter), params.startHour, params.endHour)) return candidate;
    candidate = new Date(candidate.getTime() + 60000);
  }
  throw new RangeError('No lawful contact time found within 48 hours');
}

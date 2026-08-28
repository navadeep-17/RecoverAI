import { RecoveryActionType } from '@recoverai/shared';

/**
 * Customer-facing communication action types subject to quiet hours restrictions.
 */
export const OUTBOUND_COMMUNICATION_ACTIONS: readonly RecoveryActionType[] = [
  RecoveryActionType.REQUEST_PAYMENT_UPDATE,
  RecoveryActionType.CREATE_OR_SEND_PAYMENT_LINK,
  RecoveryActionType.SEND_CHECKOUT_RECOVERY,
  RecoveryActionType.SEND_RECEIVABLE_REMINDER,
];

export function isCustomerCommunicationAction(actionType: RecoveryActionType): boolean {
  return OUTBOUND_COMMUNICATION_ACTIONS.includes(actionType);
}

export function isValidIanaTimezone(timezone: string): boolean {
  if (!timezone || typeof timezone !== 'string' || !timezone.trim()) {
    return false;
  }
  try {
    Intl.DateTimeFormat(undefined, { timeZone: timezone.trim() });
    return true;
  } catch {
    return false;
  }
}

export class InvalidQuietHoursConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidQuietHoursConfigurationError';
  }
}

export interface QuietHoursCheckParams {
  currentTime: Date;
  timezone?: string; // e.g. 'Asia/Kolkata'
  startHour?: number; // integer 0..23 (e.g. 21 = 9 PM)
  endHour?: number; // integer 0..23 (e.g. 9 = 9 AM)
}

export interface QuietHoursResult {
  inQuietHours: boolean;
  localHour: number;
  timezone: string;
  startHour: number;
  endHour: number;
}

export function checkQuietHours(params: QuietHoursCheckParams): QuietHoursResult {
  const timezone = params.timezone || 'Asia/Kolkata';
  const startHour = params.startHour ?? 21; // 9:00 PM default
  const endHour = params.endHour ?? 9; // 9:00 AM default

  if (!isValidIanaTimezone(timezone)) {
    throw new InvalidQuietHoursConfigurationError(`Invalid IANA timezone: "${timezone}". Quiet hours requires a valid timezone.`);
  }

  if (!Number.isInteger(startHour) || startHour < 0 || startHour > 23) {
    throw new InvalidQuietHoursConfigurationError(`quietHoursStart must be an integer between 0 and 23, received: ${startHour}`);
  }

  if (!Number.isInteger(endHour) || endHour < 0 || endHour > 23) {
    throw new InvalidQuietHoursConfigurationError(`quietHoursEnd must be an integer between 0 and 23, received: ${endHour}`);
  }

  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    hourCycle: 'h23',
  });
  const localHour = parseInt(formatter.format(params.currentTime), 10);

  let inQuietHours = false;
  if (startHour > endHour) {
    // Overnight window (e.g. 21:00 to 09:00)
    inQuietHours = localHour >= startHour || localHour < endHour;
  } else if (startHour < endHour) {
    // Single-day window (e.g. 01:00 to 05:00)
    inQuietHours = localHour >= startHour && localHour < endHour;
  } else {
    // startHour === endHour means no quiet window
    inQuietHours = false;
  }

  return {
    inQuietHours,
    localHour,
    timezone,
    startHour,
    endHour,
  };
}

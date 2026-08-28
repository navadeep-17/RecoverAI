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

export interface QuietHoursCheckParams {
  currentTime: Date;
  timezone?: string; // e.g. 'Asia/Kolkata' or 'UTC'
  startHour?: number; // e.g. 21 (9 PM)
  endHour?: number; // e.g. 9 (9 AM)
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

  let localHour: number;
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: 'numeric',
      hourCycle: 'h23',
    });
    localHour = parseInt(formatter.format(params.currentTime), 10);
    if (isNaN(localHour)) {
      localHour = params.currentTime.getUTCHours();
    }
  } catch {
    // Fallback if invalid timezone string is provided
    localHour = params.currentTime.getUTCHours();
  }

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

import { describe, it, expect } from 'vitest';
import { checkQuietHours, isCustomerCommunicationAction } from '../src/quiet-hours.js';
import { RecoveryActionType } from '@recoverai/shared';

describe('Quiet Hours Verification', () => {
  describe('checkQuietHours calculation', () => {
    it('detects 22:30 IST as quiet hours (in overnight window 21:00 to 09:00 IST)', () => {
      // 22:30 IST is 17:00 UTC
      const date = new Date('2026-08-28T17:00:00.000Z');
      const result = checkQuietHours({
        currentTime: date,
        timezone: 'Asia/Kolkata',
        startHour: 21,
        endHour: 9,
      });

      expect(result.inQuietHours).toBe(true);
      expect(result.localHour).toBe(22);
    });

    it('detects 04:30 IST as quiet hours (in overnight window 21:00 to 09:00 IST)', () => {
      // 04:30 IST is 23:00 UTC previous day
      const date = new Date('2026-08-27T23:00:00.000Z');
      const result = checkQuietHours({
        currentTime: date,
        timezone: 'Asia/Kolkata',
        startHour: 21,
        endHour: 9,
      });

      expect(result.inQuietHours).toBe(true);
      expect(result.localHour).toBe(4);
    });

    it('detects 14:30 IST as daytime (allowed, outside quiet hours)', () => {
      // 14:30 IST is 09:00 UTC
      const date = new Date('2026-08-28T09:00:00.000Z');
      const result = checkQuietHours({
        currentTime: date,
        timezone: 'Asia/Kolkata',
        startHour: 21,
        endHour: 9,
      });

      expect(result.inQuietHours).toBe(false);
      expect(result.localHour).toBe(14);
    });

    it('detects 10:00 IST as daytime (allowed, right after 09:00 end)', () => {
      // 10:00 IST is 04:30 UTC
      const date = new Date('2026-08-28T04:30:00.000Z');
      const result = checkQuietHours({
        currentTime: date,
        timezone: 'Asia/Kolkata',
        startHour: 21,
        endHour: 9,
      });

      expect(result.inQuietHours).toBe(false);
      expect(result.localHour).toBe(10);
    });

    it('throws InvalidQuietHoursConfigurationError on invalid IANA timezone without falling back to UTC', () => {
      const date = new Date('2026-08-28T04:30:00.000Z');
      expect(() =>
        checkQuietHours({
          currentTime: date,
          timezone: 'not-a-valid-timezone',
          startHour: 21,
          endHour: 9,
        }),
      ).toThrow();
    });

    it('throws InvalidQuietHoursConfigurationError on out-of-range start or end hours', () => {
      const date = new Date('2026-08-28T04:30:00.000Z');
      expect(() =>
        checkQuietHours({
          currentTime: date,
          timezone: 'Asia/Kolkata',
          startHour: -1,
          endHour: 9,
        }),
      ).toThrow();

      expect(() =>
        checkQuietHours({
          currentTime: date,
          timezone: 'Asia/Kolkata',
          startHour: 24,
          endHour: 9,
        }),
      ).toThrow();

      expect(() =>
        checkQuietHours({
          currentTime: date,
          timezone: 'Asia/Kolkata',
          startHour: 21,
          endHour: 25,
        }),
      ).toThrow();
    });
  });

  describe('isCustomerCommunicationAction', () => {
    it('identifies customer-facing communication actions subject to quiet hours', () => {
      expect(isCustomerCommunicationAction(RecoveryActionType.REQUEST_PAYMENT_UPDATE)).toBe(true);
      expect(isCustomerCommunicationAction(RecoveryActionType.CREATE_OR_SEND_PAYMENT_LINK)).toBe(true);
      expect(isCustomerCommunicationAction(RecoveryActionType.SEND_CHECKOUT_RECOVERY)).toBe(true);
      expect(isCustomerCommunicationAction(RecoveryActionType.SEND_RECEIVABLE_REMINDER)).toBe(true);
    });

    it('identifies non-customer-facing or system actions exempt from quiet hours', () => {
      expect(isCustomerCommunicationAction(RecoveryActionType.RETRY_PAYMENT)).toBe(false);
      expect(isCustomerCommunicationAction(RecoveryActionType.SCHEDULE_FOLLOWUP)).toBe(false);
      expect(isCustomerCommunicationAction(RecoveryActionType.RECORD_PROMISE_TO_PAY)).toBe(false);
      expect(isCustomerCommunicationAction(RecoveryActionType.ESCALATE_TO_HUMAN)).toBe(false);
      expect(isCustomerCommunicationAction(RecoveryActionType.STOP_RECOVERY)).toBe(false);
    });
  });
});

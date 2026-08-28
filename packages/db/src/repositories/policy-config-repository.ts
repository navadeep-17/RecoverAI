import { Prisma, PolicyConfig } from '@prisma/client';
import { prisma } from '../client.js';
import { toPrismaDecimal } from './case-repository.js';
import { Money } from '@recoverai/shared';

export type PolicyThresholdInput = string | Prisma.Decimal;

export class InvalidPolicyConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidPolicyConfigurationError';
  }
}

export function validatePolicyConfigInput(data: Partial<{
  maxRetriesPerCase: number;
  maxContactsPerCase: number;
  maxActionsPerCase: number;
  cooldownHoursBetweenActions: number;
  highValueThreshold: PolicyThresholdInput;
  minConfidenceThreshold: number;
  quietHoursStart: number;
  quietHoursEnd: number;
  quietHoursTimezone: string;
  maxRecoveryWindowDays: number;
  overdueGracePeriodDays: number;
}>): void {
  if (data.maxActionsPerCase !== undefined && (!Number.isInteger(data.maxActionsPerCase) || data.maxActionsPerCase <= 0)) {
    throw new InvalidPolicyConfigurationError('maxActionsPerCase must be an integer >= 1');
  }
  if (data.maxRetriesPerCase !== undefined && (!Number.isInteger(data.maxRetriesPerCase) || data.maxRetriesPerCase < 0)) {
    throw new InvalidPolicyConfigurationError('maxRetriesPerCase must be an integer >= 0');
  }
  if (data.maxContactsPerCase !== undefined && (!Number.isInteger(data.maxContactsPerCase) || data.maxContactsPerCase < 0)) {
    throw new InvalidPolicyConfigurationError('maxContactsPerCase must be an integer >= 0');
  }
  if (data.cooldownHoursBetweenActions !== undefined && (typeof data.cooldownHoursBetweenActions !== 'number' || data.cooldownHoursBetweenActions < 0)) {
    throw new InvalidPolicyConfigurationError('cooldownHoursBetweenActions must be a number >= 0');
  }
  if (data.minConfidenceThreshold !== undefined && (typeof data.minConfidenceThreshold !== 'number' || data.minConfidenceThreshold < 0 || data.minConfidenceThreshold > 1)) {
    throw new InvalidPolicyConfigurationError('minConfidenceThreshold must be a number between 0 and 1');
  }
  if (data.quietHoursStart !== undefined && (!Number.isInteger(data.quietHoursStart) || data.quietHoursStart < 0 || data.quietHoursStart > 23)) {
    throw new InvalidPolicyConfigurationError('quietHoursStart must be an integer between 0 and 23');
  }
  if (data.quietHoursEnd !== undefined && (!Number.isInteger(data.quietHoursEnd) || data.quietHoursEnd < 0 || data.quietHoursEnd > 23)) {
    throw new InvalidPolicyConfigurationError('quietHoursEnd must be an integer between 0 and 23');
  }
  if (data.quietHoursTimezone !== undefined) {
    if (!data.quietHoursTimezone || typeof data.quietHoursTimezone !== 'string' || !data.quietHoursTimezone.trim()) {
      throw new InvalidPolicyConfigurationError('quietHoursTimezone must be a non-empty IANA timezone string');
    }
    try {
      Intl.DateTimeFormat(undefined, { timeZone: data.quietHoursTimezone.trim() });
    } catch {
      throw new InvalidPolicyConfigurationError(`quietHoursTimezone "${data.quietHoursTimezone}" is not a valid IANA timezone`);
    }
  }
  if (data.maxRecoveryWindowDays !== undefined && (!Number.isInteger(data.maxRecoveryWindowDays) || data.maxRecoveryWindowDays <= 0)) {
    throw new InvalidPolicyConfigurationError('maxRecoveryWindowDays must be an integer >= 1');
  }
  if (data.overdueGracePeriodDays !== undefined && (!Number.isInteger(data.overdueGracePeriodDays) || data.overdueGracePeriodDays < 0)) {
    throw new InvalidPolicyConfigurationError('overdueGracePeriodDays must be an integer >= 0');
  }
  if (data.highValueThreshold !== undefined) {
    const val = typeof data.highValueThreshold === 'string' ? data.highValueThreshold : data.highValueThreshold.toString();
    if (!Money.isValidDecimalString(val)) {
      throw new InvalidPolicyConfigurationError(`highValueThreshold "${val}" is not a valid non-negative monetary decimal string`);
    }
  }
}

export class PolicyConfigRepository {
  async getOrCreateConfig(merchantId: string): Promise<PolicyConfig> {
    const existing = await prisma.policyConfig.findUnique({
      where: { merchantId },
    });

    if (existing) {
      return existing;
    }

    return prisma.policyConfig.create({
      data: {
        merchantId,
        maxRetriesPerCase: 3,
        maxContactsPerCase: 3,
        maxActionsPerCase: 5,
        cooldownHoursBetweenActions: 24,
        highValueThreshold: new Prisma.Decimal('50000.00'),
        minConfidenceThreshold: 0.65,
        reviewFirstMode: false,
        checkoutAbandonmentThresholdMinutes: 30,
        quietHoursStart: 21,
        quietHoursEnd: 9,
        quietHoursTimezone: 'Asia/Kolkata',
        maxRecoveryWindowDays: 30,
        overdueGracePeriodDays: 3,
      },
    });
  }

  async updateConfig(
    merchantId: string,
    updates: Partial<{
      maxRetriesPerCase: number;
      maxContactsPerCase: number;
      maxActionsPerCase: number;
      cooldownHoursBetweenActions: number;
      highValueThreshold: PolicyThresholdInput;
      minConfidenceThreshold: number;
      reviewFirstMode: boolean;
      checkoutAbandonmentThresholdMinutes: number;
      quietHoursStart: number;
      quietHoursEnd: number;
      quietHoursTimezone: string;
      maxRecoveryWindowDays: number;
      overdueGracePeriodDays: number;
    }>,
  ): Promise<PolicyConfig> {
    validatePolicyConfigInput(updates);
    return prisma.policyConfig.upsert({
      where: { merchantId },
      create: {
        merchantId,
        maxRetriesPerCase: updates.maxRetriesPerCase ?? 3,
        maxContactsPerCase: updates.maxContactsPerCase ?? 3,
        maxActionsPerCase: updates.maxActionsPerCase ?? 5,
        cooldownHoursBetweenActions: updates.cooldownHoursBetweenActions ?? 24,
        highValueThreshold: updates.highValueThreshold !== undefined
          ? toPrismaDecimal(updates.highValueThreshold)
          : new Prisma.Decimal('50000.00'),
        minConfidenceThreshold: updates.minConfidenceThreshold ?? 0.65,
        reviewFirstMode: updates.reviewFirstMode ?? false,
        checkoutAbandonmentThresholdMinutes: updates.checkoutAbandonmentThresholdMinutes ?? 30,
        quietHoursStart: updates.quietHoursStart ?? 21,
        quietHoursEnd: updates.quietHoursEnd ?? 9,
        quietHoursTimezone: updates.quietHoursTimezone ?? 'Asia/Kolkata',
        maxRecoveryWindowDays: updates.maxRecoveryWindowDays ?? 30,
        overdueGracePeriodDays: updates.overdueGracePeriodDays ?? 3,
      },
      update: {
        ...(updates.maxRetriesPerCase !== undefined ? { maxRetriesPerCase: updates.maxRetriesPerCase } : {}),
        ...(updates.maxContactsPerCase !== undefined ? { maxContactsPerCase: updates.maxContactsPerCase } : {}),
        ...(updates.maxActionsPerCase !== undefined ? { maxActionsPerCase: updates.maxActionsPerCase } : {}),
        ...(updates.cooldownHoursBetweenActions !== undefined ? { cooldownHoursBetweenActions: updates.cooldownHoursBetweenActions } : {}),
        ...(updates.highValueThreshold !== undefined ? { highValueThreshold: toPrismaDecimal(updates.highValueThreshold) } : {}),
        ...(updates.minConfidenceThreshold !== undefined ? { minConfidenceThreshold: updates.minConfidenceThreshold } : {}),
        ...(updates.reviewFirstMode !== undefined ? { reviewFirstMode: updates.reviewFirstMode } : {}),
        ...(updates.checkoutAbandonmentThresholdMinutes !== undefined ? { checkoutAbandonmentThresholdMinutes: updates.checkoutAbandonmentThresholdMinutes } : {}),
        ...(updates.quietHoursStart !== undefined ? { quietHoursStart: updates.quietHoursStart } : {}),
        ...(updates.quietHoursEnd !== undefined ? { quietHoursEnd: updates.quietHoursEnd } : {}),
        ...(updates.quietHoursTimezone !== undefined ? { quietHoursTimezone: updates.quietHoursTimezone } : {}),
        ...(updates.maxRecoveryWindowDays !== undefined ? { maxRecoveryWindowDays: updates.maxRecoveryWindowDays } : {}),
        ...(updates.overdueGracePeriodDays !== undefined ? { overdueGracePeriodDays: updates.overdueGracePeriodDays } : {}),
      },
    });
  }
}

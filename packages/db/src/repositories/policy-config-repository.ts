import { Prisma, PolicyConfig } from '@prisma/client';
import { prisma } from '../client.js';
import { toPrismaDecimal } from './case-repository.js';

export type PolicyThresholdInput = string | Prisma.Decimal;

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

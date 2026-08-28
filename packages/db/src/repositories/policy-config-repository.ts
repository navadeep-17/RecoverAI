import { Prisma, PolicyConfig } from '@prisma/client';
import { prisma } from '../client.js';
import { ExactMonetaryInput, toPrismaDecimal } from './case-repository.js';

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
        cooldownHoursBetweenActions: 24,
        highValueThreshold: new Prisma.Decimal('50000.00'),
        minConfidenceThreshold: 0.65,
        reviewFirstMode: false,
        checkoutAbandonmentThresholdMinutes: 30,
      },
    });
  }

  async updateConfig(
    merchantId: string,
    updates: Partial<{
      maxRetriesPerCase: number;
      maxContactsPerCase: number;
      cooldownHoursBetweenActions: number;
      highValueThreshold: ExactMonetaryInput;
      minConfidenceThreshold: number;
      reviewFirstMode: boolean;
      checkoutAbandonmentThresholdMinutes: number;
    }>,
  ): Promise<PolicyConfig> {
    return prisma.policyConfig.upsert({
      where: { merchantId },
      create: {
        merchantId,
        maxRetriesPerCase: updates.maxRetriesPerCase ?? 3,
        maxContactsPerCase: updates.maxContactsPerCase ?? 3,
        cooldownHoursBetweenActions: updates.cooldownHoursBetweenActions ?? 24,
        highValueThreshold: updates.highValueThreshold !== undefined
          ? toPrismaDecimal(updates.highValueThreshold)
          : new Prisma.Decimal('50000.00'),
        minConfidenceThreshold: updates.minConfidenceThreshold ?? 0.65,
        reviewFirstMode: updates.reviewFirstMode ?? false,
        checkoutAbandonmentThresholdMinutes: updates.checkoutAbandonmentThresholdMinutes ?? 30,
      },
      update: {
        ...(updates.maxRetriesPerCase !== undefined ? { maxRetriesPerCase: updates.maxRetriesPerCase } : {}),
        ...(updates.maxContactsPerCase !== undefined ? { maxContactsPerCase: updates.maxContactsPerCase } : {}),
        ...(updates.cooldownHoursBetweenActions !== undefined ? { cooldownHoursBetweenActions: updates.cooldownHoursBetweenActions } : {}),
        ...(updates.highValueThreshold !== undefined ? { highValueThreshold: toPrismaDecimal(updates.highValueThreshold) } : {}),
        ...(updates.minConfidenceThreshold !== undefined ? { minConfidenceThreshold: updates.minConfidenceThreshold } : {}),
        ...(updates.reviewFirstMode !== undefined ? { reviewFirstMode: updates.reviewFirstMode } : {}),
        ...(updates.checkoutAbandonmentThresholdMinutes !== undefined ? { checkoutAbandonmentThresholdMinutes: updates.checkoutAbandonmentThresholdMinutes } : {}),
      },
    });
  }
}

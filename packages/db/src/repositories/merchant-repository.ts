import { Merchant } from '@prisma/client';
import { prisma } from '../client.js';

export class MerchantRepository {
  async findById(id: string): Promise<Merchant | null> {
    return prisma.merchant.findUnique({ where: { id } });
  }

  async findBySlug(slug: string): Promise<Merchant | null> {
    return prisma.merchant.findUnique({ where: { slug } });
  }

  async create(data: { id?: string; name: string; slug: string; killSwitchActive?: boolean }): Promise<Merchant> {
    return prisma.merchant.create({
      data: {
        id: data.id,
        name: data.name,
        slug: data.slug,
        killSwitchActive: data.killSwitchActive ?? false,
      },
    });
  }

  async setKillSwitch(id: string, active: boolean): Promise<Merchant> {
    return prisma.merchant.update({
      where: { id },
      data: { killSwitchActive: active },
    });
  }
}

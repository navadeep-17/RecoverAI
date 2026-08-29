import { Merchant } from '@prisma/client';
import { prisma } from '../client.js';

export class MerchantRepository {
  async findById(id: string): Promise<Merchant | null> {
    return prisma.merchant.findUnique({ where: { id } });
  }

  async getMerchantById(id: string): Promise<Merchant | null> {
    return this.findById(id);
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

  async createMerchant(data: { id?: string; name: string; slug: string; killSwitchActive?: boolean }): Promise<Merchant> {
    return this.create(data);
  }

  async setKillSwitch(id: string, active: boolean): Promise<Merchant> {
    return prisma.merchant.update({
      where: { id },
      data: { killSwitchActive: active },
    });
  }

  async delete(id: string): Promise<Merchant> {
    return prisma.merchant.delete({ where: { id } });
  }

  async deleteMerchant(id: string): Promise<Merchant> {
    return this.delete(id);
  }
}

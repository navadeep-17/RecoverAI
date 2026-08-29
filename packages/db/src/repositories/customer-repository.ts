import { Customer } from '@prisma/client';
import { prisma } from '../client.js';

export class CustomerRepository {
  async getOrCreateCustomer(
    merchantId: string,
    data: {
      externalCustomerId?: string;
      email?: string;
      phone?: string;
      name?: string;
      contactConsent?: boolean | null;
    },
  ): Promise<Customer> {
    if (data.externalCustomerId) {
      const existing = await prisma.customer.findUnique({
        where: {
          merchantId_externalCustomerId: {
            merchantId,
            externalCustomerId: data.externalCustomerId,
          },
        },
      });
      if (existing) {
        return existing;
      }
    }

    try {
      return await prisma.customer.create({
        data: {
          merchantId,
          externalCustomerId: data.externalCustomerId,
          email: data.email,
          phone: data.phone,
          name: data.name,
          contactConsent: data.contactConsent !== undefined ? data.contactConsent : null,
        },
      });
    } catch (err: unknown) {
      if (
        data.externalCustomerId &&
        err &&
        typeof err === 'object' &&
        'code' in err &&
        (err as { code: string }).code === 'P2002'
      ) {
        const existing = await prisma.customer.findUnique({
          where: {
            merchantId_externalCustomerId: {
              merchantId,
              externalCustomerId: data.externalCustomerId,
            },
          },
        });
        if (existing) {
          return existing;
        }
      }
      throw err;
    }
  }

  async updateContactTimestamp(merchantId: string, customerId: string, timestamp = new Date()): Promise<Customer> {
    const customer = await prisma.customer.findFirstOrThrow({
      where: { id: customerId, merchantId },
    });

    return prisma.customer.update({
      where: { id: customer.id },
      data: { lastContactedAt: timestamp },
    });
  }

  async updateLastContactedAt(merchantId: string, customerId: string, timestamp = new Date()): Promise<Customer> {
    return this.updateContactTimestamp(merchantId, customerId, timestamp);
  }

  async setContactConsent(merchantId: string, customerId: string, contactConsent: boolean | null): Promise<Customer> {
    const customer = await prisma.customer.findFirstOrThrow({
      where: { id: customerId, merchantId },
    });

    return prisma.customer.update({
      where: { id: customer.id },
      data: { contactConsent },
    });
  }

  async setOptOut(merchantId: string, customerId: string, optedOut: boolean): Promise<Customer> {
    const customer = await prisma.customer.findFirstOrThrow({
      where: { id: customerId, merchantId },
    });

    return prisma.customer.update({
      where: { id: customer.id },
      data: { optedOut },
    });
  }
}

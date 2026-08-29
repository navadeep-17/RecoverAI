import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  prisma,
  ScheduledJobRepository,
  MerchantRepository,
  CaseRepository,
} from '../src/index.js';
import { RiskType } from '@recoverai/shared';

describe('ScheduledJob Tenant Isolation & Lifecycle Integration Tests', () => {
  let dbAvailable = false;
  let scheduledJobRepo: ScheduledJobRepository;
  let merchantRepo: MerchantRepository;
  let caseRepo: CaseRepository;

  let merchantAId: string;
  let merchantBId: string;

  beforeAll(async () => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      dbAvailable = true;

      scheduledJobRepo = new ScheduledJobRepository();
      merchantRepo = new MerchantRepository();
      caseRepo = new CaseRepository();

      const mchA = await merchantRepo.createMerchant({
        name: 'Merchant Job Isolation A',
        slug: `mch-job-a-${Date.now()}`,
      });
      merchantAId = mchA.id;

      const mchB = await merchantRepo.createMerchant({
        name: 'Merchant Job Isolation B',
        slug: `mch-job-b-${Date.now()}`,
      });
      merchantBId = mchB.id;
    } catch {
      dbAvailable = false;
    }
  });

  afterAll(async () => {
    if (dbAvailable) {
      if (merchantAId) await merchantRepo.deleteMerchant(merchantAId).catch(() => {});
      if (merchantBId) await merchantRepo.deleteMerchant(merchantBId).catch(() => {});
      await prisma.$disconnect();
    }
  });

  it('creates and lists scheduled jobs scoped strictly to merchant', async () => {
    if (!dbAvailable) return;

    const scheduledFor = new Date(Date.now() + 30 * 60 * 1000);
    const jobA = await scheduledJobRepo.createJob(merchantAId, {
      jobType: 'CHECKOUT_ABANDONMENT_CHECK',
      scheduledFor,
      payloadJson: { checkoutSessionId: 'sess_iso_1' },
      pgBossJobId: 'pg_boss_uuid_001',
    });

    expect(jobA.id).toBeDefined();
    expect(jobA.merchantId).toBe(merchantAId);
    expect(jobA.status).toBe('PENDING_DISPATCH');

    // Merchant A can query the job
    const fetchedA = await scheduledJobRepo.getJobById(merchantAId, jobA.id);
    expect(fetchedA?.id).toBe(jobA.id);

    // Merchant B CANNOT query Merchant A job (tenant isolation)
    const fetchedB = await scheduledJobRepo.getJobById(merchantBId, jobA.id);
    expect(fetchedB).toBeNull();

    // Listing jobs is tenant-scoped
    const listA = await scheduledJobRepo.listScheduledJobs(merchantAId);
    expect(listA.some((j) => j.id === jobA.id)).toBe(true);

    const listB = await scheduledJobRepo.listScheduledJobs(merchantBId);
    expect(listB.some((j) => j.id === jobA.id)).toBe(false);
  });

  it('rejects cross-tenant scheduled job status updates', async () => {
    if (!dbAvailable) return;

    const jobA = await scheduledJobRepo.createJob(merchantAId, {
      jobType: 'INVOICE_OVERDUE_CHECK',
      scheduledFor: new Date(Date.now() + 60 * 60 * 1000),
      payloadJson: { invoiceId: 'inv_iso_1' },
    });

    // Merchant B trying to update Merchant A job fails
    await expect(
      scheduledJobRepo.updateJobStatus(merchantBId, jobA.id, 'COMPLETED'),
    ).rejects.toThrow();

    // Merchant A successfully updates
    const updated = await scheduledJobRepo.updateJobStatus(merchantAId, jobA.id, 'COMPLETED');
    expect(updated.status).toBe('COMPLETED');
  });
});

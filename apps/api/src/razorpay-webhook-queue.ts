import PgBoss from 'pg-boss';
import { ScheduledJobRepository } from '@recoverai/db';
import { ApiPgBossJobScheduler } from './merchant-event-scheduler.js';
import { RazorpayWebhookQueue } from '@recoverai/integrations';

/** Minimal durable handoff: the API only acknowledges after pg-boss accepts the receipt ID. */
export class PgBossRazorpayWebhookQueue implements RazorpayWebhookQueue {
  private readonly boss: PgBoss;

  constructor(connectionString: string, schema: string) {
    this.boss = new PgBoss({ connectionString, schema });
  }

  async start(): Promise<void> { await this.boss.start(); }
  async stop(): Promise<void> { await this.boss.stop({ graceful: true, timeout: 5000 }); }

  createScheduler(scheduledJobRepo: ScheduledJobRepository): ApiPgBossJobScheduler {
    return new ApiPgBossJobScheduler(this.boss, scheduledJobRepo);
  }

  async enqueue(payload: { merchantId: string; webhookEventId: string }): Promise<void> {
    const jobId = await this.boss.send('RAZORPAY_WEBHOOK_PROCESS', payload, {
      singletonKey: `razorpay-webhook:${payload.webhookEventId}`,
    });
    if (!jobId) throw new Error('Durable Razorpay webhook queue did not accept receipt');
  }
}

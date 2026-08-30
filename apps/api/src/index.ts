import { buildServer } from './server.js';
import { loadEnv, createLogger } from '@recoverai/shared';
import { AuditRepository, EventRepository } from '@recoverai/db';
import { RazorpayWebhookService } from '@recoverai/integrations';
import { PgBossRazorpayWebhookQueue } from './razorpay-webhook-queue.js';
import { composeApiReviewService } from './runtime.js';

const env = loadEnv();
const logger = createLogger({ level: env.LOG_LEVEL });
const webhookQueue = new PgBossRazorpayWebhookQueue(env.DATABASE_URL, env.PG_BOSS_SCHEMA);
const server = buildServer({
  reviewService: composeApiReviewService(env),
  razorpayWebhookService: new RazorpayWebhookService({
    merchantId: env.RAZORPAY_TEST_MERCHANT_ID,
    webhookSecret: env.RAZORPAY_WEBHOOK_SECRET,
    eventRepo: new EventRepository(),
    auditRepo: new AuditRepository(),
    queue: webhookQueue,
  }),
});

async function start() {
  try {
    await webhookQueue.start();
    const address = await server.listen({
      port: env.PORT,
      host: env.HOST,
    });
    logger.info({ msg: `RecoverAI API server running at ${address}` });
  } catch (err) {
    logger.error({ err, msg: 'Failed to start API server' });
    process.exit(1);
  }
}

const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];
for (const signal of signals) {
  process.on(signal, async () => {
    logger.info({ msg: `Received ${signal}, closing HTTP server...` });
    await server.close();
    await webhookQueue.stop();
    process.exit(0);
  });
}

if (process.env.NODE_ENV !== 'test') {
  start();
}

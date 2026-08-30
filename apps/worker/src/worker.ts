import PgBoss from 'pg-boss';
import { loadEnv, createLogger } from '@recoverai/shared';
import {
  CaseRepository,
  CustomerRepository,
  PolicyConfigRepository,
  AuditRepository,
  EventRepository,
  ScheduledJobRepository,
  ActionRepository,
  OutcomeRepository,
  CommitmentRepository,
  HumanReviewRepository,
} from '@recoverai/db';
import { DurableReviewGateService, ReviewGateRequester, RiskDetector, OutcomeObserver, EventIngestionService } from '@recoverai/core';
import { RazorpayEventNormalizer, RazorpayPaymentLinkProvider } from '@recoverai/integrations';
import { PgBossJobScheduler } from './scheduler.js';

export interface RecoveryWorkerConfig {
  connectionString?: string;
  schema?: string;
  bossInstance?: PgBoss;
  caseRepo?: CaseRepository;
  customerRepo?: CustomerRepository;
  policyConfigRepo?: PolicyConfigRepository;
  auditRepo?: AuditRepository;
  eventRepo?: EventRepository;
  scheduledJobRepo?: ScheduledJobRepository;
  outcomeObserver?: OutcomeObserver;
  reviewGateRequester?: ReviewGateRequester;
  scheduler?: PgBossJobScheduler;
  riskDetector?: RiskDetector;
  eventIngestionService?: EventIngestionService;
}

export class RecoveryWorkerService {
  private boss: PgBoss | null = null;
  private logger = createLogger();
  /** Resource acquisition is distinct from fully registered subscribers. */
  private bossStarted = false;
  private workerReady = false;
  private isRunning = false;
  private stopPromise: Promise<void> | null = null;
  private scheduler: PgBossJobScheduler | null = null;
  private riskDetector: RiskDetector | null = null;
  private outcomeObserver: OutcomeObserver | null = null;
  private eventIngestionService: EventIngestionService | null = null;

  constructor(private config?: RecoveryWorkerConfig) {
    if (config?.bossInstance) {
      this.boss = config.bossInstance;
    }
    if (config?.outcomeObserver) {
      this.outcomeObserver = config.outcomeObserver;
    }
  }

  async start(): Promise<void> {
    const env = loadEnv();
    const connectionString = this.config?.connectionString || env.DATABASE_URL;
    const schema = this.config?.schema || env.PG_BOSS_SCHEMA;

    this.logger.info({ schema, msg: 'Initializing pg-boss recovery worker' });

    try {
      if (!this.boss) {
        this.boss = new PgBoss({
          connectionString,
          schema,
        });
      }

      this.boss.on('error', (err) => {
        this.logger.error({ err, msg: 'pg-boss internal error' });
      });

      await this.boss.start();
      this.bossStarted = true;

      // Initialize repositories & services
      const caseRepo = this.config?.caseRepo || new CaseRepository();
      const customerRepo = this.config?.customerRepo || new CustomerRepository();
      const policyConfigRepo = this.config?.policyConfigRepo || new PolicyConfigRepository();
      const auditRepo = this.config?.auditRepo || new AuditRepository();
      const eventRepo = this.config?.eventRepo || new EventRepository();
      const scheduledJobRepo = this.config?.scheduledJobRepo || new ScheduledJobRepository();
      const reviewGateRequester = this.config?.reviewGateRequester || new DurableReviewGateService(
        new HumanReviewRepository(),
        caseRepo,
        auditRepo,
      );

      this.scheduler = this.config?.scheduler || new PgBossJobScheduler(this.boss, scheduledJobRepo);
      this.riskDetector = this.config?.riskDetector || new RiskDetector(
        caseRepo,
        customerRepo,
        policyConfigRepo,
        auditRepo,
        eventRepo,
        this.scheduler,
      );
      this.eventIngestionService = this.config?.eventIngestionService || new EventIngestionService(eventRepo, auditRepo, this.riskDetector, customerRepo);
      if (!this.outcomeObserver) {
        this.outcomeObserver = new OutcomeObserver({
          caseRepo,
          actionRepo: new ActionRepository(),
          outcomeRepo: new OutcomeRepository(),
          customerRepo,
          commitmentRepo: new CommitmentRepository(),
          eventRepo,
          auditRepo,
          scheduledJobRepo,
          jobScheduler: this.scheduler,
          reviewGateRequester,
        });
      }

      // Register pg-boss job subscribers
      await this.registerJobHandlers(scheduledJobRepo);

      this.workerReady = true;
      this.isRunning = true;
      this.logger.info({ msg: 'Recovery worker service started and subscribers registered successfully' });
    } catch (err) {
      this.logger.error({ err, msg: 'Failed to start recovery worker service' });
      this.workerReady = false;
      this.isRunning = false;
      try {
        await this.stop();
      } catch (cleanupError) {
        this.logger.error({ cleanupError, msg: 'Failed to clean up partially started recovery worker' });
      }
      throw err;
    }
  }

  private async registerJobHandlers(scheduledJobRepo: ScheduledJobRepository): Promise<void> {
    if (!this.boss) return;

    await this.boss.work('RAZORPAY_WEBHOOK_PROCESS', async (job) => {
      const data = job.data as { merchantId: string; webhookEventId: string };
      if (!this.eventIngestionService || !this.outcomeObserver) {
        throw new Error('Razorpay webhook worker dependencies unavailable');
      }
      const eventRepo = this.config?.eventRepo || new EventRepository();
      const receipt = await eventRepo.getWebhookEventById(data.merchantId, data.webhookEventId);
      if (!receipt || !receipt.verified || receipt.provider !== 'RAZORPAY') {
        throw new Error('Verified Razorpay webhook receipt not found');
      }
      const normalized = RazorpayEventNormalizer.normalize(
        data.merchantId,
        JSON.parse(receipt.rawPayload),
        receipt.externalEventId || undefined,
      );
      const paymentLinkId = (normalized.metadata as Record<string, unknown> | null)?.razorpayPaymentLinkId;
      const paymentLinkSuccess = normalized.eventType === 'PAYMENT_SUCCEEDED' && typeof paymentLinkId === 'string';
      const ingested = await this.eventIngestionService.ingestEvent(normalized, { skipRiskDetection: paymentLinkSuccess });
      if (paymentLinkSuccess) {
        const actionRepo = new ActionRepository();
        const action = await actionRepo.findSuccessfulPaymentLinkAction(
          data.merchantId,
          new RazorpayPaymentLinkProvider().providerName,
          paymentLinkId,
        );
        if (action) {
          await this.outcomeObserver.observeMerchantEvent(normalized, ingested.event.id, {
            actionId: action.id,
            caseId: action.caseId,
            providerName: action.providerName!,
            externalActionId: action.externalActionId!,
          });
        }
      } else {
        await this.outcomeObserver.observeMerchantEvent(normalized, ingested.event.id);
      }
      await eventRepo.markWebhookProcessed(data.merchantId, 'RAZORPAY', receipt.dedupeKey);
    });

    // 1. Checkout Abandonment Recheck
    await this.boss.work('CHECKOUT_ABANDONMENT_CHECK', async (job) => {
      const data = job.data as {
        merchantId: string;
        checkoutSessionId: string;
        jobRecordId?: string;
        [key: string]: unknown;
      };
      this.logger.info({ msg: 'Processing CHECKOUT_ABANDONMENT_CHECK', data });

      if (this.riskDetector) {
        await this.riskDetector.evaluateCheckoutTimer(data.merchantId, data.checkoutSessionId, data);
      }

      if (data.jobRecordId) {
        await scheduledJobRepo.updateJobStatus(data.merchantId, data.jobRecordId, 'COMPLETED');
      }
    });

    // 2. Invoice Overdue Recheck
    await this.boss.work('INVOICE_OVERDUE_CHECK', async (job) => {
      const data = job.data as {
        merchantId: string;
        invoiceId: string;
        jobRecordId?: string;
        [key: string]: unknown;
      };
      this.logger.info({ msg: 'Processing INVOICE_OVERDUE_CHECK', data });

      if (this.riskDetector) {
        await this.riskDetector.evaluateInvoiceTimer(data.merchantId, data.invoiceId, data);
      }

      if (data.jobRecordId) {
        await scheduledJobRepo.updateJobStatus(data.merchantId, data.jobRecordId, 'COMPLETED');
      }
    });

    // 3. Promise to Pay Check
    await this.boss.work('PROMISE_TO_PAY_CHECK', async (job) => {
      const data = job.data as {
        merchantId: string;
        caseId: string;
        jobRecordId?: string;
        commitmentId?: string;
        [key: string]: unknown;
      };
      this.logger.info({ msg: 'Processing PROMISE_TO_PAY_CHECK', data });

      if (!this.outcomeObserver) {
        const errMsg = 'RecoveryWorkerService cannot process PROMISE_TO_PAY_CHECK without OutcomeObserver configured; failing closed';
        this.logger.error({ msg: errMsg, data });
        if (data.jobRecordId) {
          await scheduledJobRepo.updateJobStatus(data.merchantId, data.jobRecordId, 'FAILED');
        }
        throw new Error(errMsg);
      }

      if (!data.jobRecordId) {
        throw new Error('PROMISE_TO_PAY_CHECK job is missing required jobRecordId');
      }

      try {
        const result = await this.outcomeObserver.observeTimerFired({
          merchantId: data.merchantId,
          caseId: data.caseId,
          scheduledJobId: data.jobRecordId,
          timerType: 'PROMISE_TO_PAY_CHECK',
          payload: data,
        });

        if (!result.observed) {
          if (result.isEarlyTimer) {
            this.logger.info({ msg: 'PROMISE_TO_PAY_CHECK fired early; future timer wake preserved/rescheduled', result, data });
            await scheduledJobRepo.updateJobStatus(data.merchantId, data.jobRecordId, 'COMPLETED');
            return;
          }
          this.logger.warn({ msg: 'PROMISE_TO_PAY_CHECK timer rejected/not observed', result, data });
          await scheduledJobRepo.updateJobStatus(data.merchantId, data.jobRecordId, 'FAILED');
          return;
        }

        await scheduledJobRepo.updateJobStatus(data.merchantId, data.jobRecordId, 'COMPLETED');
      } catch (err) {
        this.logger.error({ err, msg: 'Error processing PROMISE_TO_PAY_CHECK; marking FAILED for retry', data });
        await scheduledJobRepo.updateJobStatus(data.merchantId, data.jobRecordId, 'FAILED');
        throw err;
      }
    });

    // 4. Recovery Follow-up Check
    await this.boss.work('RECOVERY_FOLLOWUP_CHECK', async (job) => {
      const data = job.data as {
        merchantId: string;
        caseId: string;
        jobRecordId?: string;
        [key: string]: unknown;
      };
      this.logger.info({ msg: 'Processing RECOVERY_FOLLOWUP_CHECK', data });

      if (!this.outcomeObserver) {
        const errMsg = 'RecoveryWorkerService cannot process RECOVERY_FOLLOWUP_CHECK without OutcomeObserver configured; failing closed';
        this.logger.error({ msg: errMsg, data });
        if (data.jobRecordId) {
          await scheduledJobRepo.updateJobStatus(data.merchantId, data.jobRecordId, 'FAILED');
        }
        throw new Error(errMsg);
      }

      if (!data.jobRecordId) {
        throw new Error('RECOVERY_FOLLOWUP_CHECK job is missing required jobRecordId');
      }

      try {
        const result = await this.outcomeObserver.observeTimerFired({
          merchantId: data.merchantId,
          caseId: data.caseId,
          scheduledJobId: data.jobRecordId,
          timerType: 'RECOVERY_FOLLOWUP_CHECK',
          payload: data,
        });

        if (!result.observed) {
          this.logger.warn({ msg: 'RECOVERY_FOLLOWUP_CHECK timer rejected/not observed', result, data });
          await scheduledJobRepo.updateJobStatus(data.merchantId, data.jobRecordId, 'FAILED');
          return;
        }

        await scheduledJobRepo.updateJobStatus(data.merchantId, data.jobRecordId, 'COMPLETED');
      } catch (err) {
        this.logger.error({ err, msg: 'Error processing RECOVERY_FOLLOWUP_CHECK; marking FAILED for retry', data });
        await scheduledJobRepo.updateJobStatus(data.merchantId, data.jobRecordId, 'FAILED');
        throw err;
      }
    });
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    if (!this.boss || !this.bossStarted) return;
    this.stopPromise = (async () => {
      this.logger.info({ msg: 'Stopping recovery worker service...' });
      await this.boss!.stop({ graceful: true, timeout: 5000 });
      this.bossStarted = false;
      this.workerReady = false;
      this.isRunning = false;
    })();
    try {
      await this.stopPromise;
    } finally {
      this.stopPromise = null;
    }
  }

  getStatus(): { isRunning: boolean; hasBossInstance: boolean } {
    return {
      isRunning: this.isRunning,
      hasBossInstance: this.boss !== null,
    };
  }

  getBoss(): PgBoss | null {
    return this.boss;
  }

  getScheduler(): PgBossJobScheduler | null {
    return this.scheduler;
  }

  getRiskDetector(): RiskDetector | null {
    return this.riskDetector;
  }

  getOutcomeObserver(): OutcomeObserver | null {
    return this.outcomeObserver;
  }
}

import PgBoss from 'pg-boss';
import { loadEnv, createLogger } from '@recoverai/shared';
import {
  CaseRepository,
  CustomerRepository,
  PolicyConfigRepository,
  AuditRepository,
  EventRepository,
  ScheduledJobRepository,
} from '@recoverai/db';
import { RiskDetector, OutcomeObserver } from '@recoverai/core';
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
}

export class RecoveryWorkerService {
  private boss: PgBoss | null = null;
  private logger = createLogger();
  private isRunning = false;
  private scheduler: PgBossJobScheduler | null = null;
  private riskDetector: RiskDetector | null = null;
  private outcomeObserver: OutcomeObserver | null = null;

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
      this.isRunning = true;

      // Initialize repositories & services
      const caseRepo = this.config?.caseRepo || new CaseRepository();
      const customerRepo = this.config?.customerRepo || new CustomerRepository();
      const policyConfigRepo = this.config?.policyConfigRepo || new PolicyConfigRepository();
      const auditRepo = this.config?.auditRepo || new AuditRepository();
      const eventRepo = this.config?.eventRepo || new EventRepository();
      const scheduledJobRepo = this.config?.scheduledJobRepo || new ScheduledJobRepository();

      this.scheduler = new PgBossJobScheduler(this.boss, scheduledJobRepo);
      this.riskDetector = new RiskDetector(
        caseRepo,
        customerRepo,
        policyConfigRepo,
        auditRepo,
        eventRepo,
        this.scheduler,
      );

      // Register pg-boss job subscribers
      await this.registerJobHandlers(scheduledJobRepo);

      this.logger.info({ msg: 'Recovery worker service started and subscribers registered successfully' });
    } catch (err) {
      this.logger.error({ err, msg: 'Failed to start recovery worker service' });
      this.isRunning = false;
      throw err;
    }
  }

  private async registerJobHandlers(scheduledJobRepo: ScheduledJobRepository): Promise<void> {
    if (!this.boss) return;

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

      if (this.outcomeObserver && data.jobRecordId) {
        await this.outcomeObserver.observeTimerFired({
          merchantId: data.merchantId,
          caseId: data.caseId,
          scheduledJobId: data.jobRecordId,
          timerType: 'PROMISE_TO_PAY_CHECK',
          payload: data,
        });
      }

      if (data.jobRecordId) {
        await scheduledJobRepo.updateJobStatus(data.merchantId, data.jobRecordId, 'COMPLETED');
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

      if (this.outcomeObserver && data.jobRecordId) {
        await this.outcomeObserver.observeTimerFired({
          merchantId: data.merchantId,
          caseId: data.caseId,
          scheduledJobId: data.jobRecordId,
          timerType: 'RECOVERY_FOLLOWUP_CHECK',
          payload: data,
        });
      }

      if (data.jobRecordId) {
        await scheduledJobRepo.updateJobStatus(data.merchantId, data.jobRecordId, 'COMPLETED');
      }
    });
  }

  async stop(): Promise<void> {
    if (this.boss && this.isRunning) {
      this.logger.info({ msg: 'Stopping recovery worker service...' });
      await this.boss.stop({ graceful: true, timeout: 5000 });
      this.isRunning = false;
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

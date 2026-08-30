import PgBoss from 'pg-boss';
import {
  ActionRepository,
  AuditRepository,
  CaseRepository,
  CommitmentRepository,
  CustomerRepository,
  EventRepository,
  HumanReviewRepository,
  MerchantRepository,
  OutcomeRepository,
  PolicyConfigRepository,
  ScheduledJobRepository,
  TriggerRepository,
  prisma,
} from '@recoverai/db';
import {
  ActionExecutor,
  DurableReviewGateService,
  EventIngestionService,
  HumanReviewService,
  IPolicyEngine,
  MockLLMProvider,
  OutcomeObserver,
  RecoveryAgent,
  RecoveryOrchestrator,
  RiskDetector,
} from '@recoverai/core';
import { GeminiLLMProvider, ProviderRegistry } from '@recoverai/integrations';
import { PolicyEngine } from '@recoverai/policy';
import { createLogger, EnvConfig, loadEnv } from '@recoverai/shared';
import { PgBossJobScheduler } from './scheduler.js';
import { RecoveryWorkerService } from './worker.js';

export interface WorkerRuntime {
  worker: Pick<RecoveryWorkerService, 'start' | 'stop'>;
  closeDatabase: () => Promise<void>;
}

export interface WorkerBootstrapOptions {
  runtime?: WorkerRuntime;
  installSignalHandlers?: boolean;
  logger?: ReturnType<typeof createLogger>;
}

/** Builds the production dependency graph; no provider/network work occurs here. */
export function composeWorkerRuntime(env: EnvConfig = loadEnv()): WorkerRuntime {
  const logger = createLogger({ level: env.LOG_LEVEL, isProduction: env.NODE_ENV === 'production' });
  if (env.AI_PROVIDER === 'mock' && env.NODE_ENV === 'production') {
    throw new Error('AI_PROVIDER=mock is development/test-only; production worker refuses fake AI');
  }
  if (env.AI_PROVIDER === 'openai' || env.AI_PROVIDER === 'anthropic') {
    throw new Error(`AI_PROVIDER=${env.AI_PROVIDER} is unsupported at runtime`);
  }
  const llmProvider = env.AI_PROVIDER === 'gemini'
    ? new GeminiLLMProvider({ apiKey: env.GEMINI_API_KEY!, model: env.GEMINI_MODEL })
    : new MockLLMProvider();
  if (env.AI_PROVIDER === 'mock') logger.warn({ msg: 'Starting worker with explicit development/test MockLLMProvider; autonomous output is not production AI-backed' });

  const caseRepo = new CaseRepository();
  const actionRepo = new ActionRepository();
  const customerRepo = new CustomerRepository();
  const merchantRepo = new MerchantRepository();
  const policyConfigRepo = new PolicyConfigRepository();
  const auditRepo = new AuditRepository();
  const eventRepo = new EventRepository();
  const scheduledJobRepo = new ScheduledJobRepository();
  const outcomeRepo = new OutcomeRepository();
  const commitmentRepo = new CommitmentRepository();
  const humanReviewRepo = new HumanReviewRepository();
  const policyEngine = new PolicyEngine();
  const executionPolicy = policyEngine as unknown as IPolicyEngine;
  const boss = new PgBoss({ connectionString: env.DATABASE_URL, schema: env.PG_BOSS_SCHEMA });
  const scheduler = new PgBossJobScheduler(boss, scheduledJobRepo);
  const reviewGate = new DurableReviewGateService(humanReviewRepo, caseRepo, auditRepo);
  const providerRegistry = ProviderRegistry.forRuntime({
    enabled: Boolean(env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET),
    keyId: env.RAZORPAY_KEY_ID,
    keySecret: env.RAZORPAY_KEY_SECRET,
  });
  const actionExecutor = new ActionExecutor({
    actionRepo, caseRepo, customerRepo, merchantRepo, policyConfigRepo, auditRepo,
    humanReviewRepo, reviewGateRequester: reviewGate, commitmentRepo, policyEngine: executionPolicy,
    providerRegistry, jobScheduler: scheduler,
  });
  const reviewService = new HumanReviewService({
    humanReviewRepo, caseRepo, actionRepo, customerRepo, merchantRepo, policyConfigRepo,
    commitmentRepo, outcomeRepo, auditRepo, policyEngine: executionPolicy, actionExecutor,
  });
  actionExecutor.setReviewGateRequester(reviewService);
  const orchestrator = new RecoveryOrchestrator({
    caseRepo, actionRepo, customerRepo, merchantRepo, policyConfigRepo, commitmentRepo,
    auditRepo, humanReviewRepo, reviewGateRequester: reviewService,
    recoveryAgent: new RecoveryAgent(llmProvider), policyEngine: executionPolicy, actionExecutor,
    triggerRepo: new TriggerRepository(), jobScheduler: scheduler,
  });
  const observer = new OutcomeObserver({
    caseRepo, actionRepo, outcomeRepo, customerRepo, commitmentRepo, eventRepo, auditRepo,
    scheduledJobRepo, jobScheduler: scheduler, orchestrator, reviewGateRequester: reviewService,
  });
  const detector = new RiskDetector(caseRepo, customerRepo, policyConfigRepo, auditRepo, eventRepo, scheduler);
  const worker = new RecoveryWorkerService({
    connectionString: env.DATABASE_URL, schema: env.PG_BOSS_SCHEMA, bossInstance: boss,
    caseRepo, customerRepo, policyConfigRepo, auditRepo, eventRepo, scheduledJobRepo,
    reviewGateRequester: reviewService, scheduler, riskDetector: detector,
    eventIngestionService: new EventIngestionService(eventRepo, auditRepo, detector, customerRepo),
    outcomeObserver: observer,
  });
  return { worker, closeDatabase: () => prisma.$disconnect() };
}

/** Starts the executable worker and installs one idempotent graceful shutdown path. */
export async function bootstrapWorker(options: WorkerBootstrapOptions = {}): Promise<{ shutdown: () => Promise<void> }> {
  const logger = options.logger || createLogger();
  const runtime = options.runtime || composeWorkerRuntime();
  let shutdownPromise: Promise<void> | null = null;
  const shutdown = (): Promise<void> => {
    if (!shutdownPromise) {
      shutdownPromise = (async () => {
        await runtime.worker.stop();
        await runtime.closeDatabase();
      })();
    }
    return shutdownPromise;
  };
  try {
    await runtime.worker.start();
  } catch (error) {
    await shutdown();
    throw error;
  }
  if (options.installSignalHandlers !== false) {
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.once(signal, () => {
        logger.info({ msg: `Received ${signal}, shutting down recovery worker` });
        void shutdown().catch((error) => { logger.error({ error, msg: 'Worker shutdown failed' }); process.exitCode = 1; });
      });
    }
  }
  return { shutdown };
}

import fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import sensible from '@fastify/sensible';
import { generateCorrelationId, createLogger, loadEnv } from '@recoverai/shared';
import { checkDatabaseConnection, AuditRepository, CaseRepository, EventRepository, PolicyConfigRepository } from '@recoverai/db';
import { RazorpayWebhookService } from '@recoverai/integrations';

import { EventIngestionService, HumanReviewService, OutcomeObserver } from '@recoverai/core';
import { reviewRoutes } from './routes/review-routes.js';
import { authenticatePrincipalHook } from './auth/principal.js';
import { razorpayWebhookRoutes } from './routes/razorpay-webhook-routes.js';
import { caseRoutes } from './routes/case-routes.js';
import { merchantEventRoutes } from './routes/merchant-event-routes.js';
import { policyRoutes } from './routes/policy-routes.js';
import { evaluationRoutes } from './routes/evaluation-routes.js';

export interface BuildServerOptions {
  checkDbConnection?: () => Promise<boolean>;
  reviewService?: HumanReviewService;
  razorpayWebhookService?: RazorpayWebhookService;
  caseRepo?: CaseRepository;
  auditRepo?: AuditRepository;
  policyConfigRepo?: PolicyConfigRepository;
  merchantEventIngestionService?: EventIngestionService;
  merchantEventOutcomeObserver?: OutcomeObserver;
}

export function buildServer(options: BuildServerOptions = {}): FastifyInstance {
  const env = loadEnv();
  const logger = createLogger({ level: env.LOG_LEVEL, isProduction: env.NODE_ENV === 'production' });
  const checkDb = options.checkDbConnection ?? checkDatabaseConnection;

  const app = fastify({
    logger: false,
    genReqId: (req) => {
      const headerId = req.headers['x-correlation-id'] || req.headers['x-request-id'];
      if (typeof headerId === 'string' && headerId.trim().length > 0) {
        return headerId;
      }
      return generateCorrelationId();
    },
  });

  // Keep raw bytes only for the Razorpay webhook route. Other JSON routes retain parsed objects.
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    if (req.url.split('?')[0] === '/webhooks/razorpay') return done(null, body);
    try { done(null, JSON.parse(body.toString('utf8'))); } catch (err) { done(err as Error); }
  });

  // Plugins
  app.register(sensible);
  app.register(cors, {
    origin: env.CORS_ORIGIN,
    credentials: true,
  });

  app.decorateRequest('principal', null);
  app.addHook('preHandler', authenticatePrincipalHook);

  // Request/Response logging & correlation header injection
  app.addHook('onRequest', async (req, reply) => {
    reply.header('x-correlation-id', req.id);
    logger.info({
      correlationId: req.id,
      method: req.method,
      url: req.url,
      msg: 'Incoming request',
    });
  });

  app.addHook('onResponse', async (req, reply) => {
    logger.info({
      correlationId: req.id,
      method: req.method,
      url: req.url,
      statusCode: reply.statusCode,
      responseTime: reply.elapsedTime,
      msg: 'Request completed',
    });
  });

  // Health endpoint: fast liveness probe
  app.get('/health', async (_req, reply) => {
    return reply.status(200).send({
      status: 'ok',
      version: '0.1.0',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      service: 'recoverai-api',
    });
  });

  // Ready endpoint: strict readiness probe reflecting database connectivity
  app.get('/ready', async (_req, reply) => {
    const isDbConnected = await checkDb();
    const statusCode = isDbConnected ? 200 : 503;

    return reply.status(statusCode).send({
      ready: isDbConnected,
      database: isDbConnected,
      timestamp: new Date().toISOString(),
    });
  });

  // Human Review Routes
  if (options.reviewService) {
    app.register(reviewRoutes, {
      prefix: '/reviews',
      reviewService: options.reviewService,
    });
  }

  app.register(caseRoutes, {
    prefix: '/cases',
    caseRepo: options.caseRepo || new CaseRepository(),
    auditRepo: options.auditRepo || new AuditRepository(),
  });

  app.register(policyRoutes, { prefix: '/policy', policyConfigRepo: options.policyConfigRepo || new PolicyConfigRepository(), auditRepo: options.auditRepo || new AuditRepository() });
  app.register(evaluationRoutes, { prefix: '/evaluation' });

  if (options.merchantEventIngestionService) {
    app.register(merchantEventRoutes, { prefix: '/merchant-events', ingestionService: options.merchantEventIngestionService, outcomeObserver: options.merchantEventOutcomeObserver });
  }

  app.register(razorpayWebhookRoutes, {
    prefix: '/webhooks',
    webhookService: options.razorpayWebhookService || new RazorpayWebhookService({
      merchantId: env.RAZORPAY_TEST_MERCHANT_ID,
      webhookSecret: env.RAZORPAY_WEBHOOK_SECRET,
      eventRepo: new EventRepository(),
      auditRepo: new AuditRepository(),
    }),
  });

  return app;
}

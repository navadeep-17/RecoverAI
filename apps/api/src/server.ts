import fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import sensible from '@fastify/sensible';
import { generateCorrelationId, createLogger, loadEnv } from '@recoverai/shared';
import { checkDatabaseConnection } from '@recoverai/db';

export function buildServer(): FastifyInstance {
  const env = loadEnv();
  const logger = createLogger({ level: env.LOG_LEVEL, isProduction: env.NODE_ENV === 'production' });

  const app = fastify({
    logger: false, // Managed custom logger
    genReqId: (req) => {
      const headerId = req.headers['x-correlation-id'] || req.headers['x-request-id'];
      if (typeof headerId === 'string' && headerId.trim().length > 0) {
        return headerId;
      }
      return generateCorrelationId();
    },
  });

  // Plugins
  app.register(sensible);
  app.register(cors, {
    origin: env.CORS_ORIGIN,
    credentials: true,
  });

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

  // Ready endpoint: readiness probe including DB dependency check
  app.get('/ready', async (_req, reply) => {
    const isDbConnected = await checkDatabaseConnection();

    const isReady = isDbConnected || env.NODE_ENV === 'test';

    const statusCode = isReady ? 200 : 503;
    return reply.status(statusCode).send({
      ready: isReady,
      database: isDbConnected,
      timestamp: new Date().toISOString(),
    });
  });

  return app;
}

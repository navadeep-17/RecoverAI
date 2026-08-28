import { buildServer } from './server.js';
import { loadEnv, createLogger } from '@recoverai/shared';

const env = loadEnv();
const logger = createLogger({ level: env.LOG_LEVEL });
const server = buildServer();

async function start() {
  try {
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
    process.exit(0);
  });
}

if (process.env.NODE_ENV !== 'test') {
  start();
}

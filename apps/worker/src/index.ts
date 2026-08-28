import { RecoveryWorkerService } from './worker.js';
import { createLogger } from '@recoverai/shared';

const logger = createLogger();
const workerService = new RecoveryWorkerService();

async function main() {
  try {
    await workerService.start();
  } catch (err) {
    logger.error({ err, msg: 'Worker process exiting due to startup error' });
    process.exit(1);
  }
}

const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];
for (const signal of signals) {
  process.on(signal, async () => {
    logger.info({ msg: `Received ${signal}, stopping worker...` });
    await workerService.stop();
    process.exit(0);
  });
}

if (process.env.NODE_ENV !== 'test') {
  main();
}

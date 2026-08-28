import PgBoss from 'pg-boss';
import { loadEnv, createLogger } from '@recoverai/shared';

export interface RecoveryWorkerConfig {
  connectionString: string;
  schema: string;
}

export class RecoveryWorkerService {
  private boss: PgBoss | null = null;
  private logger = createLogger();
  private isRunning = false;

  constructor(private config?: Partial<RecoveryWorkerConfig>) {}

  async start(): Promise<void> {
    const env = loadEnv();
    const connectionString = this.config?.connectionString || env.DATABASE_URL;
    const schema = this.config?.schema || env.PG_BOSS_SCHEMA;

    this.logger.info({ schema, msg: 'Initializing pg-boss recovery worker' });

    try {
      this.boss = new PgBoss({
        connectionString,
        schema,
      });

      this.boss.on('error', (err) => {
        this.logger.error({ err, msg: 'pg-boss internal error' });
      });

      if (env.NODE_ENV !== 'test') {
        await this.boss.start();
      }

      this.isRunning = true;
      this.logger.info({ msg: 'Recovery worker service started successfully' });
    } catch (err) {
      this.logger.error({ err, msg: 'Failed to start recovery worker service' });
      throw err;
    }
  }

  async stop(): Promise<void> {
    if (this.boss && this.isRunning) {
      this.logger.info({ msg: 'Stopping recovery worker service...' });
      await this.boss.stop();
      this.isRunning = false;
    }
  }

  getStatus(): { isRunning: boolean; hasBossInstance: boolean } {
    return {
      isRunning: this.isRunning,
      hasBossInstance: this.boss !== null,
    };
  }
}

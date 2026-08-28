import pino from 'pino';

export interface LoggerContext {
  correlationId?: string;
  merchantId?: string;
  caseId?: string;
  actionId?: string;
  eventId?: string;
  [key: string]: unknown;
}

export function createLogger(options?: { level?: string; isProduction?: boolean }) {
  const level = options?.level || process.env.LOG_LEVEL || 'info';
  const isProduction = options?.isProduction ?? process.env.NODE_ENV === 'production';

  return pino({
    level,
    transport: isProduction
      ? undefined
      : {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:standard',
            ignore: 'pid,hostname',
          },
        },
    base: {
      service: 'recoverai',
    },
    formatters: {
      level(label) {
        return { level: label };
      },
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

export type Logger = ReturnType<typeof createLogger>;

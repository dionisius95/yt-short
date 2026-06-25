import pino from 'pino';
import path from 'path';
import fs from 'fs';

// Determine log file path — use userData in production, stdout in dev
function getLogDest(): pino.DestinationStream | undefined {
  if (process.env.NODE_ENV === 'development') return undefined;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { app } = require('electron') as typeof import('electron');
    const logDir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    const logFile = path.join(logDir, 'app.log');
    return pino.destination({ dest: logFile, sync: false });
  } catch {
    return undefined;
  }
}

/**
 * Structured logger using pino.
 */
export const logger = pino(
  {
    level: process.env.LOG_LEVEL ?? 'info',
    transport:
      process.env.NODE_ENV === 'development'
        ? {
            target: 'pino-pretty',
            options: {
              colorize: true,
              translateTime: 'SYS:standard',
              ignore: 'pid,hostname',
            },
          }
        : undefined,
  },
  getLogDest()
);

export function createLogger(name: string) {
  return logger.child({ module: name });
}

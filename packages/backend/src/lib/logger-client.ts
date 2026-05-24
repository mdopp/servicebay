/**
 * Client-safe logger — identical API surface as the full `logger.ts` but with
 * zero Node.js dependencies (no `fs`, `path`, `better-sqlite3`).
 *
 * The frontend imports `logger` via `@servicebay/api-client`; this module is
 * the backing implementation for that re-export. Moving the client logger
 * into its own file means the client bundle never reaches the server-only
 * `require()` calls in `logger.ts`, which in turn lets the build run under
 * Turbopack without the Webpack `resolve.fallback` hack (#905).
 *
 * The server continues to import the full `logger` from `@/lib/logger` (which
 * adds SQLite persistence, file-system access, and trace-provider support).
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

class ClientLogger {
  private currentLogLevel: LogLevel = 'info';

  setLogLevel(level: LogLevel): void {
    this.currentLogLevel = level;
  }

  getLogLevel(): LogLevel {
    return this.currentLogLevel;
  }

  private shouldLog(level: LogLevel): boolean {
    return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[this.currentLogLevel];
  }

  debug(tag: string, message: string, ...args: unknown[]) {
    if (!this.shouldLog('debug')) return;
    console.debug(`[${tag}]`, message, ...args);
  }

  info(tag: string, message: string, ...args: unknown[]) {
    if (!this.shouldLog('info')) return;
    console.info(`[${tag}]`, message, ...args);
  }

  warn(tag: string, message: string, ...args: unknown[]) {
    if (!this.shouldLog('warn')) return;
    console.warn(`[${tag}]`, message, ...args);
  }

  error(tag: string, message: string, ...args: unknown[]) {
    // Always log errors
    console.error(`[${tag}]`, message, ...args);
  }
}

export const logger = new ClientLogger();

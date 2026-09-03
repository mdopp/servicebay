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
 *
 * It carries no ANSI at all, so #2667's colour half never applied here. The
 * blank-line half does: Next.js SSR runs inside the backend process, so a
 * server-rendered `logger.info('x', 'msg', someObject)` lands in the same
 * journald pipe, where the multi-line object inspection becomes a run of empty
 * entries. Hence the shared `log-format` sink helpers — pure, no Node built-ins,
 * so importing them keeps this module client-safe.
 */

import { renderLogArg, toSingleJournalLine } from './log-format';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

class ClientLogger {
  private currentLogLevel: LogLevel = 'info';

  /**
   * Render tag + message + args as ONE line (#2667) — see `log-format.ts`.
   * Args are stringified here rather than handed to `console.*`, so an object
   * or an Error stack can no longer be split into a prefixed entry plus a run
   * of blank ones by journald on the SSR path.
   */
  private line(tag: string, message: string, args: unknown[]): string {
    return toSingleJournalLine([`[${tag}]`, message, ...args.map(a => renderLogArg(a))].join(' '));
  }

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
    console.debug(this.line(tag, message, args));
  }

  info(tag: string, message: string, ...args: unknown[]) {
    if (!this.shouldLog('info')) return;
    console.info(this.line(tag, message, args));
  }

  warn(tag: string, message: string, ...args: unknown[]) {
    if (!this.shouldLog('warn')) return;
    console.warn(this.line(tag, message, args));
  }

  error(tag: string, message: string, ...args: unknown[]) {
    // Always log errors
    console.error(this.line(tag, message, args));
  }
}

export const logger = new ClientLogger();

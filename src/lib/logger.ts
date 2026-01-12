import type * as fs from 'fs';
import type * as path from 'path';

const isServer = typeof window === 'undefined';

const COLORS = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bright: "\x1b[1m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
};

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

class Logger {
  private fs: typeof fs | null = null;
  private path: typeof path | null = null;
  private logDir: string = '';

  constructor() {
    if (isServer) {
        try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            this.fs = require('fs');
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            this.path = require('path');
            
            if (this.path) {
                this.logDir = this.path.join(process.cwd(), 'data', 'logs');
            }

            if (this.fs && !this.fs.existsSync(this.logDir)) {
                this.fs.mkdirSync(this.logDir, { recursive: true });
            }
        } catch (e) {
            console.error('Failed to initialize file logging:', e);
        }
    }
  }

  private getTimestamp() {
    return new Date().toISOString().replace('T', ' ').replace('Z', '');
  }

  private getLogFile() {
    if (!this.fs || !this.path) return null;
    const date = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    return this.path.join(this.logDir, `servicebay-${date}.log`);
  }

  private appendStats(level: string, tag: string, message: string, args: unknown[]) {
      if (!this.fs) return;
      try {
          const file = this.getLogFile();
          if (file) {
              const timestamp = this.getTimestamp();
              const argsStr = args.length > 0 ? ' ' + JSON.stringify(args) : '';
              const line = `${timestamp} [${level.toUpperCase()}] [${tag}] ${message}${argsStr}\n`;
              this.fs.appendFileSync(file, line);
          }
      } catch {
          // Silent fail on file write to avoid loop
      }
  }

  private format(level: LogLevel, tag: string, message: string, args: unknown[]) {
    if (!isServer) {
       // Browser fallback: Use native grouping or just simple prefix
       return [`[${tag}] ${message}`, ...args];
    }

    // Persist to file (without colors)
    this.appendStats(level, tag, message, args);

    const timestamp = `${COLORS.dim}${this.getTimestamp()}${COLORS.reset}`;
    let levelColor = COLORS.reset;
    const levelLabel = level.toUpperCase().padEnd(5);

    switch(level) {
        case 'debug': levelColor = COLORS.blue; break;
        case 'info': levelColor = COLORS.green; break;
        case 'warn': levelColor = COLORS.yellow; break;
        case 'error': levelColor = COLORS.red; break;
    }

    const coloredLevel = `${levelColor}${levelLabel}${COLORS.reset}`;
    const coloredTag = `${COLORS.magenta}[${tag}]${COLORS.reset}`;
    
    return [`${timestamp} ${coloredLevel} ${coloredTag} ${message}`, ...args];
  }

  debug(tag: string, message: string, ...args: unknown[]) {
      if (process.env.NODE_ENV !== 'production' || process.env.DEBUG) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          console.debug(...(this.format('debug', tag, message, args) as any[]));
      }
  }

  info(tag: string, message: string, ...args: unknown[]) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      console.info(...(this.format('info', tag, message, args) as any[]));
  }

  warn(tag: string, message: string, ...args: unknown[]) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      console.warn(...(this.format('warn', tag, message, args) as any[]));
  }

  error(tag: string, message: string, ...args: unknown[]) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      console.error(...(this.format('error', tag, message, args) as any[]));
  }
}

export const logger = new Logger();

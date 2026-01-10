// src/lib/logger.ts

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
  private fs: any;
  private path: any;
  private logDir: string = '';

  constructor() {
    if (isServer) {
        try {
            this.fs = require('fs');
            this.path = require('path');
            this.logDir = this.path.join(process.cwd(), 'data', 'logs');
            if (!this.fs.existsSync(this.logDir)) {
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
    if (!this.fs) return null;
    const date = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    return this.path.join(this.logDir, `servicebay-${date}.log`);
  }

  private appendStats(level: string, tag: string, message: string, args: any[]) {
      if (!this.fs) return;
      try {
          const file = this.getLogFile();
          if (file) {
              const timestamp = this.getTimestamp();
              const argsStr = args.length > 0 ? ' ' + JSON.stringify(args) : '';
              const line = `${timestamp} [${level.toUpperCase()}] [${tag}] ${message}${argsStr}\n`;
              this.fs.appendFileSync(file, line);
          }
      } catch (e) {
          // Silent fail on file write to avoid loop
      }
  }

  private format(level: LogLevel, tag: string, message: string, args: any[]) {
    if (!isServer) {
       // Browser fallback: Use native grouping or just simple prefix
       return [`[${tag}] ${message}`, ...args];
    }

    // Persist to file (without colors)
    this.appendStats(level, tag, message, args);

    const timestamp = `${COLORS.dim}${this.getTimestamp()}${COLORS.reset}`;
    let levelColor = COLORS.reset;
    let levelLabel = level.toUpperCase().padEnd(5);

    switch(level) {
        case 'debug': levelColor = COLORS.blue; break;
        case 'info': levelColor = COLORS.green; break;
        case 'warn': levelColor = COLORS.yellow; break;
        case 'error': levelColor = COLORS.red; break;
    }

    const coloredLevel = `${levelColor}${levelLabel}${COLORS.reset}`;
    const coloredTag = `${COLORS.magenta}[${tag}]${COLORS.reset}`;
    
    // Check if args contains objects to print pretty
    const rest = args.length > 0 ? args : '';
    
    return [`${timestamp} ${coloredLevel} ${coloredTag} ${message}`, ...args];
  }

  debug(tag: string, message: string, ...args: any[]) {
      if (process.env.NODE_ENV !== 'production' || process.env.DEBUG) {
          console.debug(...this.format('debug', tag, message, args));
      }
  }

  info(tag: string, message: string, ...args: any[]) {
      console.info(...this.format('info', tag, message, args));
  }

  warn(tag: string, message: string, ...args: any[]) {
      console.warn(...this.format('warn', tag, message, args));
  }

  error(tag: string, message: string, ...args: any[]) {
      console.error(...this.format('error', tag, message, args));
  }
}

export const logger = new Logger();

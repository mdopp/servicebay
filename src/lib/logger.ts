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

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  tag: string;
  message: string;
  args?: unknown[];
}

class Logger {
  private fs: typeof fs | null = null;
  private path: typeof path | null = null;
  private logDir: string = '';
  private currentLogLevel: LogLevel = 'info';
  private logLevelPriority: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

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

            // Load log level from environment or default to 'info'
            const envLevel = process.env.LOG_LEVEL as LogLevel;
            if (envLevel && this.logLevelPriority.hasOwnProperty(envLevel)) {
                this.currentLogLevel = envLevel;
            }
        } catch (e) {
            console.error('Failed to initialize file logging:', e);
        }
    }
  }

  setLogLevel(level: LogLevel): void {
    this.currentLogLevel = level;
    if (isServer) {
      process.env.LOG_LEVEL = level;
    }
  }

  getLogLevel(): LogLevel {
    return this.currentLogLevel;
  }

  private shouldLog(level: LogLevel): boolean {
    return this.logLevelPriority[level] >= this.logLevelPriority[this.currentLogLevel];
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

  private format(level: LogLevel, tag: string, message: string, args: unknown[]): LogEntry {
    if (!isServer) {
       // Browser fallback
       return { timestamp: this.getTimestamp(), level, tag, message, args };
    }

    // Persist to file (without colors)
    if (this.shouldLog(level)) {
      this.appendStats(level, tag, message, args);
    }

    return { timestamp: this.getTimestamp(), level, tag, message, args };
  }

  private formatConsole(level: LogLevel, entry: LogEntry): unknown[] {
    const timestamp = `${COLORS.dim}${entry.timestamp}${COLORS.reset}`;
    let levelColor = COLORS.reset;
    const levelLabel = level.toUpperCase().padEnd(5);

    switch(level) {
        case 'debug': levelColor = COLORS.blue; break;
        case 'info': levelColor = COLORS.green; break;
        case 'warn': levelColor = COLORS.yellow; break;
        case 'error': levelColor = COLORS.red; break;
    }

    const coloredLevel = `${levelColor}${levelLabel}${COLORS.reset}`;
    const coloredTag = `${COLORS.magenta}[${entry.tag}]${COLORS.reset}`;
    
    return [`${timestamp} ${coloredLevel} ${coloredTag} ${entry.message}`, ...(entry.args || [])];
  }

  debug(tag: string, message: string, ...args: unknown[]) {
      if (!this.shouldLog('debug')) return;
      const entry = this.format('debug', tag, message, args);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      console.debug(...(this.formatConsole('debug', entry) as any[]));
  }

  info(tag: string, message: string, ...args: unknown[]) {
      if (!this.shouldLog('info')) return;
      const entry = this.format('info', tag, message, args);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      console.info(...(this.formatConsole('info', entry) as any[]));
  }

  warn(tag: string, message: string, ...args: unknown[]) {
      if (!this.shouldLog('warn')) return;
      const entry = this.format('warn', tag, message, args);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      console.warn(...(this.formatConsole('warn', entry) as any[]));
  }

  error(tag: string, message: string, ...args: unknown[]) {
      // Always log errors
      const entry = this.format('error', tag, message, args);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      console.error(...(this.formatConsole('error', entry) as any[]));
  }

  /**
   * Parse log file and return entries
   */
  readLogs(filename: string, filterLevel?: LogLevel, filterTag?: string, searchText?: string): LogEntry[] {
    if (!this.fs) return [];
    try {
      const filepath = this.path!.join(this.logDir, filename);
      const content = this.fs.readFileSync(filepath, 'utf-8');
      const entries = content.split('\n').filter(Boolean).map(line => this.parseLogLine(line));
      
      return entries.filter(e => {
        if (filterLevel && this.logLevelPriority[e.level] < this.logLevelPriority[filterLevel]) return false;
        if (filterTag && e.tag !== filterTag) return false;
        if (searchText && !e.message.toLowerCase().includes(searchText.toLowerCase())) return false;
        return true;
      });
    } catch {
      return [];
    }
  }

  private parseLogLine(line: string): LogEntry {
    // Format: YYYY-MM-DD HH:MM:SS [LEVEL] [TAG] message [args]
    const match = line.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) \[(\w+)\] \[([^\]]+)\] (.+?)(?:\s+(.+))?$/);
    if (!match) {
      return { timestamp: new Date().toISOString(), level: 'info', tag: 'Unknown', message: line };
    }
    const [, timestamp, level, tag, message, argsStr] = match;
    const args = argsStr ? [argsStr] : [];
    return {
      timestamp,
      level: (level.toLowerCase() as LogLevel),
      tag,
      message,
      args
    };
  }

  /**
   * List available log files
   */
  listLogFiles(): string[] {
    if (!this.fs) return [];
    try {
      return this.fs.readdirSync(this.logDir).filter(f => f.startsWith('servicebay-') && f.endsWith('.log')).sort().reverse();
    } catch {
      return [];
    }
  }
}

export const logger = new Logger();

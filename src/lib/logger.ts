import type * as fs from 'fs';
import type * as path from 'path';
import type { Database } from 'better-sqlite3';

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

interface LogEntry {
  id?: number;
  timestamp: string;
  level: LogLevel;
  tag: string;
  message: string;
  args?: unknown[];
}

export interface LogFilter {
  level?: LogLevel;
  tags?: string[];
  search?: string;
  date?: string; // YYYY-MM-DD or 'live'
  limit?: number;
  offset?: number;
}

class Logger {
  private fs: typeof fs | null = null;
  private path: typeof path | null = null;
  private db: Database | null = null;
  private logDir: string = '';
  private currentLogLevel: LogLevel = 'info';
  private logLevelPriority: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
  private onLogCallbacks: Set<(entry: LogEntry) => void> = new Set();

  constructor() {
    if (isServer) {
        try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            this.fs = require('fs');
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            this.path = require('path');
            
            if (this.path) {
                this.logDir = this.path.join(process.cwd(), 'data');
            }

            if (this.fs && !this.fs.existsSync(this.logDir)) {
                this.fs.mkdirSync(this.logDir, { recursive: true });
            }
            
            // Initialize SQLite
            try {
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const Database = require('better-sqlite3');
                const dbPath = this.path!.join(this.logDir, 'logs.db');
                this.db = new Database(dbPath);
                
                // Enable WAL mode for better concurrency
                this.db!.pragma('journal_mode = WAL');
                
                // Create table
                this.db!.exec(`
                    CREATE TABLE IF NOT EXISTS logs (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        timestamp TEXT NOT NULL,
                        level TEXT NOT NULL,
                        tag TEXT NOT NULL,
                        message TEXT NOT NULL,
                        args TEXT
                    );
                    CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON logs(timestamp);
                    CREATE INDEX IF NOT EXISTS idx_logs_level ON logs(level);
                    CREATE INDEX IF NOT EXISTS idx_logs_tag ON logs(tag);
                `);
            } catch (e) {
                console.error('Failed to initialize SQLite logger:', e);
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
  
  onLog(callback: (entry: LogEntry) => void) {
      this.onLogCallbacks.add(callback);
      return () => this.onLogCallbacks.delete(callback);
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

  private insertLog(level: LogLevel, tag: string, message: string, args: unknown[]): LogEntry {
      const timestamp = this.getTimestamp();
      const entry: LogEntry = {
          timestamp,
          level,
          tag,
          message,
          args: args.length > 0 ? args : undefined
      };
      
      if (isServer && this.db) {
          try {
              const stmt = this.db.prepare('INSERT INTO logs (timestamp, level, tag, message, args) VALUES (?, ?, ?, ?, ?)');
              const info = stmt.run(
                  timestamp,
                  level,
                  tag,
                  message,
                  args.length > 0 ? JSON.stringify(args) : null
              );
              entry.id = Number(info.lastInsertRowid);
              
              // Emit event
              this.onLogCallbacks.forEach(cb => cb(entry));
          } catch (e) {
              console.error('Failed to write log to DB:', e);
          }
      }
      return entry;
  }

  private format(level: LogLevel, tag: string, message: string, args: unknown[]): LogEntry {
    if (!isServer) {
       // Browser fallback
       return { timestamp: this.getTimestamp(), level, tag, message, args };
    }

    // Persist to DB (without colors)
    if (this.shouldLog(level)) {
       return this.insertLog(level, tag, message, args);
    }
    
    // Even if not persisted, return entry structure
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
   * Get all unique tags (split by :)
   */
  getTags(): string[] {
    if (!this.db) return [];
    try {
        const rows = this.db.prepare('SELECT DISTINCT tag FROM logs').all() as { tag: string }[];
        const tagSet = new Set<string>();
        rows.forEach(row => {
            if (row.tag) {
                row.tag.split(':').forEach(t => t && tagSet.add(t));
            }
        });
        return Array.from(tagSet).sort();
    } catch {
        return [];
    }
  }

  /**
   * Query logs from DB
   */
  queryLogs(filter: LogFilter): LogEntry[] {
    if (!this.db) return [];
    
    let query = 'SELECT * FROM logs WHERE 1=1';
    const params: unknown[] = [];
    
    if (filter.date && filter.date !== 'live') {
        // Date format in DB: YYYY-MM-DD HH:MM:SS.mmm
        // Filter by day prefix
        query += ' AND timestamp LIKE ?';
        params.push(`${filter.date}%`);
    }
    
    if (filter.level) {
        // Support equality, or maybe priority? 
        // For now strict equality as implied by UI, or we can look up priority map
        // If UI sends 'warn', user typically expects warn and error.
        // Let's implement >= level logic
        const priority = this.logLevelPriority[filter.level];
        // This is tricky in SQL directly without mapping text to int. 
        // Let's stick to simple filtering or IN clause for now to match file implementation
        // File implementation: if (filterLevel && this.logLevelPriority[e.level] < this.logLevelPriority[filterLevel]) return false;
        // So it returns all logs >= filterLevel.
        const levels = Object.entries(this.logLevelPriority)
            .filter(([, p]) => p >= priority)
            .map(([l]) => l);
            
        if (levels.length > 0) {
            query += ` AND level IN (${levels.map(() => '?').join(',')})`;
            params.push(...levels);
        }
    }
    
    if (filter.tags && filter.tags.length > 0) {
        const conditions = filter.tags.map(() => 'tag LIKE ?').join(' OR ');
        query += ` AND (${conditions})`;
        params.push(...filter.tags.map(t => `%${t}%`));
    }
    
    if (filter.search) {
        query += ' AND (message LIKE ? OR tag LIKE ?)';
        const term = `%${filter.search}%`;
        params.push(term, term);
    }
    
    // Order: Newest on top
    query += ' ORDER BY timestamp DESC';
    
    if (filter.limit) {
        query += ' LIMIT ?';
        params.push(filter.limit);
    }
    
    if (filter.offset) {
        query += ' OFFSET ?';
        params.push(filter.offset);
    }
    
    try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const rows = this.db.prepare(query).all(...params) as any[];
        return rows.map(row => ({
            id: row.id,
            timestamp: row.timestamp,
            level: row.level as LogLevel,
            tag: row.tag,
            message: row.message,
            args: row.args ? JSON.parse(row.args) : undefined
        }));
    } catch (e) {
        console.error('Failed to query logs:', e);
        return [];
    }
  }

  /**
   * List available log dates
   */
  listLogDates(): string[] {
    if (!this.db) return [];
    try {
        // Extract YYYY-MM-DD from timestamp
         
        const rows = this.db.prepare(`
            SELECT DISTINCT substr(timestamp, 1, 10) as date 
            FROM logs 
            ORDER BY date DESC
        `).all() as { date: string }[];
        
        return rows.map(r => r.date);
    } catch {
        return [];
    }
  }
}

export const logger = new Logger();

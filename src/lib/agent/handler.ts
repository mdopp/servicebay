import { EventEmitter } from 'events';
import { SSHConnectionPool } from '../ssh/pool';
import fs from 'fs';
import path from 'path';
import { ClientChannel } from 'ssh2';
import { spawn, ChildProcess } from 'child_process';
import { listNodes } from '../nodes';
import { logger } from '@/lib/logger';
import { getConfig } from '@/lib/config';

type AgentLogLevel = 'info' | 'warn' | 'error' | 'debug';

type AgentLoggerMethod = (scope: string, msg: string, ...rest: unknown[]) => void;
type AgentLogger = Record<AgentLogLevel, AgentLoggerMethod>;

const fallbackLogger: AgentLogger = {
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  debug: (console.debug ?? console.log).bind(console)
};

const bindLoggerMethod = (level: AgentLogLevel): AgentLoggerMethod => {
  const source = logger as unknown as Partial<Record<AgentLogLevel, AgentLoggerMethod>>;
  const candidate = source[level];
  if (typeof candidate === 'function') {
    return candidate.bind(logger);
  }
  return fallbackLogger[level];
};

const loggerMethods: AgentLogger = {
  info: bindLoggerMethod('info'),
  warn: bindLoggerMethod('warn'),
  error: bindLoggerMethod('error'),
  debug: bindLoggerMethod('debug')
};

// Cache the agent script content
// Updated: Force reload 2
let AGENT_SCRIPT_B64: string = '';

function getAgentScript() {
  // In development, always reload the script to pick up changes
  if (!AGENT_SCRIPT_B64 || process.env.NODE_ENV === 'development') {
    // Determine path. In Next.js prod, this might need adjustment or bundling.
    // For now, assume process.cwd() is project root.
    // V4 Update: Point to new agent script
    const p = path.join(process.cwd(), 'src/lib/agent/v4/agent.py');
    const content = fs.readFileSync(p, 'utf-8');
    AGENT_SCRIPT_B64 = Buffer.from(content).toString('base64');
  }
  return AGENT_SCRIPT_B64;
}

export interface AgentEvent {
  type: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload: any;
}

export interface AgentHealth {
  nodeName: string;
  isConnected: boolean;
  lastSync: number; // timestamp
  messageCount: number;
  errorCount: number;
  lastError?: string;
  runId?: string;
  sessionId?: string;
}

export class AgentHandler extends EventEmitter {
  public nodeName: string;
  private channel: ClientChannel | null = null;
  private process: ChildProcess | null = null;
  private buffer: Buffer = Buffer.alloc(0);
  private logBuffer: string = '';
    private isStarting = false;
    private startPromise: Promise<void> | null = null;
    private currentRunId?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private pendingRequests: Map<string, { resolve: (val: any) => void; reject: (err: any) => void }> = new Map();
  private isConnected: boolean = false;
  private consecutiveParseErrors = 0;
  private readonly MAX_PARSE_ERRORS = 5;
  
  // Health tracking
  private health: AgentHealth = {
    nodeName: '',
    isConnected: false,
    lastSync: 0,
    messageCount: 0,
    errorCount: 0,
  };

  constructor(nodeName: string) {
    super();
    this.nodeName = nodeName;
    this.health.nodeName = nodeName;
  }

  private generateRunId(): string {
    return `${this.nodeName}-${Date.now().toString(36)}-${Math.random().toString(36).slice(-4)}`;
  }

  private getSessionId(): string | undefined {
    return process.env.SERVICEBAY_SESSION || undefined;
  }

  public getCurrentRunId(): string | undefined {
    return this.currentRunId;
  }

  private formatWithRunId(message: string): string {
    if (!this.currentRunId) return message;
    if (message.startsWith(`[${this.currentRunId}]`)) {
        return message;
    }
    return `[${this.currentRunId}] ${message}`;
  }

  private log(scope: string, level: AgentLogLevel, message: string, ...args: unknown[]) {
    loggerMethods[level](scope, this.formatWithRunId(message), ...args);
  }

  private logRaw(scope: string, level: AgentLogLevel, message: string, ...args: unknown[]) {
    loggerMethods[level](scope, message, ...args);
  }

  public getHealth(): AgentHealth {
    return { ...this.health };
  }

  public async start() {
    if (this.isConnected) return;
    if (this.isStarting && this.startPromise) {
      return this.startPromise;
    }

    this.isStarting = true;
    const runId = this.generateRunId();
    this.currentRunId = runId;
    this.health.runId = runId;
    this.health.sessionId = this.getSessionId();

    const starter = (async () => {
      // Check if we should use Local Spawn or SSH
      let useLocalSpawn = false;
      try {
        const nodes = await listNodes();
        const configured = nodes.find(n => n.Name === this.nodeName);
            
        // Use local spawn if:
        // 1. Node is named 'Local' and NOT configured (implicit local)
        // 2. Node is configured with URI 'local'
        if ((!configured && this.nodeName === 'Local') || (configured && configured.URI === 'local')) {
          useLocalSpawn = true;
        }
      } catch {
        // Fallback for implicit Local
        if (this.nodeName === 'Local') useLocalSpawn = true;
      }

      if (useLocalSpawn) {
        this.log('AgentHandler', 'info', 'Starting Local Agent...');
        await this.startLocal(runId);
      } else {
        this.log('AgentHandler', 'info', `Starting SSH Agent for ${this.nodeName}...`);
        await this.startSSH(runId);
      }
    })();

    this.startPromise = starter.finally(() => {
      this.isStarting = false;
      this.startPromise = null;
    });

    return this.startPromise;
  }

  private async startLocal(runId: string): Promise<void> {
    try {
        const script = getAgentScript();
        const args = ['-u', '-c', `import base64, sys; exec(base64.b64decode("${script}"))`];
      const sessionId = this.getSessionId();
      if (sessionId) {
        args.push('--session-id', sessionId);
      }
        this.log('Agent:Local', 'info', 'Spawning python3...');
        
        // Ensure XDG_RUNTIME_DIR is set for systemctl --user
        const env = { ...process.env };
        if (!env.XDG_RUNTIME_DIR) {
            const uid = process.getuid ? process.getuid() : 0;
            env.XDG_RUNTIME_DIR = `/run/user/${uid}`;
        }
        const config = await getConfig();
        env.SERVICEBAY_AGENT_ID = runId;
        if (sessionId) {
          env.SERVICEBAY_SESSION = sessionId;
          env.SERVICEBAY_SESSION_ID = sessionId;
        }
        if (config.agent?.cleanupOrphansOnStart === false) {
          env.SERVICEBAY_AGENT_CLEANUP_ON_START = 'false';
        }
        if (config.agent?.processCleanup?.enabled === false) {
          env.SERVICEBAY_AGENT_CLEANUP_ENABLED = 'false';
        }
        if (config.agent?.processCleanup?.dryRun) {
          env.SERVICEBAY_AGENT_CLEANUP_DRY_RUN = 'true';
        }
        if (typeof config.agent?.processCleanup?.maxAgeMinutes === 'number') {
          env.SERVICEBAY_AGENT_CLEANUP_MAX_AGE_MINUTES = String(config.agent?.processCleanup?.maxAgeMinutes);
        }

        const child = spawn('python3', args, { env });

        this.process = child;
        this.isConnected = true;
        this.health.isConnected = true;
        this.health.lastSync = Date.now();
        this.emit('connected');

        child.stdout.on('data', (data) => {
             // console.log(`[Agent:Local] Raw Data (${data.length} bytes)`); // Debug disabled
             this.handleData(data);
        });
        child.stderr.on('data', (data) => {
             this.handleLog(data);
        });
        
        child.on('close', (code) => {
          this.log('Agent:Local', 'info', `Closed. Code: ${code}`);
            this.handleDisconnect();
        });
        
        child.on('error', (err) => {
            this.health.errorCount++;
            this.health.lastError = err.message;
          this.log('Agent:Local', 'error', 'Spawn Error:', err);
            this.emit('error', err);
        });

    } catch (e) {
        this.emit('error', e);
        throw e;
    }
  }

  private async startSSH(runId: string) {
    try {
      this.log(this.nodeName, 'info', 'Establishing SSH connection...');
      const pool = SSHConnectionPool.getInstance();
      const conn = await pool.getConnection(this.nodeName);
      
      this.log(this.nodeName, 'info', 'SSH connection established, starting Python agent...');
      const script = getAgentScript();
      const config = await getConfig();
      const sessionId = this.getSessionId();
      
      // Ensure systemd environment variables are set for the agent process
      // We export XDG_RUNTIME_DIR so systemctl can find the bus.
      // We do NOT manually set DBUS_SESSION_BUS_ADDRESS as it can vary (file vs abstract).
      const cleanupOnStart = config.agent?.cleanupOrphansOnStart === false ? 'false' : 'true';
      const cleanupEnabled = config.agent?.processCleanup?.enabled === false ? 'false' : 'true';
      const cleanupDryRun = config.agent?.processCleanup?.dryRun ? 'true' : 'false';
      const cleanupMaxAge = typeof config.agent?.processCleanup?.maxAgeMinutes === 'number'
        ? String(config.agent?.processCleanup?.maxAgeMinutes)
        : '';
      const envSetup = [
        `export SERVICEBAY_AGENT_ID="${runId}"`,
        `export XDG_RUNTIME_DIR="/run/user/$(id -u)"`,
        `export SERVICEBAY_AGENT_CLEANUP_ON_START="${cleanupOnStart}"`,
        `export SERVICEBAY_AGENT_CLEANUP_ENABLED="${cleanupEnabled}"`,
        `export SERVICEBAY_AGENT_CLEANUP_DRY_RUN="${cleanupDryRun}"`,
        cleanupMaxAge ? `export SERVICEBAY_AGENT_CLEANUP_MAX_AGE_MINUTES="${cleanupMaxAge}"` : '',
        sessionId ? `export SERVICEBAY_SESSION="${sessionId}"` : '',
        sessionId ? `export SERVICEBAY_SESSION_ID="${sessionId}"` : ''
      ].filter(Boolean).join('; ');
      const sessionArg = sessionId ? ` --session-id "${sessionId}"` : '';
      const cmd = `${envSetup}; python3 -u -c 'import base64, sys; exec(base64.b64decode("${script}"))'${sessionArg}`;

      return new Promise<void>((resolve, reject) => {
        conn.exec(cmd, (err, stream) => {
          if (err) {
              const errorMsg = `Failed to execute agent command on ${this.nodeName}: ${err.message}`;
              this.log(this.nodeName, 'error', errorMsg);
              this.health.lastError = errorMsg;
              this.health.errorCount++;
              this.emit('error', err);
              reject(new Error(errorMsg));
              return;
          }

          this.channel = stream;
          this.isConnected = true;
          this.health.isConnected = true;
          this.health.lastSync = Date.now();
          this.health.lastError = '';
          this.log(this.nodeName, 'info', '✓ Python agent started successfully via SSH');
          this.emit('connected');
          resolve();

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          stream.on('close', (code: any) => {
            this.log(this.nodeName, 'info', `Agent Closed. Code: ${code}`);
            this.handleDisconnect();
          });

          stream.on('data', (data: Buffer) => this.handleData(data));
          stream.stderr.on('data', (data: Buffer) => {
              this.handleLog(data);
          });
        });
      });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.log(this.nodeName, 'error', `SSH agent startup failed: ${errorMsg}`);
      this.health.lastError = `SSH startup failed: ${errorMsg}`;
      this.health.errorCount++;
      this.health.isConnected = false;
      this.emit('error', error);
      throw error;
    }
  }

  private handleLog(data: Buffer | string) {
      this.logBuffer += data.toString();
      
      let newlineIndex;
      while ((newlineIndex = this.logBuffer.indexOf('\n')) !== -1) {
          const line = this.logBuffer.substring(0, newlineIndex).trim();
          this.logBuffer = this.logBuffer.substring(newlineIndex + 1);
          
          if (!line) continue;
            if (this.tryHandleStructuredLog(line)) {
              continue;
            }
          
            if (line.includes('[INFO]')) {
              this.log(`Agent:${this.nodeName}`, 'info', line.replace(/.*\[INFO\]\s*/, ''));
            } else if (line.includes('[WARN]')) {
              this.log(`Agent:${this.nodeName}`, 'warn', line.replace(/.*\[WARN\]\s*/, ''));
            } else if (line.includes('[ERROR]')) {
              this.health.errorCount++;
              this.health.lastError = line;
              this.log(`Agent:${this.nodeName}`, 'error', line.replace(/.*\[ERROR\]\s*/, ''));
            } else if (line.includes('[DEBUG]')) {
              this.log(`Agent:${this.nodeName}`, 'debug', line.replace(/.*\[DEBUG\]\s*/, ''));
          } else {
              // Unclassified stderr (e.g. traceback, system tool output)
              this.health.errorCount++;
              this.health.lastError = line;
              this.log(`Agent:${this.nodeName}:STDERR`, 'error', line);
          }
      }
      
      // Safety: Prevent unlimited buffer growth if no newline ever comes (unlikely but safe)
      if (this.logBuffer.length > 1024 * 1024) {
          // Log what we have and clear
          this.log(`Agent:${this.nodeName}`, 'error', 'Log buffer exceeded 1MB, flushing raw content');
          this.log(`Agent:${this.nodeName}:STDERR`, 'error', this.logBuffer);
          this.logBuffer = '';
      }
  }

    private tryHandleStructuredLog(line: string): boolean {
      const trimmed = line.trim();
      if (!trimmed) return false;
      const startsJson = trimmed.startsWith('{') || trimmed.startsWith('[');
      if (!startsJson) return false;

      try {
        JSON.parse(trimmed);
        this.logRaw(`Agent:${this.nodeName}`, 'info', trimmed);
        return true;
      } catch {
        return false;
      }
    }

  private handleDisconnect() {
      this.isConnected = false;
      this.health.isConnected = false;
      this.channel = null;
      this.process = null;
      const runLabel = this.currentRunId ? ` (runId=${this.currentRunId})` : '';
      this.log(this.nodeName, 'warn', `Agent disconnected${runLabel}. Health: ${JSON.stringify(this.health)}`);
      this.emit('disconnected');
      this.cleanupPending();
  }

  private handleData(data: Buffer) {
    this.health.lastSync = Date.now();
    this.buffer = Buffer.concat([this.buffer, data]);
    
    // Process null-terminated messages
    let offset = 0;
    while (true) {
      const delimiterIndex = this.buffer.indexOf(0, offset); // 0 = null byte
      if (delimiterIndex === -1) break;
      
      const msgBuf = this.buffer.subarray(offset, delimiterIndex);
      const msgStr = msgBuf.toString('utf-8').trim();
      
      if (msgStr) {
        try {
          const msg = JSON.parse(msgStr);
          this.health.messageCount++;
          this.health.lastSync = Date.now();
          this.processMessage(msg);
          this.consecutiveParseErrors = 0; // Reset on success
        } catch (e: unknown) {
             this.consecutiveParseErrors++;
             this.health.errorCount++;
             const errorMsg = e instanceof Error ? e.message : String(e);
             this.health.lastError = `Parse Error: ${errorMsg}`;
             this.log(this.nodeName, 'error', `Invalid JSON error: ${errorMsg}`);
             this.log(this.nodeName, 'error', `Invalid JSON content (first 200 chars): ${msgStr.substring(0, 200)}`);

             if (this.consecutiveParseErrors >= this.MAX_PARSE_ERRORS) {
                 this.log(this.nodeName, 'error', `Too many consecutive parse errors (${this.consecutiveParseErrors}). Disconnecting for safety.`);
                 this.emit('error', new Error('Circuit Breaker: Too many parse errors'));
                 this.disconnect();
                 return; // Stop processing further messages in this batch
             }
        }
      }
      
      offset = delimiterIndex + 1;
    }
    
    // Keep remaining buffer
    if (offset > 0) {
        this.buffer = this.buffer.subarray(offset);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private processMessage(msg: any) {
    // 1. Response to a request?
    if (msg.type === 'response' && msg.payload && msg.payload.id) {
        const req = this.pendingRequests.get(msg.payload.id);
        if (req) {
            if (msg.payload.error) req.reject(new Error(msg.payload.error));
            else req.resolve(msg.payload.result);
            this.pendingRequests.delete(msg.payload.id);
        }
        return;
    }

    // 2. Generic Event
    this.emit('event', msg);
    // Also specific types
    if (msg.type) {
        this.emit(msg.type, msg.payload);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public async sendCommand(action: string, params: any = {}): Promise<any> {
    if (!this.isConnected) {
        this.log(this.nodeName, 'warn', 'Not connected, attempting to reconnect...');
        try {
            await this.start();
        } catch (e) {  
            this.health.errorCount++;
            const msg = e instanceof Error ? e.message : String(e);
            this.health.lastError = `Reconnection failed: ${msg}`;
            this.log(this.nodeName, 'error', 'Reconnection failed:', e);
            throw new Error(`Agent not connected: ${msg}`);
        }
    }

    const id = Math.random().toString(36).substring(7);
    const cmd = JSON.stringify({ id, action, payload: params });
    const payloadPreview = (() => {
      if (!params || Object.keys(params).length === 0) return '{}';
      try {
        const serialized = JSON.stringify(params);
        return serialized.length > 400 ? `${serialized.slice(0, 400)}…` : serialized;
      } catch {
        return '[unserializable payload]';
      }
    })();

    this.log(this.nodeName, 'info', `Sending command '${action}' (id: ${id}) payload: ${payloadPreview}`);
    
    return new Promise((resolve, reject) => {
        // maintain pending map
        this.pendingRequests.set(id, { resolve, reject });
        
        // Timeout
        setTimeout(() => {
            if (this.pendingRequests.has(id)) {
                this.pendingRequests.delete(id);
                this.health.errorCount++;
                this.health.lastError = `Command timeout: ${action}`;
                this.log(this.nodeName, 'warn', `Command timeout for '${action}' (id: ${id})`);
                reject(new Error('Agent request timeout'));
            }
        }, 10000);

        const payload = cmd + '\n';
        if (this.process && this.process.stdin) {
            this.process.stdin.write(payload);
        } else if (this.channel) {
            this.channel.write(payload);
        } else {
             this.health.errorCount++;
             this.health.lastError = 'No active channel/process';
             reject(new Error('No active channel/process'));
        }
    });
  }

    public async restart(reason: string = 'manual', timeoutMs: number = 30000): Promise<void> {
      const sessionId = this.getSessionId();
      this.log(this.nodeName, 'info', `Restarting agent (${reason})${sessionId ? ` [session=${sessionId}]` : ''}`);

      const waitForDisconnect = new Promise<void>((resolve) => {
        const handler = () => {
          this.off('disconnected', handler);
          resolve();
        };
        this.on('disconnected', handler);
      });

      try {
        await this.sendCommand('shutdown', { reason });
      } catch (e) {
        this.log(this.nodeName, 'warn', 'Shutdown command failed, forcing disconnect:', e);
      }

      await Promise.race([
        waitForDisconnect,
        new Promise<void>(resolve => setTimeout(resolve, timeoutMs))
      ]);

      if (this.isConnected) {
        this.log(this.nodeName, 'warn', `Shutdown timeout after ${timeoutMs}ms, killing agent process.`);
        this.disconnect();
      }

      await this.start();
    }

  public disconnect() {
      if (this.channel) {
          this.channel.close(); // sends EOF
      }
      if (this.process) {
          this.process.kill();
      }
  }
  
  public async setMonitoring(enabled: boolean): Promise<void> {
      if (!this.isConnected) return;
      try {
          await this.sendCommand(enabled ? 'startMonitoring' : 'stopMonitoring');
      } catch (e) {
          this.log(this.nodeName, 'warn', 'Failed to toggle monitoring:', e);
      }
  }

  public async setResourceMode(active: boolean): Promise<void> {
      if (!this.isConnected) return;
      try {
          await this.sendCommand('setResourceMode', { active });
      } catch (e) {
          this.log(this.nodeName, 'warn', 'Failed to set resource mode:', e);
      }
  }

  private cleanupPending() {
      for (const [, req] of this.pendingRequests) {
          req.reject(new Error('Agent disconnected'));
      }
      this.pendingRequests.clear();
  }
}

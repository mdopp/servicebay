import { EventEmitter } from 'events';
import { SSHConnectionPool } from '../ssh/pool';
import fs from 'fs';
import path from 'path';
import { ClientChannel } from 'ssh2';
import { spawn, ChildProcess } from 'child_process';
import { listNodes } from '../nodes';
import { logger } from '@/lib/logger';

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
}

export class AgentHandler extends EventEmitter {
  public nodeName: string;
  private channel: ClientChannel | null = null;
  private process: ChildProcess | null = null;
  private buffer: Buffer = Buffer.alloc(0);
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

  public getHealth(): AgentHealth {
    return { ...this.health };
  }

  public async start() {
    if (this.isConnected) return;

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
        logger.info('AgentHandler', 'Starting Local Agent...');
        this.startLocal();
    } else {
        logger.info('AgentHandler', `Starting SSH Agent for ${this.nodeName}...`);
        await this.startSSH();
    }
  }

  private startLocal() {
    try {
        const script = getAgentScript();
        const args = ['-u', '-c', `import base64, sys; exec(base64.b64decode("${script}"))`];
        logger.info('Agent:Local', 'Spawning python3...');
        
        // Ensure XDG_RUNTIME_DIR is set for systemctl --user
        const env = { ...process.env };
        if (!env.XDG_RUNTIME_DIR) {
            const uid = process.getuid ? process.getuid() : 0;
            env.XDG_RUNTIME_DIR = `/run/user/${uid}`;
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
             const str = data.toString().trim();
             this.health.errorCount++;
             this.health.lastError = str;
             // Log all stderr from agent
             logger.error('Agent:Local:STDERR', str);
        });
        
        child.on('close', (code) => {
            logger.info('Agent:Local', `Closed. Code: ${code}`);
            this.handleDisconnect();
        });
        
        child.on('error', (err) => {
            this.health.errorCount++;
            this.health.lastError = err.message;
            logger.error('Agent:Local', 'Spawn Error:', err);
            this.emit('error', err);
        });

    } catch (e) {
        this.emit('error', e);
        throw e;
    }
  }

  private async startSSH() {
    try {
      const pool = SSHConnectionPool.getInstance();
      const conn = await pool.getConnection(this.nodeName);
      
      const script = getAgentScript();
      
      // Ensure systemd environment variables are set for the agent process
      // We export XDG_RUNTIME_DIR so systemctl can find the bus.
      // We do NOT manually set DBUS_SESSION_BUS_ADDRESS as it can vary (file vs abstract).
      const envSetup = 'export XDG_RUNTIME_DIR="/run/user/$(id -u)";';
      const cmd = `${envSetup} python3 -u -c 'import base64, sys; exec(base64.b64decode("${script}"))'`;

      return new Promise<void>((resolve, reject) => {
        conn.exec(cmd, (err, stream) => {
          if (err) {
              this.emit('error', err);
              reject(err);
              return;
          }

          this.channel = stream;
          this.isConnected = true;
          this.emit('connected');
          resolve();

          // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars
          stream.on('close', (code: any, signal: any) => {
            logger.info(this.nodeName, `Agent Closed. Code: ${code}`);
            this.handleDisconnect();
          });

          stream.on('data', (data: Buffer) => this.handleData(data));
          stream.stderr.on('data', (data: Buffer) => {
              const str = data.toString().trim();
              this.health.errorCount++;
              logger.error(`${this.nodeName}:STDERR`, str);
          });
        });
      });
    } catch (error) {
      this.emit('error', error);
      throw error;
    }
  }

  private handleDisconnect() {
      this.isConnected = false;
      this.health.isConnected = false;
      this.channel = null;
      this.process = null;
      logger.warn(this.nodeName, `Agent disconnected. Health: ${JSON.stringify(this.health)}`);
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
             logger.error(this.nodeName, `Invalid JSON error: ${errorMsg}`);
             logger.error(this.nodeName, `Invalid JSON content (first 200 chars): ${msgStr.substring(0, 200)}`);

             if (this.consecutiveParseErrors >= this.MAX_PARSE_ERRORS) {
                 logger.error(this.nodeName, `Too many consecutive parse errors (${this.consecutiveParseErrors}). Disconnecting for safety.`);
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
        logger.warn(this.nodeName, 'Not connected, attempting to reconnect...');
        try {
            await this.start();
        } catch (e) {  
            this.health.errorCount++;
            const msg = e instanceof Error ? e.message : String(e);
            this.health.lastError = `Reconnection failed: ${msg}`;
            logger.error(this.nodeName, 'Reconnection failed:', e);
            throw new Error(`Agent not connected: ${msg}`);
        }
    }

    const id = Math.random().toString(36).substring(7);
    const cmd = JSON.stringify({ id, action, payload: params });
    
    return new Promise((resolve, reject) => {
        // maintain pending map
        this.pendingRequests.set(id, { resolve, reject });
        
        // Timeout
        setTimeout(() => {
            if (this.pendingRequests.has(id)) {
                this.pendingRequests.delete(id);
                this.health.errorCount++;
                this.health.lastError = `Command timeout: ${action}`;
                logger.warn(this.nodeName, `Command timeout for '${action}' (id: ${id})`);
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
          logger.warn(this.nodeName, 'Failed to toggle monitoring:', e);
      }
  }

  public async setResourceMode(active: boolean): Promise<void> {
      if (!this.isConnected) return;
      try {
          await this.sendCommand('setResourceMode', { active });
      } catch (e) {
          logger.warn(this.nodeName, 'Failed to set resource mode:', e);
      }
  }

  private cleanupPending() {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for (const [id, req] of this.pendingRequests) {
          req.reject(new Error('Agent disconnected'));
      }
      this.pendingRequests.clear();
  }
}

import { EventEmitter } from 'events';
import { SSHConnectionPool } from '../ssh/pool';
import fs from 'fs';
import path from 'path';
import { ClientChannel } from 'ssh2';
import { spawn, ChildProcess } from 'child_process';
import { listNodes } from '../nodes';

// Cache the agent script content
let AGENT_SCRIPT_B64: string = '';

function getAgentScript() {
  if (!AGENT_SCRIPT_B64) {
    // Determine path. In Next.js prod, this might need adjustment or bundling.
    // For now, assume process.cwd() is project root.
    const p = path.join(process.cwd(), 'src/lib/agent/agent.py');
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

export class AgentHandler extends EventEmitter {
  private nodeName: string;
  private channel: ClientChannel | null = null;
  private process: ChildProcess | null = null;
  private buffer: string = '';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private pendingRequests: Map<string, { resolve: (val: any) => void; reject: (err: any) => void }> = new Map();
  private isConnected: boolean = false;

  constructor(nodeName: string) {
    super();
    this.nodeName = nodeName;
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
    } catch (e) {
        // Fallback for implicit Local
        if (this.nodeName === 'Local') useLocalSpawn = true;
    }

    if (useLocalSpawn) {
        this.startLocal();
    } else {
        await this.startSSH();
    }
  }

  private startLocal() {
    try {
        const script = getAgentScript();
        const args = ['-u', '-c', `import base64, sys; exec(base64.b64decode("${script}"))`];
        const child = spawn('python3', args);

        this.process = child;
        this.isConnected = true;
        this.emit('connected');

        child.stdout.on('data', (data) => this.handleData(data));
        child.stderr.on('data', (data) => {
             console.error(`[Agent:Local STDERR] ${data.toString()}`);
        });
        
        child.on('close', (code) => {
            console.log(`[Agent:Local] Closed. Code: ${code}`);
            this.handleDisconnect();
        });
        
        child.on('error', (err) => {
            console.error('[Agent:Local] Spawn Error:', err);
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
            console.log(`[Agent:${this.nodeName}] Closed. Code: ${code}`);
            this.handleDisconnect();
          });

          stream.on('data', (data: Buffer) => this.handleData(data));
          stream.stderr.on('data', (data: Buffer) => {
              console.error(`[Agent:${this.nodeName} STDERR] ${data.toString()}`);
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
      this.channel = null;
      this.process = null;
      this.emit('disconnected');
      this.cleanupPending();
  }

  private handleData(data: Buffer) {
    this.buffer += data.toString();
    
    // Process line by line
    let newlineIndex: number;
    while ((newlineIndex = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      
      if (line) {
        try {
          const msg = JSON.parse(line);
          this.processMessage(msg);
        } catch (e) {
             // Ignoring lint for 'e' to match eslint config for unused vars in catch blocks if necessary
             console.error(`[Agent:${this.nodeName}] Invalid JSON: ${line}`);
        }
      }
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
        console.log(`[Agent:${this.nodeName}] Not connected, attempting to reconnect...`);
        try {
            await this.start();
        } catch (e) {  
            console.error(`[Agent:${this.nodeName}] Reconnection failed:`, e);
            throw new Error(`Agent not connected: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    const id = Math.random().toString(36).substring(7);
    const cmd = JSON.stringify({ id, action, ...params });
    
    return new Promise((resolve, reject) => {
        // maintain pending map
        this.pendingRequests.set(id, { resolve, reject });
        
        // Timeout
        setTimeout(() => {
            if (this.pendingRequests.has(id)) {
                this.pendingRequests.delete(id);
                reject(new Error('Agent request timeout'));
            }
        }, 10000);

        const payload = cmd + '\n';
        if (this.process && this.process.stdin) {
            this.process.stdin.write(payload);
        } else if (this.channel) {
            this.channel.write(payload);
        } else {
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

  private cleanupPending() {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for (const [id, req] of this.pendingRequests) {
          req.reject(new Error('Agent disconnected'));
      }
      this.pendingRequests.clear();
  }
}

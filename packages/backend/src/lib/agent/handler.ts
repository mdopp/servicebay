import { EventEmitter } from 'events';
import { SSHConnectionPool } from '../ssh/pool';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { ClientChannel } from 'ssh2';
import { logger } from '@/lib/logger';
import { getConfig } from '@/lib/config';
import { AgentTimeoutError } from '@/lib/util/domainError';

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

/**
 * Inline-script sentinels that the bundler substitutes when reading
 * the agent source. Each entry pairs the `@@NAME@@` placeholder used
 * inside agent.py with the relative path to the file whose contents
 * should replace it (#723).
 *
 * Add a new entry whenever a shell or sub-script gets extracted into
 * `src/lib/agent/v4/scripts/`. The sentinel keeps the embedded script
 * editable + lintable as a real file while preserving the single-
 * file delivery contract (we still ship one Python blob; the inlining
 * happens once at server startup before base64-encoding).
 */
const AGENT_SCRIPT_INLINES: Array<{ sentinel: string; relativePath: string }> = [
  { sentinel: '@@NGINX_INSPECTOR_SCRIPT@@', relativePath: 'src/lib/agent/v4/scripts/nginx_inspector.sh' },
];

function inlineAgentScripts(agentSource: string): string {
  let out = agentSource;
  for (const { sentinel, relativePath } of AGENT_SCRIPT_INLINES) {
    if (!out.includes(sentinel)) continue;
    const scriptPath = path.join(process.cwd(), relativePath);
    const scriptContent = fs.readFileSync(scriptPath, 'utf-8');
    // Match the full `r"""<sentinel>"""` Python wrapper, not the
    // bare sentinel. The bare token shows up in comments too
    // (e.g. `# substitutes into the @@SENTINEL@@ below…`), and a
    // bare-string replace would inline the script there as well —
    // turning the comment's remainder into raw shell that crashes
    // Python with `SyntaxError: invalid syntax`. Matching
    // `r"""…"""` means we only ever substitute inside the actual
    // string literal.
    //
    // `replaceAll(string, string)` would interpret `$&` / `$$` / `$<n>`
    // in the replacement — shell scripts contain `$1`, `$file`,
    // `$(...)` everywhere, so we'd corrupt the contents. The
    // callback form bypasses that substitution: the inserted text
    // is verbatim regardless of `$` characters in it.
    const escaped = sentinel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`r"""${escaped}"""`, 'g');
    out = out.replace(pattern, () => `r"""${scriptContent}"""`);
  }
  return out;
}

function getAgentScript() {
  if (!AGENT_SCRIPT_B64) {
    // Determine path. In Next.js prod, this might need adjustment or bundling.
    // For now, assume process.cwd() is project root.
    // V4 Update: Point to new agent script
    const p = path.join(process.cwd(), 'src/lib/agent/v4/agent.py');
    const content = fs.readFileSync(p, 'utf-8');
    const inlined = inlineAgentScripts(content);
    // gzip-then-base64 before stuffing into the SSH command. The agent
    // script is ~100 kB; raw base64 is ~132 kB which exceeds Linux's
    // `MAX_ARG_STRLEN` (PAGE_SIZE * 32 = 128 kB per single argv string)
    // and the remote `/bin/bash -c "<cmd>"` invocation dies with
    // `Argument list too long` before the agent ever runs. Adding
    // `nginx_inspector.sh` inline in #750 was what pushed us over the
    // edge. Gzip brings the wire payload to ~36 kB. Decompressed
    // server-side by the Python `gzip.decompress` matching the
    // `python3 -u -c 'import gzip,base64; exec(gzip.decompress(
    // base64.b64decode("…")))'` in `startSSH`.
    AGENT_SCRIPT_B64 = zlib.gzipSync(Buffer.from(inlined)).toString('base64');
  }
  return AGENT_SCRIPT_B64;
}

export interface AgentEvent {
  type: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload: any;
}

export interface PullProgressEvent {
  pull_id: string;
  image: string;
  id: string;         // layer id
  status: string;     // "Downloading" | "Extracting" | "Pull complete" | etc.
  stream?: string;
  current?: number;
  total?: number;
}

export interface AgentHealth {
  nodeName: string;
  isConnected: boolean;
  lastSync: number; // timestamp
  messageCount: number;
  /**
   * Errors observed *after* the agent finishes its bootstrap window
   * (~60 s post-connect). These are the ones the operator should
   * actually pay attention to.
   */
  errorCount: number;
  /**
   * Errors observed during the agent bootstrap window — typically
   * `python3: command not found` while FCoS first-boot install-python
   * is still running, RAID-setup unit content captured on stderr by
   * `tee`, and the first connect/disconnect churn before the agent's
   * state machine settles. Tracked separately so the user-visible
   * `Errs:` counter stays at 0 on a healthy install instead of
   * inflating to ~40+ purely from first-boot noise.
   */
  bootstrapErrorCount?: number;
  lastError?: string;
  runId?: string;
  sessionId?: string;
}

/**
 * How long after the agent starts to treat errors as "bootstrap noise"
 * rather than real failures. Covers the FCoS install-python.service
 * race, the RAID-setup unit content that comes through on stderr, and
 * the first reconnect churn before the agent settles.
 */
const BOOTSTRAP_WINDOW_MS = 60 * 1000;

const SECRET_KEY_RE = /(TOKEN|SECRET|PASSWORD|API_KEY)/i;

/**
 * Redact secret material from a command payload before it is logged.
 *
 * The rendered pod YAML shipped to the agent via `write_file` carries
 * plaintext `env` secrets (HERMES_TOKEN, …); logging the payload verbatim
 * leaked live credentials into the journal (#1211). Replace any `content`
 * blob with a size marker and mask the value of any secret-looking key.
 */
export function redactCommandPayloadForLog(params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (key === 'content' && typeof value === 'string') {
      out[key] = `<${value.length} chars redacted>`;
    } else if (SECRET_KEY_RE.test(key) && typeof value === 'string') {
      out[key] = '***';
    } else {
      out[key] = value;
    }
  }
  return out;
}

export class AgentHandler extends EventEmitter {
  public nodeName: string;
  private channel: ClientChannel | null = null;
  private buffer: Buffer = Buffer.alloc(0);
  private logBuffer: string = '';
    private isStarting = false;
    private startPromise: Promise<void> | null = null;
    private currentRunId?: string;
    /** Wall-clock when the current run's bootstrap window started.
     *  0 means "not yet connected on this run". */
    private bootstrapWindowStart = 0;
  /* eslint-disable @typescript-eslint/no-explicit-any */
  private pendingRequests: Map<string, {
      resolve: (val: any) => void;
      reject: (err: any) => void;
      onChunk?: (line: string) => void;
  }> = new Map();
  /* eslint-enable @typescript-eslint/no-explicit-any */
  private isConnected: boolean = false;
  private consecutiveParseErrors = 0;
  private readonly MAX_PARSE_ERRORS = 5;
  private deferredCommands: Array<() => void> = [];

  // Health tracking
  private health: AgentHealth = {
    nodeName: '',
    isConnected: false,
    lastSync: 0,
    messageCount: 0,
    errorCount: 0,
    bootstrapErrorCount: 0,
  };

  /** True iff we're inside the post-connect bootstrap window — errors
   *  observed during this period are tagged as bootstrap noise rather
   *  than visible failures. See BOOTSTRAP_WINDOW_MS. */
  private inBootstrapWindow(): boolean {
    return this.bootstrapWindowStart > 0
      && Date.now() - this.bootstrapWindowStart < BOOTSTRAP_WINDOW_MS;
  }

  /** Bump errorCount or bootstrapErrorCount depending on which window
   *  we're in. Called from every site that previously did
   *  `this.health.errorCount++` directly. */
  private bumpErrorCount(): void {
    if (this.inBootstrapWindow()) {
      this.health.bootstrapErrorCount = (this.health.bootstrapErrorCount ?? 0) + 1;
    } else {
      this.health.errorCount++;
    }
  }

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
      this.log('AgentHandler', 'info', `Starting SSH Agent for ${this.nodeName}...`);
      await this.startSSH(runId);
    })();

    this.startPromise = starter.finally(() => {
      this.isStarting = false;
      this.startPromise = null;
    });

    return this.startPromise;
  }

  private async startSSH(runId: string) {
    try {
      this.log(this.nodeName, 'info', 'Establishing SSH connection...');
      // Open the bootstrap window — errors observed during the next
      // ~60 s (FCoS install-python race, RAID-setup unit content on
      // stderr, first state-machine churn) are tagged as bootstrap
      // noise rather than visible failures.
      this.bootstrapWindowStart = Date.now();
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
      // Wait up to 90 s for python3 to appear before invoking it. Covers the
      // FCoS first-boot race where install-python.service hasn't finished
      // rpm-ostree-installing python3 by the time we SSH in. No-op (~0 ms)
      // when python3 is already on PATH, so safe for established installs.
      const waitForPython =
        'i=0; while ! command -v python3 >/dev/null 2>&1; do i=$((i+1)); ' +
        '[ $i -ge 90 ] && { echo "python3 not available after 90s" >&2; exit 127; }; ' +
        'sleep 1; done';
      // Decompress + decode server-side. Script is gzip+base64'd by
      // `getAgentScript()` to dodge Linux's 128 kB single-argv limit
      // (`MAX_ARG_STRLEN`). The historical `exec(base64.b64decode(…))`
      // worked while the script stayed under ~96 kB raw; #750 inlining
      // nginx_inspector.sh pushed it past the threshold.
      const cmd = `${envSetup}; ${waitForPython}; python3 -u -c 'import base64, gzip; exec(gzip.decompress(base64.b64decode("${script}")))'${sessionArg}`;

      return new Promise<void>((resolve, reject) => {
        conn.exec(cmd, (err, stream) => {
          if (err) {
              const errorMsg = `Failed to execute agent command on ${this.nodeName}: ${err.message}`;
              this.log(this.nodeName, 'error', errorMsg);
              this.health.lastError = errorMsg;
              this.bumpErrorCount();
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
          this.flushDeferredCommands();
          this.emit('connected');
          
          // Trigger a refresh on connect/reconnect so initialSyncComplete fires again for the twin (#894)
          void this.sendCommand('refresh', {}).catch(err => {
              this.log(this.nodeName, 'error', `Failed to send automatic refresh command on connect: ${err.message}`);
          });

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
      this.bumpErrorCount();
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
              this.bumpErrorCount();
              this.health.lastError = line;
              this.log(`Agent:${this.nodeName}`, 'error', line.replace(/.*\[ERROR\]\s*/, ''));
            } else if (line.includes('[DEBUG]')) {
              this.log(`Agent:${this.nodeName}`, 'debug', line.replace(/.*\[DEBUG\]\s*/, ''));
          } else {
              // Unclassified stderr (e.g. traceback, system tool output)
              this.bumpErrorCount();
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
             this.bumpErrorCount();
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

    // 1b. Streaming chunk for an in-flight exec_stream — forward to
    // the per-request onChunk callback if the caller registered one.
    if (msg.type === 'exec:chunk' && msg.payload && msg.payload.id) {
        const req = this.pendingRequests.get(msg.payload.id);
        if (req?.onChunk && typeof msg.payload.line === 'string') {
            try { req.onChunk(msg.payload.line); }
            catch (e) { this.log(this.nodeName, 'warn', 'onChunk handler threw:', e); }
        }
        // Don't fall through to the generic event emitter for chunks
        // — they're noisy and the only legitimate consumer is the
        // request that owns this id.
        return;
    }

    // 2. Generic Event
    this.emit('event', msg);
    // Also specific types
    if (msg.type) {
        this.emit(msg.type, msg.payload);
    }
  }

  /* eslint-disable @typescript-eslint/no-explicit-any */
  public async sendCommand(
      action: string,
      params: any = {},
      options: { timeoutMs?: number; onChunk?: (line: string) => void } = {},
  ): Promise<any> {
  /* eslint-enable @typescript-eslint/no-explicit-any */
    if (!this.isConnected) {
        // Single start() used to be enough, but install loops that
        // straddle a ServiceBay autoupdate or host reboot need to wait
        // out the reconnect window — otherwise the wizard fails every
        // service it tries during that ~10–30 s gap. Retry start() with
        // backoff for up to 30 s before giving up.
        this.log(this.nodeName, 'warn', 'Not connected, waiting for reconnect...');
        const deadline = Date.now() + 30_000;
        let attempt = 0;
        let lastErr: unknown = null;
        while (!this.isConnected) {
            try {
                await this.start();
                if (this.isConnected) break;
                lastErr = new Error('start() returned but agent still not connected');
            } catch (e) {
                lastErr = e;
            }
            attempt += 1;
            const remaining = deadline - Date.now();
            if (remaining <= 0) break;
            const wait = Math.min(2_000, Math.max(500, 250 * 2 ** attempt), remaining);
            await new Promise(r => setTimeout(r, wait));
        }
        if (!this.isConnected) {
            this.bumpErrorCount();
            const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
            this.health.lastError = `Reconnection failed: ${msg}`;
            this.log(this.nodeName, 'error', 'Reconnection failed after retries:', lastErr);
            throw new Error(`Agent not connected: ${msg}`);
        }
    }

    const id = Math.random().toString(36).substring(7);
    const cmd = JSON.stringify({ id, action, payload: params });
    const payloadPreview = (() => {
      if (!params || Object.keys(params).length === 0) return '{}';
      try {
        const serialized = JSON.stringify(redactCommandPayloadForLog(params));
        return serialized.length > 400 ? `${serialized.slice(0, 400)}…` : serialized;
      } catch {
        return '[unserializable payload]';
      }
    })();

    this.log(this.nodeName, 'info', `Sending command '${action}' (id: ${id}) payload: ${payloadPreview}`);
    
    return new Promise((resolve, reject) => {
        // maintain pending map. onChunk (when set) is invoked for each
        // exec:chunk event the agent emits with this id — used by
        // exec_stream callers (post-deploy scripts) so the wizard can
        // surface each line as it arrives instead of a 10-min void.
        this.pendingRequests.set(id, { resolve, reject, onChunk: options.onChunk });
        
        // Timeout (extendable per command; defaults to 30s).
        // 10s was too aggressive: a `systemctl start <pod>` for a fresh deploy
        // routinely takes 10–30s even with `--no-block`, and timeouts cascade
        // because subsequent commands queue behind the in-flight one through
        // the single SSH channel.
        const timeoutMs = options.timeoutMs ?? 30000;
        setTimeout(() => {
            if (this.pendingRequests.has(id)) {
                this.pendingRequests.delete(id);
                this.bumpErrorCount();
                this.health.lastError = `Command timeout: ${action}`;
                this.log(this.nodeName, 'warn', `Command timeout for '${action}' after ${timeoutMs}ms (id: ${id})`);
                reject(new AgentTimeoutError({ action, timeoutMs }));
            }
        }, timeoutMs);

        const payload = cmd + '\n';
        if (!this.channel) {
            this.bumpErrorCount();
            this.health.lastError = 'No active channel/process';
            reject(new Error('No active channel/process'));
            return;
        }
        try {
            const ok = this.channel.write(payload);
            if (ok === false && typeof this.channel.once === 'function') {
                // Backpressure: pause input until the agent stream drains.
                // We don't unblock the caller — they're already in the pending
                // map and will resolve when the agent replies. This guards the
                // local write buffer from growing unboundedly under bursts.
                this.channel.once('drain', () => { /* drained */ });
            }
        } catch (e) {
            this.pendingRequests.delete(id);
            this.bumpErrorCount();
            this.health.lastError = `channel.write failed: ${e instanceof Error ? e.message : String(e)}`;
            reject(e instanceof Error ? e : new Error(String(e)));
        }
    });
  }

    public async pullImage(image: string, onProgress?: (event: PullProgressEvent) => void): Promise<{ success: boolean }> {
      const pullId = `pull-${Date.now().toString(36)}-${Math.random().toString(36).slice(-4)}`;

      // Register temporary listener for PULL_PROGRESS events
      const handler = onProgress ? (payload: PullProgressEvent) => {
        if (payload?.pull_id === pullId) {
          onProgress(payload);
        }
      } : undefined;

      if (handler) {
        this.on('PULL_PROGRESS', handler);
      }

      try {
        // 60 min per image: cover slow internet (multi-GB pulls on a 5 Mbps
        // line) without giving up. The agent emits PULL_PROGRESS events every
        // 250 ms while bytes are flowing, so the UI sees forward motion;
        // we only fall over if the registry is genuinely unreachable.
        const result = await this.sendCommand('pull_image', { image, pull_id: pullId }, { timeoutMs: 3_600_000 });
        return result as { success: boolean };
      } finally {
        if (handler) {
          this.off('PULL_PROGRESS', handler);
        }
      }
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

  /**
   * Reboot the underlying node now (#1235). Distinct from `restart()`, which
   * only restarts the agent process, and from `set_boot_next_usb`, which
   * changes boot order. The reboot tears its own transport down, so we fire
   * the command and report which path was used rather than awaiting a reply
   * that will never arrive.
   *
   * Primary path is the agent's `exec` channel. When the agent process is
   * unreachable but the box itself is up — the recovery case the launcher
   * (#1231) needs — fall back to a direct SSH exec via the connection pool.
   */
  public async rebootNode(): Promise<{ via: 'agent' | 'ssh' }> {
      if (this.isConnected) {
          this.sendCommand('exec', { command: 'sudo -n systemctl reboot' })
              .catch(() => { /* connection drop mid-reboot is expected */ });
          this.log(this.nodeName, 'info', 'Reboot initiated via agent exec.');
          return { via: 'agent' };
      }
      this.log(this.nodeName, 'warn', 'Agent not connected; rebooting via direct SSH.');
      await this.rebootViaSsh();
      return { via: 'ssh' };
  }

  private async rebootViaSsh(): Promise<void> {
      const conn = await SSHConnectionPool.getInstance().getConnection(this.nodeName);
      await new Promise<void>((resolve, reject) => {
          conn.exec('sudo -n systemctl reboot', (err, stream) => {
              if (err) { reject(err); return; }
              // The reboot drops the link, so resolve on close/error rather
              // than waiting for a clean exit, with a short timeout so a stuck
              // channel can't hang the caller.
              const done = () => resolve();
              stream.on('close', done);
              stream.on('error', done);
              setTimeout(done, 5000);
          });
      });
  }

  public disconnect() {
      if (this.channel) {
          this.channel.close(); // sends EOF
      }
  }
  
  public async setMonitoring(enabled: boolean): Promise<void> {
      if (!this.isConnected) {
          this.deferredCommands.push(() => { this.setMonitoring(enabled); });
          return;
      }
      try {
          await this.sendCommand(enabled ? 'startMonitoring' : 'stopMonitoring');
      } catch (e) {
          this.log(this.nodeName, 'warn', 'Failed to toggle monitoring:', e);
      }
  }

  public async setResourceMode(active: boolean): Promise<void> {
      if (!this.isConnected) {
          this.deferredCommands.push(() => { this.setResourceMode(active); });
          return;
      }
      try {
          await this.sendCommand('setResourceMode', { active });
      } catch (e) {
          this.log(this.nodeName, 'warn', 'Failed to set resource mode:', e);
      }
  }

  private flushDeferredCommands() {
      const commands = this.deferredCommands.splice(0);
      for (const cmd of commands) {
          cmd();
      }
  }

  private cleanupPending() {
      for (const [, req] of this.pendingRequests) {
          req.reject(new Error('Agent disconnected'));
      }
      this.pendingRequests.clear();
      this.deferredCommands = [];
  }
}

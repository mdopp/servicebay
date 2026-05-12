import type { Server, Socket } from 'socket.io';
import * as pty from 'node-pty';
import os from 'os';
import fs from 'fs';
import { listNodes } from '../nodes';
import { logger } from '../logger';

interface PtySession {
  process: pty.IPty;
  history: HistoryBuffer;
  lastActive: number;
}

interface HistoryBuffer {
  append(s: string): void;
  toString(): string;
}

interface PtySpec {
  shell: string;
  args: string[];
  fallbackWarning: string;
}

const PTY_INACTIVITY_MS = 1000 * 60 * 5;
const PTY_SWEEP_INTERVAL_MS = 60_000;

export interface SessionManagerOptions {
  io: Server;
  /** Upper bound on retained scrollback per session (in chars). */
  historyBytes?: number;
  /** Factory for the bounded buffer. Falls back to a substring-shift impl. */
  createHistory?: (bytes: number) => HistoryBuffer;
}

class StringHistoryBuffer implements HistoryBuffer {
  private buf = '';
  constructor(private readonly cap: number) {}
  append(s: string): void {
    if (!s) return;
    this.buf += s;
    if (this.buf.length > this.cap) {
      this.buf = this.buf.substring(this.buf.length - this.cap);
    }
  }
  toString(): string { return this.buf; }
}

const DEFAULT_HISTORY_BYTES = 100_000;

export class TerminalSessionManager {
  private readonly sessions = new Map<string, PtySession>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly options: SessionManagerOptions) {}

  start() {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => this.sweep(), PTY_SWEEP_INTERVAL_MS);
    this.options.io.on('connection', socket => this.bind(socket));
    // Pre-spawn the host PTY so first-open is instant. Best-effort.
    this.ensure('host').catch(err => logger.error('Server', 'ensurePty(host) failed', err));
  }

  stop() {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    for (const [id, session] of this.sessions.entries()) {
      try { session.process.kill(); } catch { /* ignore */ }
      this.sessions.delete(id);
    }
  }

  /** Number of live sessions — exposed for tests and shutdown logic. */
  get size(): number { return this.sessions.size; }

  private bind(socket: Socket) {
    socket.on('join', async (payload: string | { id: string; cols?: number; rows?: number }) => {
      let id: string;
      let cols = 80;
      let rows = 30;
      if (typeof payload === 'string') {
        id = payload;
      } else {
        id = payload.id;
        cols = payload.cols || 80;
        rows = payload.rows || 30;
      }
      logger.info('Server', `Client joining terminal ${id} with dims ${cols}x${rows}`);
      socket.join(id);
      try {
        const session = await this.ensure(id, cols, rows);
        socket.emit('history', session.history.toString());
      } catch (e) {
        logger.error('Server', 'Failed to join terminal:', e);
        socket.emit('output', '\r\n\x1b[31m>>> Failed to join terminal session.\x1b[0m\r\n');
      }
    });

    socket.on('input', ({ id, data }: { id: string; data: string }) => {
      const session = this.sessions.get(id);
      if (session) {
        session.process.write(data);
        session.lastActive = Date.now();
      }
    });

    socket.on('resize', ({ id, cols, rows }: { id: string; cols: number; rows: number }) => {
      const session = this.sessions.get(id);
      if (session) {
        session.process.resize(cols, rows);
      }
    });
  }

  private async ensure(id: string, cols = 80, rows = 30): Promise<PtySession> {
    const existing = this.sessions.get(id);
    if (existing) {
      if (cols > 0 && rows > 0) {
        try { existing.process.resize(cols, rows); }
        catch (e) { logger.error('Server', `Error resizing existing session ${id}:`, e); }
      }
      return existing;
    }

    const spec = await resolvePtySpec(id);
    logger.info('Server', `Spawning PTY: ${spec.shell} ${spec.args.join(' ')}`);

    const cwd = resolveHomeDir();
    const ptyProcess = pty.spawn(spec.shell, spec.args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      env: { ...process.env, TERM: 'xterm-256color' } as any,
    });
    logger.info('Server', `Spawned new PTY process for ${id} (PID: ${ptyProcess.pid})`);

    const cap = this.options.historyBytes ?? DEFAULT_HISTORY_BYTES;
    const factory = this.options.createHistory ?? ((bytes) => new StringHistoryBuffer(bytes));
    const history = factory(cap);
    history.append(`\r\n\x1b[32m>>> Connected to terminal session: ${id}\x1b[0m\r\n${spec.fallbackWarning}`);
    const session: PtySession = { process: ptyProcess, history, lastActive: Date.now() };
    this.sessions.set(id, session);

    ptyProcess.onData(data => {
      session.history.append(data);
      session.lastActive = Date.now();
      this.options.io.to(id).emit('output', data);
    });

    ptyProcess.onExit(e => {
      logger.info('Server', `PTY process ${id} exited with code ${e.exitCode}`);
      this.options.io.to(id).emit('output', `\r\n\x1b[31m>>> Session exited with code ${e.exitCode}\x1b[0m\r\n`);
      this.sessions.delete(id);
    });

    return session;
  }

  private sweep() {
    const now = Date.now();
    for (const [id, session] of this.sessions.entries()) {
      if (id === 'host') continue;
      if (now - session.lastActive <= PTY_INACTIVITY_MS) continue;
      logger.info('Server', `Killing inactive session ${id}`);
      try { session.process.kill(); } catch { /* ignore */ }
      this.sessions.delete(id);
    }
  }
}

function resolveHomeDir(): string {
  const home = process.env.HOME;
  try {
    if (!home || !fs.existsSync(home)) {
      logger.warn('Server', `Home directory ${home} invalid or missing. Defaulting terminal CWD to /`);
      return '/';
    }
    return home;
  } catch {
    return '/';
  }
}

export async function resolvePtySpec(id: string): Promise<PtySpec> {
  const defaultShell = os.platform() === 'win32' ? 'powershell.exe' : (process.env.SHELL || 'bash');

  if (id.startsWith('container:')) {
    const parts = id.split(':');
    const nodeName = parts.length === 3 ? parts[1] : 'local';
    const containerId = parts.length === 3 ? parts[2] : parts[1];
    if (!containerId) {
      throw new Error('Invalid container ID');
    }

    // Always try to resolve the node (incl. `local` → `Local`) and route via
    // SSH when the node has an ssh:// URI. In container-mode installs every
    // node — including `Local` (`ssh://core@127.0.0.1`) — is reached via SSH
    // because the ServiceBay container deliberately ships without the podman
    // CLI (see Dockerfile: "Removed podman and systemd - agent uses SSH to
    // execute commands on host"). Before this, `container:local:<id>` skipped
    // the SSH branch and tried to spawn `podman` directly inside the
    // ServiceBay container — failing with `execvp(3) failed.: No such file or
    // directory`.
    const nodeKey = nodeName === 'local' ? 'Local' : nodeName;
    try {
      const nodes = await listNodes();
      const node = nodes.find(n => n.Name === nodeKey);
      if (node) {
        const uri = new URL(node.URI);
        if (uri.protocol === 'ssh:') {
          const args: string[] = [];
          if (node.Identity) args.push('-i', node.Identity);
          if (uri.port) args.push('-p', uri.port);
          args.push('-o', 'StrictHostKeyChecking=no');
          args.push('-o', 'UserKnownHostsFile=/dev/null');
          args.push('-t');
          args.push(`${uri.username}@${uri.hostname}`);
          args.push(`podman exec -it -e TERM=xterm-256color ${containerId} sh -c 'if [ -x /bin/bash ]; then exec /bin/bash; else exec /bin/sh; fi'`);
          return { shell: 'ssh', args, fallbackWarning: '' };
        }
      }
    } catch (e) {
      logger.error('Server', `Failed to setup container terminal for ${nodeKey}:`, e);
    }

    // Bare-metal install path: ServiceBay runs on the host with the podman CLI
    // in PATH. Container-mode installs don't reach this — see the SSH branch
    // above. Kept so a hypothetical `node:` install (or a future packaged
    // binary) still works without a per-node SSH config entry.
    return {
      shell: 'podman',
      args: ['exec', '-it', '-e', 'TERM=xterm-256color', containerId, 'sh', '-c', 'if [ -x /bin/bash ]; then exec /bin/bash; else exec /bin/sh; fi'],
      fallbackWarning: '',
    };
  }

  if (id === 'host' || id.startsWith('node:')) {
    const nodeName = id === 'host' ? 'Local' : id.split(':')[1];
    let nodeResolved = false;
    let shell = defaultShell;
    let args: string[] = [];
    try {
      const nodes = await listNodes();
      const node = nodes.find(n => n.Name === nodeName);
      if (node) {
        const uri = new URL(node.URI);
        if (uri.protocol === 'ssh:') {
          shell = 'ssh';
          args = [];
          if (node.Identity) args.push('-i', node.Identity);
          if (uri.port) args.push('-p', uri.port);
          args.push('-o', 'StrictHostKeyChecking=no');
          args.push('-o', 'UserKnownHostsFile=/dev/null');
          args.push(`${uri.username}@${uri.hostname}`);
          nodeResolved = true;
        }
      } else {
        logger.warn('Server', `Node "${nodeName}" not found. Available nodes: ${nodes.map(n => n.Name).join(', ') || '(none)'}`);
      }
    } catch (e) {
      logger.error('Server', 'Failed to resolve node connection', e);
    }
    if (nodeResolved) {
      return { shell, args, fallbackWarning: '' };
    }
    const fallbackWarning = `\x1b[33m⚠ WARNING: Could not connect to node "${nodeName}" via SSH. Falling back to container shell.\x1b[0m\r\n\x1b[33m  This is the ServiceBay container, not the host system. Check your node configuration.\x1b[0m\r\n\r\n`;
    logger.warn('Server', `Terminal fallback to container shell for "${id}" – node "${nodeName}" could not be resolved`);
    return { shell: defaultShell, args: [], fallbackWarning };
  }

  return { shell: defaultShell, args: [], fallbackWarning: '' };
}

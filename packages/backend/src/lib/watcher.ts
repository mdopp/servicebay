
import fs from 'fs';
import path from 'path';
import os from 'os';
import { EventEmitter } from 'events';
import { SSHConnectionPool } from './ssh/pool';
import { listNodes, PodmanConnection } from './nodes';

const SYSTEMD_DIR = path.join(os.homedir(), '.config/containers/systemd');

// Singleton to prevent duplicate watchers across module reloads
declare global {
   
  var __serviceBayWatcher: ServiceWatcher | undefined;
}

class ServiceWatcher extends EventEmitter {
  private isWatching = false;
  private podmanWatcherActive = false;
  private restartTimer: NodeJS.Timeout | null = null;

  constructor() {
    super();
    this.start();
  }

  public start() {
    if (this.isWatching) return;
    this.isWatching = true;

    console.log('[Watcher] Starting monitoring...');

    // 1. Watch File System
    try {
      if (!fs.existsSync(SYSTEMD_DIR)) {
        fs.mkdirSync(SYSTEMD_DIR, { recursive: true });
      }
      
      fs.watch(SYSTEMD_DIR, (eventType, filename) => {
        if (filename && (filename.endsWith('.kube') || filename.endsWith('.yml') || filename.endsWith('.yaml'))) {
          console.log(`[Watcher] File changed: ${filename}`);
          this.emit('change', { type: 'config', message: `Config changed: ${filename}` });
        }
      });
    } catch (e) {
      console.error('[Watcher] Failed to watch directory:', e);
    }

    // 2. Watch Podman Events
    void this.startPodmanWatcher();
  }

  private async startPodmanWatcher() {
    if (this.podmanWatcherActive || !this.isWatching) return;

    try {
      await this.startRemotePodmanWatcher();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[Watcher] Podman watcher unavailable via SSH: ${message}`);
      this.podmanWatcherActive = false;
      this.scheduleWatcherRestart();
    }
  }

  private async resolveDefaultNode(): Promise<PodmanConnection | null> {
    try {
      const nodes = await listNodes();
      if (!nodes.length) return null;
      return nodes.find((n) => n.Default) || nodes[0];
    } catch (error) {
      console.error('[Watcher] Failed to read nodes.json:', error);
      return null;
    }
  }

  private async startRemotePodmanWatcher(): Promise<void> {
    const node = await this.resolveDefaultNode();
    if (!node) {
      throw new Error('No nodes configured');
    }
    if (node.URI === 'local') {
      throw new Error(`Node ${node.Name} still uses the legacy 'local' URI. Edit the node to use ssh://user@host`);
    }

    const pool = SSHConnectionPool.getInstance();
    const conn = await pool.getConnection(node.Name);

    await new Promise<void>((resolve, reject) => {
      conn.exec('podman events --format json --filter type=container', (err, stream) => {
        if (err || !stream) {
          reject(err || new Error('Failed to open remote stream'));
          return;
        }

        this.podmanWatcherActive = true;
        console.log(`[Watcher] Monitoring Podman events via SSH node ${node.Name}`);

        stream.on('data', (data: Buffer) => this.processPodmanChunk(node.Name, data));
        stream.stderr.on('data', (data: Buffer) => {
          console.error(`[Watcher][${node.Name}] Podman stderr: ${data}`);
        });

        stream.on('close', (code: number) => {
          console.log(`[Watcher] Remote Podman watcher closed for ${node.Name} (code=${code})`);
          this.podmanWatcherActive = false;
          this.scheduleWatcherRestart();
        });

        stream.on('error', (errorStream: Error) => {
          console.error(`[Watcher] Remote Podman watcher error (${node.Name}):`, errorStream);
          this.podmanWatcherActive = false;
          this.scheduleWatcherRestart();
        });

        resolve();
      });
    });
  }

  // Crash-looping containers can emit a `start` (or pair of `start`/`die`)
  // every ~50 ms, which floods the journal with hundreds of identical
  // [Watcher] log lines per second. Coalesce by (status, name) over a
  // short window: log the first event immediately, then suppress duplicates
  // and emit a single summary line at the end of the window.
  private readonly EVENT_COALESCE_MS = 5000;
  private eventCounts = new Map<string, number>();
  private eventFlushTimers = new Map<string, NodeJS.Timeout>();

  private processPodmanChunk(source: string, data: Buffer) {
    const lines = data.toString().split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (['start', 'stop', 'die', 'remove', 'create'].includes(event.Status)) {
          const key = `${source}|${event.Status}|${event.Name}`;
          const count = (this.eventCounts.get(key) ?? 0) + 1;
          this.eventCounts.set(key, count);

          // First occurrence in the window: log + emit immediately.
          if (count === 1) {
            console.log(`[Watcher] Podman event (${source}): ${event.Status} on ${event.Name}`);
            this.emit('change', { type: 'container', message: `Container ${event.Name} ${event.Status}` });

            const timer = setTimeout(() => {
              const total = this.eventCounts.get(key) ?? 1;
              this.eventCounts.delete(key);
              this.eventFlushTimers.delete(key);
              if (total > 1) {
                console.log(`[Watcher] Podman event (${source}): ${event.Status} on ${event.Name} ×${total} (coalesced over ${this.EVENT_COALESCE_MS / 1000}s)`);
              }
            }, this.EVENT_COALESCE_MS);
            this.eventFlushTimers.set(key, timer);
          }
          // Subsequent occurrences in the window are silently counted; the
          // flush timer above logs the total and re-emits a single change
          // event downstream consumers can act on.
        }
      } catch {
        // Ignore parse errors
      }
    }
  }

  private scheduleWatcherRestart() {
    if (!this.isWatching || this.restartTimer) return;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.startPodmanWatcher();
    }, 5000);
  }
}

// Ensure singleton
if (!global.__serviceBayWatcher) {
  global.__serviceBayWatcher = new ServiceWatcher();
}
const watcher = global.__serviceBayWatcher;

export default watcher;

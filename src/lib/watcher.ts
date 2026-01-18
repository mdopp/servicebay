
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn, spawnSync, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';

const SYSTEMD_DIR = path.join(os.homedir(), '.config/containers/systemd');
const PODMAN_EVENT_PATTERNS = [
  'podman events --format json --filter type=container',
  'podman events --format json'
];

let hasCleanedOrphanedPodmanWatchers = false;

const cleanupOrphanedPodmanWatchers = () => {
  if (hasCleanedOrphanedPodmanWatchers) return;
  hasCleanedOrphanedPodmanWatchers = true;

  if (process.platform === 'win32') return;

  PODMAN_EVENT_PATTERNS.forEach(pattern => {
    try {
      const result = spawnSync('pkill', ['-TERM', '-f', pattern], { stdio: 'ignore' });
      if (result.status === 0) {
        console.log(`[Watcher] Cleaned leftover Podman watcher (${pattern})`);
      }
    } catch (error) {
      // Ignore missing pkill binaries but surface other issues for troubleshooting
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error(`[Watcher] Failed to clean Podman watchers for pattern "${pattern}":`, error);
      }
    }
  });
};

// Singleton to manage event emitters across hot reloads in dev
declare global {
   
  var __serviceBayWatcher: ServiceWatcher | undefined;
}

class ServiceWatcher extends EventEmitter {
  private podmanProcess: ChildProcess | null = null;
  private isWatching = false;

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
    this.startPodmanWatcher();
  }

  private startPodmanWatcher() {
    cleanupOrphanedPodmanWatchers();

    // Monitor container events to detect starts, stops, failures
    this.podmanProcess = spawn('podman', ['events', '--format', 'json', '--filter', 'type=container']);

    if (this.podmanProcess.stdout) {
        this.podmanProcess.stdout.on('data', (data: Buffer) => {
        const lines = data.toString().split('\n');
        for (const line of lines) {
            if (!line.trim()) continue;
            try {
            const event = JSON.parse(line);
            // event.Status can be: create, init, start, kill, die, stop, remove, ...
            // We are interested in anything that changes state
            if (['start', 'stop', 'die', 'remove', 'create'].includes(event.Status)) {
                console.log(`[Watcher] Podman event: ${event.Status} on ${event.Name}`);
                this.emit('change', { type: 'container', message: `Container ${event.Name} ${event.Status}` });
            }
            } catch {
            // Ignore parse errors
            }
        }
        });
    }

    if (this.podmanProcess.stderr) {
        this.podmanProcess.stderr.on('data', (data: Buffer) => {
            console.error(`[Watcher] Podman stderr: ${data}`);
        });
    }

    this.podmanProcess.on('close', (code: number) => {
      console.log(`[Watcher] Podman events exited with code ${code}`);
      this.isWatching = false;
      // Retry after delay if it crashed
      setTimeout(() => {
          if (!this.isWatching) this.startPodmanWatcher();
      }, 5000);
    });
  }
}

// Ensure singleton
if (!global.__serviceBayWatcher) {
  global.__serviceBayWatcher = new ServiceWatcher();
}
const watcher = global.__serviceBayWatcher;

export default watcher;

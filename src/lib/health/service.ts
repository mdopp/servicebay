import { Server } from 'socket.io';
import fs from 'fs';
import path from 'path';
import { logger } from '@/lib/logger';
import { HealthStore } from './store';
import { CheckRunner } from './runner';
import { CheckConfig, CheckResult } from './types';
import { initializeDefaultChecks } from './init';
import { sendEmailAlert } from '@/lib/email';
import { NotificationBatcher } from './notificationBatcher';
import { DATA_DIR } from '@/lib/dirs';

// In-memory interval tracking
const intervals = new Map<string, NodeJS.Timeout>();

const CHECKS_FILE = path.join(DATA_DIR, 'checks.json');

export class HealthService {
  private static io: Server | null = null;

  static async init(io: Server) {
    this.io = io;

    // 1. Ensure defaults
    await initializeDefaultChecks();

    // 1a. Service-health poller (#626 / Phase 3A). Discovers deployed
    //     services that ship a `servicebay.healthcheck` annotation and
    //     registers each with the continuous poller. Result lands on
    //     `ServiceUnit.health` in the digital twin — the single source
    //     of truth Phase 3B migrates `settleWait`, diagnose probes, and
    //     per-template `wait_for_X` helpers onto.
    //
    //     Best-effort: a discovery failure on one service doesn't block
    //     boot, and the periodic agent sync will eventually pick up new
    //     services. Phase 3B replaces this one-shot bootstrap with
    //     capability-bus hooks on deploy/wipe.
    try {
      const { bootstrapServiceHealth } = await import('./serviceHealthBootstrap');
      await bootstrapServiceHealth('Local');
    } catch (e) {
      logger.warn('Health', `Service-health bootstrap failed: ${e instanceof Error ? e.message : String(e)}. Probes will be available after next restart.`);
    }

    // 1b. Open the boot-grace email-batch window. Health checks
    //     that flip ok → fail during the first 10 min after boot
    //     (or until events settle for 90 s, whichever comes first)
    //     are coalesced into one digest email instead of spamming
    //     the operator with N "service down" notifications during
    //     the cold-start race. See NotificationBatcher for the
    //     coalescing rules.
    NotificationBatcher.start();

    // 2. Start initial scheduling
    this.restartAll();

    // 3. Re-schedule whenever the checks file changes on disk.
    //
    // The previous design used an in-process listener on HealthStore,
    // which worked for code paths that shared this module instance — but
    // Next.js bundles API routes (and the wizard's ServiceManager
    // auto-add path) into a webpack graph that's separate from the
    // custom server's esbuild bundle. saveCheck calls from there
    // landed on a *different* `listeners[]` array, so the listener
    // never fired and the new checks sat dormant with lastResult=null.
    //
    // fs.watch is bundle-agnostic: any process that mutates the file
    // triggers our restart, regardless of which module wrote it. We
    // debounce because a single saveCheck typically emits two `change`
    // events on Linux (one for each step of an atomic-ish replace).
    this.startChecksFileWatcher();
  }

  private static checksWatcher: fs.FSWatcher | null = null;
  private static checksWatcherDebounce: NodeJS.Timeout | null = null;

  private static startChecksFileWatcher() {
    if (this.checksWatcher) return;
    try {
      // Make sure the file's parent dir exists; fs.watch on a missing
      // path throws synchronously.
      try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch { /* ok */ }
      this.checksWatcher = fs.watch(DATA_DIR, (_event, filename) => {
        if (filename !== 'checks.json') return;
        if (this.checksWatcherDebounce) clearTimeout(this.checksWatcherDebounce);
        this.checksWatcherDebounce = setTimeout(() => {
          this.checksWatcherDebounce = null;
          logger.info('Health', 'checks.json changed — re-scheduling.');
          this.restartAll();
        }, 250);
      });
      this.checksWatcher.on('error', (e) => {
        logger.warn('Health', `checks.json watcher error: ${e instanceof Error ? e.message : String(e)}`);
      });
      logger.info('Health', `Watching ${CHECKS_FILE} for new/changed checks.`);
    } catch (e) {
      logger.warn('Health', `Could not start checks.json watcher: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  static getChecks() {
      return HealthStore.getChecks();
  }

  static restartAll() {
    // Clear existing
    this.stopAll();

    const checks = HealthStore.getChecks();
    checks.filter(c => c.enabled).forEach(check => {
      this.scheduleCheck(check);
    });

    logger.info('Health', `Started ${intervals.size} checks.`);
  }

  static stopAll() {
    intervals.forEach(timer => clearInterval(timer));
    intervals.clear();
  }

  private static scheduleCheck(check: CheckConfig) {
    // Run immediately
    this.runAndEmit(check);

    // Schedule
    const ms = (check.interval || 60) * 1000;
    const timer = setInterval(() => {
      this.runAndEmit(check);
    }, ms);
    
    intervals.set(check.id, timer);
  }

  private static async runAndEmit(check: CheckConfig) {
    try {
      const result = await CheckRunner.run(check);
      const history = HealthStore.getResults(check.id);
      const prev = history[1]; // [0] is current
      const failed = result.status === 'fail';
      const recovered = result.status === 'ok';
      const enteredFailure = failed && (!prev || prev.status === 'ok');
      const recoveredNow = recovered && prev && prev.status === 'fail';
      
      // Emit if we have IO
      if (this.io) {
      // Broadcast update event (silent refresh)
      this.io.emit('health:update', { checkId: check.id, result });
        
      if (enteredFailure) {
         this.io.emit('health:alert', {
           type: 'error',
           title: `Check Failed: ${check.name}`,
           message: result.message || 'Service is down'
         });
      }
        
      if (recoveredNow) {
        this.io.emit('health:alert', {
          type: 'success',
          title: `Service Recovered: ${check.name}`,
          message: 'Service is back online'
        });
      }
      }

      if (enteredFailure) {
        const buffered = NotificationBatcher.enqueue('fail', check, result);
        if (!buffered) {
          await sendEmailAlert(
            `Check Failed: ${check.name}`,
            formatAlertMessage('fail', check, result)
          );
        }
      }

      if (recoveredNow) {
        const buffered = NotificationBatcher.enqueue('recovery', check, result);
        if (!buffered) {
          await sendEmailAlert(
            `Service Recovered: ${check.name}`,
            formatAlertMessage('recovery', check, result)
          );
        }
      }
    } catch (e) {
      logger.error('Health', `Error running check ${check.name}:`, e);
    }
  }
}

function formatAlertMessage(
    reason: 'fail' | 'recovery',
    check: CheckConfig,
    result: CheckResult
): string {
    const header = reason === 'fail'
        ? 'ServiceBay Health detected a failure.'
        : 'ServiceBay Health detected a recovery.';

    const lines = [
      `Check: ${check.name}`,
      `Type: ${check.type}`,
      check.nodeName ? `Node: ${check.nodeName}` : null,
      check.target ? `Target: ${check.target}` : null,
      `Status: ${result.status.toUpperCase()}`,
      result.latency !== undefined ? `Latency: ${result.latency}ms` : null,
      `Timestamp: ${result.timestamp}`,
      result.message ? `Details: ${result.message}` : null,
    ].filter(Boolean);

    return `${header}\n\n${lines.join('\n')}`;
}

import { Server } from 'socket.io';
import fs from 'fs';
import path from 'path';
import { logger } from '@/lib/logger';
import { HealthStore } from './store';
import { CheckRunner } from './runner';
import { CheckConfig, CheckResult } from './types';
import { decideAlert } from './alertDecision';
import { initializeDefaultChecks } from './init';
import { sendEmailAlert } from '@/lib/email';
import { NotificationBatcher } from './notificationBatcher';
import { DATA_DIR } from '@/lib/dirs';
import { getNodeTwins, subscribeToTwin } from '@/lib/store/repository';
import { runDiagnoseChecks, DIAGNOSE_INTERVAL_SECONDS } from '@/lib/diagnose/diagnoseChecks';

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
    //     The bootstrap reads deployed services off the twin. On a fresh
    //     process start the agent hasn't synced yet, so an eager call
    //     here finds zero services and registers no probes — every
    //     template stays at health=unknown forever (#935). We re-run
    //     the bootstrap once per node when its initial sync completes,
    //     which is also when `ServiceManager.listServices` first returns
    //     meaningful data. `register()` keys by `(node, name)` so
    //     repeated calls are idempotent.
    this.startServiceHealthBootstrap();

    // 1b. Open the boot-grace email-batch window. Health checks
    //     that flip ok → fail during the first 10 min after boot
    //     (or until events settle for 90 s, whichever comes first)
    //     are coalesced into one digest email instead of spamming
    //     the operator with N "service down" notifications during
    //     the cold-start race. See NotificationBatcher for the
    //     coalescing rules.
    NotificationBatcher.start();

    // 1c. Daily self-diagnose run (#1423). The diagnose suite is heavy
    //     (multi-probe agent fan-out), so it runs once a day rather than
    //     on the per-minute check cadence. Each probe is persisted as a
    //     synthetic `diagnose:<probeId>` check result so the Checks tab
    //     surfaces it with the same per-row stats as any other check.
    this.startDiagnoseSchedule();

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
  private static bootstrappedNodes = new Set<string>();
  private static twinUnsubscribe: (() => void) | null = null;

  private static async runServiceHealthBootstrap(nodeName: string): Promise<void> {
    if (this.bootstrappedNodes.has(nodeName)) return;
    this.bootstrappedNodes.add(nodeName);
    try {
      const { bootstrapServiceHealth } = await import('./serviceHealthBootstrap');
      await bootstrapServiceHealth(nodeName);
    } catch (e) {
      this.bootstrappedNodes.delete(nodeName);
      logger.warn('Health', `Service-health bootstrap failed for ${nodeName}: ${e instanceof Error ? e.message : String(e)}. Will retry on next sync.`);
    }
  }

  private static startServiceHealthBootstrap() {
    // First pass: any node already past initial sync (e.g. the install
    // runner bootstrapped them mid-deploy and this is a hot re-init).
    for (const [nodeName, twin] of Object.entries(getNodeTwins())) {
      if (twin.initialSyncComplete) {
        void this.runServiceHealthBootstrap(nodeName);
      }
    }
    // Catch the common cold-boot case: agent finishes syncing after
    // HealthService.init returns. Re-running bootstrap is cheap (the
    // poller dedupes by key) so we don't need to filter on first-flip
    // — we just guard with `bootstrappedNodes` for the "already done"
    // case.
    if (this.twinUnsubscribe) return;
    this.twinUnsubscribe = subscribeToTwin(() => {
      for (const [nodeName, twin] of Object.entries(getNodeTwins())) {
        if (twin.initialSyncComplete && !this.bootstrappedNodes.has(nodeName)) {
          void this.runServiceHealthBootstrap(nodeName);
        }
      }
    });
  }

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

  private static diagnoseTimer: NodeJS.Timeout | null = null;

  /** Kick off a daily self-diagnose run (#1423). Runs once shortly after
   *  init, then every {@link DIAGNOSE_INTERVAL_SECONDS}. The first run is
   *  deferred a short while so the agent has a chance to connect — an
   *  eager run on cold boot would just report "agent not reachable". */
  private static startDiagnoseSchedule() {
    if (this.diagnoseTimer) return;
    const tick = async () => {
      try {
        const results = await runDiagnoseChecks('Local');
        if (this.io) {
          for (const result of results) {
            this.io.emit('health:update', { checkId: result.check_id, result });
          }
        }
      } catch (e) {
        logger.error('Health', 'Daily self-diagnose run failed:', e);
      }
    };
    // Defer the first run ~60 s past boot so the agent is connected.
    const FIRST_RUN_DELAY_MS = 60_000;
    setTimeout(() => { void tick(); }, FIRST_RUN_DELAY_MS);
    this.diagnoseTimer = setInterval(() => { void tick(); }, DIAGNOSE_INTERVAL_SECONDS * 1000);
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
      // CheckRunner.run has already persisted `result`, so history is
      // newest-first with history[0] === result.
      const history = HealthStore.getResults(check.id);
      // Require N consecutive fails before alerting (#1651); recovery
      // only fires if a fail alert was actually sent. The decision is a
      // pure function so it stays testable and extensible (#1652).
      const { alertFailure: enteredFailure, alertRecovery: recoveredNow } =
        decideAlert(check, history);

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

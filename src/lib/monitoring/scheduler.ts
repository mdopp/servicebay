import { MonitoringStore } from './store';
import { CheckRunner } from './runner';
import { CheckConfig } from './types';
import { initializeDefaultChecks } from './init';
import { Server } from 'socket.io';
import { sendEmailAlert } from '../email';

declare global {
   
  var __monitoringScheduler: MonitoringScheduler | undefined;
}

export class MonitoringScheduler {
  private intervals: Map<string, NodeJS.Timeout> = new Map();
  private checks: Map<string, CheckConfig> = new Map();
  private isRunning = false;
  private io: Server | null = null;

  constructor() {
    // Don't start automatically, wait for start() call
  }

  public setIO(io: Server) {
    this.io = io;
  }

  public start() {
    if (this.isRunning) return;
    this.isRunning = true;
    console.log('[Scheduler] Starting monitoring scheduler...');
    
    // Initialize default checks (async)
    initializeDefaultChecks().then(() => {
        this.refresh();
    });
    
    // Refresh checks every minute to pick up new/deleted checks
    // In a real app, we would use an event emitter from the store
    setInterval(() => this.refresh(), 60000);
  }

  public refresh() {
    const checks = MonitoringStore.getChecks();
    const activeIds = new Set(checks.filter(c => c.enabled).map(c => c.id));

    // Remove disabled/deleted checks
    for (const [id, timer] of this.intervals) {
      if (!activeIds.has(id)) {
        clearInterval(timer);
        this.intervals.delete(id);
        this.checks.delete(id);
        console.log(`[Scheduler] Stopped check ${id}`);
      }
    }

    // Add/Update checks
    for (const check of checks) {
      if (!check.enabled) continue;

      const existingCheck = this.checks.get(check.id);
      const configChanged = existingCheck && JSON.stringify(existingCheck) !== JSON.stringify(check);

      if (!this.intervals.has(check.id) || configChanged) {
        if (configChanged) {
            console.log(`[Scheduler] Config changed for ${check.name}, restarting check...`);
            clearInterval(this.intervals.get(check.id)!);
            this.intervals.delete(check.id);
        }
        
        this.checks.set(check.id, check);
        this.scheduleCheck(check);
      }
    }
  }

  private scheduleCheck(check: CheckConfig) {
    console.log(`[Scheduler] Scheduling check ${check.name} every ${check.interval}s`);
    
    // Run immediately
    this.runCheck(check);

    const timer = setInterval(() => {
      this.runCheck(check);
    }, check.interval * 1000);

    this.intervals.set(check.id, timer);
  }

  private async runCheck(check: CheckConfig) {
    try {
      const result = await CheckRunner.run(check);
      
      // Check for status change if we have IO
      if (this.io) {
        const history = MonitoringStore.getResults(check.id);
        const previousResult = history.length > 1 ? history[1] : null;
        
        const previousStatus = previousResult ? previousResult.status : 'unknown';
        const currentStatus = result.status;

        if (currentStatus !== previousStatus) {
            // Only alert if we are transitioning from a known 'ok' state to 'fail'
            // This prevents alerts on first run (unknown -> fail) or startup
            if (currentStatus === 'fail' && previousStatus === 'ok') {
                const msg = result.message || 'Unknown error';
                this.io.emit('monitoring:alert', {
                    title: `Check Failed: ${check.name}`,
                    message: msg,
                    type: 'error'
                });
                // Send Email
                sendEmailAlert(`Check Failed: ${check.name}`, `The check "${check.name}" (${check.target}) has failed.\n\nError: ${msg}`);
            } else if (currentStatus === 'ok' && previousStatus === 'fail') {
                const msg = `Service is back online. Latency: ${result.latency}ms`;
                this.io.emit('monitoring:alert', {
                    title: `Check Recovered: ${check.name}`,
                    message: msg,
                    type: 'success'
                });
                // Send Email
                sendEmailAlert(`Check Recovered: ${check.name}`, `The check "${check.name}" (${check.target}) has recovered.\n\n${msg}`);
            }
        }
        
        // Always emit update for real-time graphs
        this.io.emit('monitoring:update', { checkId: check.id, result });
      }
    } catch (e) {
      console.error(`[Scheduler] Check ${check.name} failed to execute:`, e);
    }
  }
}

// Ensure singleton
if (!global.__monitoringScheduler) {
  global.__monitoringScheduler = new MonitoringScheduler();
  // Start it if it was created just now
  global.__monitoringScheduler.start();
}
const scheduler = global.__monitoringScheduler;

export default scheduler;

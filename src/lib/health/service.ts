import { Server } from 'socket.io';
import { logger } from '@/lib/logger';
import { HealthStore } from './store';
import { CheckRunner } from './runner';
import { CheckConfig, CheckResult } from './types';
import { initializeDefaultChecks } from './init';
import { sendEmailAlert } from '@/lib/email';

// In-memory interval tracking
const intervals = new Map<string, NodeJS.Timeout>();

export class HealthService {
  private static io: Server | null = null;

  static async init(io: Server) {
    this.io = io;
    
    // 1. Ensure defaults
    await initializeDefaultChecks();

    // 2. Start initial scheduling
    this.restartAll();
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
        await sendEmailAlert(
          `Check Failed: ${check.name}`,
          formatAlertMessage('fail', check, result)
        );
      }

      if (recoveredNow) {
        await sendEmailAlert(
          `Service Recovered: ${check.name}`,
          formatAlertMessage('recovery', check, result)
        );
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

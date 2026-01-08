import { Server } from 'socket.io';
import { MonitoringStore } from './store';
import { CheckRunner } from './runner';
import { CheckConfig } from './types';
import { initializeDefaultChecks } from './init';

// In-memory interval tracking
const intervals = new Map<string, NodeJS.Timeout>();

export class MonitoringService {
  private static io: Server | null = null;

  static async init(io: Server) {
    this.io = io;
    
    // 1. Ensure defaults
    await initializeDefaultChecks();

    // 2. Start initial scheduling
    this.restartAll();
  }

  static getChecks() {
      return MonitoringStore.getChecks();
  }

  static restartAll() {
    // Clear existing
    this.stopAll();

    const checks = MonitoringStore.getChecks();
    checks.filter(c => c.enabled).forEach(check => {
      this.scheduleCheck(check);
    });

    console.log(`[Monitoring] Started ${intervals.size} checks.`);
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
      
      // Emit if we have IO
      if (this.io) {
        // Broadcast update event (silent refresh)
        this.io.emit('monitoring:update', { checkId: check.id, result });
        
        // If status changed to fail, maybe emit alert
        const history = MonitoringStore.getResults(check.id);
        const prev = history[1]; // [0] is current
        
        if (result.status === 'fail' && (!prev || prev.status === 'ok')) {
             this.io.emit('monitoring:alert', {
                 type: 'error',
                 title: `Check Failed: ${check.name}`,
                 message: result.message || 'Service is down'
             });
        }
        
        // If recovered
        if (result.status === 'ok' && prev && prev.status === 'fail') {
            this.io.emit('monitoring:alert', {
                type: 'success',
                title: `Service Recovered: ${check.name}`,
                message: 'Service is back online'
            });
        }
      }
    } catch (e) {
      console.error(`[Monitoring] Error running check ${check.name}:`, e);
    }
  }
}

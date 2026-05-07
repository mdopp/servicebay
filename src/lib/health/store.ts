import fs from 'fs';
import path from 'path';
import { CheckConfig, CheckResult } from './types';
import { DATA_DIR } from '../dirs';

const CONFIG_DIR = DATA_DIR;
const CHECKS_FILE = path.join(CONFIG_DIR, 'checks.json');
const RESULTS_DIR = path.join(CONFIG_DIR, 'results');

function ensureDirs() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
  if (!fs.existsSync(RESULTS_DIR)) {
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
  }
}

/**
 * Listener interface for check mutations. HealthService subscribes here in
 * init() so any code path that adds/edits/removes a check (the wizard, the
 * API, ServiceManager auto-add, backup-sync) immediately gets the new check
 * scheduled — without each call site needing to know about the scheduler.
 */
export interface HealthStoreListener {
  onSave?: (check: CheckConfig) => void;
  onDelete?: (id: string) => void;
}

const listeners: HealthStoreListener[] = [];

export class HealthStore {
  /** Register a listener. Returns an unsubscribe fn. */
  static subscribe(listener: HealthStoreListener): () => void {
    listeners.push(listener);
    return () => {
      const i = listeners.indexOf(listener);
      if (i >= 0) listeners.splice(i, 1);
    };
  }

  static getChecks(): CheckConfig[] {
    if (!fs.existsSync(CHECKS_FILE)) return [];
    try {
      return JSON.parse(fs.readFileSync(CHECKS_FILE, 'utf-8'));
    } catch (e) {
      console.error('Failed to read checks config', e);
      return [];
    }
  }

  static saveCheck(check: CheckConfig) {
    ensureDirs();
    const checks = this.getChecks();
    const index = checks.findIndex(c => c.id === check.id);
    if (index >= 0) {
      checks[index] = check;
    } else {
      checks.push(check);
    }
    fs.writeFileSync(CHECKS_FILE, JSON.stringify(checks, null, 2));
    for (const l of listeners) l.onSave?.(check);
  }

  static deleteCheck(id: string) {
    ensureDirs();
    const checks = this.getChecks().filter(c => c.id !== id);
    fs.writeFileSync(CHECKS_FILE, JSON.stringify(checks, null, 2));
    for (const l of listeners) l.onDelete?.(id);
  }

  static saveResult(result: CheckResult) {
    ensureDirs();
    const resultFile = path.join(RESULTS_DIR, `${result.check_id}.json`);
    let results: CheckResult[] = [];
    if (fs.existsSync(resultFile)) {
      try {
        results = JSON.parse(fs.readFileSync(resultFile, 'utf-8'));
      } catch {}
    }
    results.unshift(result);
    
    // Keep results for 7 days
    const retentionMs = 7 * 24 * 60 * 60 * 1000;
    const now = Date.now();
    results = results.filter(r => new Date(r.timestamp).getTime() > now - retentionMs);
    
    try {
        fs.writeFileSync(resultFile, JSON.stringify(results, null, 2));
    } catch (e) {
        console.error(`[HealthStore] Failed to save result for ${result.check_id}:`, e);
    }
  }

  static getResults(checkId: string): CheckResult[] {
    const resultFile = path.join(RESULTS_DIR, `${checkId}.json`);
    if (!fs.existsSync(resultFile)) return [];
    try {
      return JSON.parse(fs.readFileSync(resultFile, 'utf-8'));
    } catch {
      return [];
    }
  }
  
  static getLastResult(checkId: string): CheckResult | null {
    const results = this.getResults(checkId);
    return results.length > 0 ? results[0] : null;
  }
}

import fs from 'fs';
import path from 'path';
import { CheckConfig, CheckResult } from './types';
import { DATA_DIR } from '../dirs';
import { logger } from '../logger';

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
 * Note: an earlier listener-callback design (PR #166) was abandoned because
 * Next.js bundles API routes in a webpack module graph that's separate from
 * the custom server's esbuild bundle. saveCheck calls from API routes
 * therefore landed on a *different* listeners[] array than where
 * HealthService.init subscribed — so the listener never fired and per-
 * service checks created via the wizard sat dormant with lastResult=null.
 *
 * The current design is bundle-agnostic: HealthService watches the on-disk
 * checks.json file with fs.watch and re-schedules whenever it changes.
 * Both bundles share the filesystem, so the signal lands wherever the
 * server is actually running.
 */

export class HealthStore {
  static getChecks(): CheckConfig[] {
    if (!fs.existsSync(CHECKS_FILE)) return [];
    try {
      return JSON.parse(fs.readFileSync(CHECKS_FILE, 'utf-8'));
    } catch (e) {
      logger.error('store', 'Failed to read checks config', e);
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
  }

  static deleteCheck(id: string) {
    ensureDirs();
    const checks = this.getChecks().filter(c => c.id !== id);
    fs.writeFileSync(CHECKS_FILE, JSON.stringify(checks, null, 2));
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
        logger.error('HealthStore', `Failed to save result for ${result.check_id}:`, e);
    }
  }

  /** Every check_id that has a persisted result file on disk. Used by
   *  the diagnose→checks bridge (#1423) to enumerate synthetic
   *  `diagnose:<probeId>` rows, which never live in checks.json. */
  static getResultCheckIds(): string[] {
    if (!fs.existsSync(RESULTS_DIR)) return [];
    try {
      return fs.readdirSync(RESULTS_DIR)
        .filter(f => f.endsWith('.json'))
        .map(f => f.slice(0, -'.json'.length));
    } catch {
      return [];
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

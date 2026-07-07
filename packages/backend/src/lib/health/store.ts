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
 * Hot-path read cache (#2163). getChecks / getResults sit on the diagnose,
 * health-API and core-health-summary request paths and were doing a full
 * readFileSync + JSON.parse on every call — with many checks or a large
 * results file on a loaded disk that blocks the event loop and wedges the
 * diagnose/health pages.
 *
 * We keep the public API sync (dozens of callers across MCP, portal, service
 * lifecycle and API routes rely on it) but serve parsed JSON from an in-memory
 * cache keyed on the file's mtime+size. A `statSync` is a single cheap syscall;
 * we only pay the expensive read+parse when the file actually changed. This is
 * multi-writer-safe: writes from any bundle/process (the API-route webpack
 * bundle, fs.watch in service.ts, another node process) bump the mtime, so the
 * next reader re-parses. On write we invalidate our own entry immediately so a
 * read-after-write in the same process never serves stale data even within
 * mtime granularity.
 */
interface CacheEntry<T> {
  mtimeMs: number;
  size: number;
  value: T;
}

const checksCache = { entry: null as CacheEntry<CheckConfig[]> | null };
const resultsCache = new Map<string, CacheEntry<CheckResult[]>>();

/** Read + JSON.parse a file, but reuse the cached parse when mtime+size are
 *  unchanged. Returns `fallback` on any error (missing file / bad JSON). */
function cachedRead<T>(
  file: string,
  getEntry: () => CacheEntry<T> | null | undefined,
  setEntry: (e: CacheEntry<T> | null) => void,
  fallback: T,
): T {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    setEntry(null);
    return fallback;
  }
  const cached = getEntry();
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.value;
  }
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf-8')) as T;
    setEntry({ mtimeMs: stat.mtimeMs, size: stat.size, value });
    return value;
  } catch (e) {
    logger.error('store', `Failed to read/parse ${file}`, e);
    setEntry(null);
    return fallback;
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
    return cachedRead<CheckConfig[]>(
      CHECKS_FILE,
      () => checksCache.entry,
      e => { checksCache.entry = e; },
      [],
    );
  }

  /** Persist checks.json and invalidate the read cache so a same-process
   *  read-after-write can't serve stale data within mtime granularity. */
  private static writeChecks(checks: CheckConfig[]) {
    fs.writeFileSync(CHECKS_FILE, JSON.stringify(checks, null, 2));
    checksCache.entry = null;
  }

  static saveCheck(check: CheckConfig) {
    ensureDirs();
    // Copy — getChecks() may return the cached array; don't mutate it in place.
    const checks = [...this.getChecks()];
    const index = checks.findIndex(c => c.id === check.id);
    if (index >= 0) {
      checks[index] = check;
    } else {
      checks.push(check);
    }
    this.writeChecks(checks);
  }

  /** Delete a STORED check by id. Returns false when nothing matched — e.g. a
   *  synthetic `diagnose:<probeId>` row (those live only in the live diagnose
   *  bridge, never in checks.json), so the caller can report honestly instead of
   *  a fake success that silently no-ops and lets the row reappear. */
  static deleteCheck(id: string): boolean {
    ensureDirs();
    const checks = this.getChecks();
    const remaining = checks.filter(c => c.id !== id);
    if (remaining.length === checks.length) return false;
    this.writeChecks(remaining);
    return true;
  }

  /**
   * Remove the auto-created per-service health check(s) for a service that
   * is being uninstalled. Matches the shape `addServiceChecks` /
   * `deployStack` create: `type:'service'` with `target === serviceName`,
   * or the legacy `name === 'Service: <serviceName>'` row. Returns the
   * number of checks removed.
   *
   * Per-service checks are gated on actual deployment (#1506): a stack is
   * the only thing that creates its check (on deploy) and uninstall is the
   * only thing that removes it. An un-installed service must show no check,
   * never a red "failing" one.
   */
  static deleteServiceCheck(serviceName: string): number {
    ensureDirs();
    const all = this.getChecks();
    const remaining = all.filter(c =>
      !((c.type === 'service' && c.target === serviceName) ||
        c.name === `Service: ${serviceName}`));
    if (remaining.length !== all.length) {
      this.writeChecks(remaining);
    }
    return all.length - remaining.length;
  }

  /** Persist a check's result file and invalidate its cache entry. */
  private static writeResults(checkId: string, results: CheckResult[]) {
    const resultFile = path.join(RESULTS_DIR, `${checkId}.json`);
    try {
      fs.writeFileSync(resultFile, JSON.stringify(results, null, 2));
      resultsCache.delete(checkId);
    } catch (e) {
      logger.error('HealthStore', `Failed to save result for ${checkId}:`, e);
    }
  }

  static saveResult(result: CheckResult) {
    ensureDirs();
    let results: CheckResult[] = [...this.getResults(result.check_id)];
    results.unshift(result);

    // Keep results for 7 days
    const retentionMs = 7 * 24 * 60 * 60 * 1000;
    const now = Date.now();
    results = results.filter(r => new Date(r.timestamp).getTime() > now - retentionMs);

    this.writeResults(result.check_id, results);
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
    return cachedRead<CheckResult[]>(
      resultFile,
      () => resultsCache.get(checkId),
      e => { if (e) resultsCache.set(checkId, e); else resultsCache.delete(checkId); },
      [],
    );
  }
  
  static getLastResult(checkId: string): CheckResult | null {
    const results = this.getResults(checkId);
    return results.length > 0 ? results[0] : null;
  }

  /**
   * Mark the most-recent persisted result for a check as having emitted a
   * failure alert (#1661). `runAndEmit` calls this after the #1651 threshold
   * and #1652 root-cause gates both pass, so the recovery side can later tell
   * an alerted failure (recover) from a suppressed downstream symptom (stay
   * silent). No-op if there is no persisted result yet.
   */
  static markLastResultAlerted(checkId: string): void {
    const results = [...this.getResults(checkId)];
    if (results.length === 0) return;
    results[0] = { ...results[0], alerted: true };
    this.writeResults(checkId, results);
  }
}

/**
 * Persistent store for unresolved install-time failures (#2160 / #2161).
 *
 * Two failure classes leave a service in a silent half-state that the
 * install log alone can't recover from once it scrolls away:
 *   - a `feature.installed` capability handler (OIDC client / NPM proxy
 *     host / AdGuard rewrite) that stayed failed after bounded retries;
 *   - a NAS auto-restore that failed, so the service came up on default
 *     config while the operator believes their state was restored.
 *
 * Both are recorded here (keyed `${kind}:${service}`) so the
 * `install_handler_failed` diagnose probe can surface them with a
 * retry/reconcile action — symmetric with `servicePostDeploy` +
 * `post_deploy_failed`. A successful reconcile clears exactly the one
 * service's record.
 *
 * All writes are best-effort: a persistence failure here must never
 * abort or fail an install (it only means the operator loses the
 * standing diagnose row), so callers get a swallow-on-error contract.
 */
import { getConfig, saveConfig } from '@/lib/config';
import { logger } from '@/lib/logger';
import type { InstallHandlerFailureRecord } from '@/lib/config';
import type { EmitResult } from '@/lib/capabilities/bus';

export type { InstallHandlerFailureRecord };

/** How many times the install runner emits `feature.installed` before it
 *  gives up on a still-retryable handler failure (#2160). */
export const MAX_EMIT_ATTEMPTS = 3;
const RETRY_DELAY_MS = 2_000;

/**
 * Emit `feature.installed` with bounded retry of RETRYABLE handler
 * failures (#2160). Handlers are idempotent, so re-emitting the whole
 * event is safe — already-done work no-ops and only the still-failing
 * handler gets another attempt. Stops early once no failure is still
 * retryable, or after `MAX_EMIT_ATTEMPTS`. Non-retryable failures are
 * never retried. Extracted from the runner so the retry policy is unit-
 * testable (a fail-then-succeed handler retries; an always-fail one
 * exhausts). Injects `emit`, `onRetry`, and `sleep` for the tests.
 */
export async function emitFeatureInstalledWithRetry(deps: {
  emit: () => Promise<EmitResult>;
  onRetry?: (attempt: number, retryableCount: number) => void | Promise<void>;
  sleep?: (ms: number) => Promise<void>;
}): Promise<EmitResult> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  let result = await deps.emit();
  for (
    let attempt = 1;
    attempt < MAX_EMIT_ATTEMPTS && result.failures.some(f => !f.result.ok && f.result.retryable);
    attempt++
  ) {
    const retryableCount = result.failures.filter(f => !f.result.ok && f.result.retryable).length;
    await deps.onRetry?.(attempt, retryableCount);
    await sleep(RETRY_DELAY_MS);
    result = await deps.emit();
  }
  return result;
}

const LOG_SCOPE = 'install:handlerFailures';

/** Compose the record key. Exported so the probe + callers agree. */
export function handlerFailureKey(kind: InstallHandlerFailureRecord['kind'], service: string): string {
  return `${kind}:${service}`;
}

/**
 * Persist (or overwrite) one unresolved failure. Best-effort — a write
 * error is logged and swallowed so it can never break the install.
 */
export async function recordHandlerFailure(
  entry: Omit<InstallHandlerFailureRecord, 'lastFailedAt'> & { lastFailedAt?: string },
): Promise<void> {
  const record: InstallHandlerFailureRecord = {
    kind: entry.kind,
    service: entry.service,
    message: entry.message,
    lastFailedAt: entry.lastFailedAt ?? new Date().toISOString(),
  };
  try {
    const config = await getConfig();
    const failures = { ...(config.installHandlerFailures ?? {}) };
    failures[handlerFailureKey(record.kind, record.service)] = record;
    // saveConfig (not updateConfig): updateConfig deep-merges, which can't
    // remove keys — but here we always write the whole map so add/overwrite
    // and the delete path in `clearHandlerFailure` stay consistent.
    await saveConfig({ ...config, installHandlerFailures: failures });
  } catch (e) {
    logger.warn(LOG_SCOPE, `Could not persist ${record.kind} failure for ${record.service}:`, e);
  }
}

/**
 * Clear the record for one service+kind (e.g. after a successful
 * reconcile/retry). Best-effort. Returns true if a record existed.
 */
export async function clearHandlerFailure(
  kind: InstallHandlerFailureRecord['kind'],
  service: string,
): Promise<boolean> {
  try {
    const config = await getConfig();
    const failures = { ...(config.installHandlerFailures ?? {}) };
    const key = handlerFailureKey(kind, service);
    if (!(key in failures)) return false;
    delete failures[key];
    await saveConfig({ ...config, installHandlerFailures: failures });
    return true;
  } catch (e) {
    logger.warn(LOG_SCOPE, `Could not clear ${kind} failure for ${service}:`, e);
    return false;
  }
}

/** Read all standing failures (probe-facing). Never throws. */
export async function listHandlerFailures(): Promise<InstallHandlerFailureRecord[]> {
  try {
    const config = await getConfig();
    return Object.values(config.installHandlerFailures ?? {});
  } catch {
    return [];
  }
}

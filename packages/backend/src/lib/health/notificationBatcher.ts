/**
 * Boot-grace alert batcher.
 *
 * Health checks fire once per interval (default 60 s). Every time a
 * check transitions ok → fail, the runAndEmit path sends one email.
 * Right after a server restart that's a problem: every previously-
 * passing check goes through the ok → fail transition at the same
 * moment because the upstream service is still cold-starting, so the
 * operator gets N "service down" emails followed by N "service
 * recovered" emails within minutes. Same pattern during install
 * wipes/reinstalls.
 *
 * This module buffers fail/recovery events for a configurable boot
 * grace window after server startup. At the end of the window — or
 * earlier, once events stop arriving for `SETTLE_WINDOW_MS` — it
 * coalesces per check (latest state wins) and sends *one* digest
 * email summarising the checks still failing. If nothing is still
 * failing, no email is sent at all: that's the typical clean-boot
 * case where everything came back up.
 *
 * After the window closes, callers fall through to the per-event
 * email path with no behaviour change.
 */

import type { CheckConfig, CheckResult } from './types';
import { logger } from '@/lib/logger';
import { sendEmailAlert } from '@/lib/email';
import {
  isRootCause,
  makePrerequisiteContext,
  type ServiceDependencyMap,
} from './prerequisiteChecks';

/** Hard cap on how long we'll hold alerts after boot. Covers the
 *  longest cold-start envelope (NPM + AdGuard + auth pods) plus a
 *  buffer for slow disks; beyond this the operator is owed real-time
 *  alerts even if events keep arriving. */
const BOOT_GRACE_MAX_MS = 10 * 60 * 1000;

/** Idle window after the last event before we declare boot
 *  stabilised and flush early. 90 s comfortably exceeds a normal
 *  health-check interval (60 s) so we won't flush in the middle of a
 *  burst, but it's short enough that operators don't wait the full
 *  10 min when things actually settle quickly. */
const SETTLE_WINDOW_MS = 90 * 1000;

export type AlertKind = 'fail' | 'recovery';

interface PendingAlert {
  kind: AlertKind;
  check: CheckConfig;
  result: CheckResult;
  queuedAt: number;
}

/** Format the same body the per-event path uses, kept inline so the
 *  digest reads consistently with non-batched alerts. */
function formatAlert(reason: AlertKind, check: CheckConfig, result: CheckResult): string {
  const lines = [
    `Check: ${check.name}`,
    `Type: ${check.type}`,
    check.nodeName ? `Node: ${check.nodeName}` : null,
    check.target ? `Target: ${check.target}` : null,
    `Status: ${result.status.toUpperCase()} (last seen ${reason === 'fail' ? 'failing' : 'recovered'} at boot)`,
    result.latency !== undefined ? `Latency: ${result.latency}ms` : null,
    `Timestamp: ${result.timestamp}`,
    result.message ? `Details: ${result.message}` : null,
  ].filter(Boolean);
  return lines.join('\n');
}

export class NotificationBatcher {
  private static pending: PendingAlert[] = [];
  private static settleTimer: NodeJS.Timeout | null = null;
  private static maxGraceTimer: NodeJS.Timeout | null = null;
  /** When true, callers should buffer instead of sending immediately.
   *  Flips false at flush time. */
  private static active = false;
  /** Settle-window length, captured from `start()` so every enqueue
   *  uses the same value. Previously enqueue read its own default and
   *  ignored `start({settleMs})`, which silently broke the
   *  "stabilises early" contract. */
  private static settleMs = SETTLE_WINDOW_MS;
  /** Promise of the in-flight flush, exposed for tests so they can
   *  await the timer-triggered digest. Production callers don't need
   *  it — the timer callbacks fire-and-forget. */
  private static flushInFlight: Promise<void> | null = null;

  /**
   * Root-cause inputs (#1652). Injected by `HealthService.init` so the
   * boot digest collapses a restart cascade to root failures only — the
   * same resolution the steady-state alert path uses — without the
   * batcher importing the registry/config layer directly. When unset the
   * digest falls back to listing every still-failing check (legacy).
   */
  private static serviceDeps: ServiceDependencyMap | null = null;
  private static hosts: import('../config').ProxyHostEntry[] = [];

  /** Wire the root-cause graph for the boot digest. Called once from
   *  `HealthService.init` after the dependency graph is built. */
  static setRootCauseResolution(input: {
    serviceDeps: ServiceDependencyMap;
    hosts: import('../config').ProxyHostEntry[];
  }): void {
    this.serviceDeps = input.serviceDeps;
    this.hosts = input.hosts;
  }

  /** Initialise the grace window. Called from `HealthService.init`
   *  once per server start. Repeated calls are no-ops so HMR
   *  reloads in dev don't reset the timer. */
  static start(opts: { maxMs?: number; settleMs?: number } = {}): void {
    if (this.active) return;
    this.active = true;
    this.pending = [];
    const maxMs = opts.maxMs ?? BOOT_GRACE_MAX_MS;
    this.settleMs = opts.settleMs ?? SETTLE_WINDOW_MS;
    this.maxGraceTimer = setTimeout(() => {
      this.flushInFlight = this.flush('max-grace-elapsed');
    }, maxMs);
    // Don't arm the settle timer until the first alert arrives —
    // otherwise a quiet boot (no health-check failures at all) would
    // still send a 90-s-after-boot "everything fine" event through.
    logger.info(
      'NotificationBatcher',
      `Boot grace active (max ${maxMs / 1000}s, settle ${this.settleMs / 1000}s).`,
    );
  }

  /** Enqueue a fail/recovery event. Returns true when the caller
   *  should NOT send the per-event email (we'll send a digest);
   *  false when the grace window is closed and the caller should
   *  send normally. */
  static enqueue(kind: AlertKind, check: CheckConfig, result: CheckResult): boolean {
    if (!this.active) return false;
    this.pending.push({ kind, check, result, queuedAt: Date.now() });
    // Reset the settle timer on every event — boot is still in flux.
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => {
      this.flushInFlight = this.flush('settled');
    }, this.settleMs);
    return true;
  }

  /** Flush the buffer immediately. Public so tests can drive it;
   *  the timers call it internally. */
  static async flush(reason: 'settled' | 'max-grace-elapsed' | 'manual' = 'manual'): Promise<void> {
    if (!this.active) return;
    this.active = false;
    if (this.settleTimer) {
      clearTimeout(this.settleTimer);
      this.settleTimer = null;
    }
    if (this.maxGraceTimer) {
      clearTimeout(this.maxGraceTimer);
      this.maxGraceTimer = null;
    }

    // Coalesce: latest event per check.id wins. Two-step pass so a
    // check that went fail → recovery → fail during boot lands as
    // fail (its last observed state).
    const finalState = new Map<string, PendingAlert>();
    for (const a of this.pending) finalState.set(a.check.id, a);
    const allFailing = [...finalState.values()].filter(a => a.kind === 'fail');
    // Root-cause coalescing (#1652): a reboot/internet blip floods the
    // buffer with the whole cascade. If the dependency graph is wired,
    // keep only the roots — a check whose prerequisite is also in the
    // failing set is a downstream symptom, named by its root's chain, not
    // a separate digest line. Treat the buffered fail set as the "currently
    // failing" universe (during boot the live per-check status hasn't
    // settled, so the buffer is the better signal).
    const stillFailing = this.coalesceToRoots(allFailing);

    const total = this.pending.length;
    this.pending = [];

    if (stillFailing.length === 0) {
      logger.info(
        'NotificationBatcher',
        `Boot grace ${reason}: ${total} transient event${total === 1 ? '' : 's'} settled cleanly, no email sent.`,
      );
      return;
    }

    const subject =
      stillFailing.length === 1
        ? `Health check failing after boot: ${stillFailing[0].check.name}`
        : `${stillFailing.length} health checks failing after boot`;

    const summary = `ServiceBay boot grace window (${reason === 'settled' ? 'stabilised early' : 'max duration reached'}). `
      + `${stillFailing.length} of ${finalState.size} unique check${finalState.size === 1 ? '' : 's'} `
      + `that changed state during the window ${stillFailing.length === 1 ? 'is' : 'are'} still failing.`;

    const body = `${summary}\n\n${stillFailing.map(a => formatAlert(a.kind, a.check, a.result)).join('\n---\n')}`;

    try {
      await sendEmailAlert(subject, body);
      logger.info(
        'NotificationBatcher',
        `Sent digest for ${stillFailing.length} still-failing check(s) after boot (${reason}).`,
      );
    } catch (e) {
      logger.warn(
        'NotificationBatcher',
        `Digest email failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  /** Collapse a buffered fail set to root causes only (#1652). When the
   *  dependency graph isn't wired, returns the input unchanged (legacy
   *  behaviour). The failing universe is the buffer itself. */
  private static coalesceToRoots(failing: PendingAlert[]): PendingAlert[] {
    if (!this.serviceDeps || failing.length <= 1) return failing;
    const failingIds = new Set(failing.map(a => a.check.id));
    const ctx = makePrerequisiteContext({
      checks: failing.map(a => a.check),
      serviceDeps: this.serviceDeps,
      config: { reverseProxy: { hosts: this.hosts } },
      isFailing: (id: string) => failingIds.has(id),
    });
    const roots = failing.filter(a => isRootCause(a.check, ctx));
    // Defensive: never collapse to nothing (a pure cycle would) — fall
    // back to the full set so the operator always gets the digest.
    return roots.length > 0 ? roots : failing;
  }

  /** Test-only: reset module state so each test starts clean. */
  static _resetForTesting(): void {
    if (this.settleTimer) clearTimeout(this.settleTimer);
    if (this.maxGraceTimer) clearTimeout(this.maxGraceTimer);
    this.settleTimer = null;
    this.maxGraceTimer = null;
    this.pending = [];
    this.active = false;
    this.serviceDeps = null;
    this.hosts = [];
  }

  /** Test-only: peek at the pending buffer. */
  static _pendingForTesting(): readonly PendingAlert[] {
    return this.pending;
  }

  /** Test-only: whether the grace window is open. */
  static _activeForTesting(): boolean {
    return this.active;
  }

  /** Test-only: await the in-flight flush promise (if any) that was
   *  triggered by a timer. Lets tests synchronise on the async flush
   *  body completing after `advanceTimersByTimeAsync`. */
  static async _awaitFlushForTesting(): Promise<void> {
    const p = this.flushInFlight;
    this.flushInFlight = null;
    if (p) await p;
  }
}

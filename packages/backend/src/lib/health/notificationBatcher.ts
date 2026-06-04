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

import fs from 'fs';
import path from 'path';
import type { CheckConfig, CheckResult } from './types';
import { logger } from '@/lib/logger';
import { sendEmailAlert } from '@/lib/email';
import {
  isRootCause,
  makePrerequisiteContext,
  type ServiceDependencyMap,
} from './prerequisiteChecks';
import { readBootState, writeBootState, readAppVersion } from './bootState';
import { extractChangelogHighlights } from './changelogHighlights';

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

/** Restart framing captured at boot (#1653): did the version change across
 *  this restart, and how long was the box down + recovering. */
interface RestartContext {
  /** Version the process is now running. */
  currentVersion: string;
  /** Version recorded at the previous boot — undefined on first boot. */
  previousVersion?: string;
  /** True when `currentVersion !== previousVersion` (and we knew a prior). */
  versionChanged: boolean;
  /** Epoch ms of this process's boot (when `start()` ran). */
  bootAt: number;
  /** Epoch ms of the last healthy heartbeat before this restart, if known —
   *  the start of the downtime+recovery window. */
  lastSeenAt?: number;
  /** Changelog highlights for the versions crossed (empty if no change). */
  changelog: string[];
}

/** Default location of the repo CHANGELOG.md, read for update highlights. */
const CHANGELOG_PATH = path.join(process.cwd(), 'CHANGELOG.md');

/** Humanise a millisecond span as e.g. "3m12s" / "45s" / "1h02m". */
function formatDuration(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m${String(s).padStart(2, '0')}s`;
  return `${s}s`;
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

  /** Restart framing captured once at `start()` (#1653). Null until the
   *  grace window opens. Drives the version-change / recovery-duration /
   *  changelog lines and the "when to send" rule. */
  private static restart: RestartContext | null = null;

  /** Test seam: inject the restart context instead of reading package.json /
   *  boot-state / CHANGELOG.md from disk. */
  private static restartOverride: RestartContext | null = null;
  static _setRestartContextForTesting(ctx: RestartContext | null): void {
    this.restartOverride = ctx;
  }

  /** Wire the root-cause graph for the boot digest. Called once from
   *  `HealthService.init` after the dependency graph is built. */
  static setRootCauseResolution(input: {
    serviceDeps: ServiceDependencyMap;
    hosts: import('../config').ProxyHostEntry[];
  }): void {
    this.serviceDeps = input.serviceDeps;
    this.hosts = input.hosts;
  }

  /** Read the prior boot-state from disk, diff the version, load changelog
   *  highlights when it changed, then persist the new boot-state so the
   *  *next* restart can diff against this one. Best-effort: any failure
   *  yields a minimal context (no version change, no changelog) rather than
   *  throwing during boot. */
  private static captureRestartContext(): RestartContext {
    const bootAt = Date.now();
    const currentVersion = readAppVersion();
    const prior = readBootState();
    const previousVersion = prior.lastSeenVersion;
    const versionChanged = previousVersion !== undefined && previousVersion !== currentVersion;

    let changelog: string[] = [];
    if (versionChanged) {
      try {
        const text = fs.readFileSync(CHANGELOG_PATH, 'utf-8');
        changelog = extractChangelogHighlights(text, currentVersion, previousVersion, { max: 6 });
      } catch {
        /* changelog unreadable — digest still reports the version change */
      }
    }

    // Persist the new state immediately so a crash before flush still leaves
    // the next boot a version to diff against.
    writeBootState({ lastSeenVersion: currentVersion, lastSeenAt: bootAt });

    return {
      currentVersion,
      previousVersion,
      versionChanged,
      bootAt,
      lastSeenAt: prior.lastSeenAt,
      changelog,
    };
  }

  /** Refresh the persisted heartbeat so the *next* restart can measure
   *  downtime as `now − lastSeenAt`. Called periodically by the health
   *  poller from steady state. No-op-safe if boot-state is unwritable. */
  static heartbeat(): void {
    writeBootState({ lastSeenVersion: readAppVersion(), lastSeenAt: Date.now() });
  }

  /** Initialise the grace window. Called from `HealthService.init`
   *  once per server start. Repeated calls are no-ops so HMR
   *  reloads in dev don't reset the timer. */
  static start(opts: { maxMs?: number; settleMs?: number } = {}): void {
    if (this.active) return;
    this.active = true;
    this.pending = [];
    this.restart = this.restartOverride ?? this.captureRestartContext();
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

    const restart = this.restart;
    const versionChanged = restart?.versionChanged ?? false;

    // When-to-send (#1653): send on a version change OR any remaining root
    // failure. Stay silent only on a plain no-version-change clean restart —
    // the uneventful case where nothing's failing and we're on the same
    // version as before.
    if (stillFailing.length === 0 && !versionChanged) {
      logger.info(
        'NotificationBatcher',
        `Boot grace ${reason}: ${total} transient event${total === 1 ? '' : 's'} settled cleanly, no version change, no email sent.`,
      );
      return;
    }

    const subject = this.buildSubject(stillFailing, restart);
    const body = this.buildBody(stillFailing, finalState.size, reason, restart);

    try {
      await sendEmailAlert(subject, body);
      logger.info(
        'NotificationBatcher',
        `Sent restart digest (${reason}): ${stillFailing.length} still-failing root(s), versionChanged=${versionChanged}.`,
      );
    } catch (e) {
      logger.warn(
        'NotificationBatcher',
        `Digest email failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  /** Subject line (#1653). Leads with the restart framing — version change
   *  if any — then the count of still-failing roots:
   *    `ServiceBay restarted — updated to v4.94.0, 2 checks still failing (a, b)` */
  private static buildSubject(
    stillFailing: PendingAlert[],
    restart: RestartContext | null,
  ): string {
    const head = restart?.versionChanged
      ? `ServiceBay restarted — updated to v${restart.currentVersion}`
      : `ServiceBay restarted`;

    if (stillFailing.length === 0) {
      // Reached only on a version change with a clean recovery.
      return `${head}, all checks healthy`;
    }
    const names = stillFailing.map(a => a.check.name);
    const shown = names.slice(0, 3).join(', ');
    const more = names.length > 3 ? `, +${names.length - 3} more` : '';
    const plural = stillFailing.length === 1 ? 'check' : 'checks';
    return `${head}, ${stillFailing.length} ${plural} still failing (${shown}${more})`;
  }

  /** Digest body (#1653): restart framing (version change, recovery
   *  duration, changelog highlights) followed by the still-failing roots. */
  private static buildBody(
    stillFailing: PendingAlert[],
    uniqueChanged: number,
    reason: 'settled' | 'max-grace-elapsed' | 'manual',
    restart: RestartContext | null,
  ): string {
    const sections: string[] = [];

    if (restart) {
      const framing: string[] = [];
      if (restart.versionChanged) {
        framing.push(`Updated to v${restart.currentVersion} (was v${restart.previousVersion}).`);
      } else {
        framing.push(`Restarted on v${restart.currentVersion} — no version change.`);
      }
      // Recovery duration: from the last healthy heartbeat before the
      // restart (downtime start) through to now (all settled). Falls back to
      // boot→now when no prior heartbeat is known (first boot).
      const recoveredFrom = restart.lastSeenAt ?? restart.bootAt;
      framing.push(`Recovered in ${formatDuration(Date.now() - recoveredFrom)}.`);
      sections.push(framing.join(' '));

      if (restart.changelog.length > 0) {
        sections.push(
          `What changed:\n${restart.changelog.map(h => `  • ${h}`).join('\n')}`,
        );
      }
    }

    if (stillFailing.length === 0) {
      sections.push('All health checks recovered cleanly after the restart.');
      return sections.join('\n\n');
    }

    const summary =
      `Boot grace window (${reason === 'settled' ? 'stabilised early' : reason === 'max-grace-elapsed' ? 'max duration reached' : 'flushed'}). `
      + `${stillFailing.length} of ${uniqueChanged} unique check${uniqueChanged === 1 ? '' : 's'} `
      + `that changed state during the window ${stillFailing.length === 1 ? 'is' : 'are'} still failing (root cause${stillFailing.length === 1 ? '' : 's'} only).`;
    sections.push(summary);
    sections.push(stillFailing.map(a => formatAlert(a.kind, a.check, a.result)).join('\n---\n'));

    return sections.join('\n\n');
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
    this.restart = null;
    this.restartOverride = null;
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

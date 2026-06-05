/**
 * Orphan-container reconcile (#1668).
 *
 * podman's container DB lives on the preserved RAID
 * (`/mnt/data/containers/storage`) and survives an OS-disk reinstall, but
 * the quadlet *units* that managed those containers do not. After a
 * wipe-and-reinstall the DB can therefore hold stale container records
 * whose managing `PODMAN_SYSTEMD_UNIT` no longer exists on disk — they
 * surface in the UI as ghost "Unmanaged Bundle" pods (e.g. an exited
 * `hermes-hermes` labelled `PODMAN_SYSTEMD_UNIT=hermes.service` where that
 * unit is gone).
 *
 * This module reconciles podman's preserved DB against the present quadlet
 * units: it `podman rm`s ONLY genuinely-orphaned records.
 *
 * CRITICAL GUARDRAIL — the orphan predicate is strict. A record is only an
 * orphan when ALL of:
 *   1. it carries a `PODMAN_SYSTEMD_UNIT` label, AND
 *   2. that managing unit file is ABSENT on disk (a ghost of a prior
 *      install — `systemctl --user show -p LoadState` reports
 *      `not-found` / empty `FragmentPath`), AND
 *   3. the container is NOT running.
 *
 * A running container, or one whose managing quadlet/unit IS present, is
 * NEVER reconciled — that includes the CURRENT, kept hermes/OSCAR service
 * (running, with its quadlet present). Only the stale `Exited(0)` ghost of
 * an old install whose unit is gone is removed.
 *
 * This is invoked on an explicit reinstall/startup reconcile pass, not as
 * an aggressive auto-`rm` at arbitrary moments.
 */

import { getPodmanPs } from '@/lib/manager';
import { getExecutor } from '@/lib/executor';
import type { PodmanConnection } from '@/lib/nodes';
import { logger } from '@/lib/logger';

/** Minimal shape of a `podman ps -a --format json` record we reason about. */
export interface ContainerRecord {
  Id: string;
  Names?: string[];
  /** podman container state, e.g. `running`, `exited`, `created`. */
  State?: string;
  Labels?: Record<string, string> | null;
}

/** First non-empty container name (with leading `/` stripped), else the id. */
export function containerDisplayName(record: ContainerRecord): string {
  const name = (record.Names || [])
    .map(n => (typeof n === 'string' ? n.replace(/^\//, '') : ''))
    .find(n => n.length > 0);
  return name || record.Id.substring(0, 12);
}

/**
 * Strict orphan predicate. Returns true only for a genuinely-orphaned
 * record: it has a managing systemd unit label, that unit's file is ABSENT,
 * and the container is not running.
 *
 * @param record           the podman container record.
 * @param managingUnitExists whether the unit named by the record's
 *                           `PODMAN_SYSTEMD_UNIT` label currently exists on
 *                           disk. Callers resolve this via systemd.
 */
export function isOrphanedContainerRecord(
  record: ContainerRecord,
  managingUnitExists: boolean,
): boolean {
  const unit = record.Labels?.['PODMAN_SYSTEMD_UNIT'];
  // (1) must be a systemd-managed record — no label means it's an
  //     ad-hoc container we don't own; never reconcile.
  if (!unit) return false;
  // (3) never touch a running container.
  if (isRunningState(record.State)) return false;
  // (2) only orphaned when its managing unit is gone.
  return !managingUnitExists;
}

function isRunningState(state: string | undefined): boolean {
  if (!state) return false;
  const normalized = state.toLowerCase();
  // `running` and the transient `stopping` both mean a live container; be
  // conservative and treat anything that isn't a clearly-dead state as
  // running so we never remove an in-flight container.
  return normalized !== 'exited'
    && normalized !== 'stopped'
    && normalized !== 'created'
    && normalized !== 'configured'
    && normalized !== 'dead';
}

/**
 * Resolve whether a `*.service` unit currently exists on disk by asking
 * systemd. A unit that has no fragment and loads as `not-found` is gone.
 */
async function unitFileExists(
  unit: string,
  executor: ReturnType<typeof getExecutor>,
): Promise<boolean> {
  try {
    const { stdout } = await executor.execArgv([
      'systemctl', '--user', 'show', '-p', 'LoadState', '-p', 'FragmentPath', unit,
    ]);
    const loadState = /^LoadState=(.*)$/m.exec(stdout)?.[1]?.trim() ?? '';
    const fragmentPath = /^FragmentPath=(.*)$/m.exec(stdout)?.[1]?.trim() ?? '';
    if (loadState === 'not-found' || loadState === 'masked') return false;
    // A loaded unit has a FragmentPath; a ghost reports loaded=='' and no
    // fragment. Require a fragment path to consider the unit present.
    return fragmentPath.length > 0;
  } catch (e) {
    // If we can't determine the unit state, fail SAFE: treat the unit as
    // present so we never remove a container we're unsure about.
    logger.warn('reconcileOrphans', `unit existence probe failed for ${unit}: ${e instanceof Error ? e.message : String(e)}`);
    return true;
  }
}

export interface ReconcileOrphanResult {
  /** Container names removed because their managing unit was gone. */
  removed: string[];
  /** Container names that were orphans but failed to remove. */
  failed: { name: string; error: string }[];
  /** Total candidate records inspected (labelled + not running). */
  inspected: number;
}

/**
 * Reconcile podman's preserved container DB against the present quadlet
 * units. `podman rm`s only genuinely-orphaned records (see
 * {@link isOrphanedContainerRecord}). Best-effort: a probe/removal failure
 * never throws.
 */
export async function reconcileOrphanContainers(
  connection?: PodmanConnection,
): Promise<ReconcileOrphanResult> {
  const executor = getExecutor(connection);
  const removed: string[] = [];
  const failed: { name: string; error: string }[] = [];
  let inspected = 0;

  let containers: ContainerRecord[] = [];
  try {
    containers = (await getPodmanPs(connection)) as ContainerRecord[];
  } catch (e) {
    logger.warn('reconcileOrphans', `podman ps failed, nothing to reconcile: ${e instanceof Error ? e.message : String(e)}`);
    return { removed, failed, inspected };
  }

  for (const record of containers) {
    const unit = record.Labels?.['PODMAN_SYSTEMD_UNIT'];
    // Only labelled, non-running records are even candidates — skip the
    // unit-existence probe for everything else (cheap + safe).
    if (!unit || isRunningState(record.State)) continue;
    inspected += 1;

    const exists = await unitFileExists(unit, executor);
    if (!isOrphanedContainerRecord(record, exists)) continue;

    const name = containerDisplayName(record);
    try {
      await executor.execArgv(['podman', 'rm', '-f', record.Id]);
      removed.push(name);
      logger.info('reconcileOrphans', `Removed orphan container ${name} (managing unit ${unit} is gone).`);
    } catch (e) {
      failed.push({ name, error: e instanceof Error ? e.message : String(e) });
      logger.warn('reconcileOrphans', `Failed to remove orphan container ${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return { removed, failed, inspected };
}

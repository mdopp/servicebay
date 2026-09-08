/**
 * `installed_templates_drift` probe (#2902) — reports where
 * `config.installedTemplates` and the services that actually exist have
 * fallen out of step, in BOTH directions, and offers the one-click
 * reconcile that repairs the direction which is safe to repair.
 *
 * Why a probe at all: `installedTemplates` is what upgrade planning
 * (`/napi/upgrades`, the bulk upgrade plan), migration chains, backup
 * gating and `autoRestoreServiceOnReinstall` reason about. #2863 stopped
 * `delete_service` from CREATING drift and added a boot reconcile, but a
 * box only boots when it is restarted, and nothing ever *said* that the
 * map had drifted — so seven stale records sat there unnoticed for days.
 *
 * The two directions are not symmetrical, and the difference is the whole
 * point of this module:
 *
 *  - **Record with no service** — either the service is in the trash
 *    (`awaitingRestore`: NOT drift; `restore_trashed_service` needs that
 *    record, #2859/#2862/#2863) or it exists nowhere at all
 *    (`orphanedRecords`: drift, and the reconcile action drops it).
 *  - **Service with no record** (`unrecordedServices`) — reported, never
 *    repaired: this side can only be fixed by an install, and inventing a
 *    record would make upgrade planning act on a schemaVersion nobody
 *    wrote.
 *
 * "Came from a template" is decided by EVIDENCE, never by the shape of a
 * name (see `collectTemplateOriginNames`). Without that rule the probe
 * would nag about `servicebay` (the control plane itself) and about the
 * `solaris-*` / `llama-embed` sidecar units a stack's post-deploy writes.
 * The tempting `<record>-<suffix>` sibling heuristic is deliberately NOT
 * used: `solaris-import-google` is a real template that happens to look
 * like a `solaris` sibling, so shape-matching would hide exactly the
 * unrecorded install this direction exists to surface.
 */

import { getConfig, type AppConfig } from '@/lib/config';
import { getTemplates } from '@/lib/registry';
import { ServiceManager } from '@/lib/services/ServiceManager';
import {
  findInstalledTemplateDrift,
  reconcileInstalledTemplates,
} from '@/lib/install/reconcileInstalledTemplates';
import { logger } from '@/lib/logger';
import { registerProbeAction, type ProbeActionResult, type ProbeItem } from '../actions';

const PROBE_ID = 'installed_templates_drift';
const RECONCILE_ACTION_ID = 'reconcile_installed_templates';

export interface InstalledTemplateDriftInput {
  /** Keys of `config.installedTemplates`. */
  installedNames: readonly string[];
  /** Base names of the `<name>.kube` / `<name>.container` units on the node. */
  quadletBaseNames: readonly string[];
  /** Service names with a restorable trash entry. */
  trashedServices: readonly string[];
  /**
   * Names for which there is EVIDENCE that a template install produced
   * them: a template of that name resolves in a registry, or the config
   * still carries a per-service install stamp for it. A service outside
   * this set is never reported as "unrecorded" — it may simply not be a
   * template install (the control plane, a stack's sidecar unit, a
   * hand-rolled Quadlet).
   */
  templateOriginNames: readonly string[];
}

export interface InstalledTemplateDriftReport {
  /** Records whose service exists neither as a unit nor in the trash. */
  orphanedRecords: string[];
  /** Records kept on purpose: the service is trashed and still restorable. */
  awaitingRestore: string[];
  /** Services with template evidence but no install record. */
  unrecordedServices: string[];
}

/** Pure: classify both directions of drift. No I/O, no config write. */
export function classifyInstalledTemplateDrift(
  input: InstalledTemplateDriftInput,
): InstalledTemplateDriftReport {
  const quadlets = new Set(input.quadletBaseNames);
  const trashed = new Set(input.trashedServices);
  const installed = new Set(input.installedNames);
  const origin = new Set(input.templateOriginNames);

  const orphanedRecords = findInstalledTemplateDrift(
    input.installedNames,
    input.quadletBaseNames,
    input.trashedServices,
  ).map(d => d.name);

  return {
    orphanedRecords: orphanedRecords.sort(),
    awaitingRestore: input.installedNames
      .filter(name => !quadlets.has(name) && trashed.has(name))
      .sort(),
    unrecordedServices: input.quadletBaseNames
      .filter(name => !installed.has(name) && origin.has(name))
      .sort(),
  };
}

/**
 * The evidence set for "this name came from a template install":
 *  1. a template (or stack) of that exact name resolves in a registry, and
 *  2. the config carries a per-service install stamp — a `servicePostDeploy`
 *     entry or an `installedVariables` row scoped to that service — both of
 *     which only the install path writes.
 *
 * A registry that can't be read contributes nothing rather than failing the
 * probe: the worst case is a genuine unrecorded install going unreported for
 * one run, never a false accusation against a hand-rolled unit.
 */
export async function collectTemplateOriginNames(config: AppConfig): Promise<string[]> {
  const names = new Set<string>();
  try {
    for (const t of await getTemplates()) names.add(t.name);
  } catch (e) {
    logger.warn('diagnose:installed_templates_drift', `Could not list templates: ${e instanceof Error ? e.message : String(e)}`);
  }
  for (const name of Object.keys(config.servicePostDeploy ?? {})) names.add(name);
  for (const v of config.installedVariables ?? []) {
    if (v.service) names.add(v.service);
  }
  return [...names];
}

export interface InstalledTemplatesDriftResult {
  status: 'ok' | 'warn' | 'info';
  detail: string;
  hint?: string;
  items?: ProbeItem[];
}

/** One-line summary of the direction(s) found, naming the services. */
function driftDetail(report: InstalledTemplateDriftReport, recordCount: number, serviceCount: number): string {
  const parts: string[] = [];
  if (report.orphanedRecords.length > 0) {
    parts.push(`${report.orphanedRecords.length} install record(s) name a service that exists nowhere on the box: ${report.orphanedRecords.join(', ')}`);
  }
  if (report.unrecordedServices.length > 0) {
    parts.push(`${report.unrecordedServices.length} service(s) came from a template but carry no install record: ${report.unrecordedServices.join(', ')}`);
  }
  parts.push(`${recordCount} record(s) against ${serviceCount} service(s)`);
  return `${parts.join('. ')}.`;
}

/** Which direction the operator is looking at, and what to do about it. */
function driftHint(report: InstalledTemplateDriftReport): string {
  const hints: string[] = [];
  if (report.orphanedRecords.length > 0) {
    hints.push('Records without a service: upgrade planning, migration chains and backup gating all read this map, so each one makes them plan for a service that does not exist. "Drop orphaned records" removes exactly these.');
  }
  if (report.unrecordedServices.length > 0) {
    hints.push('Services without a record: they are running and a template of that name exists, but ServiceBay will never upgrade or template-back-up them. Re-install/upgrade the service from its template to restore the record — the reconcile only ever removes records, it never invents one.');
  }
  if (report.awaitingRestore.length > 0) {
    hints.push(`Kept on purpose: ${report.awaitingRestore.join(', ')} — the service is in the trash and its record is what a restore needs.`);
  }
  return hints.join(' ');
}

export async function checkInstalledTemplatesDrift(nodeName: string): Promise<InstalledTemplatesDriftResult> {
  const quadletBaseNames = await ServiceManager.listQuadletBaseNames(nodeName);
  if (quadletBaseNames === null) {
    // An unreadable node is not an empty one — the same rule the reconcile
    // itself follows, so a transient agent failure can't look like drift.
    return {
      status: 'info',
      detail: `Skipped: could not read the Quadlet units on ${nodeName}.`,
    };
  }
  const config = await getConfig();
  const trashed = await ServiceManager.listTrashedServices(nodeName).catch(() => []);
  const installedNames = Object.keys(config.installedTemplates ?? {});
  const report = classifyInstalledTemplateDrift({
    installedNames,
    quadletBaseNames,
    trashedServices: trashed.map(t => t.service),
    templateOriginNames: await collectTemplateOriginNames(config),
  });

  if (report.orphanedRecords.length === 0 && report.unrecordedServices.length === 0) {
    const kept = report.awaitingRestore.length > 0
      ? ` ${report.awaitingRestore.length} record(s) kept for a restore from the trash: ${report.awaitingRestore.join(', ')}.`
      : '';
    return {
      status: 'ok',
      detail: `${installedNames.length} install record(s) line up with the ${quadletBaseNames.length} service(s) on the node.${kept}`,
    };
  }

  const items: ProbeItem[] = [
    ...report.orphanedRecords.map(name => ({
      id: `record:${name}`,
      label: name,
      detail: 'Install record with no unit and no trash entry — the service exists nowhere.',
      status: 'warn' as const,
      actionIds: [],
    })),
    ...report.unrecordedServices.map(name => ({
      id: `service:${name}`,
      label: name,
      detail: 'Service came from a template but has no install record — it is invisible to upgrades and template backups.',
      status: 'warn' as const,
      actionIds: [],
    })),
  ];
  return {
    status: 'warn',
    detail: driftDetail(report, installedNames.length, quadletBaseNames.length),
    hint: driftHint(report),
    items,
  };
}

/**
 * The operator-runnable half of #2902: drop the orphaned records without
 * SSH. Dispatched from the diagnose row (`POST /api/system/diagnose/run-action`),
 * so the same repair the boot reconcile does is available on demand and is
 * idempotent — a second click drops nothing and says so.
 */
async function reconcileRecords({ node }: { node: string }): Promise<ProbeActionResult> {
  try {
    const quadletBaseNames = await ServiceManager.listQuadletBaseNames(node);
    if (quadletBaseNames === null) {
      return {
        ok: false,
        message: `Could not read the Quadlet units on ${node}, so nothing was changed — an unreadable node is not an empty one.`,
        refresh: false,
      };
    }
    const trashed = await ServiceManager.listTrashedServices(node).catch(() => []);
    const dropped = await reconcileInstalledTemplates({
      quadletBaseNames,
      trashedServices: trashed.map(t => t.service),
    });
    if (dropped.length === 0) {
      return {
        ok: true,
        message: 'Nothing to drop — every install record still has a service on the node or a restorable trash entry.',
        refresh: true,
      };
    }
    logger.info('diagnose:installed_templates_drift', `Operator reconcile dropped ${dropped.map(d => d.name).join(', ')}`);
    return {
      ok: true,
      message: `Dropped ${dropped.length} orphaned install record(s): ${dropped.map(d => d.name).join(', ')}. Upgrade planning, migrations and backup gating no longer see them.`,
      refresh: true,
    };
  } catch (e) {
    return {
      ok: false,
      message: `Reconcile failed: ${e instanceof Error ? e.message : String(e)}`,
      refresh: false,
    };
  }
}

registerProbeAction(
  PROBE_ID,
  {
    id: RECONCILE_ACTION_ID,
    label: 'Drop orphaned records',
    description:
      'Removes the install records whose service exists nowhere on the box — no Quadlet unit and no trash entry. A service sitting in the trash keeps its record, because restoring it needs one, and no record is ever created. Afterwards upgrade planning, migration chains and backup gating stop reasoning about services that are gone. Re-installing such a service writes a fresh record.',
    destructive: true,
  },
  reconcileRecords,
);

// Reconcile `config.installedTemplates` against the services that actually
// exist (#2863).
//
// `installedTemplates` is what upgrade planning (`/napi/upgrades`, the bulk
// upgrade plan), migration chains, backup gating and `autoRestoreServiceOnReinstall`
// reason about. A delete that dropped the unit but left the record behind — the
// pre-#2863 soft-delete, and every hand-removed service — made all of them plan
// for services that do not exist (5 orphaned records measured on the box:
// `ollama`, `asteroids-spike`, `asteroids-qwen2`, `asteroids-dino`,
// `asteroids-dino-r8`).
//
// The rule is deliberately narrow: an entry is dropped ONLY when the service has
// neither a Quadlet unit on disk NOR a trash entry waiting to be restored. A
// trashed service keeps its record in the trash manifest, not here, so it must
// not be reported as drift either. Nothing is ever auto-CREATED — this reconcile
// can only remove, so a missing record stays a question for the install path.
//
// This is the *decision*; the caller supplies the two ground truths (via the
// ServiceManager facade) so this module stays pure enough to test and free of
// the service-mutation import rule.

import { getConfig, saveConfig } from '@/lib/config';
import { logger } from '@/lib/logger';

export interface InstalledTemplateDrift {
  name: string;
  reason: string;
}

export interface ReconcileInput {
  /** Base names of `<name>.kube` / `<name>.container` on the node. `null` when
   *  the node could not be read — the reconcile then does nothing at all. */
  quadletBaseNames: string[] | null;
  /** Service names that currently have a trash entry (restorable). */
  trashedServices: string[];
}

/** Pure: which `installedTemplates` keys have neither a unit nor a trash entry. */
export function findInstalledTemplateDrift(
  installedNames: readonly string[],
  quadletBaseNames: readonly string[],
  trashedServices: readonly string[],
): InstalledTemplateDrift[] {
  const quadlets = new Set(quadletBaseNames);
  const trashed = new Set(trashedServices);
  return installedNames
    .filter(name => !quadlets.has(name) && !trashed.has(name))
    .map(name => ({ name, reason: 'no Quadlet unit and no trash entry' }));
}

/**
 * Drop the drifted entries from the persisted config and return what went.
 * Logs each drop once (the entry is gone afterwards, so it cannot repeat).
 * A no-op — no write — when the node could not be read or nothing drifted.
 */
export async function reconcileInstalledTemplates(input: ReconcileInput): Promise<InstalledTemplateDrift[]> {
  if (input.quadletBaseNames === null) {
    logger.warn('install:reconcile', 'installedTemplates reconcile skipped — could not read the node\'s Quadlet units');
    return [];
  }
  const config = await getConfig();
  const installed = config.installedTemplates ?? {};
  const drift = findInstalledTemplateDrift(Object.keys(installed), input.quadletBaseNames, input.trashedServices);
  if (drift.length === 0) return [];
  const next = { ...installed };
  for (const d of drift) {
    delete next[d.name];
    logger.info('install:reconcile', `Dropped installedTemplates record for ${d.name} — ${d.reason} (#2863)`);
  }
  config.installedTemplates = next;
  await saveConfig(config);
  return drift;
}

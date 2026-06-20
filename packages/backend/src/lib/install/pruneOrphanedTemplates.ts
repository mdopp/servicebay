// Prune ORPHANED installedTemplates entries (#health-hermes-ghost).
//
// A template can be removed/renamed in the catalogue (the OSCAR→solbay→solaris
// churn deleted `hermes`, `hermes-chat`, `solilos-chat`, `solbay`, `solilos`,
// `oscar-household`) while its entry lingers in `config.installedTemplates`. The
// normal stack wipe can't clear it ("Stack has no manifest"), so it sticks
// forever — and self-diagnose probes keyed on `installedTemplates` (e.g.
// `hermes_chat`) keep firing for a service that no longer exists, nagging the
// operator about a thing they already uninstalled.
//
// This prunes an entry IFF it is BOTH:
//   1. manifest-less — `getTemplateVariables(name)` is null (no variables.json in
//      local or any registry), so it can never be (re)installed/rendered, AND
//   2. not backed by any RUNNING container.
// The double guard is critical: a still-running family (e.g. `solaris`, whose 6
// containers are live) is NEVER pruned even if its manifest moved, and a valid
// template whose registry is momentarily unreachable is protected by guard 2 if
// it has containers. (A registry blip on a manifest-less AND container-less entry
// is the only false-positive window — and such an entry is already dead weight.)

import { getConfig, saveConfig } from '@/lib/config';
import { getTemplateVariables } from '@/lib/registry';
import { logger } from '@/lib/logger';

export interface OrphanedTemplate {
  name: string;
  reason: string;
}

/** True when a running-container name belongs to template `name` — either the
 *  container IS the template (`name`) or is one of its pod containers
 *  (`name-<container>`, the Quadlet/kube naming). */
function hasRunningContainer(name: string, runningContainers: readonly string[]): boolean {
  return runningContainers.some(c => c === name || c.startsWith(`${name}-`));
}

/**
 * Find installedTemplates entries that are orphaned (manifest-less AND not
 * backed by a running container). Pure read — does not mutate. `runningContainers`
 * is the live `podman ps` name list, injected so this stays testable and the
 * caller controls the node/exec.
 */
export async function findOrphanedTemplates(runningContainers: readonly string[]): Promise<OrphanedTemplate[]> {
  const config = await getConfig();
  const installed = config.installedTemplates ?? {};
  const orphans: OrphanedTemplate[] = [];
  for (const name of Object.keys(installed)) {
    const meta = await getTemplateVariables(name).catch(() => null);
    if (meta !== null) continue; // manifest exists → installable/renderable → keep
    if (hasRunningContainer(name, runningContainers)) continue; // still running → keep
    orphans.push({ name, reason: 'no template manifest and no running container (removed/renamed service)' });
  }
  return orphans;
}

/**
 * Remove orphaned installedTemplates entries from the persisted config and return
 * what was pruned. Uses read→mutate→saveConfig (NOT updateConfig, whose deepMerge
 * can't delete keys). A no-op (empty result, no write) when nothing is orphaned.
 */
export async function pruneOrphanedTemplates(runningContainers: readonly string[]): Promise<OrphanedTemplate[]> {
  const orphans = await findOrphanedTemplates(runningContainers);
  if (orphans.length === 0) return [];
  const config = await getConfig();
  const next = { ...(config.installedTemplates ?? {}) };
  for (const o of orphans) delete next[o.name];
  config.installedTemplates = next;
  await saveConfig(config);
  logger.info('install:prune', `pruned ${orphans.length} orphaned template(s): ${orphans.map(o => o.name).join(', ')}`);
  return orphans;
}

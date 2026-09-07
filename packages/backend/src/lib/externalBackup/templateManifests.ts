/**
 * The I/O half of the backup bridge (#2858, slice C): read each installed
 * template's `servicebay.backup` annotation off disk and resolve it into the
 * runtime manifests, through the pure rules in `./backupDeclaration` — the
 * same code `scripts/check-backup-coverage.ts` gates on.
 *
 * Nothing here decides what a backup contains; it only decides WHICH templates
 * to ask. A declaration problem is logged, never thrown: a broken annotation
 * must not abort a deploy, but it must never be silent either — silence is how
 * three services sat un-backed-up while the nightly run reported success
 * (#2595).
 */

import { getConfig } from '@/lib/config';
import { logger } from '@/lib/logger';
import { getTemplateYaml } from '@/lib/registry';
import { parseTemplateManifest } from '@/lib/template/contract';
import type { ServiceBackupManifest } from '@servicebay/backup-manifest';

import { resolveTemplateBackupDeclaration } from './backupDeclaration';

const LOG_SCOPE = 'ExternalBackup';

/** Read a template's `servicebay.backup` body, or `undefined` when the
 *  template is unreadable / unparseable / carries no annotation. */
async function readTemplateBackupRaw(template: string): Promise<string | undefined> {
  const yamlText = await getTemplateYaml(template).catch(() => null);
  if (!yamlText) return undefined;
  const parsed = parseTemplateManifest(yamlText);
  return parsed.ok ? parsed.manifest.backupRaw : undefined;
}

/** The manifests ONE template contributes (its own store + its `stores:`).
 *  Problems are logged, never thrown: a broken declaration must not abort a
 *  deploy, but it must never be silent either. */
export async function resolveTemplateManifests(template: string): Promise<ServiceBackupManifest[]> {
  const resolution = resolveTemplateBackupDeclaration(template, await readTemplateBackupRaw(template));
  for (const problem of resolution.problems) logger.warn(LOG_SCOPE, problem);
  return resolution.manifests;
}

/**
 * Every manifest the box's INSTALLED templates declare — the replacement for
 * `SERVICE_BACKUP_MANIFESTS.filter(installed)`. A template's declaration is
 * itself the gate: a `stores:` entry activates because its declaring template
 * is installed, which is exactly what `gateOn` meant.
 */
export async function resolveInstalledBackupManifests(): Promise<ServiceBackupManifest[]> {
  const installed = Object.keys((await getConfig()).installedTemplates ?? {});
  const out: ServiceBackupManifest[] = [];
  for (const template of installed) out.push(...(await resolveTemplateManifests(template)));
  return out;
}

/**
 * The manifest for one service, or `undefined`. Looks in the service's own
 * template first — so a template being installed for the FIRST time (not yet
 * in `installedTemplates`) resolves — then across the installed templates,
 * which is where a `stores:` entry like `home-assistant-zwave` lives.
 */
export async function resolveServiceBackupManifest(
  service: string,
): Promise<ServiceBackupManifest | undefined> {
  const own = (await resolveTemplateManifests(service)).find(m => m.service === service);
  if (own) return own;
  const installed = Object.keys((await getConfig()).installedTemplates ?? {});
  for (const template of installed) {
    if (template === service) continue;
    const found = (await resolveTemplateManifests(template)).find(m => m.service === service);
    if (found) return found;
  }
  return undefined;
}

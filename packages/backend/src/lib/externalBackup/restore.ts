/**
 * Restore a per-service config backup from the FritzBox NAS back into its
 * on-disk data dir — the consumer half of the config-survival feature
 * (#1218, epic #1190). The producer (`producer.ts`) writes
 * `sb-backup/<service>.tar`; this fetches it and safely extracts the manifest
 * config files into `<DATA_DIR>/<service>`, so a fresh install / reinstall
 * re-seeds the same config.
 *
 * Guard: by default we only restore into an EMPTY or absent data dir, so a
 * restore never clobbers a live service's config. The reinstall auto-detect
 * (#1218 entry point 1) relies on this default; pass `force: true` for a
 * deliberate operator-triggered overwrite.
 *
 * Extraction goes through `safeTarExtract` (the #580 hardened restore path:
 * refuses absolute paths / `..` traversal / link escapes) — our service tars
 * are plain (uncompressed), hence `gzip: false`.
 */
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { fetchServiceBackup, listServiceBackups, resolveServiceDataDir, type ServiceBackupMeta } from './producer';
import { getServiceManifest } from './serviceManifest';
import { safeTarExtract } from '../systemBackup';
import { logger } from '../logger';

export interface RestoreResult {
  service: string;
  dataDir: string;
  files: number;
  meta: ServiceBackupMeta | null;
}

/** True if `dir` is empty or doesn't exist — the safe-to-seed condition. */
export async function isFreshDataDir(dir: string): Promise<boolean> {
  try {
    const entries = await fs.readdir(dir);
    return entries.length === 0;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw e;
  }
}

/** Count regular files under `dir` (recursively) — for the restore summary. */
async function countFiles(dir: string): Promise<number> {
  let total = 0;
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await countFiles(full);
    else if (entry.isFile()) total += 1;
  }
  return total;
}

/**
 * Restore `<service>.tar` from the NAS into the service's data dir.
 * Refuses a non-empty data dir unless `force` is set. Returns the data dir,
 * the number of files restored, and the backup's meta sidecar (if present).
 */
export async function restoreServiceBackup(
  service: string,
  opts: { force?: boolean } = {},
): Promise<RestoreResult> {
  if (!getServiceManifest(service)) {
    throw new Error(`No backup manifest for service "${service}"`);
  }
  const dataDir = await resolveServiceDataDir(service);
  if (!opts.force && !(await isFreshDataDir(dataDir))) {
    throw new Error(
      `Refusing to restore "${service}": ${dataDir} already has data. Restore ` +
      `only seeds a fresh/empty data dir; pass force to overwrite a live service.`,
    );
  }

  const { tar, meta } = await fetchServiceBackup(`${service}.tar`);

  // safeTarExtract reads from a path, so stage the fetched tar to a temp file.
  const tmp = path.join(os.tmpdir(), `sb-restore-${service}-${Date.now()}.tar`);
  try {
    await fs.writeFile(tmp, tar);
    await fs.mkdir(dataDir, { recursive: true });
    await safeTarExtract(tmp, dataDir, { gzip: false });
  } finally {
    await fs.rm(tmp, { force: true });
  }

  const files = await countFiles(dataDir);
  logger.info('ExternalBackup', `Restored "${service}" from NAS into ${dataDir} (${files} files)`);
  return { service, dataDir, files, meta };
}

/**
 * #1218 entry point 1 — auto-restore a service's config from the NAS during a
 * **reinstall**, before its pod starts. No-op (and never throws) unless:
 *  - this is a clean install / reinstall (`cleanInstall`), AND
 *  - the node is Local (the restore primitive uses the backend's own fs), AND
 *  - a `<service>.tar` exists on the NAS, AND
 *  - the service's data dir is empty (`restoreServiceBackup` also refuses a
 *    non-empty dir, so a live service's config is never clobbered).
 * Logs each step through the injected `log` so it shows on the install stream.
 * Best-effort: a restore failure is logged and swallowed so it can't block the
 * deploy. The install runner calls this from `deployItem` (epic #1190).
 */
export async function autoRestoreServiceOnReinstall(
  service: string,
  opts: { cleanInstall?: boolean; node?: string | null },
  log: (line: string) => Promise<void>,
): Promise<void> {
  if (!opts.cleanInstall) return;
  if (opts.node && opts.node !== 'Local') return;
  try {
    const hasBackup = (await listServiceBackups()).some(b => b.service === service);
    if (!hasBackup) return;
    if (!(await isFreshDataDir(await resolveServiceDataDir(service)))) return;
    await log(`💾 ${service}: found a config backup on the FritzBox NAS and the data dir is empty — restoring before first start…`);
    const r = await restoreServiceBackup(service);
    await log(`✅ ${service}: restored ${r.files} config file(s) from the NAS${r.meta ? ` (backed up ${r.meta.createdAt.slice(0, 10)} from ${r.meta.nodeId})` : ''}.`);
  } catch (e) {
    // A restore failure must never block the deploy — log a breadcrumb and continue.
    await log(`(note) ${service}: NAS config restore skipped — ${e instanceof Error ? e.message : String(e)}.`);
  }
}

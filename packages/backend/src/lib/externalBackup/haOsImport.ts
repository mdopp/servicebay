/**
 * Import a Home Assistant OS (Supervisor) backup into the FritzBox-NAS
 * config-survival format (#1353, epic #1350).
 *
 * A Supervisor backup is a tar containing `backup.json`, `homeassistant.tar.gz`,
 * and per-add-on `core_*.tar.gz`. The dockerized Home Assistant only needs the
 * core config, which lives inside `homeassistant.tar.gz` under `data/`
 * (configuration.yaml, .storage/, …). So we extract that `data/` dir and hand
 * it to the existing per-service backup producer — which applies the
 * `home-assistant` manifest (keep config + .storage/zwave_js keys, drop the DB
 * / logs / media) and writes the canonical `home-assistant.tar` to the NAS.
 * Reusing the producer keeps the on-NAS format identical to box-side backups
 * and what the restore flow expects — one source of truth.
 */
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
// `node:` prefix so a stray browser-polyfill in the SSR graph can't shadow
// child_process (see systemBackup.ts / producer.ts).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { backupServiceToNas, type ServiceBackupResult } from './producer';

const execFileAsync = promisify(execFile);

const HA_SERVICE = 'home-assistant';
const INNER_ARCHIVE = 'homeassistant.tar.gz';

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Extract the dockerized Home Assistant config dir (the inner
 * `homeassistant.tar.gz`'s `data/`) from a Supervisor backup tar into workDir,
 * returning its path. Throws a clear error if the archive isn't an HA backup.
 * Extraction is into an isolated temp dir (tar refuses `..`/absolute escapes by
 * default on both GNU and libarchive tar), and the producer then only copies
 * the manifest's fixed relative paths — so stray archive members can't reach
 * the NAS. Plain `tar` flags only, for portability across the dev box
 * (libarchive) and CI / the FCoS box (GNU).
 */
export async function extractHaConfigDir(haBackupTarPath: string, workDir: string): Promise<string> {
  const outerDir = path.join(workDir, 'outer');
  await fs.mkdir(outerDir, { recursive: true });
  // Pull just the core HA archive out of the (possibly large) Supervisor tar.
  try {
    await execFileAsync('tar', ['-xf', haBackupTarPath, '-C', outerDir, INNER_ARCHIVE]);
  } catch {
    throw new Error(`not a Home Assistant backup: ${INNER_ARCHIVE} not found`);
  }
  const innerTar = path.join(outerDir, INNER_ARCHIVE);
  if (!(await exists(innerTar))) {
    throw new Error(`not a Home Assistant backup: ${INNER_ARCHIVE} not found`);
  }

  const innerDir = path.join(workDir, 'inner');
  await fs.mkdir(innerDir, { recursive: true });
  await execFileAsync('tar', ['-xzf', innerTar, '-C', innerDir]);

  const dataDir = path.join(innerDir, 'data');
  if (!(await exists(dataDir))) {
    throw new Error('Home Assistant backup has no data/ config directory');
  }
  return dataDir;
}

/**
 * Import a Home Assistant OS backup tar: extract its config dir and stage the
 * manifest-filtered `home-assistant.tar` (+ meta) onto the NAS, ready for a
 * fresh install's restore. Cleans up its temp work dir.
 */
export async function importHaOsBackupToNas(haBackupTarPath: string): Promise<ServiceBackupResult> {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sb-haimport-'));
  try {
    const configDir = await extractHaConfigDir(haBackupTarPath, workDir);
    return await backupServiceToNas(HA_SERVICE, { serviceDataDir: configDir });
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}

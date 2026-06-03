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
 *
 * We extract ONLY the manifest's include paths, never the whole `data/` dir.
 * A real HA install's `data/` is hundreds of MB (the `home-assistant_v2.db`
 * alone is often >150 MB, plus HACS frontend assets) — unpacking all of that
 * into the container's space-limited `/tmp` just to discard it at the staging
 * step exhausted `/tmp` and failed the import (#1353). Selective extraction
 * keeps peak temp usage to the few MB the manifest actually keeps.
 */
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
// `node:` prefix so a stray browser-polyfill in the SSR graph can't shadow
// child_process (see systemBackup.ts / producer.ts).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { backupServiceToNas, type ServiceBackupResult } from './producer';
import { getServiceManifest } from './serviceManifest';

const execFileAsync = promisify(execFile);

const HA_SERVICE = 'home-assistant';
const INNER_ARCHIVE = 'homeassistant.tar.gz';
const DATA_PREFIX = 'data/';

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

/** A tar listing line, normalised: strip a leading `./` and any trailing `/`. */
function normaliseMember(member: string): string {
  return member.replace(/^\.\//, '').replace(/\/+$/, '');
}

/**
 * Does the relative path `rel` (under `data/`) match a manifest include? An
 * include is either an exact path (a file), a dir prefix (anything beneath it),
 * or a trailing-`*` leaf glob (`.storage/lovelace*`, `.storage/hacs*`) matching
 * any sibling whose name starts with the prefix. Mirrors the producer's
 * `resolveIncludeGlob` so HA-OS imports keep the same files a box backup does
 * (#1595 dashboards / #1596 HACS data).
 */
function matchesInclude(rel: string, inc: string): boolean {
  if (inc.endsWith('*')) {
    const prefix = inc.slice(0, -1);
    return rel === prefix || rel.startsWith(prefix);
  }
  return rel === inc || rel.startsWith(`${inc}/`);
}

/**
 * From an inner-archive listing, pick the exact member names (verbatim, so tar
 * can find them) whose path under `data/` matches one of the manifest includes
 * — either the include itself (a file), anything beneath a dir include, or a
 * trailing-`*` glob include.
 */
function selectWantedMembers(members: string[], includes: string[]): string[] {
  const wanted: string[] = [];
  for (const member of members) {
    const norm = normaliseMember(member);
    if (!norm.startsWith(DATA_PREFIX)) continue;
    const rel = norm.slice(DATA_PREFIX.length);
    if (includes.some(inc => matchesInclude(rel, inc))) {
      wanted.push(member);
    }
  }
  return wanted;
}

/**
 * Extract the dockerized Home Assistant config dir (the inner
 * `homeassistant.tar.gz`'s `data/`) from a Supervisor backup tar into workDir,
 * returning its path. Only the `includes` paths (relative to `data/`) are
 * unpacked — see the module header for why we never extract the whole dir.
 * Throws a clear error if the archive isn't an HA backup. Extraction is into an
 * isolated temp dir (tar refuses `..`/absolute escapes by default on both GNU
 * and libarchive tar), and the producer then only copies the manifest's fixed
 * relative paths — so stray archive members can't reach the NAS. Plain `tar`
 * flags only, for portability across the dev box (libarchive) and CI / the
 * FCoS box (GNU).
 */
export async function extractHaConfigDir(
  haBackupTarPath: string,
  workDir: string,
  includes: string[],
): Promise<string> {
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

  // List the inner archive and extract ONLY the manifest's include members.
  const { stdout } = await execFileAsync('tar', ['-tzf', innerTar]);
  const members = stdout.split('\n').map(s => s.trim()).filter(Boolean);
  const wanted = selectWantedMembers(members, includes);

  const innerDir = path.join(workDir, 'inner');
  await fs.mkdir(innerDir, { recursive: true });
  if (wanted.length > 0) {
    await execFileAsync('tar', ['-xzf', innerTar, '-C', innerDir, ...wanted]);
  }

  const dataDir = path.join(innerDir, DATA_PREFIX);
  if (!(await exists(dataDir))) {
    throw new Error('Home Assistant backup has no recognised config files under data/');
  }
  return dataDir;
}

/**
 * Import a Home Assistant OS backup tar: extract its config dir and stage the
 * manifest-filtered `home-assistant.tar` (+ meta) onto the NAS, ready for a
 * fresh install's restore. Cleans up its temp work dir.
 */
export async function importHaOsBackupToNas(haBackupTarPath: string): Promise<ServiceBackupResult> {
  const manifest = getServiceManifest(HA_SERVICE);
  if (!manifest) throw new Error(`No backup manifest for service "${HA_SERVICE}"`);
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sb-haimport-'));
  try {
    const configDir = await extractHaConfigDir(haBackupTarPath, workDir, manifest.include);
    return await backupServiceToNas(HA_SERVICE, { serviceDataDir: configDir });
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}

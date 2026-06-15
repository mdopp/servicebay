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
import {
  fetchServiceBackup,
  latestServiceBackupName,
  listServiceBackups,
  resolveServiceDataDir,
  type ServiceBackupMeta,
} from './producer';
import { getServiceManifest, getConfigPaths } from './serviceManifest';
import { safeTarExtract, extractServiceConfigToNode } from '../systemBackup';
import { getExecutor, type Executor } from '../executor';
import { logger } from '../logger';

/**
 * Per-service wipe mode (#1585). Structurally identical to
 * `install/jobStore.ts`'s `WipeMode` but declared locally so this backup module
 * doesn't import from the install module (the install runner already imports
 * THIS module — a cross-import would form a cycle). The install runner passes
 * its `JobInput.wipeMode` straight through.
 */
type WipeMode = 'install' | 'wipe-config' | 'wipe-all';

/**
 * The few filesystem primitives the restore + wipe logic needs, so the SAME
 * logic can run against either:
 *  - the **local** container filesystem (the unit tests / an explicit
 *    serviceDataDir under /app/data), or
 *  - the **host** filesystem via the node agent (#1600 — the box reinstall
 *    operates on `/mnt/data/stacks/<service>`, which is NOT bind-mounted into
 *    the servicebay container; only the host agent can see it, exactly as the
 *    producer's box backup does since #1597).
 *
 * This is the symmetric consumer-side counterpart to producer.ts's
 * `BackupFileBackend`: without it, a box (re)install's wipe-config "cleared"
 * nothing and the restore wrote into a container-only path the real service
 * never reads (the #1600 silent failure).
 */
interface RestoreFsBackend {
  /** True if `dir` is empty or doesn't exist — the safe-to-seed condition. */
  isFreshDir(dir: string): Promise<boolean>;
  /** Count regular files under `dir`, recursively — for the restore summary. */
  countFiles(dir: string): Promise<number>;
  mkdirp(dir: string): Promise<void>;
  /** Recursive force-remove (a file, dir, or absent path). */
  rmrf(target: string): Promise<void>;
  /**
   * Extract `tar` into `destDir`, preserving safeTarExtract's traversal guard
   * (#580/#590). The traversal/symlink-escape pre-pass always runs in-container
   * on the fetched tar bytes; only the extraction lands on this backend's side.
   */
  extractTar(tar: Buffer, destDir: string): Promise<void>;
}

/** Local-filesystem backend — the in-container path (tests / explicit dir). */
const localRestoreBackend: RestoreFsBackend = {
  async isFreshDir(dir) {
    try {
      return (await fs.readdir(dir)).length === 0;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return true;
      throw e;
    }
  },
  async countFiles(dir) {
    let total = 0;
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) total += await this.countFiles(full);
      else if (entry.isFile()) total += 1;
    }
    return total;
  },
  async mkdirp(dir) {
    await fs.mkdir(dir, { recursive: true });
  },
  async rmrf(target) {
    await fs.rm(target, { recursive: true, force: true });
  },
  async extractTar(tar, destDir) {
    // safeTarExtract reads from a path, so stage the fetched tar to a temp file.
    const tmp = path.join(os.tmpdir(), `sb-restore-${Date.now()}-${process.pid}.tar`);
    try {
      await fs.writeFile(tmp, tar);
      await fs.mkdir(destDir, { recursive: true });
      await safeTarExtract(tmp, destDir, { gzip: false });
    } finally {
      await fs.rm(tmp, { force: true });
    }
  },
};

/**
 * Host-agent backend (#1600) — every fs op runs on the HOST via the node agent,
 * so it sees `/mnt/data/stacks/<service>` (not mounted into the servicebay
 * container). Mirrors producer.ts's `agentFileBackend`.
 */
function agentRestoreBackend(executor: Executor): RestoreFsBackend {
  return {
    async isFreshDir(dir) {
      if (!(await executor.exists(dir))) return true;
      // `ls -A` lists entries (incl. dotfiles, excl. . and ..); empty stdout → fresh.
      const { stdout } = await executor.execArgv(['ls', '-A', dir]);
      return stdout.trim().length === 0;
    },
    async countFiles(dir) {
      if (!(await executor.exists(dir))) return 0;
      const { stdout } = await executor.execArgv(['find', dir, '-type', 'f']);
      return stdout.split('\n').filter(l => l.trim().length > 0).length;
    },
    async mkdirp(dir) {
      await executor.execArgv(['mkdir', '-p', dir]);
    },
    async rmrf(target) {
      await executor.execArgv(['rm', '-rf', target]);
    },
    async extractTar(tar, destDir) {
      // #1610 — the host-side per-service tar extraction (in-container
      // traversal/link pre-pass on the fetched tar bytes → base64 push →
      // host-side tar with safeTarExtract's hardening flags → host-side
      // symlink-escape walk) is the SAME engine the guided System-Snapshot
      // restore uses. Delegate to it so config-survival auto-restore and guided
      // restore can't fork their safety rails.
      await extractServiceConfigToNode(executor, tar, destDir);
    },
  };
}

/**
 * Pick the fs backend for a restore/wipe. A box (re)install operates on the
 * stacks dir, which is NOT mounted into the servicebay container, so it routes
 * through the host agent (#1600). A `local: true` opt forces the in-container
 * path (the unit tests, which stage into a real container-local temp dir).
 */
function pickRestoreBackend(opts: { node?: string | null; local?: boolean }): RestoreFsBackend {
  if (opts.local) return localRestoreBackend;
  return agentRestoreBackend(getExecutor(opts.node || 'Local'));
}

export interface RestoreResult {
  service: string;
  dataDir: string;
  files: number;
  meta: ServiceBackupMeta | null;
  /** Set when a restore touched a service whose DB carries its own admin
   *  credential (NPM, #1529) — the outcome of reconciling ServiceBay's stored
   *  credential with the restored DB. Absent for services with no credential
   *  reconciliation. */
  credentialReconcile?: { ok: boolean; message: string };
}

/**
 * After restoring a service whose DB carries an admin credential, reconcile
 * ServiceBay's stored credential with the restored DB (#1529). NPM's
 * database.sqlite ships its own admin password hash, so a restore leaves
 * ServiceBay's stored `reverseProxy.npm` credential pointing at the OLD
 * password — SB then silently 401s on every proxy auto-sync, the same
 * credential-reconciliation lockout the install runner already self-heals.
 *
 * Mirrors the install-runner self-heal: `npmAdminCredStatus` → on
 * `rejected`/`no-creds` run `rekeyNpmAdmin`, which reads the real admin email
 * from the restored DB and persists a fresh verified password. Best-effort and
 * non-throwing (a restore must not be undone by a reconcile hiccup), but the
 * outcome is surfaced on the result — never masked — so the manual re-key
 * affordance remains the fallback. No-op (`status: 'unknown'`) when NPM isn't
 * running yet, e.g. the reinstall path where the runner heals post-deploy.
 */
async function reconcileNpmCredentialAfterRestore(
  node: string,
): Promise<RestoreResult['credentialReconcile']> {
  try {
    const { npmAdminCredStatus, rekeyNpmAdmin } = await import('../reverseProxy/npmAdminRekey');
    const status = await npmAdminCredStatus(node);
    if (status !== 'rejected' && status !== 'no-creds') return undefined;
    const r = await rekeyNpmAdmin(node);
    if (!r.ok) {
      logger.warn('ExternalBackup', `NPM credential reconcile after restore failed: ${r.message}`);
    } else {
      logger.info('ExternalBackup', 'Reconciled NPM admin credential with the restored database.');
    }
    return { ok: r.ok, message: r.message };
  } catch (e) {
    const message = `NPM credential reconcile after restore errored: ${e instanceof Error ? e.message : String(e)}`;
    logger.warn('ExternalBackup', message);
    return { ok: false, message };
  }
}

/**
 * True if `dir` is empty or doesn't exist — the safe-to-seed condition.
 * Standalone local-fs check; the restore/wipe flows resolve their backend
 * (host agent on a box, local in tests) and call `backend.isFreshDir` instead.
 */
export async function isFreshDataDir(dir: string): Promise<boolean> {
  return localRestoreBackend.isFreshDir(dir);
}

/**
 * Restore a service's config backup from the NAS into its data dir. By default
 * restores the MOST-RECENT dated snapshot (#1865); pass `tarName` to restore a
 * specific snapshot instead (the "restore a chosen one" path — recover from
 * BEFORE a silently-corrupted run, not just the latest state). A bare legacy
 * `<service>.tar` (pre-#1865) is a valid snapshot and resolves as latest when
 * it's the only one — existing single-slot backups stay restorable.
 *
 * Refuses a non-empty data dir unless `force` is set. Returns the data dir, the
 * number of files restored, and the backup's meta sidecar (if present).
 */
export async function restoreServiceBackup(
  service: string,
  opts: { force?: boolean; node?: string | null; local?: boolean; tarName?: string } = {},
): Promise<RestoreResult> {
  if (!getServiceManifest(service)) {
    throw new Error(`No backup manifest for service "${service}"`);
  }
  // The stacks dir isn't mounted into the container, so a box restore runs every
  // fs op on the host via the agent (#1600); tests force the local backend.
  const backend = pickRestoreBackend(opts);
  const dataDir = await resolveServiceDataDir(service);
  if (!opts.force && !(await backend.isFreshDir(dataDir))) {
    throw new Error(
      `Refusing to restore "${service}": ${dataDir} already has data. Restore ` +
      `only seeds a fresh/empty data dir; pass force to overwrite a live service.`,
    );
  }

  // A specific snapshot when asked; otherwise default to the most-recent one.
  // A requested tarName must belong to this service (and exist), so a caller
  // can't restore one service's snapshot into another's data dir.
  let tarName = opts.tarName;
  if (tarName) {
    const known = (await listServiceBackups()).find(b => b.service === service && b.tarName === tarName);
    if (!known) {
      throw new Error(`No backup snapshot "${tarName}" on the NAS for service "${service}"`);
    }
  } else {
    const latest = await latestServiceBackupName(service);
    if (!latest) {
      throw new Error(`No config backup found on the NAS for service "${service}"`);
    }
    tarName = latest;
  }

  const { tar, meta } = await fetchServiceBackup(tarName);
  await backend.extractTar(tar, dataDir);

  const files = await backend.countFiles(dataDir);
  logger.info('ExternalBackup', `Restored "${service}" from NAS into ${dataDir} (${files} files)`);

  // #1529 — NPM's restored database.sqlite carries its own admin hash, so
  // reconcile ServiceBay's stored credential with it (no-op for other services
  // and when NPM isn't running yet).
  const credentialReconcile =
    service === 'nginx' ? await reconcileNpmCredentialAfterRestore(opts.node || 'Local') : undefined;

  return { service, dataDir, files, meta, credentialReconcile };
}

/**
 * #1585 — per-service wipe before a (re)deploy, under the install `wipeMode`
 * model. Acts ONLY on this one service's on-disk data dir (never a system-wide
 * nuke — that's Factory Reset's job):
 *
 *   install      → no-op (keep config + data)
 *   wipe-config  → delete the service's CONFIG paths (manifest `include`),
 *                  KEEP its DATA (recorder db, photo library, mesh db, …)
 *   wipe-all     → delete the whole service data dir (CONFIG + DATA)
 *
 * After this runs, `autoRestoreServiceOnReinstall` re-seeds CONFIG from the NAS
 * (the wiped CONFIG paths are gone, so the restore re-creates them over the
 * kept DATA). ServiceBay-managed bits stamped into the restored
 * `configuration.yaml` (HA `http: trusted_proxies`, the OIDC client secret) are
 * re-applied by the existing post-deploy self-heal hooks (serviceLifecycle's
 * trusted_proxies append + the #989 OIDC dispatcher), which run on every deploy
 * regardless of the restore — so the documented caveat is honoured without a
 * second stamping path here.
 *
 * Emits a VISIBLE breadcrumb for what it wiped. Best-effort: a wipe failure is
 * logged and swallowed so it can't block the deploy. Local-node only (the fs
 * primitive is local); a remote node short-circuits silently.
 */
export async function wipeServiceForReinstall(
  service: string,
  opts: { wipeMode?: WipeMode; node?: string | null; local?: boolean },
  log: (line: string) => Promise<void>,
): Promise<void> {
  const mode = opts.wipeMode ?? 'install';
  if (mode === 'install') return;
  if (opts.node && opts.node !== 'Local') return;
  if (!getServiceManifest(service)) {
    // No manifest → no declared config/data classes → nothing safe to wipe.
    await log(`(note) ${service}: no backup manifest, skipping ${mode} wipe (no config/data classification).`);
    return;
  }
  // The stacks dir isn't mounted into the container, so the wipe runs on the
  // host via the agent (#1600); without this it silently cleared nothing.
  const backend = pickRestoreBackend(opts);
  try {
    const dataDir = await resolveServiceDataDir(service);
    if (mode === 'wipe-all') {
      await backend.rmrf(dataDir);
      await log(`🧹 ${service}: wipe-all — cleared the service data dir (config + data).`);
      return;
    }
    // wipe-config: delete only the manifest's CONFIG paths, keep everything else.
    const configPaths = getConfigPaths(service);
    let removed = 0;
    for (const rel of configPaths) {
      const abs = path.join(dataDir, rel);
      // Guard against traversal — the manifest is trusted static data, but keep
      // the same invariant the restore path enforces.
      if (!abs.startsWith(dataDir + path.sep)) continue;
      try {
        await backend.rmrf(abs);
        removed += 1;
      } catch { /* path absent — fine */ }
    }
    await log(`🧹 ${service}: wipe-config — cleared ${removed} config path(s), kept the service data on disk.`);
  } catch (e) {
    await log(`(note) ${service}: ${mode} wipe skipped — ${e instanceof Error ? e.message : String(e)}.`);
  }
}

/**
 * #1218 entry point 1 / #1585 — auto-restore a service's config from the NAS
 * before its pod starts on any (re)deploy. Gated on its **own safe conditions**
 * plus the install `wipeMode`, not the retired `cleanInstall` flag (#1584: #1520
 * hard-set `cleanInstall = false`, which silently disabled restore).
 *
 * Restore conditions by mode:
 *  - `install`: restore only if the data dir is empty/fresh (config missing) —
 *    never clobber a live service's config.
 *  - `wipe-config` / `wipe-all`: the CONFIG paths were just cleared by
 *    `wipeServiceForReinstall`, so FORCE-restore them from the NAS over the kept
 *    DATA (the tar contains only CONFIG paths, so this re-seeds config without
 *    touching the kept recorder db / photo library / mesh db).
 *
 * Common preconditions (all modes): the node is Local AND a `<service>.tar`
 * exists on the NAS. Emits a VISIBLE breadcrumb for BOTH outcomes —
 * restore-performed and restore-skipped (with the reason) — so a skipped
 * restore is never silent (the #1584 root cause was the old silent `return`).
 * The Local-node short-circuit stays silent: it's an architectural no-op.
 *
 * Best-effort: a restore failure is logged and swallowed so it can't block the
 * deploy. The install runner calls this from `deployItem` (epic #1190).
 */
export async function autoRestoreServiceOnReinstall(
  service: string,
  opts: { wipeMode?: WipeMode; node?: string | null; local?: boolean },
  log: (line: string) => Promise<void>,
): Promise<void> {
  const mode = opts.wipeMode ?? 'install';
  // #1584/#1585: gated on the wipeMode + safe conditions, NOT the retired
  // cleanInstall flag (which #1520 pinned false, silently killing restore).
  if (opts.node && opts.node !== 'Local') return;
  const forceRestore = mode === 'wipe-config' || mode === 'wipe-all';
  // The stacks dir isn't mounted into the container, so the freshness check (and
  // the restore it gates) run on the host via the agent (#1600). Without this
  // the check saw an absent container path → "fresh" → restore wrote nowhere.
  const backend = pickRestoreBackend(opts);
  try {
    const hasBackup = (await listServiceBackups()).some(b => b.service === service);
    if (!hasBackup) {
      await log(`(note) ${service}: no config backup found on the FritzBox NAS — starting on existing/blank data.`);
      return;
    }
    if (!forceRestore && !(await backend.isFreshDir(await resolveServiceDataDir(service)))) {
      await log(`(note) ${service}: a config backup exists on the NAS, but the data dir is not empty — keeping the on-disk data and skipping restore.`);
      return;
    }
    await log(
      forceRestore
        ? `💾 ${service}: ${mode} — restoring config from the FritzBox NAS over the kept data before first start…`
        : `💾 ${service}: found a config backup on the FritzBox NAS and the data dir is empty — restoring before first start…`,
    );
    const r = await restoreServiceBackup(service, { node: opts.node, force: forceRestore, local: opts.local });
    await log(`✅ ${service}: restored ${r.files} config file(s) from the NAS${r.meta ? ` (backed up ${r.meta.createdAt.slice(0, 10)} from ${r.meta.nodeId})` : ''}.`);
    // On a reinstall the pod isn't up yet, so credentialReconcile is normally
    // a no-op here (the install runner's post-deploy self-heal re-keys NPM once
    // it's running); surface it only when it actually fired.
    if (r.credentialReconcile) {
      await log(`${r.credentialReconcile.ok ? '🔑 ' : '⚠️ '}${service}: ${r.credentialReconcile.message}`);
    }
  } catch (e) {
    // A restore failure must never block the deploy — log a breadcrumb and continue.
    await log(`(note) ${service}: NAS config restore skipped — ${e instanceof Error ? e.message : String(e)}.`);
  }
}

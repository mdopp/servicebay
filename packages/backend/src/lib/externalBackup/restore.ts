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
import { getServiceManifest, getConfigPaths } from './serviceManifest';
import { safeTarExtract } from '../systemBackup';
import { logger } from '../logger';

/**
 * Per-service wipe mode (#1585). Structurally identical to
 * `install/jobStore.ts`'s `WipeMode` but declared locally so this backup module
 * doesn't import from the install module (the install runner already imports
 * THIS module — a cross-import would form a cycle). The install runner passes
 * its `JobInput.wipeMode` straight through.
 */
type WipeMode = 'install' | 'wipe-config' | 'wipe-all';

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
  opts: { force?: boolean; node?: string | null } = {},
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
  opts: { wipeMode?: WipeMode; node?: string | null },
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
  try {
    const dataDir = await resolveServiceDataDir(service);
    if (mode === 'wipe-all') {
      await fs.rm(dataDir, { recursive: true, force: true });
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
        await fs.rm(abs, { recursive: true, force: true });
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
  opts: { wipeMode?: WipeMode; node?: string | null },
  log: (line: string) => Promise<void>,
): Promise<void> {
  const mode = opts.wipeMode ?? 'install';
  // #1584/#1585: gated on the wipeMode + safe conditions, NOT the retired
  // cleanInstall flag (which #1520 pinned false, silently killing restore).
  if (opts.node && opts.node !== 'Local') return;
  const forceRestore = mode === 'wipe-config' || mode === 'wipe-all';
  try {
    const hasBackup = (await listServiceBackups()).some(b => b.service === service);
    if (!hasBackup) {
      await log(`(note) ${service}: no config backup found on the FritzBox NAS — starting on existing/blank data.`);
      return;
    }
    if (!forceRestore && !(await isFreshDataDir(await resolveServiceDataDir(service)))) {
      await log(`(note) ${service}: a config backup exists on the NAS, but the data dir is not empty — keeping the on-disk data and skipping restore.`);
      return;
    }
    await log(
      forceRestore
        ? `💾 ${service}: ${mode} — restoring config from the FritzBox NAS over the kept data before first start…`
        : `💾 ${service}: found a config backup on the FritzBox NAS and the data dir is empty — restoring before first start…`,
    );
    const r = await restoreServiceBackup(service, { node: opts.node, force: forceRestore });
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

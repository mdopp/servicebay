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
 * #1218 entry point 1 — auto-restore a service's config from the NAS before its
 * pod starts on any (re)deploy. Gated on its **own safe conditions** rather than
 * the install mode: it fires when a `<service>.tar` exists on the NAS **and**
 * the service's data dir is empty/fresh — so it can't clobber live data, yet it
 * no longer depends on the retired `cleanInstall` flag (#1584: #1520 hard-set
 * `cleanInstall = false`, which silently disabled restore for every install).
 *
 * Conditions (all required to restore):
 *  - the node is Local (the restore primitive uses the backend's own fs), AND
 *  - a `<service>.tar` exists on the NAS, AND
 *  - the service's data dir is empty (`restoreServiceBackup` also refuses a
 *    non-empty dir, so a live service's config is never clobbered).
 *
 * Emits a VISIBLE breadcrumb through the injected `log` for BOTH outcomes —
 * restore-performed and restore-skipped (with the reason) — so a skipped
 * restore is never silent (the #1584 root cause was the old silent `return`).
 * The Local-node short-circuit stays silent: it's an architectural no-op (the
 * primitive is local-fs only), not a user-facing decision.
 *
 * Best-effort: a restore failure is logged and swallowed so it can't block the
 * deploy. The install runner calls this from `deployItem` (epic #1190).
 */
export async function autoRestoreServiceOnReinstall(
  service: string,
  opts: { cleanInstall?: boolean; node?: string | null },
  log: (line: string) => Promise<void>,
): Promise<void> {
  // #1584: deliberately NOT gated on opts.cleanInstall — that flag was retired
  // to false (#1520) and was the sole gate, which silently killed auto-restore.
  if (opts.node && opts.node !== 'Local') return;
  try {
    const hasBackup = (await listServiceBackups()).some(b => b.service === service);
    if (!hasBackup) {
      await log(`(note) ${service}: no config backup found on the FritzBox NAS — starting on existing/blank data.`);
      return;
    }
    if (!(await isFreshDataDir(await resolveServiceDataDir(service)))) {
      await log(`(note) ${service}: a config backup exists on the NAS, but the data dir is not empty — keeping the on-disk data and skipping restore.`);
      return;
    }
    await log(`💾 ${service}: found a config backup on the FritzBox NAS and the data dir is empty — restoring before first start…`);
    const r = await restoreServiceBackup(service, { node: opts.node });
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

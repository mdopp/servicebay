/**
 * Stack-reset engine. Extracted from `/api/system/stacks/reset` (#568) so
 * the new Factory Reset endpoint (#623) can drive the same wipe without
 * re-implementing the inventory + wipe-plan logic.
 *
 * The wizard's "clean install" path still hits the route directly — only
 * the implementation moved.
 */
import { ServiceManager } from '@/lib/services/ServiceManager';
import { agentManager } from '@/lib/agent/manager';
import { getConfig, scrubEncryptedConfig } from '@/lib/config';
import { getNodeIds } from '@/lib/store/repository';
import { logger } from '@/lib/logger';
import { RESET_GROUPS, DEFAULT_PRESERVE, isAlwaysWipe, type ResetGroup } from './resetGroups';
import { validateResetCombo } from './resetValidation';
import { regenerateWipedKeys } from './regenSecrets';

/** Service names the reset endpoint refuses to delete. */
const PROTECTED_SERVICES = new Set(['servicebay']);

export interface PerformStackResetOptions {
  /** Operator-supplied preserve list. Already-normalised arrays are
   *  accepted; raw input (`unknown[]`) gets validated here. */
  preserve?: unknown;
  /** Optional node name; defaults to the first node in the twin. */
  node?: string;
  /** #1495 — also wipe all container images on the node (`podman rmi -af`) so
   *  the next install re-pulls a fresh set (the escalating factory-reset level
   *  (b)). Default false. */
  wipeImages?: boolean;
}

export interface PerformStackResetResult {
  ok: true;
  node: string;
  dataDir: string;
  preserve: ResetGroup[];
  wipeStepsRun: string[];
  deleted: string[];
  failed: { name: string; error: string }[];
  protected: string[];
  preservedServices: string[];
  certArchive: string | null;
}

/** Error class so the calling route can return the appropriate HTTP status. */
export class StackResetError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

export async function performStackReset(
  options: PerformStackResetOptions,
): Promise<PerformStackResetResult> {
  // Validate preserve groups; ignore unknown ids rather than failing
  // so a forward-compatible caller (newer ServiceBay client talking to
  // an older backend) doesn't break — unknown groups just have no
  // effect. Default to system-critical preservation when omitted.
  // alwaysWipe groups (quadlet-backup) are dropped from preserve even
  // if requested — leaving stale Quadlet units behind would resurrect
  // deleted services after an OS reinstall.
  const validGroups = Object.keys(RESET_GROUPS) as ResetGroup[];
  const preserve: ResetGroup[] = (Array.isArray(options.preserve)
    ? (options.preserve.filter((g): g is ResetGroup => validGroups.includes(g as ResetGroup)))
    : DEFAULT_PRESERVE.slice()
  ).filter(g => !isAlwaysWipe(g));

  // --- Validation gate (#847 / ARCH-16a) ---
  // Block unsafe preserve/wipe combos before any destructive IO.
  const validation = await validateResetCombo({ preserve, node: options.node });
  if (!validation.valid) {
    throw new StackResetError(
      `Unsafe reset combination: ${validation.errors.join(' ')}`,
      400,
    );
  }

  const nodeName = options.node || getNodeIds()[0];
  if (!nodeName) throw new StackResetError('No nodes available', 404);

  const config = await getConfig();
  const dataDir = config.templateSettings?.DATA_DIR || '/mnt/data/stacks';
  // Belt-and-suspenders: refuse to wipe a path that is dangerously high
  // in the filesystem tree. Even if a malicious config injected '/' or
  // '/mnt', this engine will not act on it.
  const safeRe = /^\/(mnt|var\/mnt|opt|srv|home)\/[^.][^\s]+/;
  if (!safeRe.test(dataDir) || dataDir.length < 8) {
    throw new StackResetError(`Refusing to wipe DATA_DIR="${dataDir}" — outside the safe path whitelist`, 500);
  }

  // Service inventory: stop + remove Quadlet for everything except
  // protected services (servicebay itself). Pre-fix the certs and
  // identity groups *also* kept their owning services — nginx and
  // auth — on the assumption that "preserve data" implied "preserve
  // unit." But Quadlet yaml on disk can be stale (#697-followup:
  // operator's previous install left an nginx.yml with broken
  // `{{DATA_DIR}}` substitution, the preserve kept it, the install
  // runner skipped nginx as already-installed, and the operator hit
  // a permanent restart-loop). The data dir is what actually needs
  // preserving — handled separately by the path-based exclusion
  // below — so the reset wipes the service unit and lets the
  // install runner redeploy a freshly-rendered yaml against the
  // preserved data.
  const services = await ServiceManager.listServices(nodeName);
  const preservedServices = new Set<string>();
  const toDelete = services
    .map(s => s.name)
    .filter(name => !PROTECTED_SERVICES.has(name) && !preservedServices.has(name));

  const deleted: string[] = [];
  const failed: { name: string; error: string }[] = [];

  for (const name of toDelete) {
    try {
      await ServiceManager.deleteService(nodeName, name);
      deleted.push(name);
    } catch (e) {
      failed.push({ name, error: e instanceof Error ? e.message : 'unknown' });
      logger.warn('StackReset', `Failed to delete service ${name}`, e);
    }
  }

  const agent = await agentManager.ensureAgent(nodeName);

  // Snapshot NPM's data dir to cert-archive UNLESS the secrets group is
  // also being wiped (which would delete the archive itself, making the
  // snapshot useless). When secrets is preserved AND certs is wiped, the
  // archive lets cert-reuse pull from a backup tarball on next install —
  // without re-running into LE's rate limit.
  let certArchive: string | null = null;
  const willWipeCerts = !preserve.includes('certs');
  const willWipeSecrets = !preserve.includes('secrets');
  if (willWipeCerts && !willWipeSecrets) {
    try {
      const npmDir = `${dataDir}/nginx-proxy-manager`;
      const probe = await agent.sendCommand('exec', {
        command: `[ -d "${npmDir}/letsencrypt/live" ] && find "${npmDir}/letsencrypt/live" -mindepth 1 -maxdepth 1 -type d | head -1 || true`,
      });
      const hasCerts = !!(probe.stdout || '').trim();
      if (hasCerts) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const archivePath = `/mnt/data/servicebay/cert-archive/npm-${ts}.tar.gz`;
        await agent.sendCommand('exec', {
          command: `mkdir -p /mnt/data/servicebay/cert-archive && tar czf "${archivePath}" -C "${dataDir}" nginx-proxy-manager`,
        });
        certArchive = archivePath;
        logger.info('StackReset', `Archived NPM data to ${archivePath} before wipe.`);
      }
    } catch (e) {
      logger.warn('StackReset', `Cert archive failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Build the wipe plan: stacks subdirs (NPM, auth, service-data) are
  // handled per-group; the servicebay dir is handled separately.
  // Each rm -rf is a single shell exec so the agent can log them.
  const wipeStepsRun: string[] = [];

  // service-data: wipe everything under /mnt/data/stacks/* except the
  // preserved subdirs (NPM, auth).
  if (!preserve.includes('service-data')) {
    const exclusions: string[] = [];
    if (preserve.includes('certs')) exclusions.push('nginx-proxy-manager');
    if (preserve.includes('identity')) exclusions.push('auth');
    const findExclusions = exclusions.map(n => `! -name ${JSON.stringify(n)}`).join(' ');
    const cmd = `find ${dataDir} -mindepth 1 -maxdepth 1 ${findExclusions} -exec rm -rf {} +`;
    await agent.sendCommand('exec', { command: cmd });
    wipeStepsRun.push(`service-data (kept ${exclusions.length} preserved subdir${exclusions.length === 1 ? '' : 's'})`);
  } else {
    // service-data preserved but NPM/auth might individually be wiped —
    // narrowly target those.
    if (!preserve.includes('certs')) {
      await agent.sendCommand('exec', { command: `rm -rf ${JSON.stringify(`${dataDir}/nginx-proxy-manager`)}` });
      wipeStepsRun.push('certs only (service-data preserved)');
    }
    if (!preserve.includes('identity')) {
      await agent.sendCommand('exec', { command: `rm -rf ${JSON.stringify(`${dataDir}/auth`)}` });
      wipeStepsRun.push('identity only (service-data preserved)');
    }
  }

  // secrets: clear secret.key + the encryption-keyed encrypted state.
  // Operator-supplied non-secret config (publicDomain, gateway host,
  // SMTP host etc.) and the agent's SSH key are NOT key-dependent;
  // wiping them just creates a worse re-install experience (#702, #703).
  //
  // Pre-fix: \`find /var/mnt/data/servicebay -mindepth 1 -maxdepth 1\`
  // removed everything — including \`ssh/id_rsa\` (agent loses its
  // own host's SSH key → infinite ensureAgent retry loop) and
  // \`config.json\` (publicDomain that the wizard JUST wrote vanishes
  // before any deploy can read it — see #702).
  //
  // The targeted wipe:
  //   - secret.key, .auth-secret.env → always (the actual cipher key)
  //   - mcp-tokens.json → always (encrypted with secret.key)
  //   - auth.db, logs.db, results/ → always (sqlite encrypted with key)
  //   - checks.json → always (regenerated from manifests)
  //   - install-jobs/ → preserved (job state survives — see #705)
  //   - ssh/ → preserved (agent's own host key — see #703)
  //   - config.json → scrubbed in place: drop every enc:v1: field and
  //     the auth.passwordHash, keep operator-input fields like
  //     publicDomain, lanDomain, gateway.host (see #702)
  //   - cert-archive/ → preserved
  if (!preserve.includes('secrets')) {
    // 1) Scrub config.json via the Node.js side under the same
    //    `withConfigLock` queue as `updateConfig` / `saveConfig`
    //    (#711). The pre-fix implementation ran a Python one-liner
    //    via `agent.sendCommand('exec')` — that read + wrote
    //    config.json directly on the host, bypassing the in-process
    //    lock. A concurrent post-deploy that called
    //    `updateConfig({ adguard: { password }})` landed its write
    //    *between* the Python script's read and write; the script's
    //    older snapshot then clobbered the new credential, surfacing
    //    as "adguard.password missing after install" + wildcard DNS
    //    rewrites failing to provision.
    try {
      const { removedKeys } = await scrubEncryptedConfig();
      logger.info('StackReset', `Scrubbed config.json — removed ${removedKeys} encrypted/auth key(s).`);
    } catch (e) {
      logger.warn('StackReset', `scrubEncryptedConfig failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    // 2) Wipe everything else under /var/mnt/data/servicebay/ except
    //    the preserved subdirs + the just-scrubbed config.json.
    const preservedNames = ['ssh', 'install-jobs', 'cert-archive', 'config.json'];
    const findExclusions = preservedNames.map(n => `! -name ${JSON.stringify(n)}`).join(' ');
    await agent.sendCommand('exec', {
      command: `find /var/mnt/data/servicebay -mindepth 1 -maxdepth 1 ${findExclusions} -exec rm -rf {} +`,
    });
    wipeStepsRun.push('secrets (kept ssh/, install-jobs/, cert-archive/, scrubbed config.json)');

    // 3) Regenerate the two boot-critical key files in-process (#1246).
    //    The wipe above removed secret.key + .auth-secret.env, but the
    //    units that regenerate them (servicebay-secret-key-init,
    //    servicebay-auth-secret-init) only run on boot. A reset without
    //    an OS reboot leaves both files missing — the running container
    //    survives on its in-memory copies until its next restart (a
    //    config-save firing servicebay-trigger.path, or an image
    //    auto-update), then assertAuthSecret() throws on the missing
    //    .auth-secret.env and the container crash-loops forever with no
    //    self-recovery. Writing them now (same formats as the boot
    //    units) means the next restart finds them — no reboot needed.
    //    A failure here must NOT be swallowed: a green reset that left
    //    the keys missing would re-create the exact outage this fixes
    //    (feedback_dont_mask_failures).
    regenerateWipedKeys();
    wipeStepsRun.push('secrets regen (secret.key + .auth-secret.env written in-process)');
  }

  // alwaysWipe groups (quadlet-backup): always purged, even when their
  // parent group is preserved. Quadlet snapshots specifically would
  // resurrect deleted services after an OS reinstall because
  // setup-raid.sh replays them. setup-raid recreates the dir on next
  // boot, so removing the path itself is safe.
  for (const id of Object.keys(RESET_GROUPS) as ResetGroup[]) {
    if (!isAlwaysWipe(id)) continue;
    for (const p of RESET_GROUPS[id].paths) {
      await agent.sendCommand('exec', { command: `rm -rf ${JSON.stringify(p)}` });
    }
    wipeStepsRun.push(`${id} (always-wipe)`);
  }

  // #1495 — factory-reset level (b): wipe all container images so the next
  // install re-pulls a fresh, known set. Runs after the service teardown above
  // (no in-use images left to block removal). Best-effort: a failure here must
  // not fail the whole reset.
  if (options.wipeImages) {
    await agent.sendCommand('exec', {
      command: 'podman rmi -af 2>/dev/null; podman image prune -af 2>/dev/null || true',
    });
    wipeStepsRun.push('images (podman rmi -af — re-pulled on next install)');
  }

  return {
    ok: true,
    node: nodeName,
    dataDir,
    preserve,
    wipeStepsRun,
    deleted,
    failed,
    protected: Array.from(PROTECTED_SERVICES),
    preservedServices: Array.from(preservedServices),
    certArchive,
  };
}

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
import { getConfig } from '@/lib/config';
import { DigitalTwinStore } from '@/lib/store/twin';
import { logger } from '@/lib/logger';
import { RESET_GROUPS, DEFAULT_PRESERVE, isAlwaysWipe, type ResetGroup } from './resetGroups';

/** Service names the reset endpoint refuses to delete. */
const PROTECTED_SERVICES = new Set(['servicebay']);

export interface PerformStackResetOptions {
  /** Operator-supplied preserve list. Already-normalised arrays are
   *  accepted; raw input (`unknown[]`) gets validated here. */
  preserve?: unknown;
  /** Optional node name; defaults to the first node in the twin. */
  node?: string;
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

  const twin = DigitalTwinStore.getInstance();
  const nodeName = options.node || Object.keys(twin.nodes)[0];
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
  // services whose data dir falls under a preserved group. Otherwise
  // the operator would lose the cert-reuse benefit because the NPM
  // service was torn down even though its data dir stays.
  const services = await ServiceManager.listServices(nodeName);
  const preservedServices = new Set<string>();
  // Service template names (matches the `templates/<name>/` directory),
  // not the on-disk path basenames. Pre-fix: 'nginx-proxy-manager' was
  // the *path* basename — but ServiceManager.listServices returns the
  // template/quadlet-unit name 'nginx', so the name miss never matched
  // and the operator's `keep certs` choice silently tore down nginx
  // before the install runner redeployed it (#679 follow-up). 'auth'
  // happens to match because the template directory + path basename
  // are both called `auth`.
  if (preserve.includes('certs')) preservedServices.add('nginx');
  if (preserve.includes('identity')) preservedServices.add('auth');
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

  // secrets: wipe contents of /var/mnt/data/servicebay/. Clear contents
  // rather than removing the dir itself so the systemd mount unit +
  // setup-raid don't trip on a missing path.
  if (!preserve.includes('secrets')) {
    await agent.sendCommand('exec', {
      command: 'find /var/mnt/data/servicebay -mindepth 1 -maxdepth 1 -exec rm -rf {} +',
    });
    wipeStepsRun.push('secrets (ServiceBay state)');
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

import { NextRequest, NextResponse } from 'next/server';
import { ServiceManager } from '@/lib/services/ServiceManager';
import { agentManager } from '@/lib/agent/manager';
import { getConfig } from '@/lib/config';
import { DigitalTwinStore } from '@/lib/store/twin';
import { logger } from '@/lib/logger';
import { requireSession } from '@/lib/api/requireSession';
import { apiError } from '@/lib/api/errors';
import { RESET_GROUPS, DEFAULT_PRESERVE, type ResetGroup } from '@/lib/install/resetGroups';

export const dynamic = 'force-dynamic';

/** Service names that must never be auto-deleted by the reset endpoint. */
const PROTECTED = new Set(['servicebay']);

/**
 * POST /api/system/stacks/reset
 * Body: {
 *   confirm: 'RESET',
 *   node?: string,
 *   preserve?: ResetGroup[]   // omit = use DEFAULT_PRESERVE
 * }
 *
 * Wipes stack data so the install wizard can re-deploy. Granular per
 * #568 — the operator picks which groups to keep. Defaults preserve
 * the three system-critical groups (secrets / certs / identity); only
 * service-data wipes unless the operator explicitly opts in.
 *
 * Concrete steps:
 *   - stops + removes Quadlet definitions for all non-protected services
 *   - reloads systemd
 *   - archives NPM data to /mnt/data/servicebay/cert-archive/ (so a
 *     full wipe still leaves the cert-reuse helper a fallback)
 *   - deletes paths under `<DATA_DIR>` according to the preserve map
 *   - removes /mnt/data/servicebay/quadlet-backup so an OS reinstall
 *     does not restore now-deleted services from setup-raid.sh
 *
 * ServiceBay itself is intentionally not touched (Quadlet definition).
 */
export async function POST(request: NextRequest) {
  try {
    const auth = await requireSession(request);
    if (auth instanceof NextResponse) return auth;

    const body = await request.json();
    const { confirm, node: requestedNode, preserve: rawPreserve } = body as {
      confirm?: string;
      node?: string;
      preserve?: string[];
    };

    if (confirm !== 'RESET') {
      return NextResponse.json(
        { error: "Confirmation required: pass {\"confirm\": \"RESET\"} in body" },
        { status: 400 }
      );
    }

    // Validate preserve groups; ignore unknown ids rather than failing
    // so a forward-compatible caller (newer ServiceBay client talking
    // to an older backend) doesn't break — unknown groups just have
    // no effect. Default to system-critical preservation when omitted.
    const validGroups = Object.keys(RESET_GROUPS) as ResetGroup[];
    const preserve: ResetGroup[] = Array.isArray(rawPreserve)
      ? (rawPreserve.filter((g): g is ResetGroup => validGroups.includes(g as ResetGroup)))
      : DEFAULT_PRESERVE.slice();

    const twin = DigitalTwinStore.getInstance();
    const nodeName = requestedNode || Object.keys(twin.nodes)[0];
    if (!nodeName) {
      return NextResponse.json({ error: 'No nodes available' }, { status: 404 });
    }

    const config = await getConfig();
    const dataDir = config.templateSettings?.DATA_DIR || '/mnt/data/stacks';
    // Belt-and-suspenders: refuse to wipe a path that is dangerously high in
    // the filesystem tree. Even if a malicious config injected '/' or '/mnt',
    // this endpoint will not act on it.
    const safeRe = /^\/(mnt|var\/mnt|opt|srv|home)\/[^.][^\s]+/;
    if (!safeRe.test(dataDir) || dataDir.length < 8) {
      return NextResponse.json(
        { error: `Refusing to wipe DATA_DIR="${dataDir}" — outside the safe path whitelist` },
        { status: 500 }
      );
    }

    // Service inventory: stop + remove Quadlet for everything except
    // services whose data dir falls under a preserved group. Otherwise
    // the operator would lose the cert-reuse benefit because the NPM
    // service was torn down even though its data dir stays.
    const services = await ServiceManager.listServices(nodeName);
    const preservedServices = new Set<string>();
    if (preserve.includes('certs')) preservedServices.add('nginx-proxy-manager');
    if (preserve.includes('identity')) preservedServices.add('auth');
    const toDelete = services
      .map(s => s.name)
      .filter(name => !PROTECTED.has(name) && !preservedServices.has(name));

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

    // Snapshot NPM's data dir to cert-archive UNLESS the secrets group
    // is also being wiped (which would delete the archive itself, making
    // the snapshot useless). When secrets is preserved AND certs is
    // wiped, the archive lets cert-reuse pull from a backup tarball on
    // next install — without re-running into LE's rate limit.
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

    // service-data: wipe everything under /mnt/data/stacks/* except
    // the preserved subdirs (NPM, auth).
    if (!preserve.includes('service-data')) {
      const exclusions: string[] = [];
      if (preserve.includes('certs')) exclusions.push('nginx-proxy-manager');
      if (preserve.includes('identity')) exclusions.push('auth');
      // Use `find -mindepth 1 -maxdepth 1 ! -name X ! -name Y -exec rm -rf`
      const findExclusions = exclusions.map(n => `! -name ${JSON.stringify(n)}`).join(' ');
      const cmd = `find ${dataDir} -mindepth 1 -maxdepth 1 ${findExclusions} -exec rm -rf {} +`;
      await agent.sendCommand('exec', { command: cmd });
      wipeStepsRun.push(`service-data (kept ${exclusions.length} preserved subdir${exclusions.length === 1 ? '' : 's'})`);
    } else {
      // service-data preserved but NPM/auth might individually be wiped
      // — narrowly target those.
      if (!preserve.includes('certs')) {
        await agent.sendCommand('exec', { command: `rm -rf ${JSON.stringify(`${dataDir}/nginx-proxy-manager`)}` });
        wipeStepsRun.push('certs only (service-data preserved)');
      }
      if (!preserve.includes('identity')) {
        await agent.sendCommand('exec', { command: `rm -rf ${JSON.stringify(`${dataDir}/auth`)}` });
        wipeStepsRun.push('identity only (service-data preserved)');
      }
    }

    // secrets: wipe /var/mnt/data/servicebay/ (except quadlet-backup
    // which we always wipe — handled below).
    if (!preserve.includes('secrets')) {
      // Refuse to wipe the path itself; clear its contents instead so
      // the systemd mount unit + setup-raid don't trip on a missing
      // dir.
      await agent.sendCommand('exec', {
        command: 'find /var/mnt/data/servicebay -mindepth 1 -maxdepth 1 -exec rm -rf {} +',
      });
      wipeStepsRun.push('secrets (ServiceBay state)');
    }

    // Quadlet backup: always wipe so an OS reinstall does not restore
    // stale units from setup-raid.sh. setup-raid re-creates the dir
    // on next boot.
    await agent.sendCommand('exec', {
      command: 'rm -rf /var/mnt/data/servicebay/quadlet-backup',
    });

    return NextResponse.json({
      ok: true,
      node: nodeName,
      dataDir,
      preserve,
      wipeStepsRun,
      deleted,
      failed,
      protected: Array.from(PROTECTED),
      preservedServices: Array.from(preservedServices),
      certArchive,
    });
  } catch (error) {
    return apiError(error, { tag: 'api:system:stacks:reset', status: 500 });
  }
}

import { NextRequest, NextResponse } from 'next/server';
import { ServiceManager } from '@/lib/services/ServiceManager';
import { agentManager } from '@/lib/agent/manager';
import { getConfig } from '@/lib/config';
import { DigitalTwinStore } from '@/lib/store/twin';
import { logger } from '@/lib/logger';
import { requireSession } from '@/lib/api/requireSession';
import { apiError } from '@/lib/api/errors';

export const dynamic = 'force-dynamic';

/** Service names that must never be auto-deleted by the reset endpoint. */
const PROTECTED = new Set(['servicebay']);

/**
 * POST /api/system/stacks/reset
 * Body: { confirm: 'RESET', node?: string }
 *
 * Wipes all stack data so the install wizard can re-deploy from a truly
 * clean slate. Specifically:
 *   - lists all installed services on the target node
 *   - stops + removes their Quadlet definitions (.kube + .yml)
 *   - reloads systemd
 *   - deletes everything in `<DATA_DIR>` (default /mnt/data/stacks)
 *   - removes /mnt/data/servicebay/quadlet-backup so an OS reinstall does
 *     not restore the now-deleted services from setup-raid.sh
 *
 * ServiceBay itself is intentionally not touched.
 */
export async function POST(request: NextRequest) {
  try {
    const auth = await requireSession(request);
    if (auth instanceof NextResponse) return auth;

    const body = await request.json();
    const { confirm, node: requestedNode } = body as {
      confirm?: string;
      node?: string;
    };

    if (confirm !== 'RESET') {
      return NextResponse.json(
        { error: "Confirmation required: pass {\"confirm\": \"RESET\"} in body" },
        { status: 400 }
      );
    }

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

    const services = await ServiceManager.listServices(nodeName);
    const toDelete = services
      .map(s => s.name)
      .filter(name => !PROTECTED.has(name));

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

    // Snapshot NPM's data dir (cert files + DB) to a path that survives
    // the wipe below. Without this, every clean install burns a fresh
    // batch of Let's Encrypt issuances and we run head-first into the
    // "5 duplicate certs / 168h" rate limit after a few re-deploys.
    // Archive path is intentionally under /mnt/data/servicebay/cert-archive/
    // — neither this endpoint nor any other code path wipes that.
    let certArchive: string | null = null;
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
      // Best-effort — a failed archive shouldn't block the reset.
      logger.warn('StackReset', `Cert archive failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    // Wipe stack data dir contents (but keep the dir itself).
    await agent.sendCommand('exec', {
      command: `find ${dataDir} -mindepth 1 -maxdepth 1 -exec rm -rf {} +`,
    });

    // Remove Quadlet backup so an OS reinstall does not restore stale units.
    // Path is intentionally hardcoded — setup-raid.sh always writes here.
    await agent.sendCommand('exec', {
      command: 'rm -rf /mnt/data/servicebay/quadlet-backup',
    });

    return NextResponse.json({
      ok: true,
      node: nodeName,
      dataDir,
      deleted,
      failed,
      protected: Array.from(PROTECTED),
      certArchive,
    });
  } catch (error) {
    return apiError(error, { tag: 'api:system:stacks:reset', status: 500 });
  }
}

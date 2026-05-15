import { NextRequest, NextResponse } from 'next/server';
import { agentManager } from '@/lib/agent/manager';
import { getConfig } from '@/lib/config';
import { DigitalTwinStore } from '@/lib/store/twin';
import { requireSession } from '@/lib/api/requireSession';
import { apiError } from '@/lib/api/errors';
import { logger } from '@/lib/logger';

export const dynamic = 'force-dynamic';

/**
 * Cert archive management.
 *
 * **Why this exists:** LE's "5 duplicate certs per 168h" rate limit
 * bites hard when an operator iterates on a fresh install — every
 * clean-install/reset wipes NPM's `/etc/letsencrypt` and `data/`
 * directories, so the next install re-requests the same domains and
 * the operator quickly hits the wall.
 *
 * Archives live at `/mnt/data/servicebay/cert-archive/npm-<ts>.tar.gz`.
 * That path is outside the reset endpoint's wipe target and outside
 * the OS-reinstall-recovery `quadlet-backup`, so a snapshot survives
 * everything short of `rm -rf /mnt/data/servicebay`.
 *
 * Endpoints:
 *   - `GET`  — list archives (newest first), each with size + mtime.
 *   - `POST` — take a fresh snapshot of the current NPM data dir.
 *   - `POST { restore: <filename> }` — restore an archive into NPM's
 *     data dir. Refuses if NPM has running services that would block
 *     the operation; recommends a stop-and-redeploy flow.
 */

const ARCHIVE_DIR = '/mnt/data/servicebay/cert-archive';

function resolveDataDir(cfg: { templateSettings?: Record<string, string> }): string {
  return cfg.templateSettings?.DATA_DIR || '/mnt/data/stacks';
}

function resolveNode(twin: DigitalTwinStore, requested?: string | null): string | null {
  if (requested) return requested;
  return Object.keys(twin.nodes)[0] ?? null;
}

interface ListEntry {
  filename: string;
  size: number;
  modifiedAt: string;
}

async function listArchives(): Promise<ListEntry[]> {
  const twin = DigitalTwinStore.getInstance();
  const node = resolveNode(twin);
  if (!node) return [];
  const agent = await agentManager.ensureAgent(node);
  const res = await agent.sendCommand('exec', {
    // GNU stat output: name|size|epoch. Sort by epoch desc so newest is first.
    command: `mkdir -p ${ARCHIVE_DIR} && find ${ARCHIVE_DIR} -maxdepth 1 -type f -name 'npm-*.tar.gz' -printf '%f|%s|%T@\\n' 2>/dev/null | sort -t '|' -k3 -r`,
  });
  const lines = (res.stdout || '').split('\n').filter(Boolean);
  return lines.map((line: string) => {
    const [filename, sizeStr, epochStr] = line.split('|');
    const epoch = parseFloat(epochStr || '0');
    return {
      filename,
      size: parseInt(sizeStr || '0', 10),
      modifiedAt: Number.isFinite(epoch) ? new Date(epoch * 1000).toISOString() : new Date(0).toISOString(),
    };
  });
}

export async function GET(request: NextRequest) {
  try {
    const auth = await requireSession(request);
    if (auth instanceof NextResponse) return auth;
    const archives = await listArchives();
    return NextResponse.json({ archives, archiveDir: ARCHIVE_DIR });
  } catch (error) {
    return apiError(error, { tag: 'api:system:certs:archive:list', status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await requireSession(request);
    if (auth instanceof NextResponse) return auth;

    const body = (await request.json().catch(() => ({}))) as { restore?: string; node?: string };
    const twin = DigitalTwinStore.getInstance();
    const node = resolveNode(twin, body.node);
    if (!node) return NextResponse.json({ error: 'No nodes available' }, { status: 404 });

    const cfg = await getConfig();
    const dataDir = resolveDataDir(cfg);
    const agent = await agentManager.ensureAgent(node);

    if (body.restore) {
      // Refuse paths that escape the archive dir — the only way to
      // weaponise this endpoint is to point it at an arbitrary
      // tarball outside our control.
      if (!/^npm-[A-Za-z0-9_.\-]+\.tar\.gz$/.test(body.restore)) {
        return NextResponse.json({ error: 'Invalid archive filename' }, { status: 400 });
      }
      const archivePath = `${ARCHIVE_DIR}/${body.restore}`;
      // Refuse if NPM's data dir is non-empty — we don't want to
      // half-overwrite a running stack's state. Operator should
      // reset (which now auto-snapshots) and reinstall instead.
      const probe = await agent.sendCommand('exec', {
        command: `[ -d "${dataDir}/nginx-proxy-manager" ] && find "${dataDir}/nginx-proxy-manager" -mindepth 1 -maxdepth 1 | head -1 || true`,
      });
      if ((probe.stdout || '').trim()) {
        return NextResponse.json({
          error: 'NPM data dir is not empty. Run a clean install (which auto-archives current state) and the install runner will restore this snapshot on the next nginx deploy.',
        }, { status: 409 });
      }
      await agent.sendCommand('exec', {
        command: `mkdir -p "${dataDir}" && tar xzf "${archivePath}" -C "${dataDir}"`,
      });
      logger.info('CertArchive', `Restored ${archivePath} into ${dataDir}/nginx-proxy-manager`);
      return NextResponse.json({ ok: true, restored: archivePath });
    }

    // Snapshot path.
    const probe = await agent.sendCommand('exec', {
      command: `[ -d "${dataDir}/nginx-proxy-manager/letsencrypt/live" ] && find "${dataDir}/nginx-proxy-manager/letsencrypt/live" -mindepth 1 -maxdepth 1 -type d | head -1 || true`,
    });
    if (!(probe.stdout || '').trim()) {
      return NextResponse.json({ error: 'No issued certs found — nothing worth archiving yet.' }, { status: 400 });
    }
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `npm-${ts}.tar.gz`;
    const archivePath = `${ARCHIVE_DIR}/${filename}`;
    await agent.sendCommand('exec', {
      command: `mkdir -p ${ARCHIVE_DIR} && tar czf "${archivePath}" -C "${dataDir}" nginx-proxy-manager`,
    });
    const stat = await agent.sendCommand('exec', {
      command: `stat -c '%s|%Y' "${archivePath}" 2>/dev/null || true`,
    });
    const [sizeStr, epochStr] = (stat.stdout || '').trim().split('|');
    logger.info('CertArchive', `Snapshot saved to ${archivePath}`);
    return NextResponse.json({
      ok: true,
      archive: {
        filename,
        size: parseInt(sizeStr || '0', 10),
        modifiedAt: epochStr ? new Date(parseFloat(epochStr) * 1000).toISOString() : new Date().toISOString(),
      },
    });
  } catch (error) {
    return apiError(error, { tag: 'api:system:certs:archive:write', status: 500 });
  }
}

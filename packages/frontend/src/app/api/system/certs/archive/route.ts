import { NextResponse } from 'next/server';
import { z } from 'zod';
import { agentManager } from '@/lib/agent/manager';
import { getConfig } from '@/lib/config';
import { getNodeTwins } from '@/lib/store/repository';
import { logger } from '@/lib/logger';
import { withApiHandler } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

/**
 * Cert archive management (#603 — migrated to withApiHandler).
 *
 * LE's "5 duplicate certs per 168h" rate limit bites when an operator
 * iterates on a fresh install; this endpoint manages snapshots at
 * `/mnt/data/servicebay/cert-archive/npm-<ts>.tar.gz` that survive
 * a clean install + OS reinstall.
 */

const ARCHIVE_DIR = '/mnt/data/servicebay/cert-archive';

function resolveDataDir(cfg: { templateSettings?: Record<string, string> }): string {
  return cfg.templateSettings?.DATA_DIR || '/mnt/data/stacks';
}

function resolveNode(requested?: string | null): string | null {
  if (requested) return requested;
  return Object.keys(getNodeTwins())[0] ?? null;
}

interface ListEntry {
  filename: string;
  size: number;
  modifiedAt: string;
}

async function listArchives(): Promise<ListEntry[]> {
  const node = resolveNode();
  if (!node) return [];
  const agent = await agentManager.ensureAgent(node);
  const res = await agent.sendCommand('exec', {
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

export const GET = withApiHandler({}, async () => {
  const archives = await listArchives();
  return NextResponse.json({ archives, archiveDir: ARCHIVE_DIR });
});

const PostBody = z.object({
  restore: z.string().optional(),
  node: z.string().optional(),
});

export const POST = withApiHandler({ body: PostBody }, async ({ body }) => {
  const node = resolveNode(body.node);
  if (!node) return NextResponse.json({ error: 'No nodes available' }, { status: 404 });

  const cfg = await getConfig();
  const dataDir = resolveDataDir(cfg);
  const agent = await agentManager.ensureAgent(node);

  if (body.restore) {
    if (!/^npm-[A-Za-z0-9_.\-]+\.tar\.gz$/.test(body.restore)) {
      return NextResponse.json({ error: 'Invalid archive filename' }, { status: 400 });
    }
    const archivePath = `${ARCHIVE_DIR}/${body.restore}`;
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
});

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getConfig, updateConfig } from '@/lib/config';
import { runBackup, getBackupHistory, isBackupRunning, testBackupTarget, scheduleBackup } from '@/lib/backup/service';
import type { BackupConfig, BackupTarget } from '@/lib/backup/types';
import { HealthStore } from '@/lib/health/store';
import { withApiHandler } from '@/lib/api/handler';
import crypto from 'crypto';

export const dynamic = 'force-dynamic';

const BACKUP_CHECK_NAME = 'Backup Sync';

function ensureBackupHealthCheck(enabled: boolean) {
  const checks = HealthStore.getChecks();
  const existing = checks.find(c => c.type === 'backup' && c.name === BACKUP_CHECK_NAME);
  if (enabled && !existing) {
    HealthStore.saveCheck({
      id: crypto.randomUUID(),
      name: BACKUP_CHECK_NAME,
      type: 'backup',
      target: 'backup-sync',
      interval: 300,
      enabled: true,
      created_at: new Date().toISOString(),
    });
  } else if (!enabled && existing) {
    HealthStore.deleteCheck(existing.id);
  }
}

// GET — Return backup config + recent history + status
export const GET = withApiHandler({}, async () => {
  const config = await getConfig();
  const history = await getBackupHistory();
  return NextResponse.json({
    config: config.backup || null,
    history: history.slice(0, 20),
    running: isBackupRunning(),
  });
});

// POST — action dispatcher. Body validation per branch is loose
// (BackupConfig + BackupTarget come from `lib/backup/types.ts` and
// have a richer schema than is worth duplicating here); the migration
// keeps the same shape while picking up requireSession + uniform
// error envelope.
const PostBody = z.object({
  action: z.enum(['save', 'run', 'test']),
  config: z.unknown().optional(),
  target: z.unknown().optional(),
});

export const POST = withApiHandler({ body: PostBody }, async ({ body }) => {
  switch (body.action) {
    case 'save': {
      const backupConfig = body.config as BackupConfig | undefined;
      if (!backupConfig) {
        return NextResponse.json({ error: 'config is required' }, { status: 400 });
      }
      await updateConfig({ backup: backupConfig });
      ensureBackupHealthCheck(backupConfig.enabled);
      scheduleBackup();
      return NextResponse.json({ success: true });
    }
    case 'run': {
      if (isBackupRunning()) {
        return NextResponse.json({ error: 'Backup is already running' }, { status: 409 });
      }
      const config = await getConfig();
      if (!config.backup) {
        return NextResponse.json({ error: 'No backup configured' }, { status: 400 });
      }
      runBackup(config.backup).catch(() => { /* logged internally */ });
      return NextResponse.json({ success: true, message: 'Backup started' });
    }
    case 'test': {
      const target = body.target as BackupTarget | undefined;
      if (!target) {
        return NextResponse.json({ error: 'target is required' }, { status: 400 });
      }
      const result = await testBackupTarget(target);
      return NextResponse.json(result);
    }
  }
});

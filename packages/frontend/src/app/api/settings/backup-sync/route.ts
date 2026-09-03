import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getConfig, updateConfig } from '@/lib/config';
import { runBackup, getBackupHistory, isBackupRunning, testBackupTarget, scheduleBackup } from '@/lib/backup/service';
import type { BackupConfig, BackupTarget } from '@/lib/backup/types';
import { resolveBackupSources, redactBackupConfig, preserveBackupTargetSecrets } from '@/lib/backup/types';
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

// GET — Return backup config + recent history + status. The target's stored
// smb password is masked to a `hasPassword` flag (#2771): the settings load
// must never round-trip the live secret into the browser, so the form shows
// "a password is stored" and the operator overwrites it to change it.
export const GET = withApiHandler({}, async () => {
  const config = await getConfig();
  const history = await getBackupHistory();
  return NextResponse.json({
    config: config.backup ? redactBackupConfig(config.backup) : null,
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
      // The form never holds the stored password, so a save that left the
      // field alone sends it blank — keep the stored secret rather than
      // wiping it (#2771).
      const existing = await getConfig();
      await updateConfig({
        backup: {
          ...backupConfig,
          target: preserveBackupTargetSecrets(backupConfig.target, existing.backup?.target),
        },
      });
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
      // Resolve the configured sources so Test applies the same same-device
      // guard Run does (#1612) — a target on the source's filesystem is refused.
      const cfg = await getConfig();
      const sources = cfg.backup ? resolveBackupSources(cfg.backup) : [];
      // Same blank-means-stored rule as save (#2771), so Test still works on a
      // target whose password the operator never re-typed.
      const result = await testBackupTarget(preserveBackupTargetSecrets(target, cfg.backup?.target), sources);
      return NextResponse.json(result);
    }
  }
});

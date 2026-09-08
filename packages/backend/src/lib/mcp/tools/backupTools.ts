/**
 * Backup MCP tools (#2384 extraction): backup history, an on-demand run, and
 * the full-system restore.
 *
 * Both listing and running report the box's TWO backup mechanisms separately
 * (ADR 0002, #2872): Backup Sync (content → operator-chosen destination) and
 * the nightly config push (per-service configuration → NAS). Collapsing them
 * into one number is how a healthy nightly run hid the fact that nothing else
 * had run for a year.
 */
import { z } from 'zod';
import { getBackupHistory, isBackupRunning } from '@/lib/backup/service';
import { runBackupNow } from '@/lib/backup/runNow';
import { listServiceBackups } from '@/lib/externalBackup/producer';
import { getConfig } from '@/lib/config';
import { restoreSystemBackup } from '@/lib/systemBackup';
import { textResult, errorResult, type ToolRegistration } from './context';

/**
 * What the NAS holds and how its last run went. The listing is a live NAS
 * round-trip, so a failure there is reported as its own field rather than
 * taking the whole tool down — the recorded run outcome is still worth having
 * when the share is unreachable.
 */
async function nasConfigBackupSummary() {
  const record = (await getConfig()).externalBackup;
  const lastRun = {
    lastRun: record?.lastRun ?? null,
    lastStatus: record?.lastStatus ?? null,
    lastMessage: record?.lastMessage ?? null,
    servicesOk: record?.servicesOk ?? null,
    servicesTotal: record?.servicesTotal ?? null,
    servicesIncomplete: record?.servicesIncomplete ?? [],
  };
  try {
    return { ...lastRun, backups: await listServiceBackups() };
  } catch (err) {
    return { ...lastRun, backups: [], listError: err instanceof Error ? err.message : String(err) };
  }
}

export function registerBackupTools({ server }: ToolRegistration) {
  server.tool(
    'list_backups',
    'List recent backup runs: Backup Sync (content) runs, plus the NAS config backup — its last run and the service tarballs currently on the NAS',
    {},
    async () => {
      const [contentRuns, configBackup] = await Promise.all([getBackupHistory(), nasConfigBackupSummary()]);
      return textResult({ contentBackup: { runs: contentRuns }, configBackup });
    },
  );

  server.tool(
    'run_backup',
    'Trigger a backup run now. Runs Backup Sync when a content target is configured, otherwise backs up every installed service\'s configuration to the NAS. Returns the run record once complete. Errors if a backup is already running.',
    {},
    async () => {
      if (isBackupRunning()) {
        return errorResult('A backup is already running. Wait for it to finish before starting another.');
      }
      try {
        const result = await runBackupNow();
        return textResult(result);
      } catch (err) {
        return errorResult(`Backup failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  server.tool(
    'restore_backup',
    'Restore a full system backup from a backup file. This restores config, services, and data — use with care. For selective restore, use the UI.',
    {
      fileName: z.string().min(1).describe('Backup file name as returned by list_backups (e.g. "servicebay-2026-05-04.tar.gz")'),
    },
    async ({ fileName }) => {
      try {
        const entry = await restoreSystemBackup(fileName);
        return textResult({ restored: entry });
      } catch (err) {
        return errorResult(`Restore failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );
}

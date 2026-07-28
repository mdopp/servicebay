/**
 * Backup MCP tools (#2384 extraction): backup history, an on-demand run, and
 * the full-system restore.
 */
import { z } from 'zod';
import {
  getBackupHistory,
  runBackup as runBackupService,
  isBackupRunning,
} from '@/lib/backup/service';
import { restoreSystemBackup } from '@/lib/systemBackup';
import { textResult, errorResult, type ToolRegistration } from './context';

export function registerBackupTools({ server }: ToolRegistration) {
  server.tool('list_backups', 'List recent backup runs (success / failed) with timestamps and file paths', {}, async () => {
    const history = await getBackupHistory();
    return textResult(history);
  });

  server.tool(
    'run_backup',
    'Trigger a backup run now. Returns the run record once complete. Errors if a backup is already running.',
    {},
    async () => {
      if (isBackupRunning()) {
        return errorResult('A backup is already running. Wait for it to finish before starting another.');
      }
      try {
        const result = await runBackupService();
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

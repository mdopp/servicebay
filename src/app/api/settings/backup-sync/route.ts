import { NextResponse } from 'next/server';
import { getConfig, updateConfig } from '@/lib/config';
import { runBackup, getBackupHistory, isBackupRunning, testBackupTarget, scheduleBackup } from '@/lib/backup/service';
import type { BackupConfig, BackupTarget } from '@/lib/backup/types';
import { MonitoringStore } from '@/lib/monitoring/store';
import crypto from 'crypto';

export const dynamic = 'force-dynamic';

const BACKUP_CHECK_NAME = 'Backup Sync';

function ensureBackupMonitoringCheck(enabled: boolean) {
    const checks = MonitoringStore.getChecks();
    const existing = checks.find(c => c.type === 'backup' && c.name === BACKUP_CHECK_NAME);

    if (enabled && !existing) {
        MonitoringStore.saveCheck({
            id: crypto.randomUUID(),
            name: BACKUP_CHECK_NAME,
            type: 'backup',
            target: 'backup-sync',
            interval: 300, // check every 5 minutes
            enabled: true,
            created_at: new Date().toISOString(),
        });
    } else if (!enabled && existing) {
        MonitoringStore.deleteCheck(existing.id);
    }
}

// GET — Return backup config + recent history + status
export async function GET() {
    try {
        const config = await getConfig();
        const history = await getBackupHistory();
        return NextResponse.json({
            config: config.backup || null,
            history: history.slice(0, 20),
            running: isBackupRunning(),
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to load backup config';
        return NextResponse.json({ error: message }, { status: 500 });
    }
}

// POST — Actions: save, run, test
export async function POST(request: Request) {
    try {
        const body = await request.json();
        const action = body.action as string;

        switch (action) {
            case 'save': {
                const backupConfig = body.config as BackupConfig;
                if (!backupConfig) {
                    return NextResponse.json({ error: 'config is required' }, { status: 400 });
                }
                await updateConfig({ backup: backupConfig });
                // Create or remove monitoring check
                ensureBackupMonitoringCheck(backupConfig.enabled);
                // Reschedule
                scheduleBackup();
                return NextResponse.json({ success: true });
            }

            case 'run': {
                if (isBackupRunning()) {
                    return NextResponse.json({ error: 'Backup is already running' }, { status: 409 });
                }
                // Run in background, return immediately
                const config = await getConfig();
                if (!config.backup) {
                    return NextResponse.json({ error: 'No backup configured' }, { status: 400 });
                }
                // Fire and forget — client polls for status
                runBackup(config.backup).catch(() => { /* logged internally */ });
                return NextResponse.json({ success: true, message: 'Backup started' });
            }

            case 'test': {
                const target = body.target as BackupTarget;
                if (!target) {
                    return NextResponse.json({ error: 'target is required' }, { status: 400 });
                }
                const result = await testBackupTarget(target);
                return NextResponse.json(result);
            }

            default:
                return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to process backup action';
        return NextResponse.json({ error: message }, { status: 500 });
    }
}

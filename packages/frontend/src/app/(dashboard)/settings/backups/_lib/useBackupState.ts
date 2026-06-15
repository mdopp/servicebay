'use client';

import { useCallback, useState } from 'react';
import { useToast } from '@/providers/ToastProvider';
import type { BackupLogEntry, BackupPreviewResult } from '@/lib/systemBackup';
import type { SystemBackupEntrySummary } from '../../_lib/helpers';

type RestoreSelectionState = {
  nodes: Record<string, boolean>;
  checks: Record<string, boolean>;
  configFlags: {
    externalLinks: boolean;
    registries: boolean;
    gateway: boolean;
    notifications: boolean;
    templateSettings: boolean;
    logLevel: boolean;
    update: boolean;
  };
  nodeFiles: Record<string, Record<string, boolean>>;
  targetNodes: Record<string, string>;
  serviceData: Record<string, Record<string, boolean>>;
};

// One editable source row. `excludePatterns` is a newline-delimited string
// while editing; it's split into a string[] on save.
export type BackupSourceDraft = {
  path: string;
  excludePatterns: string;
};

type BackupSyncState = {
  enabled: boolean;
  schedule: 'hourly' | 'daily' | 'weekly' | 'monthly';
  time: string;
  dayOfWeek?: number;
  dayOfMonth?: number;
  targetType: 'local' | 'ssh' | 'smb' | 'nfs';
  localPath: string;
  sshHost: string;
  sshPort: string;
  sshUser: string;
  sshPath: string;
  sshIdentityFile: string;
  smbHost: string;
  smbShare: string;
  smbPath: string;
  smbUsername: string;
  smbPassword: string;
  nfsHost: string;
  nfsExport: string;
  nfsPath: string;
  sources: BackupSourceDraft[];
  lastRun?: string;
  lastStatus?: 'success' | 'error';
  lastMessage?: string;
  lastDuration?: number;
};

export function useBackupState() {
  const { addToast } = useToast();

  const [backups, setBackups] = useState<SystemBackupEntrySummary[]>([]);
  const [backupsLoading, setBackupsLoading] = useState(true);
  const [creatingBackup, setCreatingBackup] = useState(false);
  const [restoreOverlayOpen, setRestoreOverlayOpen] = useState(false);
  const [restoringBackup, setRestoringBackup] = useState(false);
  const [restorePreview, setRestorePreview] = useState<BackupPreviewResult | null>(null);
  const [restoreSource, setRestoreSource] = useState<{ type: 'stored' | 'upload'; fileName?: string; token?: string } | null>(null);
  const [restoreUploadError, setRestoreUploadError] = useState<string | null>(null);
  const [restoreFilePreview, setRestoreFilePreview] = useState<{ nodeName: string; relativePath: string; content: string; loading: boolean } | null>(null);
  const [restoreFilePreviewError, setRestoreFilePreviewError] = useState<string | null>(null);
  const [restoreSelectionState, setRestoreSelectionState] = useState<RestoreSelectionState | null>(null);
  const [backupLog, setBackupLog] = useState<BackupLogEntry[]>([]);
  const [backupStatus, setBackupStatus] = useState<'idle' | 'running' | 'success' | 'error'>('idle');
  const [deleteTarget, setDeleteTarget] = useState<SystemBackupEntrySummary | null>(null);
  const [deletingBackup, setDeletingBackup] = useState(false);
  const [restoreExpandedSections, setRestoreExpandedSections] = useState<Record<string, boolean>>({});
  const [restoringLatest, setRestoringLatest] = useState(false);
  const [confirmRestoreLatestOpen, setConfirmRestoreLatestOpen] = useState(false);
  const [showAllBackups, setShowAllBackups] = useState(false);

  const [backupSync, setBackupSync] = useState<BackupSyncState>({
    enabled: false,
    schedule: 'daily',
    time: '02:00',
    targetType: 'local',
    localPath: '/mnt/backup',
    sshHost: '', sshPort: '22', sshUser: 'root', sshPath: '/backup', sshIdentityFile: '/app/data/ssh/id_rsa',
    smbHost: '', smbShare: '', smbPath: '', smbUsername: '', smbPassword: '',
    nfsHost: '', nfsExport: '', nfsPath: '',
    sources: [{ path: '/mnt/data', excludePatterns: '' }],
  });
  const [backupSyncHistory, setBackupSyncHistory] = useState<Array<{ success: boolean; startedAt: string; completedAt: string; duration: number; message: string; filesTransferred?: number }>>([]);
  const [backupSyncRunning, setBackupSyncRunning] = useState(false);
  const [backupSyncTesting, setBackupSyncTesting] = useState(false);
  const [backupSyncSaving, setBackupSyncSaving] = useState(false);
  const [backupSyncTestResult, setBackupSyncTestResult] = useState<{ success: boolean; message: string } | null>(null);

  const [nasOverview, setNasOverview] = useState<{
    configured: boolean;
    connection: { ok: true } | { ok: false; error: string } | null;
    // `stamp` is the dated-snapshot timestamp (null for a bare legacy slot, #1865).
    backups: { service: string; tarName: string; size: number; stamp?: string | null }[];
  } | null>(null);
  const [nasLoading, setNasLoading] = useState(true);
  const [nasRestoring, setNasRestoring] = useState<string | null>(null);
  const [nasRestoreTarget, setNasRestoreTarget] = useState<{ service: string; tarName: string } | null>(null);

  const fetchBackups = useCallback(async () => {
    setBackupsLoading(true);
    try {
      const res = await fetch('/api/settings/backups');
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.error || 'Unable to load backups');
      }
      const data: SystemBackupEntrySummary[] = await res.json();
      setBackups(data);
    } catch (error) {
      console.error(error);
      const message = error instanceof Error ? error.message : undefined;
      addToast('error', 'Failed to load backups', message);
    } finally {
      setBackupsLoading(false);
    }
  }, [addToast]);

  const fetchBackupSync = useCallback(async () => {
    try {
      const res = await fetch('/api/settings/backup-sync');
      if (!res.ok) return;
      const data = await res.json();
      if (data.config) {
        const c = data.config;
        const t = c.target || { type: 'local', path: '/mnt/backup' };
        // New configs carry `sources`; pre-multi-source configs carry the
        // legacy single `sourcePath`/`excludePatterns` pair — fold it into a
        // one-element list so the editor always renders a source row.
        const sources: BackupSourceDraft[] = Array.isArray(c.sources) && c.sources.length > 0
          ? c.sources.map((s: { path: string; excludePatterns?: string[] }) => ({
              path: s.path ?? '',
              excludePatterns: (s.excludePatterns || []).join('\n'),
            }))
          : [{ path: c.sourcePath ?? '/mnt/data', excludePatterns: (c.excludePatterns || []).join('\n') }];
        setBackupSync(prev => ({
          ...prev,
          enabled: c.enabled ?? false,
          schedule: c.schedule ?? 'daily',
          time: c.time ?? '02:00',
          dayOfWeek: c.dayOfWeek,
          dayOfMonth: c.dayOfMonth,
          sources,
          targetType: t.type ?? 'local',
          localPath: t.type === 'local' ? t.path : prev.localPath,
          sshHost: t.type === 'ssh' ? t.host : prev.sshHost,
          sshPort: t.type === 'ssh' ? String(t.port ?? 22) : prev.sshPort,
          sshUser: t.type === 'ssh' ? t.user : prev.sshUser,
          sshPath: t.type === 'ssh' ? t.path : prev.sshPath,
          sshIdentityFile: t.type === 'ssh' ? (t.identityFile ?? '/app/data/ssh/id_rsa') : prev.sshIdentityFile,
          smbHost: t.type === 'smb' ? t.host : prev.smbHost,
          smbShare: t.type === 'smb' ? t.share : prev.smbShare,
          smbPath: t.type === 'smb' ? (t.path ?? '') : prev.smbPath,
          smbUsername: t.type === 'smb' ? (t.username ?? '') : prev.smbUsername,
          smbPassword: t.type === 'smb' ? (t.password ?? '') : prev.smbPassword,
          nfsHost: t.type === 'nfs' ? t.host : prev.nfsHost,
          nfsExport: t.type === 'nfs' ? t.export : prev.nfsExport,
          nfsPath: t.type === 'nfs' ? (t.path ?? '') : prev.nfsPath,
          lastRun: c.lastRun,
          lastStatus: c.lastStatus,
          lastMessage: c.lastMessage,
          lastDuration: c.lastDuration,
        }));
      }
      if (data.history) setBackupSyncHistory(data.history);
      setBackupSyncRunning(data.running ?? false);
    } catch { /* ignore */ }
  }, []);

  const fetchNasOverview = useCallback(async () => {
    setNasLoading(true);
    try {
      const res = await fetch('/api/system/external-backup/list');
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Unable to read NAS backups');
      setNasOverview({ configured: data.configured, connection: data.connection, backups: data.backups ?? [] });
    } catch (error) {
      console.error(error);
      setNasOverview({ configured: false, connection: null, backups: [] });
    } finally {
      setNasLoading(false);
    }
  }, []);

  return {
    backups, setBackups,
    backupsLoading,
    creatingBackup, setCreatingBackup,
    restoreOverlayOpen, setRestoreOverlayOpen,
    restoringBackup, setRestoringBackup,
    restorePreview, setRestorePreview,
    restoreSource, setRestoreSource,
    restoreUploadError, setRestoreUploadError,
    restoreFilePreview, setRestoreFilePreview,
    restoreFilePreviewError, setRestoreFilePreviewError,
    restoreSelectionState, setRestoreSelectionState,
    backupLog, setBackupLog,
    backupStatus, setBackupStatus,
    deleteTarget, setDeleteTarget,
    deletingBackup, setDeletingBackup,
    restoreExpandedSections, setRestoreExpandedSections,
    restoringLatest, setRestoringLatest,
    confirmRestoreLatestOpen, setConfirmRestoreLatestOpen,
    showAllBackups, setShowAllBackups,
    backupSync, setBackupSync,
    backupSyncHistory, setBackupSyncHistory,
    backupSyncRunning, setBackupSyncRunning,
    backupSyncTesting, setBackupSyncTesting,
    backupSyncSaving, setBackupSyncSaving,
    backupSyncTestResult, setBackupSyncTestResult,
    nasOverview, setNasOverview,
    nasLoading,
    nasRestoring, setNasRestoring,
    nasRestoreTarget, setNasRestoreTarget,
    fetchBackups,
    fetchBackupSync,
    fetchNasOverview,
  };
}

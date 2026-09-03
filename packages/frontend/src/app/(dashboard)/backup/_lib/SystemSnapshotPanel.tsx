'use client';

import { useCallback } from 'react';
import {
  Trash2,
  Download,
  Clock,
  Loader2,
  CheckCircle2,
  XCircle,
  HardDrive,
  RotateCcw,
  UploadCloud,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';
import { useToast } from '@/providers/ToastProvider';
import { Button, Table } from '@/components/ui';
import ConfirmModal from '@/components/ConfirmModal';
import {
  formatBytes,
  LOG_STATUS_BADGES,
  LOG_STATUS_DOTS,
  type BackupStreamEvent,
  type SystemBackupEntrySummary,
} from './helpers';
import type { BackupState } from './useBackupState';

const BACKUP_PREVIEW_COUNT = 5;

interface Props {
  state: BackupState;
  /** Nightly NAS-push schedule line, shared with the NAS panel. */
  scheduleLine: string | null;
  openRestoreOverlay: (reset?: boolean) => void;
  handleRestoreRequest: (entry: SystemBackupEntrySummary) => void;
}

/**
 * Backend 1 of 3: the local **system tar** snapshot — create/download/delete the
 * config archive under `~/.config/containers/systemd/backups`, plus the
 * one-click "restore latest" CTA. Split out of backup/page.tsx (#2743).
 */
export default function SystemSnapshotPanel({ state, scheduleLine, openRestoreOverlay, handleRestoreRequest }: Props) {
  const { addToast } = useToast();
  const {
    backups, backupsLoading,
    creatingBackup, setCreatingBackup,
    backupLog, setBackupLog,
    backupStatus, setBackupStatus,
    deleteTarget, setDeleteTarget,
    deletingBackup, setDeletingBackup,
    restoringLatest, setRestoringLatest,
    confirmRestoreLatestOpen, setConfirmRestoreLatestOpen,
    showAllBackups, setShowAllBackups,
    fetchBackups,
  } = state;

  const handleCreateBackup = async () => {
    if (creatingBackup) return;
    setCreatingBackup(true);
    setBackupStatus('running');
    setBackupLog([]);
    let sawDone = false;
    let errorMessage: string | null = null;

    try {
      const res = await fetch('/api/settings/backups', { method: 'POST' });
      if (!res.body) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.error || 'Streaming not supported by server');
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });

        let newlineIndex = buffer.indexOf('\n');
        while (newlineIndex !== -1) {
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);
          if (line.length > 0) {
            try {
              const event = JSON.parse(line) as BackupStreamEvent;
              if (event.type === 'log' && event.entry) {
                setBackupLog(prev => [...prev, event.entry]);
              } else if (event.type === 'done') {
                if (!sawDone) {
                  sawDone = true;
                  setBackupStatus('success');
                  addToast('success', 'Backup created', `Archive ${event.backup.fileName} is ready.`);
                  await fetchBackups();
                }
              } else if (event.type === 'error') {
                errorMessage = event.message || 'Backup failed';
                setBackupStatus('error');
                addToast('error', 'Failed to create backup', errorMessage);
              }
            } catch {
              // ignore malformed chunk
            }
          }
          newlineIndex = buffer.indexOf('\n');
        }

        if (done) break;
      }

      if (!sawDone && !errorMessage) {
        throw new Error('Backup stream ended unexpectedly');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      errorMessage = message;
      setBackupStatus('error');
      addToast('error', 'Failed to create backup', message);
    } finally {
      setCreatingBackup(false);
    }
  };

  const handleDownloadBackup = (fileName: string) => {
    const link = document.createElement('a');
    link.href = `/api/settings/backups/download?file=${encodeURIComponent(fileName)}`;
    link.target = '_blank';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const confirmDeleteBackup = async () => {
    if (!deleteTarget || deletingBackup) return;
    setDeletingBackup(true);
    try {
      const res = await fetch('/api/settings/backups', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileName: deleteTarget.fileName }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Unable to delete backup');
      addToast('success', 'Backup deleted', `${deleteTarget.fileName} has been removed.`);
      await fetchBackups();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      addToast('error', 'Failed to delete backup', message);
    } finally {
      setDeletingBackup(false);
      setDeleteTarget(null);
    }
  };

  const handleRestoreLatest = useCallback(async () => {
    if (backups.length === 0 || restoringLatest) return;
    setRestoringLatest(true);
    try {
      const latest = backups[0];
      const res = await fetch('/api/settings/backups/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileName: latest.fileName }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Restore failed');
      }
      addToast('success', 'Restore complete', `Restored from ${latest.fileName}`);
      await fetchBackups();
    } catch (e) {
      addToast('error', 'Restore failed', e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setRestoringLatest(false);
      setConfirmRestoreLatestOpen(false);
    }
  }, [backups, restoringLatest, addToast, fetchBackups, setRestoringLatest, setConfirmRestoreLatestOpen]);

  return (
    <>
      {/* Primary CTA: one-click restore from latest snapshot. The selective
          flow stays available behind "Selective restore…" / per-row Restore. */}
      {backups.length > 0 && (
        <div className="bg-status-ok/10 border border-status-ok/30 rounded-card shadow-sm overflow-hidden w-full">
          <div className="p-5 flex flex-col md:flex-row md:items-center gap-4">
            <div className="p-3 bg-status-ok/15 rounded-card text-status-ok shrink-0">
              <RotateCcw size={24} />
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="font-bold text-text">Restore latest snapshot</h3>
              <p className="text-sm text-text-muted break-all">
                One-click restore of <span className="font-mono">{backups[0].fileName}</span>{' '}
                <span className="text-text-subtle">
                  ({new Date(backups[0].createdAt).toLocaleString()}, {formatBytes(backups[0].size)})
                </span>
              </p>
              <p className="text-xs text-text-subtle mt-1">
                Need granular control?{' '}
                <Button
                  onClick={() => openRestoreOverlay(true)}
                  className="text-status-ok underline"
                >
                  Selective restore…
                </Button>
              </p>
            </div>
            <Button
              onClick={() => setConfirmRestoreLatestOpen(true)}
              disabled={restoringLatest}
              className="shrink-0 bg-status-ok text-on-accent hover:bg-status-ok/90"
            >
              {restoringLatest ? <Loader2 className="animate-spin" size={18} /> : <RotateCcw size={18} />}
              {restoringLatest ? 'Restoring…' : 'Restore'}
            </Button>
          </div>
        </div>
      )}

      {/* System Snapshot — config/setup; downloadable + NAS-pushed + auto-restored. */}
      <div className="bg-surface rounded-card border border-border shadow-sm overflow-hidden w-full">
        <div className="p-4 border-b border-border bg-surface-2 flex flex-col gap-3 md:flex-row md:items-center">
          <div className="flex items-center gap-3 flex-1">
            <div className="p-2 bg-status-ok/15 rounded-card text-status-ok">
              <HardDrive size={20} />
            </div>
            <div>
              <h3 className="font-bold text-text">System Snapshot</h3>
              <p className="text-xs text-text-muted">Your setup and per-service config (settings, not bulk data). Download it on demand; it&apos;s pushed to the NAS on a schedule and auto-restored on reinstall.</p>
              {scheduleLine && (
                <p className="mt-1 inline-flex items-center gap-1 text-[11px] text-text-muted">
                  <Clock size={12} /> {scheduleLine}
                </p>
              )}
              {backupStatus !== 'idle' && (
                <div className="mt-1 flex items-center gap-2 text-[11px] text-text-muted">
                  {backupStatus === 'running' && (
                    <span className="inline-flex items-center gap-1 text-status-ok">
                      <Loader2 className="w-3 h-3 animate-spin" /> Backup in progress
                    </span>
                  )}
                  {backupStatus === 'success' && (
                    <span className="inline-flex items-center gap-1 text-status-ok">
                      <CheckCircle2 className="w-3 h-3" /> Latest run completed
                    </span>
                  )}
                  {backupStatus === 'error' && (
                    <span className="inline-flex items-center gap-1 text-status-fail">
                      <XCircle className="w-3 h-3" /> Last run failed
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>
          <div className="flex flex-col md:flex-row md:items-center gap-3">
            <p className="text-[11px] text-text-muted bg-surface-muted px-3 py-1 rounded-card border border-border">
              Archives stored under <span className="font-mono">~/.config/containers/systemd/backups</span>
            </p>
            <Button variant="secondary" onClick={() => openRestoreOverlay(true)}>
              <UploadCloud size={16} /> Selective restore…
            </Button>
            <Button
              onClick={handleCreateBackup}
              disabled={creatingBackup}
              className="bg-status-ok text-on-accent hover:bg-status-ok/90"
            >
              {creatingBackup ? <Loader2 className="animate-spin" size={16} /> : <Download size={16} />}
              {creatingBackup ? 'Creating snapshot...' : 'Create Snapshot'}
            </Button>
          </div>
        </div>
        <div className="p-6">
          {backupsLoading ? (
            <div className="flex items-center gap-3 text-sm text-text-muted">
              <Loader2 className="animate-spin" size={18} />
              Loading backups...
            </div>
          ) : backups.length === 0 ? (
            <div className="text-sm text-text-muted italic">No snapshots yet. Create one to capture your setup and per-service config.</div>
          ) : (
            <div className="overflow-x-auto">
              <Table className="min-w-full text-sm">
                <thead>
                  <tr className="text-left text-text-muted border-b border-border">
                    <th className="py-2 font-medium">Archive</th>
                    <th className="py-2 font-medium">Created</th>
                    <th className="py-2 font-medium">Size</th>
                    <th className="py-2 font-medium text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {(showAllBackups ? backups : backups.slice(0, BACKUP_PREVIEW_COUNT)).map(backup => (
                    <tr key={backup.fileName}>
                      <td className="py-3 font-mono text-xs text-accent break-all">{backup.fileName}</td>
                      <td className="py-3 text-text-muted">{new Date(backup.createdAt).toLocaleString()}</td>
                      <td className="py-3 text-text-muted">{formatBytes(backup.size)}</td>
                      <td className="py-3">
                        <div className="flex justify-end gap-2">
                          <Button size="sm" variant="secondary" onClick={() => handleDownloadBackup(backup.fileName)}>
                            <Download size={14} /> Download
                          </Button>
                          <Button size="sm" variant="secondary" onClick={() => handleRestoreRequest(backup)} className="text-status-warn border-status-warn/40 hover:bg-status-warn/10">
                            <RotateCcw size={14} /> Restore
                          </Button>
                          <Button size="sm" variant="danger" onClick={() => setDeleteTarget(backup)} disabled={deletingBackup}>
                            <Trash2 size={14} /> Delete
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
              {backups.length > BACKUP_PREVIEW_COUNT && (
                <Button
                  onClick={() => setShowAllBackups(v => !v)}
                  className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-text-muted hover:text-text transition-colors"
                >
                  {showAllBackups ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  {showAllBackups
                    ? `Show fewer (newest ${BACKUP_PREVIEW_COUNT})`
                    : `Show all ${backups.length} backups`}
                </Button>
              )}
            </div>
          )}

          {(backupLog.length > 0 || backupStatus === 'running' || backupStatus === 'error') && (
            <div className="mt-6 border border-border rounded-card p-4 bg-surface-muted">
              <div className="flex items-center justify-between mb-3">
                <span className="text-sm font-semibold text-text">Backup Activity</span>
                {backupStatus === 'running' && (
                  <span className="inline-flex items-center gap-1 text-xs text-status-ok">
                    <Loader2 className="w-3 h-3 animate-spin" /> Streaming logs
                  </span>
                )}
                {backupStatus === 'error' && (
                  <span className="inline-flex items-center gap-1 text-xs text-status-fail">
                    <XCircle className="w-3 h-3" /> Check details below
                  </span>
                )}
                {backupStatus === 'success' && backupLog.length > 0 && (
                  <span className="inline-flex items-center gap-1 text-xs text-status-ok">
                    <CheckCircle2 className="w-3 h-3" /> Completed
                  </span>
                )}
              </div>
              <div className="max-h-48 overflow-y-auto pr-1 space-y-3">
                {backupLog.length === 0 ? (
                  <p className="text-xs text-text-muted italic">Waiting for backup updates…</p>
                ) : (
                  backupLog.map((entry, idx) => (
                    <div key={`${entry.timestamp}-${idx}`} className="flex gap-3 text-xs">
                      <span className={`mt-1 h-2 w-2 rounded-full ${LOG_STATUS_DOTS[entry.status] ?? LOG_STATUS_DOTS.info}`}></span>
                      <div className="flex-1">
                        <div className="flex flex-wrap items-center gap-2 text-[11px] text-text-muted">
                          <span className="font-mono">{new Date(entry.timestamp).toLocaleTimeString()}</span>
                          {entry.node && <span className="uppercase tracking-wide text-text-muted">{entry.node}</span>}
                          <span className={`px-2 py-0.5 rounded ${LOG_STATUS_BADGES[entry.status] ?? LOG_STATUS_BADGES.info}`}>{entry.status.toUpperCase()}</span>
                        </div>
                        <p className="text-text">{entry.message}</p>
                        {entry.target && <p className="text-[10px] font-mono text-text-muted break-all">{entry.target}</p>}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      <ConfirmModal
        isOpen={!!deleteTarget}
        title="Delete Backup"
        message={`Delete ${deleteTarget?.fileName || 'this backup'} permanently? This action cannot be undone.`}
        confirmText={deletingBackup ? 'Deleting...' : 'Delete Backup'}
        confirmDisabled={deletingBackup}
        isDestructive
        onConfirm={confirmDeleteBackup}
        onCancel={() => !deletingBackup && setDeleteTarget(null)}
      />

      <ConfirmModal
        isOpen={confirmRestoreLatestOpen}
        title="Restore latest snapshot"
        message={`This will overwrite current ServiceBay state with the contents of ${backups[0]?.fileName ?? ''}. Continue?`}
        confirmText={restoringLatest ? 'Restoring…' : 'Restore'}
        confirmDisabled={restoringLatest}
        onConfirm={handleRestoreLatest}
        onCancel={() => !restoringLatest && setConfirmRestoreLatestOpen(false)}
      />
    </>
  );
}


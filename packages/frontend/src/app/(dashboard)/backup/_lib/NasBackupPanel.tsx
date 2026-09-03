'use client';

import { useCallback, useState } from 'react';
import {
  Trash2,
  RefreshCw,
  Clock,
  Loader2,
  CheckCircle2,
  XCircle,
  RotateCcw,
  UploadCloud,
  ChevronDown,
  ChevronRight,
  Network,
} from 'lucide-react';
import { useToast } from '@/providers/ToastProvider';
import { Button, Table } from '@/components/ui';
import { restoreFromExternalBackup, backupNowToExternal, deleteExternalBackup } from '@servicebay/api-client';
import ConfirmModal from '@/components/ConfirmModal';
import { formatBytes } from './helpers';
import ExternalBackupDestinationSection from './ExternalBackupDestinationSection';
import type { BackupState } from './useBackupState';

// NAS snapshot list can grow long (per-service, every push) and flood the
// panel — collapse to the newest N with a "show all" expander (#2085).
const NAS_PREVIEW_COUNT = 5;

interface Props {
  state: BackupState;
  /** Nightly NAS-push schedule line, shared with the System Snapshot panel. */
  scheduleLine: string | null;
}

/**
 * Backend 2 of 3: the **external NAS** (FritzBox SMB) per-service snapshots —
 * destination config, "back up now", and per-snapshot restore/delete.
 * Split out of backup/page.tsx (#2743).
 */
export default function NasBackupPanel({ state, scheduleLine }: Props) {
  const { addToast } = useToast();
  const [showAllNasBackups, setShowAllNasBackups] = useState(false);
  const {
    nasOverview,
    nasLoading,
    nasRestoring, setNasRestoring,
    nasRestoreTarget, setNasRestoreTarget,
    nasBackingUp, setNasBackingUp,
    nasDeleteTarget, setNasDeleteTarget,
    nasDeleting, setNasDeleting,
    fetchNasOverview,
  } = state;

  const confirmRestoreNasBackup = useCallback(async () => {
    if (!nasRestoreTarget || nasRestoring) return;
    const { service, tarName } = nasRestoreTarget;
    setNasRestoring(service);
    try {
      // Restore the SPECIFIC snapshot the operator picked (#1865), not just
      // the latest — recovering from before a silently-corrupted run.
      const data = await restoreFromExternalBackup(service, tarName);
      addToast('success', 'Restored from NAS', `${tarName} → ${data.dataDir} (${data.files} files)`);
    } catch (error) {
      addToast('error', 'NAS restore failed', error instanceof Error ? error.message : 'Unknown error');
    } finally {
      setNasRestoring(null);
      setNasRestoreTarget(null);
    }
  }, [nasRestoreTarget, nasRestoring, addToast, setNasRestoring, setNasRestoreTarget]);

  // "Back up to NAS now" (#1890) — reuses the EXISTING backup-now route (no new
  // endpoint); same progress/result feedback as the System-Snapshot create.
  const handleNasBackupNow = useCallback(async () => {
    if (nasBackingUp) return;
    setNasBackingUp(true);
    try {
      const data = await backupNowToExternal();
      const failed = (data.results ?? []).filter((r: { ok: boolean }) => !r.ok).length;
      if (data.backedUp === 0 && data.total > 0) {
        const firstError = (data.results ?? []).find((r: { error?: string }) => r.error)?.error;
        throw new Error(firstError || 'No services were backed up');
      }
      addToast(
        failed > 0 ? 'info' : 'success',
        'Backed up to NAS',
        `${data.backedUp}/${data.total} service${data.total === 1 ? '' : 's'} pushed to the NAS${failed > 0 ? ` (${failed} failed)` : ''}.`,
      );
      await fetchNasOverview();
    } catch (error) {
      addToast('error', 'NAS backup failed', error instanceof Error ? error.message : 'Unknown error');
    } finally {
      setNasBackingUp(false);
    }
  }, [nasBackingUp, addToast, setNasBackingUp, fetchNasOverview]);

  // Delete one NAS snapshot — the tar + its .meta.json sidecar (#1890).
  const confirmDeleteNasBackup = useCallback(async () => {
    if (!nasDeleteTarget || nasDeleting) return;
    const { tarName } = nasDeleteTarget;
    setNasDeleting(true);
    try {
      await deleteExternalBackup(nasDeleteTarget.service, tarName);
      addToast('success', 'NAS backup deleted', `${tarName} has been removed from the NAS.`);
      await fetchNasOverview();
    } catch (error) {
      addToast('error', 'Failed to delete NAS backup', error instanceof Error ? error.message : 'Unknown error');
    } finally {
      setNasDeleting(false);
      setNasDeleteTarget(null);
    }
  }, [nasDeleteTarget, nasDeleting, addToast, setNasDeleting, setNasDeleteTarget, fetchNasOverview]);

  // ─── Backup Sync handlers ─────────────────────────────────────────
  // The "Run Now" progress poller lives in a ref so it can be stopped from
  // anywhere — most importantly on unmount. Before #2459 the 5s interval was
  // created inline and never cleared, so navigating away mid-sync left it firing

  return (
    <>
      {/* System Snapshot — NAS storage mode (FritzBox). The same per-service
          config atoms the snapshot above carries, staged under sb-backup/ so a
          fresh install auto-restores them (#1440). Not a separate backup —
          this is where the snapshot lives off-box and how reinstall finds it. */}
      <div className="bg-surface rounded-card border border-border shadow-sm overflow-hidden w-full">
        <div className="p-4 border-b border-border bg-surface-2 flex flex-col gap-3 md:flex-row md:items-center">
          <div className="flex items-center gap-3 flex-1">
            <div className="p-2 bg-accent/10 rounded-card text-accent">
              <Network size={20} />
            </div>
            <div>
              <h3 className="font-bold text-text">Snapshot on NAS</h3>
              <p className="text-xs text-text-muted">Where the System Snapshot is pushed off-box so a fresh install can auto-restore it — the FritzBox USB NAS by default, or a separate FTP/SSH destination you set below.</p>
              {scheduleLine && (
                <p className="mt-1 inline-flex items-center gap-1 text-[11px] text-text-muted">
                  <Clock size={12} /> {scheduleLine}
                </p>
              )}
            </div>
          </div>
          <div className="flex flex-col sm:flex-row sm:items-center gap-2">
            <Button
              onClick={handleNasBackupNow}
              disabled={nasBackingUp || !nasOverview?.configured}
              title={!nasOverview?.configured ? 'Configure a NAS destination below first' : undefined}
            >
              {nasBackingUp ? <Loader2 className="animate-spin" size={16} /> : <UploadCloud size={16} />}
              {nasBackingUp ? 'Backing up…' : 'Back up now'}
            </Button>
            <Button variant="secondary" onClick={() => void fetchNasOverview()} disabled={nasLoading}>
              {nasLoading ? <Loader2 className="animate-spin" size={16} /> : <RefreshCw size={16} />} Verify connection
            </Button>
          </div>
        </div>
        <div className="p-6 space-y-6">
          {/* Destination config (#1525/#1527): FritzBox NAS creds defaulting to
              the gateway, or a separate FTP/SSH host — settable from the web UI. */}
          <div id="external-backup" className="scroll-mt-24">
            <ExternalBackupDestinationSection onSaved={() => void fetchNasOverview()} />
          </div>

          <div className="border-t border-border pt-4">
          {nasLoading ? (
            <div className="flex items-center gap-3 text-sm text-text-muted">
              <Loader2 className="animate-spin" size={18} /> Checking NAS…
            </div>
          ) : !nasOverview?.configured ? (
            <div className="text-sm text-text-muted">
              No NAS destination configured yet. Set one above (it defaults to the FritzBox gateway credentials), and the box will push the System Snapshot there and list it for a fresh install to auto-restore.
            </div>
          ) : nasOverview.connection && !nasOverview.connection.ok ? (
            <div className="flex items-start gap-2 text-sm text-status-fail">
              <XCircle size={16} className="mt-0.5 shrink-0" />
              <span>Could not reach the NAS: <span className="font-mono break-all">{nasOverview.connection.error}</span></span>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2 text-xs text-status-ok mb-3">
                <CheckCircle2 size={14} /> Connected to the FritzBox NAS.
              </div>
              {nasOverview.backups.length === 0 ? (
                <div className="text-sm text-text-muted italic">No snapshot staged on the NAS yet.</div>
              ) : (() => {
                // Newest-first: `createdAt`/`stamp` desc, undated legacy slots
                // (null) sort last. The list is already grouped per-service
                // newest-first; this flattens to a global newest-first order for
                // the table (#1890). Collapse to the newest N so a long history
                // doesn't flood the panel — expand to show all (#2085).
                const sortedNasBackups = [...nasOverview.backups].sort(
                  (a, b) => (b.createdAt ?? b.stamp ?? '').localeCompare(a.createdAt ?? a.stamp ?? ''),
                );
                const visibleNasBackups = showAllNasBackups
                  ? sortedNasBackups
                  : sortedNasBackups.slice(0, NAS_PREVIEW_COUNT);
                return (
                <div className="overflow-x-auto">
                  <Table className="min-w-full text-sm">
                    <thead>
                      <tr className="text-left text-text-muted border-b border-border">
                        <th className="py-2 font-medium">Service</th>
                        <th className="py-2 font-medium">File</th>
                        <th className="py-2 font-medium">Created</th>
                        <th className="py-2 font-medium">Size</th>
                        <th className="py-2 font-medium text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {visibleNasBackups.map(b => (
                        <tr key={b.tarName}>
                          <td className="py-3 text-text-muted">{b.service}</td>
                          <td className="py-3 font-mono text-xs text-accent break-all">{b.tarName}</td>
                          <td className="py-3 text-text-muted whitespace-nowrap">
                            {b.createdAt ? new Date(b.createdAt).toLocaleString() : '—'}
                          </td>
                          <td className="py-3 text-text-muted">{formatBytes(b.size)}</td>
                          <td className="py-3">
                            <div className="flex justify-end gap-2">
                              <Button
                                size="sm"
                                variant="secondary"
                                onClick={() => setNasRestoreTarget({ service: b.service, tarName: b.tarName })}
                                disabled={nasRestoring !== null}
                                className="text-status-warn border-status-warn/40 hover:bg-status-warn/10"
                              >
                                {nasRestoring === b.service ? <Loader2 className="animate-spin" size={14} /> : <RotateCcw size={14} />} Restore
                              </Button>
                              <Button
                                size="sm"
                                variant="danger"
                                onClick={() => setNasDeleteTarget({ service: b.service, tarName: b.tarName })}
                                disabled={nasDeleting}
                              >
                                <Trash2 size={14} /> Delete
                              </Button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                  {sortedNasBackups.length > NAS_PREVIEW_COUNT && (
                    <Button
                      onClick={() => setShowAllNasBackups(v => !v)}
                      className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-text-muted hover:text-text transition-colors"
                    >
                      {showAllNasBackups ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                      {showAllNasBackups
                        ? `Show fewer (newest ${NAS_PREVIEW_COUNT})`
                        : `Show all ${sortedNasBackups.length} snapshots`}
                    </Button>
                  )}
                </div>
                );
              })()}
            </>
          )}
          </div>
        </div>
      </div>

      <ConfirmModal
        isOpen={!!nasDeleteTarget}
        title="Delete NAS backup"
        message={`Delete ${nasDeleteTarget?.tarName ?? 'this backup'} from the FritzBox NAS permanently? This removes the snapshot and its metadata sidecar and cannot be undone.`}
        confirmText={nasDeleting ? 'Deleting…' : 'Delete backup'}
        confirmDisabled={nasDeleting}
        isDestructive
        onConfirm={confirmDeleteNasBackup}
        onCancel={() => !nasDeleting && setNasDeleteTarget(null)}
      />

      <ConfirmModal
        isOpen={!!nasRestoreTarget}
        title="Restore from NAS"
        message={`Restore ${nasRestoreTarget?.tarName ?? 'this backup'} from the FritzBox NAS into ${nasRestoreTarget?.service ?? 'the service'}'s data dir? This only seeds a fresh/empty data dir; a service with existing data is left untouched.`}
        confirmText={nasRestoring ? 'Restoring…' : 'Restore'}
        confirmDisabled={nasRestoring !== null}
        onConfirm={confirmRestoreNasBackup}
        onCancel={() => nasRestoring === null && setNasRestoreTarget(null)}
      />
    </>
  );
}


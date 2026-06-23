'use client';

import { useCallback, useEffect, useState } from 'react';
import { useBackupState } from './_lib/useBackupState';
import {
  Save,
  Trash2,
  RefreshCw,
  Download,
  Clock,
  Loader2,
  CheckCircle2,
  XCircle,
  Server,
  HardDrive,
  RotateCcw,
  UploadCloud,
  X,
  Eye,
  ChevronDown,
  ChevronRight,
  Settings,
  Activity,
  FolderOpen,
  Database,
  Usb,
  Network,
  Folder,
  Cloud,
  Plus,
} from 'lucide-react';
import { useToast } from '@/providers/ToastProvider';
import { Button } from '@/components/ui';
import PageHeader from '@/components/PageHeader';
import ConfirmModal from '@/components/ConfirmModal';
import FileViewer from '@/components/FileViewer';
import { useEscapeKey } from '@/hooks/useEscapeKey';
import type { BackupPreviewResult, BackupRestoreSelection } from '@/lib/systemBackup';
import { getNodes } from '@/app/actions/nodes';
import type { PodmanConnection } from '@/lib/nodes';
import {
  formatBytes,
  groupFilesByService,
  groupServiceDataFiles,
  resolveFilePreviewLanguage,
  LOG_STATUS_BADGES,
  LOG_STATUS_DOTS,
  SERVICE_DATA_CATEGORY_ICONS,
  SERVICE_DATA_CATEGORY_LABELS,
  type BackupStreamEvent,
  type SystemBackupEntrySummary,
} from './_lib/helpers';
import ExternalBackupDestinationSection from './_lib/ExternalBackupDestinationSection';
import LocalTargetPicker from './_lib/LocalTargetPicker';

export default function BackupPage() {
  const { addToast } = useToast();
  // Backup is its own app now (#1958), outside the settings <SettingsProvider>,
  // so it loads the node list directly instead of reading the settings context.
  const [nodes, setNodes] = useState<PodmanConnection[]>([]);
  useEffect(() => {
    void getNodes().then(setNodes).catch(() => {});
  }, []);
  const BACKUP_PREVIEW_COUNT = 5;
  // NAS snapshot list can grow long (per-service, every push) and flood the
  // panel — collapse to the newest N with a "show all" expander (#2085).
  const NAS_PREVIEW_COUNT = 5;
  const [showAllNasBackups, setShowAllNasBackups] = useState(false);

  const {
    backups,
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
    nasOverview,
    nasLoading,
    nasRestoring, setNasRestoring,
    nasRestoreTarget, setNasRestoreTarget,
    nasBackingUp, setNasBackingUp,
    nasDeleteTarget, setNasDeleteTarget,
    nasDeleting, setNasDeleting,
    fetchBackups,
    fetchBackupSync,
    fetchNasOverview,
  } = useBackupState();

  useEffect(() => { void fetchNasOverview(); }, [fetchNasOverview]);
  useEffect(() => { void fetchBackups(); }, [fetchBackups]);
  useEffect(() => { void fetchBackupSync(); }, [fetchBackupSync]);

  const confirmRestoreNasBackup = useCallback(async () => {
    if (!nasRestoreTarget || nasRestoring) return;
    const { service, tarName } = nasRestoreTarget;
    setNasRestoring(service);
    try {
      const res = await fetch('/api/system/external-backup/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Restore the SPECIFIC snapshot the operator picked (#1865), not just
        // the latest — recovering from before a silently-corrupted run.
        body: JSON.stringify({ service, tarName }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Restore failed');
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
      const res = await fetch('/api/system/external-backup/backup-now', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Backup failed');
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
      const res = await fetch('/api/system/external-backup/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ service: nasDeleteTarget.service, tarName }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Delete failed');
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
  const buildBackupTarget = () => {
    const s = backupSync;
    switch (s.targetType) {
      case 'local': return { type: 'local' as const, path: s.localPath };
      case 'ssh': return { type: 'ssh' as const, host: s.sshHost, port: parseInt(s.sshPort) || 22, user: s.sshUser, path: s.sshPath, identityFile: s.sshIdentityFile || undefined };
      case 'smb': return { type: 'smb' as const, host: s.smbHost, share: s.smbShare, path: s.smbPath || undefined, username: s.smbUsername || undefined, password: s.smbPassword || undefined };
      case 'nfs': return { type: 'nfs' as const, host: s.nfsHost, export: s.nfsExport, path: s.nfsPath || undefined };
    }
  };

  const handleSaveBackupSync = async () => {
    setBackupSyncSaving(true);
    try {
      const config = {
        enabled: backupSync.enabled,
        schedule: backupSync.schedule,
        time: backupSync.time,
        dayOfWeek: backupSync.schedule === 'weekly' ? backupSync.dayOfWeek : undefined,
        dayOfMonth: backupSync.schedule === 'monthly' ? backupSync.dayOfMonth : undefined,
        target: buildBackupTarget(),
        sources: backupSync.sources
          .map(src => ({
            path: src.path.trim(),
            excludePatterns: src.excludePatterns.split('\n').map(p => p.trim()).filter(Boolean),
          }))
          .filter(src => src.path),
      };
      const res = await fetch('/api/settings/backup-sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'save', config }),
      });
      if (!res.ok) throw new Error((await res.json()).error || 'Save failed');
      addToast('success', 'Backup Sync', 'Configuration saved.');
      await fetchBackupSync();
    } catch (e) {
      addToast('error', 'Save Failed', e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setBackupSyncSaving(false);
    }
  };

  const addBackupSource = () =>
    setBackupSync(prev => ({ ...prev, sources: [...prev.sources, { path: '', excludePatterns: '' }] }));
  const removeBackupSource = (index: number) =>
    setBackupSync(prev => ({ ...prev, sources: prev.sources.filter((_, i) => i !== index) }));
  const updateBackupSource = (index: number, patch: Partial<{ path: string; excludePatterns: string }>) =>
    setBackupSync(prev => ({
      ...prev,
      sources: prev.sources.map((src, i) => (i === index ? { ...src, ...patch } : src)),
    }));

  const handleTestBackupSync = async () => {
    setBackupSyncTesting(true);
    setBackupSyncTestResult(null);
    try {
      const res = await fetch('/api/settings/backup-sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'test', target: buildBackupTarget() }),
      });
      const result = await res.json();
      setBackupSyncTestResult(result);
    } catch (e) {
      setBackupSyncTestResult({ success: false, message: e instanceof Error ? e.message : 'Connection test failed' });
    } finally {
      setBackupSyncTesting(false);
    }
  };

  const handleRunBackupSync = async () => {
    setBackupSyncRunning(true);
    try {
      const res = await fetch('/api/settings/backup-sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'run' }),
      });
      if (!res.ok) throw new Error((await res.json()).error || 'Run failed');
      addToast('info', 'Backup', 'Backup sync started. This may take a while.');
      const poll = setInterval(async () => {
        try {
          const r = await fetch('/api/settings/backup-sync');
          const data = await r.json();
          if (!data.running) {
            clearInterval(poll);
            setBackupSyncRunning(false);
            setBackupSyncHistory(data.history || []);
            if (data.config?.lastStatus === 'success') {
              addToast('success', 'Backup', data.config.lastMessage || 'Backup completed');
            } else if (data.config?.lastStatus === 'error') {
              addToast('error', 'Backup', data.config.lastMessage || 'Backup failed');
            }
            setBackupSync(prev => ({
              ...prev,
              lastRun: data.config?.lastRun,
              lastStatus: data.config?.lastStatus,
              lastMessage: data.config?.lastMessage,
              lastDuration: data.config?.lastDuration,
            }));
          }
        } catch { /* ignore */ }
      }, 5000);
    } catch (e) {
      setBackupSyncRunning(false);
      addToast('error', 'Backup Failed', e instanceof Error ? e.message : 'Unknown error');
    }
  };

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

  // Restore overlay
  const buildDefaultRestoreState = useCallback((preview: BackupPreviewResult) => {
    const nodesState = Object.fromEntries(preview.config.nodes.map(node => [node.name, true]));
    const checksState = Object.fromEntries(preview.config.checks.map(check => [check.id, true]));
    const nodeFilesState: Record<string, Record<string, boolean>> = {};
    const targetNodes: Record<string, string> = {};

    const availableTargets = ['Local', ...nodes.map(node => node.Name)];

    preview.nodeFiles.forEach(group => {
      nodeFilesState[group.nodeName] = Object.fromEntries(group.files.map(file => [file.relativePath, true]));
      targetNodes[group.nodeName] = availableTargets.includes(group.nodeName) ? group.nodeName : 'Local';
    });

    const serviceDataState: Record<string, Record<string, boolean>> = {};
    (preview.serviceData || []).forEach(sd => {
      serviceDataState[sd.name] = Object.fromEntries(sd.files.map(f => [f, true]));
    });

    setRestoreSelectionState({
      nodes: nodesState,
      checks: checksState,
      configFlags: {
        externalLinks: preview.config.externalLinks.length > 0,
        registries: preview.config.registries.length > 0,
        gateway: Boolean(preview.config.gateway),
        notifications: Boolean(preview.config.notifications),
        templateSettings: preview.config.templateSettings.length > 0,
        logLevel: Boolean(preview.config.logLevel),
        update: Boolean(preview.config.update),
      },
      nodeFiles: nodeFilesState,
      targetNodes,
      serviceData: serviceDataState,
    });
  }, [nodes, setRestoreSelectionState]);

  const openRestoreOverlay = (reset = false) => {
    if (reset) {
      setRestorePreview(null);
      setRestoreSource(null);
      setRestoreSelectionState(null);
      setRestoreUploadError(null);
      setRestoreFilePreview(null);
      setRestoreFilePreviewError(null);
    }
    setRestoreOverlayOpen(true);
    setRestoreUploadError(null);
    setRestoreExpandedSections({});
  };

  const closeRestoreOverlay = useCallback(() => {
    if (restoringBackup) return;
    setRestoreOverlayOpen(false);
    setRestorePreview(null);
    setRestoreSource(null);
    setRestoreUploadError(null);
    setRestoreSelectionState(null);
    setRestoreFilePreview(null);
    setRestoreFilePreviewError(null);
  }, [restoringBackup, setRestoreOverlayOpen, setRestorePreview, setRestoreSource, setRestoreUploadError, setRestoreSelectionState, setRestoreFilePreview, setRestoreFilePreviewError]);

  useEscapeKey(closeRestoreOverlay, restoreOverlayOpen, true);
  useEscapeKey(() => setRestoreFilePreview(null), Boolean(restoreFilePreview), true);

  const handleRestorePreviewRequest = async (payload: { file?: File; fileName?: string }) => {
    setRestoreUploadError(null);
    setRestorePreview(null);
    setRestoreSource(null);
    setRestoreSelectionState(null);
    setRestoreFilePreview(null);
    setRestoreFilePreviewError(null);

    try {
      let response: Response;
      if (payload.file) {
        const formData = new FormData();
        formData.append('file', payload.file);
        response = await fetch('/api/settings/backups/preview', { method: 'POST', body: formData });
      } else if (payload.fileName) {
        response = await fetch('/api/settings/backups/preview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fileName: payload.fileName }),
        });
      } else {
        throw new Error('No backup selected');
      }

      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Unable to read backup');

      setRestorePreview(data.preview as BackupPreviewResult);
      setRestoreSource(data.source);
      buildDefaultRestoreState(data.preview as BackupPreviewResult);
      openRestoreOverlay(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load backup preview';
      setRestoreUploadError(message);
      addToast('error', 'Restore preview failed', message);
    }
  };

  const handleRestoreFilePreview = useCallback(async (nodeName: string, relativePath: string) => {
    if (!restoreSource) return;
    setRestoreFilePreview({ nodeName, relativePath, content: '', loading: true });
    setRestoreFilePreviewError(null);
    try {
      const payload = restoreSource.type === 'stored'
        ? { fileName: restoreSource.fileName, nodeName, relativePath }
        : { uploadToken: restoreSource.token, nodeName, relativePath };
      const res = await fetch('/api/settings/backups/file', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Unable to load file');
      setRestoreFilePreview({ nodeName, relativePath, content: data.content ?? '', loading: false });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to load file preview';
      setRestoreFilePreviewError(message);
      setRestoreFilePreview({ nodeName, relativePath, content: '', loading: false });
    }
  }, [restoreSource, setRestoreFilePreview, setRestoreFilePreviewError]);

  const handleRestoreRequest = (entry: SystemBackupEntrySummary) => {
    void handleRestorePreviewRequest({ fileName: entry.fileName });
  };

  const handleRestoreFromFile = (file: File | null) => {
    if (!file) return;
    void handleRestorePreviewRequest({ file });
  };

  const confirmRestoreBackup = useCallback(async () => {
    if (!restorePreview || !restoreSource || !restoreSelectionState || restoringBackup) return;
    setRestoringBackup(true);
    try {
      const selectedNodes = Object.entries(restoreSelectionState.nodes).filter(([, v]) => v).map(([name]) => name);
      const selectedChecks = Object.entries(restoreSelectionState.checks).filter(([, v]) => v).map(([id]) => id);
      const nodeFiles = Object.entries(restoreSelectionState.nodeFiles)
        .map(([sourceNode, filesMap]) => {
          const files = Object.entries(filesMap).filter(([, v]) => v).map(([path]) => path);
          const targetNode = restoreSelectionState.targetNodes[sourceNode];
          return { sourceNode, targetNode, files };
        })
        .filter(group => group.files.length > 0 && group.targetNode);

      const selectedServiceData: { name: string; files?: string[] }[] = [];
      for (const [name, filesMap] of Object.entries(restoreSelectionState.serviceData)) {
        const selectedFiles = Object.entries(filesMap).filter(([, v]) => v).map(([f]) => f);
        if (selectedFiles.length === 0) continue;
        const sdPreview = restorePreview.serviceData?.find(sd => sd.name === name);
        if (sdPreview && selectedFiles.length === sdPreview.files.length) {
          selectedServiceData.push({ name });
        } else {
          selectedServiceData.push({ name, files: selectedFiles });
        }
      }

      const selection: BackupRestoreSelection = {
        config: {
          nodes: selectedNodes,
          checks: selectedChecks,
          externalLinks: restoreSelectionState.configFlags.externalLinks,
          registries: restoreSelectionState.configFlags.registries,
          gateway: restoreSelectionState.configFlags.gateway,
          notifications: restoreSelectionState.configFlags.notifications,
          templateSettings: restoreSelectionState.configFlags.templateSettings,
          logLevel: restoreSelectionState.configFlags.logLevel,
          update: restoreSelectionState.configFlags.update,
        },
        nodeFiles,
        serviceData: selectedServiceData.length > 0 ? selectedServiceData : undefined,
      };

      const payload = restoreSource.type === 'stored'
        ? { fileName: restoreSource.fileName, selection }
        : { uploadToken: restoreSource.token, selection };

      const res = await fetch('/api/settings/backups/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.error || 'Unable to restore backup');
      }

      addToast('success', 'Restore complete', 'Selected settings and files were restored.');
      await fetchBackups();
      closeRestoreOverlay();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Restore failed';
      addToast('error', 'Restore failed', message);
    } finally {
      setRestoringBackup(false);
    }
  }, [addToast, closeRestoreOverlay, fetchBackups, restorePreview, restoreSelectionState, restoreSource, restoringBackup, setRestoringBackup]);

  const selectAllRestoreItems = useCallback(() => {
    if (!restorePreview || !restoreSelectionState) return;
    setRestoreSelectionState({
      nodes: Object.fromEntries(restorePreview.config.nodes.map(node => [node.name, true])),
      checks: Object.fromEntries(restorePreview.config.checks.map(check => [check.id, true])),
      configFlags: {
        externalLinks: restorePreview.config.externalLinks.length > 0,
        registries: restorePreview.config.registries.length > 0,
        gateway: Boolean(restorePreview.config.gateway),
        notifications: Boolean(restorePreview.config.notifications),
        templateSettings: restorePreview.config.templateSettings.length > 0,
        logLevel: Boolean(restorePreview.config.logLevel),
        update: Boolean(restorePreview.config.update),
      },
      nodeFiles: Object.fromEntries(
        restorePreview.nodeFiles.map(group => [
          group.nodeName,
          Object.fromEntries(group.files.map(file => [file.relativePath, true])),
        ]),
      ),
      targetNodes: restoreSelectionState.targetNodes,
      serviceData: Object.fromEntries((restorePreview.serviceData || []).map(sd => [sd.name, Object.fromEntries(sd.files.map(f => [f, true]))])),
    });
  }, [restorePreview, restoreSelectionState, setRestoreSelectionState]);

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

  const availableRestoreTargets = Array.from(new Set(['Local', ...nodes.map(node => node.Name)]));

  const handleRestoreDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (event.dataTransfer.files && event.dataTransfer.files[0]) {
      handleRestoreFromFile(event.dataTransfer.files[0]);
    }
  };
  const handleRestoreDragOver = (event: React.DragEvent<HTMLDivElement>) => { event.preventDefault(); };
  const stopRestoreEvent = useCallback((event: React.MouseEvent) => { event.stopPropagation(); }, []);
  const handleRestoreBackdrop = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    event.stopPropagation();
    closeRestoreOverlay();
  }, [closeRestoreOverlay]);

  const toggleRestoreConfigFlag = (key: keyof BackupRestoreSelection['config']) => {
    setRestoreSelectionState(prev => {
      if (!prev) return prev;
      if (key === 'nodes' || key === 'checks') return prev;
      return {
        ...prev,
        configFlags: { ...prev.configFlags, [key]: !prev.configFlags[key as keyof typeof prev.configFlags] },
      };
    });
  };
  const toggleRestoreNode = (name: string) => {
    setRestoreSelectionState(prev => prev ? { ...prev, nodes: { ...prev.nodes, [name]: !prev.nodes[name] } } : prev);
  };
  const toggleRestoreCheck = (id: string) => {
    setRestoreSelectionState(prev => prev ? { ...prev, checks: { ...prev.checks, [id]: !prev.checks[id] } } : prev);
  };
  const toggleRestoreFile = (nodeName: string, filePath: string) => {
    setRestoreSelectionState(prev => prev ? {
      ...prev,
      nodeFiles: {
        ...prev.nodeFiles,
        [nodeName]: { ...prev.nodeFiles[nodeName], [filePath]: !prev.nodeFiles[nodeName]?.[filePath] },
      },
    } : prev);
  };
  const updateRestoreTargetNode = (sourceNode: string, targetNode: string) => {
    setRestoreSelectionState(prev => prev ? { ...prev, targetNodes: { ...prev.targetNodes, [sourceNode]: targetNode } } : prev);
  };
  const toggleRestoreSection = (section: string) => {
    setRestoreExpandedSections(prev => ({ ...prev, [section]: !prev[section] }));
  };
  const toggleAllNodeFiles = (nodeName: string, selected: boolean) => {
    if (!restorePreview) return;
    const group = restorePreview.nodeFiles.find(g => g.nodeName === nodeName);
    if (!group) return;
    setRestoreSelectionState(prev => prev ? {
      ...prev,
      nodeFiles: { ...prev.nodeFiles, [nodeName]: Object.fromEntries(group.files.map(f => [f.relativePath, selected])) },
    } : prev);
  };
  const toggleServiceGroupFiles = (nodeName: string, files: { relativePath: string }[], selected: boolean) => {
    setRestoreSelectionState(prev => {
      if (!prev) return prev;
      const updated = { ...prev.nodeFiles[nodeName] };
      for (const f of files) updated[f.relativePath] = selected;
      return { ...prev, nodeFiles: { ...prev.nodeFiles, [nodeName]: updated } };
    });
  };

  const getRestoreSelectionSummary = () => {
    if (!restorePreview || !restoreSelectionState) return null;
    const configCount = Object.values(restoreSelectionState.configFlags).filter(Boolean).length;
    const nodeCount = Object.values(restoreSelectionState.nodes).filter(Boolean).length;
    const checkCount = Object.values(restoreSelectionState.checks).filter(Boolean).length;
    const fileCount = Object.values(restoreSelectionState.nodeFiles).reduce(
      (sum, files) => sum + Object.values(files).filter(Boolean).length, 0,
    );
    const dataCount = Object.values(restoreSelectionState.serviceData).reduce(
      (sum, filesMap) => sum + Object.values(filesMap).filter(Boolean).length, 0,
    );
    const parts: string[] = [];
    if (configCount > 0) parts.push(`${configCount} setting${configCount !== 1 ? 's' : ''}`);
    if (nodeCount > 0) parts.push(`${nodeCount} node${nodeCount !== 1 ? 's' : ''}`);
    if (checkCount > 0) parts.push(`${checkCount} check${checkCount !== 1 ? 's' : ''}`);
    if (fileCount > 0) parts.push(`${fileCount} file${fileCount !== 1 ? 's' : ''}`);
    if (dataCount > 0) parts.push(`${dataCount} data file${dataCount !== 1 ? 's' : ''}`);
    return parts.length > 0 ? parts.join(', ') : 'Nothing selected';
  };

  // The nightly NAS-backup schedule (#1890), surfaced on both sections so the
  // operator sees the real time + next run instead of a vague "nightly".
  const schedule = nasOverview?.schedule;
  const scheduleLine = !schedule
    ? null
    : !schedule.enabled
      ? 'Nightly NAS backup is disabled.'
      : `Runs nightly at ${schedule.time} UTC` +
        (schedule.nextRunAt ? ` · next run ${new Date(schedule.nextRunAt).toLocaleString()}` : '');

  return (
    <div className="h-full flex flex-col min-h-0">
      <PageHeader title="Backup & restore" helpId="backups" />
      <div id="backups" className="flex-1 overflow-y-auto p-4 md:p-6 space-y-6 scroll-mt-24">
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
                <button
                  type="button"
                  onClick={() => openRestoreOverlay(true)}
                  className="text-status-ok underline"
                >
                  Selective restore…
                </button>
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
              <table className="min-w-full text-sm">
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
              </table>
              {backups.length > BACKUP_PREVIEW_COUNT && (
                <button
                  type="button"
                  onClick={() => setShowAllBackups(v => !v)}
                  className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-text-muted hover:text-text transition-colors"
                >
                  {showAllBackups ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  {showAllBackups
                    ? `Show fewer (newest ${BACKUP_PREVIEW_COUNT})`
                    : `Show all ${backups.length} backups`}
                </button>
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
                  <table className="min-w-full text-sm">
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
                  </table>
                  {sortedNasBackups.length > NAS_PREVIEW_COUNT && (
                    <button
                      type="button"
                      onClick={() => setShowAllNasBackups(v => !v)}
                      className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-text-muted hover:text-text transition-colors"
                    >
                      {showAllNasBackups ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                      {showAllNasBackups
                        ? `Show fewer (newest ${NAS_PREVIEW_COUNT})`
                        : `Show all ${sortedNasBackups.length} snapshots`}
                    </button>
                  )}
                </div>
                );
              })()}
            </>
          )}
          </div>
        </div>
      </div>

      {/* Backup Sync */}
      <div className="bg-surface rounded-card border border-border shadow-sm overflow-hidden w-full">
        <div className="p-4 border-b border-border bg-surface-2">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-accent/10 rounded-card text-accent">
              <UploadCloud size={20} />
            </div>
            <div className="flex-1">
              <h3 className="font-bold text-text">Backup Sync</h3>
              <p className="text-xs text-text-muted">Your bulk data (the photo library, recorder history, the Z-Wave mesh DB) — rsynced from <span className="font-mono">/mnt/data</span> to an external drive or NAS share. The System Snapshot above covers config; this covers data.</p>
            </div>
            <label className="flex items-center gap-2 cursor-pointer">
              <span className="text-xs text-text-muted">{backupSync.enabled ? 'Enabled' : 'Disabled'}</span>
              <div className="relative">
                <input type="checkbox" className="sr-only peer" checked={backupSync.enabled} onChange={e => setBackupSync(prev => ({ ...prev, enabled: e.target.checked }))} />
                <div className="w-9 h-5 bg-surface-muted peer-focus:outline-none rounded-full peer border border-border peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-surface after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-accent"></div>
              </div>
            </label>
          </div>
          {backupSync.lastRun && (
            <div className="mt-2 text-xs text-text-muted flex items-center gap-2">
              <Clock size={12} /> Last run: {new Date(backupSync.lastRun).toLocaleString()}
              {backupSync.lastStatus === 'success' && <span className="text-status-ok"><CheckCircle2 size={12} className="inline" /></span>}
              {backupSync.lastStatus === 'error' && <span className="text-status-fail"><XCircle size={12} className="inline" /></span>}
              {backupSync.lastDuration != null && <span>({backupSync.lastDuration}s)</span>}
            </div>
          )}
        </div>

        {backupSync.enabled && (
        <div className="p-4 space-y-4">
          {/* Sources — an operator-configurable list of directories, each with
              its own .gitignore-style exclude patterns. Each source rsyncs into
              its own subfolder under the target. */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="block text-xs font-medium text-text-muted">Source Directories</label>
              <button type="button" onClick={addBackupSource} className="inline-flex items-center gap-1 text-xs font-medium text-accent hover:text-accent-strong">
                <Plus size={14} /> Add source
              </button>
            </div>
            <div className="space-y-3">
              {backupSync.sources.length === 0 && (
                <p className="text-[11px] text-text-muted italic">No sources configured. Add at least one directory to sync.</p>
              )}
              {backupSync.sources.map((src, i) => (
                <div key={i} className="rounded-card border border-border bg-surface-muted p-3 space-y-2">
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      className="flex-1 px-3 py-2 text-sm rounded-card border border-border bg-surface-2 text-text"
                      value={src.path}
                      onChange={e => updateBackupSource(i, { path: e.target.value })}
                      placeholder="/mnt/data"
                    />
                    <Button
                      variant="danger"
                      size="sm"
                      onClick={() => removeBackupSource(i)}
                      aria-label="Remove source"
                      className="px-2"
                    >
                      <Trash2 size={14} />
                    </Button>
                  </div>
                  <div>
                    <label className="block text-[11px] font-medium text-text-muted mb-1">Exclude patterns (one per line)</label>
                    <textarea
                      className="w-full px-3 py-2 text-sm rounded-card border border-border bg-surface-2 text-text font-mono"
                      rows={2}
                      value={src.excludePatterns}
                      onChange={e => updateBackupSource(i, { excludePatterns: e.target.value })}
                      placeholder="*.tmp&#10;cache/"
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Target picker — radio cards. The previous version used a row of
              terse text-only buttons that read more like filter chips than a
              "choose one of these and the form below changes" prompt. Cards
              with icons + a one-line "what this is" description make the
              relationship obvious and bring this control in line with how
              the rest of ServiceBay presents primary choices. */}
          <div>
            <label className="block text-xs font-medium text-text-muted mb-2">Where should backups go?</label>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
              {([
                { val: 'local', label: 'Local / USB',  hint: 'Mounted disk on this server',  Icon: Usb },
                { val: 'ssh',   label: 'SSH',          hint: 'Push to a remote host (rsync over ssh)', Icon: Network },
                { val: 'smb',   label: 'SMB / CIFS',   hint: 'Windows or NAS network share',  Icon: Folder },
                { val: 'nfs',   label: 'NFS',          hint: 'Unix/NAS network export',       Icon: Cloud },
              ] as const).map(({ val, label, hint, Icon }) => {
                const active = backupSync.targetType === val;
                return (
                  <button
                    key={val}
                    type="button"
                    onClick={() => setBackupSync(prev => ({ ...prev, targetType: val }))}
                    aria-pressed={active}
                    className={`flex items-start gap-2 px-3 py-2 text-left rounded-card border-2 transition-colors ${active ? 'bg-accent/10 border-accent' : 'border-border hover:bg-surface-2 hover:border-border-strong'}`}
                  >
                    <Icon size={16} className={`mt-0.5 flex-shrink-0 ${active ? 'text-accent' : 'text-text-subtle'}`} />
                    <div className="min-w-0">
                      <div className={`text-xs font-semibold ${active ? 'text-accent' : 'text-text'}`}>{label}</div>
                      <div className={`text-[11px] leading-tight ${active ? 'text-accent/70' : 'text-text-muted'}`}>{hint}</div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Connection-details panel — the same fields as before, but wrapped
              in a labelled container so it's visually clear these inputs
              belong to the chosen target type. */}
          <div className="rounded-card border border-border bg-surface-muted p-3 space-y-3">
            <div className="text-[11px] uppercase tracking-wider font-semibold text-text-muted flex items-center gap-1.5">
              <ChevronRight size={12} />
              {backupSync.targetType === 'local' ? 'Local target details' :
               backupSync.targetType === 'ssh'   ? 'SSH connection details' :
               backupSync.targetType === 'smb'   ? 'SMB share details'      :
                                                   'NFS export details'}
            </div>

          {backupSync.targetType === 'local' && (
            <LocalTargetPicker
              value={backupSync.localPath}
              onChange={path => setBackupSync(prev => ({ ...prev, localPath: path }))}
            />
          )}

          {backupSync.targetType === 'ssh' && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-text-muted mb-1">Host</label>
                <input type="text" className="w-full px-3 py-2 text-sm rounded-card border border-border bg-surface-2 text-text" value={backupSync.sshHost} onChange={e => setBackupSync(prev => ({ ...prev, sshHost: e.target.value }))} placeholder="192.168.1.100" />
              </div>
              <div>
                <label className="block text-xs font-medium text-text-muted mb-1">Port</label>
                <input type="text" className="w-full px-3 py-2 text-sm rounded-card border border-border bg-surface-2 text-text" value={backupSync.sshPort} onChange={e => setBackupSync(prev => ({ ...prev, sshPort: e.target.value }))} placeholder="22" />
              </div>
              <div>
                <label className="block text-xs font-medium text-text-muted mb-1">User</label>
                <input type="text" className="w-full px-3 py-2 text-sm rounded-card border border-border bg-surface-2 text-text" value={backupSync.sshUser} onChange={e => setBackupSync(prev => ({ ...prev, sshUser: e.target.value }))} />
              </div>
              <div>
                <label className="block text-xs font-medium text-text-muted mb-1">Remote Path</label>
                <input type="text" className="w-full px-3 py-2 text-sm rounded-card border border-border bg-surface-2 text-text" value={backupSync.sshPath} onChange={e => setBackupSync(prev => ({ ...prev, sshPath: e.target.value }))} placeholder="/backup" />
              </div>
              <div className="col-span-2">
                <label className="block text-xs font-medium text-text-muted mb-1">Identity File</label>
                <input type="text" className="w-full px-3 py-2 text-sm rounded-card border border-border bg-surface-2 text-text" value={backupSync.sshIdentityFile} onChange={e => setBackupSync(prev => ({ ...prev, sshIdentityFile: e.target.value }))} />
              </div>
            </div>
          )}

          {backupSync.targetType === 'smb' && (
            <div className="grid grid-cols-2 gap-3">
              <div><label className="block text-xs font-medium text-text-muted mb-1">Host</label><input type="text" className="w-full px-3 py-2 text-sm rounded-card border border-border bg-surface-2 text-text" value={backupSync.smbHost} onChange={e => setBackupSync(prev => ({ ...prev, smbHost: e.target.value }))} placeholder="nas.local" /></div>
              <div><label className="block text-xs font-medium text-text-muted mb-1">Share Name</label><input type="text" className="w-full px-3 py-2 text-sm rounded-card border border-border bg-surface-2 text-text" value={backupSync.smbShare} onChange={e => setBackupSync(prev => ({ ...prev, smbShare: e.target.value }))} placeholder="backup" /></div>
              <div><label className="block text-xs font-medium text-text-muted mb-1">Subfolder (optional)</label><input type="text" className="w-full px-3 py-2 text-sm rounded-card border border-border bg-surface-2 text-text" value={backupSync.smbPath} onChange={e => setBackupSync(prev => ({ ...prev, smbPath: e.target.value }))} /></div>
              <div><label className="block text-xs font-medium text-text-muted mb-1">Username</label><input type="text" className="w-full px-3 py-2 text-sm rounded-card border border-border bg-surface-2 text-text" value={backupSync.smbUsername} onChange={e => setBackupSync(prev => ({ ...prev, smbUsername: e.target.value }))} /></div>
              <div className="col-span-2"><label className="block text-xs font-medium text-text-muted mb-1">Password</label><input type="password" className="w-full px-3 py-2 text-sm rounded-card border border-border bg-surface-2 text-text" value={backupSync.smbPassword} onChange={e => setBackupSync(prev => ({ ...prev, smbPassword: e.target.value }))} /></div>
            </div>
          )}

          {backupSync.targetType === 'nfs' && (
            <div className="grid grid-cols-2 gap-3">
              <div><label className="block text-xs font-medium text-text-muted mb-1">Host</label><input type="text" className="w-full px-3 py-2 text-sm rounded-card border border-border bg-surface-2 text-text" value={backupSync.nfsHost} onChange={e => setBackupSync(prev => ({ ...prev, nfsHost: e.target.value }))} placeholder="nas.local" /></div>
              <div><label className="block text-xs font-medium text-text-muted mb-1">Export Path</label><input type="text" className="w-full px-3 py-2 text-sm rounded-card border border-border bg-surface-2 text-text" value={backupSync.nfsExport} onChange={e => setBackupSync(prev => ({ ...prev, nfsExport: e.target.value }))} placeholder="/volume1/backup" /></div>
              <div className="col-span-2"><label className="block text-xs font-medium text-text-muted mb-1">Subfolder (optional)</label><input type="text" className="w-full px-3 py-2 text-sm rounded-card border border-border bg-surface-2 text-text" value={backupSync.nfsPath} onChange={e => setBackupSync(prev => ({ ...prev, nfsPath: e.target.value }))} /></div>
            </div>
          )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-text-muted mb-1">Schedule</label>
              <select className="w-full px-3 py-2 text-sm rounded-card border border-border bg-surface-2 text-text" value={backupSync.schedule} onChange={e => setBackupSync(prev => ({ ...prev, schedule: e.target.value as 'hourly' | 'daily' | 'weekly' | 'monthly' }))}>
                <option value="hourly">Hourly</option>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-text-muted mb-1">Time (UTC)</label>
              <input type="time" className="w-full px-3 py-2 text-sm rounded-card border border-border bg-surface-2 text-text" value={backupSync.time} onChange={e => setBackupSync(prev => ({ ...prev, time: e.target.value }))} />
            </div>
            {backupSync.schedule === 'weekly' && (
              <div>
                <label className="block text-xs font-medium text-text-muted mb-1">Day of Week</label>
                <select className="w-full px-3 py-2 text-sm rounded-card border border-border bg-surface-2 text-text" value={backupSync.dayOfWeek ?? 0} onChange={e => setBackupSync(prev => ({ ...prev, dayOfWeek: parseInt(e.target.value) }))}>
                  {['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((d, i) => (
                    <option key={i} value={i}>{d}</option>
                  ))}
                </select>
              </div>
            )}
            {backupSync.schedule === 'monthly' && (
              <div>
                <label className="block text-xs font-medium text-text-muted mb-1">Day of Month</label>
                <input type="number" min={1} max={28} className="w-full px-3 py-2 text-sm rounded-card border border-border bg-surface-2 text-text" value={backupSync.dayOfMonth ?? 1} onChange={e => setBackupSync(prev => ({ ...prev, dayOfMonth: parseInt(e.target.value) || 1 }))} />
              </div>
            )}
          </div>

          {backupSyncTestResult && (
            <div className={`p-3 text-sm rounded-card ${backupSyncTestResult.success ? 'bg-status-ok/10 text-status-ok' : 'bg-status-fail/10 text-status-fail'}`}>
              {backupSyncTestResult.success ? <CheckCircle2 size={14} className="inline mr-1" /> : <XCircle size={14} className="inline mr-1" />}
              {backupSyncTestResult.message}
            </div>
          )}

          <div className="flex flex-wrap gap-2 pt-2 border-t border-border">
            <Button onClick={handleSaveBackupSync} disabled={backupSyncSaving}>
              {backupSyncSaving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Save
            </Button>
            <Button variant="secondary" onClick={handleTestBackupSync} disabled={backupSyncTesting}>
              {backupSyncTesting ? <Loader2 size={14} className="animate-spin" /> : <Activity size={14} />} Test Connection
            </Button>
            <Button onClick={handleRunBackupSync} disabled={backupSyncRunning} className="bg-status-ok text-on-accent hover:bg-status-ok/90">
              {backupSyncRunning ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
              {backupSyncRunning ? 'Running...' : 'Run Now'}
            </Button>
          </div>

          {backupSyncHistory.length > 0 && (
            <div className="pt-3 border-t border-border">
              <h4 className="text-xs font-medium text-text-muted mb-2">Recent Runs</h4>
              <div className="space-y-1 max-h-40 overflow-y-auto">
                {backupSyncHistory.slice(0, 10).map((h, i) => (
                  <div key={i} className="flex items-center gap-2 text-xs text-text-muted">
                    {h.success ? <CheckCircle2 size={12} className="text-status-ok flex-shrink-0" /> : <XCircle size={12} className="text-status-fail flex-shrink-0" />}
                    <span className="font-mono">{new Date(h.startedAt).toLocaleString()}</span>
                    <span>({h.duration}s)</span>
                    {h.filesTransferred != null && <span>{h.filesTransferred} files</span>}
                    <span className="truncate flex-1">{h.message}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
        )}
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

      <ConfirmModal
        isOpen={confirmRestoreLatestOpen}
        title="Restore latest snapshot"
        message={`This will overwrite current ServiceBay state with the contents of ${backups[0]?.fileName ?? ''}. Continue?`}
        confirmText={restoringLatest ? 'Restoring…' : 'Restore'}
        confirmDisabled={restoringLatest}
        onConfirm={handleRestoreLatest}
        onCancel={() => !restoringLatest && setConfirmRestoreLatestOpen(false)}
      />

      {restoreOverlayOpen && (
        <div className="fixed inset-0 z-[90] flex items-stretch justify-end" onMouseDown={stopRestoreEvent} onClick={stopRestoreEvent}>
          <div className="absolute inset-0 bg-gray-950/70 backdrop-blur-sm" onClick={handleRestoreBackdrop} />
          <aside className="relative z-10 w-full max-w-3xl h-full bg-surface border-l border-border shadow-2xl flex flex-col">
            <div className="flex items-center justify-between px-6 py-4 border-b border-border">
              <div>
                <h3 className="text-lg font-semibold text-text">Restore from Backup</h3>
                <p className="text-xs text-text-muted">Select what to restore before applying changes.</p>
              </div>
              <button type="button" onClick={closeRestoreOverlay} className="rounded-full p-2 text-text-muted hover:text-text hover:bg-surface-2" aria-label="Close restore panel">
                <X size={18} />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
              {!restorePreview ? (
                <div className="border-2 border-dashed border-border rounded-card p-8 text-center bg-surface-muted" onDrop={handleRestoreDrop} onDragOver={handleRestoreDragOver}>
                  <UploadCloud className="mx-auto text-text-subtle" size={28} />
                  <p className="mt-3 text-sm font-medium text-text">Drop a backup archive here</p>
                  <p className="text-xs text-text-muted">Supports .tar.gz exports from ServiceBay.</p>
                  <div className="mt-4">
                    <label htmlFor="restore-backup-file" className="inline-flex items-center gap-2 px-4 py-2 bg-surface-2 border border-border rounded-card text-sm text-text hover:bg-surface-muted cursor-pointer">
                      <UploadCloud size={16} /> Select file
                    </label>
                    <input id="restore-backup-file" type="file" accept=".tar.gz" className="hidden" onChange={(event) => handleRestoreFromFile(event.target.files?.[0] || null)} />
                  </div>
                  {restoreUploadError && (<p className="mt-3 text-xs text-status-fail">{restoreUploadError}</p>)}
                </div>
              ) : restoreSelectionState ? (
                <div className="space-y-3">
                  {/* Source & Summary */}
                  <div className="rounded-card border border-border p-4 bg-surface-muted flex flex-wrap items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-xs text-text-muted">Backup Source</p>
                      <p className="text-sm font-mono text-text truncate">
                        {restoreSource?.type === 'stored' ? restoreSource.fileName : 'Uploaded archive'}
                      </p>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="text-xs text-text-muted">{getRestoreSelectionSummary()}</span>
                      <Button size="sm" variant="secondary" onClick={() => { selectAllRestoreItems(); void confirmRestoreBackup(); }} disabled={restoringBackup} className="border-status-ok/40 text-status-ok hover:bg-status-ok/10">
                        <RotateCcw size={14} /> Restore all
                      </Button>
                    </div>
                  </div>

                  {/* Settings */}
                  <div className="rounded-card border border-border overflow-hidden">
                    <button type="button" onClick={() => toggleRestoreSection('settings')} className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-surface-2 transition-colors">
                      {restoreExpandedSections.settings ? <ChevronDown size={16} className="text-text-subtle shrink-0" /> : <ChevronRight size={16} className="text-text-subtle shrink-0" />}
                      <Settings size={16} className="text-text-subtle shrink-0" />
                      <div className="flex-1 min-w-0">
                        <span className="text-sm font-medium text-text">Settings</span>
                        <span className="ml-2 text-xs text-text-muted">
                          {Object.values(restoreSelectionState.configFlags).filter(Boolean).length} of {Object.keys(restoreSelectionState.configFlags).length} selected
                        </span>
                      </div>
                    </button>
                    {restoreExpandedSections.settings && (
                      <div className="px-4 pb-4 pt-1 border-t border-border grid gap-2.5">
                        {([
                          { key: 'externalLinks' as const, label: 'External links', summary: restorePreview.config.externalLinks.length === 0 ? 'None' : `${restorePreview.config.externalLinks.length} link${restorePreview.config.externalLinks.length !== 1 ? 's' : ''}` },
                          { key: 'registries' as const, label: 'Registries', summary: restorePreview.config.registries.length === 0 ? 'None' : restorePreview.config.registries.map(r => r.name).join(', ') },
                          { key: 'gateway' as const, label: 'Gateway', summary: restorePreview.config.gateway?.host || 'Not configured' },
                          { key: 'notifications' as const, label: 'Notifications', summary: restorePreview.config.notifications ? `${restorePreview.config.notifications.host || 'SMTP'} → ${(restorePreview.config.notifications.to || []).join(', ') || 'no recipients'}` : 'Not configured' },
                          { key: 'templateSettings' as const, label: 'Template settings', summary: restorePreview.config.templateSettings.length === 0 ? 'None' : `${restorePreview.config.templateSettings.length} key${restorePreview.config.templateSettings.length !== 1 ? 's' : ''}` },
                          { key: 'logLevel' as const, label: 'Log level', summary: restorePreview.config.logLevel || 'default' },
                          { key: 'update' as const, label: 'Auto-update', summary: restorePreview.config.update ? (restorePreview.config.update.enabled === false ? 'Disabled' : 'Enabled') : 'Not configured' },
                        ]).map(item => (
                          <label key={item.key} className="flex items-center gap-3 text-sm text-text py-1">
                            <input type="checkbox" className="rounded" checked={restoreSelectionState.configFlags[item.key]} onChange={() => toggleRestoreConfigFlag(item.key)} />
                            <span className="font-medium min-w-[120px]">{item.label}</span>
                            <span className="text-xs text-text-muted truncate">{item.summary}</span>
                          </label>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Nodes & Checks */}
                  <div className="rounded-card border border-border overflow-hidden">
                    <button type="button" onClick={() => toggleRestoreSection('infrastructure')} className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-surface-2 transition-colors">
                      {restoreExpandedSections.infrastructure ? <ChevronDown size={16} className="text-text-subtle shrink-0" /> : <ChevronRight size={16} className="text-text-subtle shrink-0" />}
                      <Activity size={16} className="text-text-subtle shrink-0" />
                      <div className="flex-1 min-w-0">
                        <span className="text-sm font-medium text-text">Nodes & Health</span>
                        <span className="ml-2 text-xs text-text-muted">
                          {Object.values(restoreSelectionState.nodes).filter(Boolean).length} node{Object.values(restoreSelectionState.nodes).filter(Boolean).length !== 1 ? 's' : ''},
                          {' '}{Object.values(restoreSelectionState.checks).filter(Boolean).length} check{Object.values(restoreSelectionState.checks).filter(Boolean).length !== 1 ? 's' : ''}
                        </span>
                      </div>
                    </button>
                    {restoreExpandedSections.infrastructure && (
                      <div className="px-4 pb-4 pt-1 border-t border-border space-y-4">
                        {restorePreview.config.nodes.length > 0 && (
                          <div>
                            <p className="text-xs font-medium text-text-muted uppercase tracking-wide mb-2">Nodes</p>
                            <div className="grid gap-2">
                              {restorePreview.config.nodes.map(node => (
                                <label key={node.name} className="flex items-center gap-3 text-sm text-text">
                                  <input type="checkbox" className="rounded" checked={restoreSelectionState.nodes[node.name]} onChange={() => toggleRestoreNode(node.name)} />
                                  <Server size={14} className="text-text-subtle shrink-0" />
                                  <span className="font-medium">{node.name}</span>
                                  <span className="text-xs text-text-muted">{node.uri}{node.default ? ' · Default' : ''}</span>
                                </label>
                              ))}
                            </div>
                          </div>
                        )}
                        {restorePreview.config.checks.length > 0 && (
                          <div>
                            <p className="text-xs font-medium text-text-muted uppercase tracking-wide mb-2">Health Checks</p>
                            <div className="grid gap-2">
                              {restorePreview.config.checks.map(check => (
                                <label key={check.id} className="flex items-center gap-3 text-sm text-text">
                                  <input type="checkbox" className="rounded" checked={restoreSelectionState.checks[check.id]} onChange={() => toggleRestoreCheck(check.id)} />
                                  <span className="font-medium">{check.name}</span>
                                  {check.type && <span className="text-[10px] uppercase px-1.5 py-0.5 rounded bg-surface-2 text-text-muted">{check.type}</span>}
                                  {check.target && <span className="text-xs text-text-muted">{check.target}</span>}
                                </label>
                              ))}
                            </div>
                          </div>
                        )}
                        {restorePreview.config.nodes.length === 0 && restorePreview.config.checks.length === 0 && (
                          <p className="text-xs text-text-muted italic">No nodes or checks in this backup.</p>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Systemd Files */}
                  {restorePreview.nodeFiles.length > 0 && (
                    <div className="rounded-card border border-border overflow-hidden">
                      <button type="button" onClick={() => toggleRestoreSection('files')} className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-surface-2 transition-colors">
                        {restoreExpandedSections.files ? <ChevronDown size={16} className="text-text-subtle shrink-0" /> : <ChevronRight size={16} className="text-text-subtle shrink-0" />}
                        <FolderOpen size={16} className="text-text-subtle shrink-0" />
                        <div className="flex-1 min-w-0">
                          <span className="text-sm font-medium text-text">Systemd Files</span>
                          <span className="ml-2 text-xs text-text-muted">
                            {Object.values(restoreSelectionState.nodeFiles).reduce((sum, files) => sum + Object.values(files).filter(Boolean).length, 0)} of {restorePreview.nodeFiles.reduce((sum, g) => sum + g.files.length, 0)} files selected
                          </span>
                        </div>
                      </button>
                      {restoreExpandedSections.files && (
                        <div className="border-t border-border">
                          {restorePreview.nodeFiles.map(group => {
                            const selectedCount = Object.values(restoreSelectionState.nodeFiles[group.nodeName] || {}).filter(Boolean).length;
                            const allSelected = selectedCount === group.files.length;
                            const serviceGroups = groupFilesByService(group.files);
                            return (
                              <div key={group.nodeName} className="border-b border-border last:border-b-0">
                                <div className="flex items-center justify-between gap-2 px-4 py-2.5 bg-surface-muted">
                                  <div className="flex items-center gap-3">
                                    <input type="checkbox" className="rounded" checked={allSelected} onChange={() => toggleAllNodeFiles(group.nodeName, !allSelected)} />
                                    <span className="text-sm font-medium text-text">{group.nodeName}</span>
                                    <span className="text-xs text-text-muted">{selectedCount}/{group.files.length} files</span>
                                  </div>
                                  <div className="flex items-center gap-2 text-xs text-text-muted">
                                    <span>Target:</span>
                                    <select value={restoreSelectionState.targetNodes[group.nodeName]} onChange={(event) => updateRestoreTargetNode(group.nodeName, event.target.value)} className="bg-surface-2 border border-border text-text rounded px-2 py-1 text-xs">
                                      {availableRestoreTargets.map(target => (<option key={target} value={target}>{target}</option>))}
                                    </select>
                                  </div>
                                </div>
                                <div className="max-h-80 overflow-y-auto">
                                  {serviceGroups.map(sg => {
                                    const sgSelectedCount = sg.files.filter(f => restoreSelectionState.nodeFiles[group.nodeName]?.[f.relativePath]).length;
                                    const sgAllSelected = sgSelectedCount === sg.files.length;
                                    const sgKey = `files-${group.nodeName}-${sg.service}`;
                                    const sgExpanded = restoreExpandedSections[sgKey];
                                    const displayName = sg.service === '_other' ? 'Other files' : sg.service;
                                    return (
                                      <div key={sg.service} className="border-b border-border last:border-b-0">
                                        <div className="flex items-center gap-2 px-4 py-2 hover:bg-surface-2">
                                          <input type="checkbox" className="rounded" checked={sgAllSelected} onChange={() => toggleServiceGroupFiles(group.nodeName, sg.files, !sgAllSelected)} />
                                          <button type="button" onClick={() => toggleRestoreSection(sgKey)} className="flex items-center gap-1.5 flex-1 min-w-0 text-left">
                                            {sgExpanded ? <ChevronDown size={12} className="text-text-subtle shrink-0" /> : <ChevronRight size={12} className="text-text-subtle shrink-0" />}
                                            <span className="text-xs font-medium text-text capitalize">{displayName}</span>
                                            <span className="text-[10px] text-text-subtle">{sgSelectedCount}/{sg.files.length}</span>
                                          </button>
                                        </div>
                                        {sgExpanded && (
                                          <div className="pl-10 pr-4 pb-1">
                                            {sg.files.map(file => (
                                              <div key={file.relativePath} className="flex items-center gap-3 py-1 text-xs text-text-muted">
                                                <input type="checkbox" className="rounded" checked={Boolean(restoreSelectionState.nodeFiles[group.nodeName]?.[file.relativePath])} onChange={() => toggleRestoreFile(group.nodeName, file.relativePath)} />
                                                <span className="flex-1 font-mono truncate">{file.fileName}</span>
                                                <button type="button" onClick={() => handleRestoreFilePreview(group.nodeName, file.relativePath)} className="shrink-0 p-1 rounded text-text-subtle hover:text-text hover:bg-surface-2" title="Preview file">
                                                  <Eye size={14} />
                                                </button>
                                              </div>
                                            ))}
                                          </div>
                                        )}
                                      </div>
                                    );
                                  })}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Service Data */}
                  {restorePreview.serviceData && restorePreview.serviceData.length > 0 && (
                    <div className="rounded-card border border-border overflow-hidden">
                      <button type="button" onClick={() => toggleRestoreSection('serviceData')} className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-surface-2 transition-colors">
                        {restoreExpandedSections.serviceData ? <ChevronDown size={16} className="text-text-subtle shrink-0" /> : <ChevronRight size={16} className="text-text-subtle shrink-0" />}
                        <Database size={16} className="text-text-subtle shrink-0" />
                        <div className="flex-1 min-w-0">
                          <span className="text-sm font-medium text-text">Service Config</span>
                          <span className="ml-2 text-xs text-text-muted">
                            {Object.values(restoreSelectionState.serviceData).reduce((sum, fm) => sum + Object.values(fm).filter(Boolean).length, 0)} file{Object.values(restoreSelectionState.serviceData).reduce((sum, fm) => sum + Object.values(fm).filter(Boolean).length, 0) !== 1 ? 's' : ''} selected
                          </span>
                        </div>
                      </button>
                      {restoreExpandedSections.serviceData && (
                        <div className="px-4 pb-4 pt-1 border-t border-border space-y-3">
                          <p className="text-xs text-status-warn bg-status-warn/10 border border-status-warn/30 rounded-card px-3 py-2">
                            This is each service&apos;s <span className="font-semibold">config</span> — Home Assistant&apos;s automations and <span className="font-mono">.storage</span> registries, the Z-Wave network keys, AdGuard / Authelia / Syncthing / nginx settings, and so on. It is <span className="font-semibold">not</span> bulk data (the Immich photo library, the recorder history DB, the Z-Wave mesh DB) — that stays on disk on a wipe-configs reinstall and is Backup Sync&apos;s job. A wipe-configs reinstall does <span className="font-semibold">not</span> pull this config back automatically; select it here to recover it, or services come up with default settings.
                          </p>
                          {restorePreview.serviceData.map(sd => {
                            const label = sd.name.replace(/-/g, '/').replace(/^\//, '');
                            const fileCategories = groupServiceDataFiles(sd.files);
                            const sdKey = `sd-${sd.name}`;
                            const sdExpanded = restoreExpandedSections[sdKey];
                            const selectedCount = restoreSelectionState.serviceData[sd.name]
                              ? Object.values(restoreSelectionState.serviceData[sd.name]).filter(Boolean).length
                              : 0;
                            const allSelected = selectedCount === sd.files.length;

                            return (
                              <div key={sd.name} className="rounded border border-border">
                                <div className="flex items-center gap-2 px-3 py-2">
                                  <input type="checkbox" className="rounded" checked={allSelected} onChange={() => setRestoreSelectionState(prev => {
                                    if (!prev) return prev;
                                    const newVal = !allSelected;
                                    return { ...prev, serviceData: { ...prev.serviceData, [sd.name]: Object.fromEntries(sd.files.map(f => [f, newVal])) } };
                                  })} />
                                  <button type="button" onClick={() => toggleRestoreSection(sdKey)} className="flex items-center gap-2 flex-1 min-w-0">
                                    {sdExpanded ? <ChevronDown size={14} className="text-text-subtle shrink-0" /> : <ChevronRight size={14} className="text-text-subtle shrink-0" />}
                                    <HardDrive size={14} className="text-text-subtle shrink-0" />
                                    <div className="flex flex-col items-start min-w-0">
                                      <div className="flex items-center gap-2">
                                        <span className="text-sm font-medium text-text">{label}</span>
                                        <span className="text-xs text-text-muted">{selectedCount}/{sd.files.length}</span>
                                      </div>
                                      {(sd.sourcePath || sd.nodeName) && (
                                        <span className="text-[11px] text-text-subtle font-mono truncate max-w-full">
                                          → {sd.nodeName ? `${sd.nodeName}:` : ''}{sd.sourcePath}
                                        </span>
                                      )}
                                    </div>
                                  </button>
                                  <div className="flex items-center gap-1 shrink-0">
                                    {fileCategories.map(cat => (
                                      <button key={cat.category} type="button" title={`Select only ${SERVICE_DATA_CATEGORY_LABELS[cat.category].toLowerCase()} (${cat.files.length} files)`} onClick={() => setRestoreSelectionState(prev => {
                                        if (!prev) return prev;
                                        const newFiles: Record<string, boolean> = {};
                                        for (const f of sd.files) newFiles[f] = false;
                                        for (const f of cat.files) newFiles[f] = true;
                                        return { ...prev, serviceData: { ...prev.serviceData, [sd.name]: newFiles } };
                                      })} className="px-1.5 py-0.5 text-xs rounded border border-border hover:bg-surface-2 transition-colors">
                                        {SERVICE_DATA_CATEGORY_ICONS[cat.category]}
                                      </button>
                                    ))}
                                  </div>
                                </div>

                                {sdExpanded && (
                                  <div className="px-3 pb-3 pt-1 border-t border-border space-y-2">
                                    {fileCategories.map(cat => {
                                      const catKey = `sd-${sd.name}-${cat.category}`;
                                      const catExpanded = restoreExpandedSections[catKey];
                                      const catSelectedCount = cat.files.filter(f => restoreSelectionState.serviceData[sd.name]?.[f]).length;
                                      const catAllSelected = catSelectedCount === cat.files.length;
                                      return (
                                        <div key={cat.category}>
                                          <div className="flex items-center gap-2">
                                            <input type="checkbox" className="rounded" checked={catAllSelected} onChange={() => setRestoreSelectionState(prev => {
                                              if (!prev) return prev;
                                              const updated = { ...prev.serviceData[sd.name] };
                                              const newVal = !catAllSelected;
                                              for (const f of cat.files) updated[f] = newVal;
                                              return { ...prev, serviceData: { ...prev.serviceData, [sd.name]: updated } };
                                            })} />
                                            <button type="button" onClick={() => toggleRestoreSection(catKey)} className="flex items-center gap-1.5 flex-1 min-w-0">
                                              {catExpanded ? <ChevronDown size={12} className="text-text-subtle shrink-0" /> : <ChevronRight size={12} className="text-text-subtle shrink-0" />}
                                              <span className="text-xs">{SERVICE_DATA_CATEGORY_ICONS[cat.category]}</span>
                                              <span className="text-xs font-medium text-text-muted">{SERVICE_DATA_CATEGORY_LABELS[cat.category]}</span>
                                              <span className="text-xs text-text-muted">{catSelectedCount}/{cat.files.length}</span>
                                            </button>
                                          </div>
                                          {catExpanded && (
                                            <div className="ml-6 mt-1 space-y-0.5">
                                              {cat.files.map(file => (
                                                <label key={file} className="flex items-center gap-2 text-xs text-text-muted py-0.5">
                                                  <input type="checkbox" className="rounded" checked={Boolean(restoreSelectionState.serviceData[sd.name]?.[file])} onChange={() => setRestoreSelectionState(prev => {
                                                    if (!prev) return prev;
                                                    const updated = { ...prev.serviceData[sd.name] };
                                                    updated[file] = !updated[file];
                                                    return { ...prev, serviceData: { ...prev.serviceData, [sd.name]: updated } };
                                                  })} />
                                                  <span className="font-mono truncate">{file}</span>
                                                </label>
                                              ))}
                                            </div>
                                          )}
                                        </div>
                                      );
                                    })}
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ) : null}
            </div>

            {restorePreview && restoreSelectionState && (
              <div className="px-6 py-4 border-t border-border flex items-center justify-between">
                <p className="text-xs text-text-muted">{getRestoreSelectionSummary()}</p>
                <Button onClick={confirmRestoreBackup} disabled={restoringBackup} className="bg-status-ok text-on-accent hover:bg-status-ok/90">
                  {restoringBackup ? <Loader2 className="animate-spin" size={16} /> : <RotateCcw size={16} />}
                  {restoringBackup ? 'Restoring...' : 'Restore Selected'}
                </Button>
              </div>
            )}
          </aside>
        </div>
      )}

      {restoreFilePreview && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center" onMouseDown={stopRestoreEvent} onClick={stopRestoreEvent}>
          <div className="absolute inset-0 bg-gray-950/70 backdrop-blur-sm" onClick={() => setRestoreFilePreview(null)} />
          <div className="relative z-10 w-full max-w-5xl max-h-[85vh] bg-surface border border-border rounded-card shadow-2xl overflow-hidden flex flex-col">
            <div className="flex items-center justify-between px-5 py-3 border-b border-border">
              <div>
                <p className="text-sm font-semibold text-text">Backup File Preview</p>
                <p className="text-xs text-text-muted">
                  {restoreFilePreview.nodeName} · <span className="font-mono">{restoreFilePreview.relativePath}</span>
                </p>
              </div>
              <button type="button" onClick={() => setRestoreFilePreview(null)} className="rounded-full p-2 text-text-muted hover:text-text hover:bg-surface-2" aria-label="Close file preview">
                <X size={18} />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto bg-surface-muted p-4">
              {restoreFilePreview.loading ? (
                <div className="flex items-center gap-2 text-sm text-text-muted">
                  <Loader2 size={16} className="animate-spin" /> Loading file...
                </div>
              ) : restoreFilePreviewError ? (
                <p className="text-sm text-status-fail">{restoreFilePreviewError}</p>
              ) : (
                <FileViewer content={restoreFilePreview.content} language={resolveFilePreviewLanguage(restoreFilePreview.relativePath)} />
              )}
            </div>
          </div>
        </div>
      )}
      </div>
    </div>
  );
}

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
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
  Shield,
  Upload,
  Usb,
  Network,
  Folder,
  Cloud,
} from 'lucide-react';
import { useToast } from '@/providers/ToastProvider';
import ConfirmModal from '@/components/ConfirmModal';
import FileViewer from '@/components/FileViewer';
import { useEscapeKey } from '@/hooks/useEscapeKey';
import type { BackupLogEntry, BackupPreviewResult, BackupRestoreSelection } from '@/lib/systemBackup';
import { useSettings } from '../_lib/SettingsContext';
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
} from '../_lib/helpers';

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
  sourcePath: string;
  excludePatterns: string;
  lastRun?: string;
  lastStatus?: 'success' | 'error';
  lastMessage?: string;
  lastDuration?: number;
};

export default function BackupsSettingsPage() {
  const { addToast } = useToast();
  const { nodes } = useSettings();

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

  const [backupSync, setBackupSync] = useState<BackupSyncState>({
    enabled: false,
    schedule: 'daily',
    time: '02:00',
    targetType: 'local',
    localPath: '/mnt/backup',
    sshHost: '', sshPort: '22', sshUser: 'root', sshPath: '/backup', sshIdentityFile: '/app/data/ssh/id_rsa',
    smbHost: '', smbShare: '', smbPath: '', smbUsername: '', smbPassword: '',
    nfsHost: '', nfsExport: '', nfsPath: '',
    sourcePath: '/mnt/data',
    excludePatterns: '',
  });
  const [backupSyncHistory, setBackupSyncHistory] = useState<Array<{ success: boolean; startedAt: string; completedAt: string; duration: number; message: string; filesTransferred?: number }>>([]);
  const [backupSyncRunning, setBackupSyncRunning] = useState(false);
  const [backupSyncTesting, setBackupSyncTesting] = useState(false);
  const [backupSyncSaving, setBackupSyncSaving] = useState(false);
  const [backupSyncTestResult, setBackupSyncTestResult] = useState<{ success: boolean; message: string } | null>(null);

  const [nginxExporting, setNginxExporting] = useState(false);
  const [nginxImporting, setNginxImporting] = useState(false);
  const [nginxNode, setNginxNode] = useState<string | null>(null);
  const [nginxInstalled, setNginxInstalled] = useState(false);
  const nginxFileInputRef = useRef<HTMLInputElement>(null);
  const [nginxDiag, setNginxDiag] = useState<{ reason: string; debug: string[]; node?: string; confDir?: string } | null>(null);
  const [nginxDiagExpanded, setNginxDiagExpanded] = useState(false);

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

  useEffect(() => { void fetchBackups(); }, [fetchBackups]);

  const fetchBackupSync = useCallback(async () => {
    try {
      const res = await fetch('/api/settings/backup-sync');
      if (!res.ok) return;
      const data = await res.json();
      if (data.config) {
        const c = data.config;
        const t = c.target || { type: 'local', path: '/mnt/backup' };
        setBackupSync(prev => ({
          ...prev,
          enabled: c.enabled ?? false,
          schedule: c.schedule ?? 'daily',
          time: c.time ?? '02:00',
          dayOfWeek: c.dayOfWeek,
          dayOfMonth: c.dayOfMonth,
          sourcePath: c.sourcePath ?? '/mnt/data',
          excludePatterns: (c.excludePatterns || []).join('\n'),
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

  useEffect(() => { void fetchBackupSync(); }, [fetchBackupSync]);

  const checkNginxStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/system/nginx/status');
      const data = await res.json();
      setNginxInstalled(data.installed ?? false);
      if (data.node) setNginxNode(data.node);
    } catch {
      setNginxInstalled(false);
    }
  }, []);

  useEffect(() => { void checkNginxStatus(); }, [checkNginxStatus]);

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
        sourcePath: backupSync.sourcePath,
        excludePatterns: backupSync.excludePatterns.split('\n').map(s => s.trim()).filter(Boolean),
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

  // Nginx
  const nginxNodeQuery = nginxNode && nginxNode !== 'Local' ? `?node=${encodeURIComponent(nginxNode)}` : '';

  const handleNginxExport = async () => {
    setNginxExporting(true);
    setNginxDiag(null);
    try {
      const res = await fetch(`/api/system/nginx/export${nginxNodeQuery}`);
      if (!res.ok) throw new Error('Export failed');
      const data = await res.json();
      if (!data.files || Object.keys(data.files).length === 0) {
        setNginxDiag({
          reason: data.reason || 'No config files found (unknown reason)',
          debug: data.debug || [],
          node: data.node,
          confDir: data.confDir,
        });
        setNginxDiagExpanded(false);
        return;
      }
      const blob = new Blob([JSON.stringify(data.files, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `nginx-config-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      addToast('success', `Exported ${Object.keys(data.files).length} config file(s)`);
    } catch {
      addToast('error', 'Failed to export nginx config');
    } finally {
      setNginxExporting(false);
    }
  };

  const handleNginxImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setNginxImporting(true);
    setNginxDiag(null);
    try {
      const isBackup = file.name.endsWith('.tar.gz') || file.name.endsWith('.tgz');
      let res: Response;

      if (isBackup) {
        const formData = new FormData();
        formData.append('file', file);
        res = await fetch(`/api/system/nginx/import${nginxNodeQuery}`, { method: 'POST', body: formData });
      } else {
        const text = await file.text();
        const files = JSON.parse(text);
        if (typeof files !== 'object' || Array.isArray(files)) {
          throw new Error('Invalid format');
        }
        res = await fetch(`/api/system/nginx/import${nginxNodeQuery}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ files }),
        });
      }

      const data = await res.json();
      if (!res.ok) {
        setNginxDiag({
          reason: data.error || 'Import failed (unknown error)',
          debug: data.debug || [],
          node: data.node,
        });
        setNginxDiagExpanded(false);
        return;
      }
      addToast('success', `Imported ${data.imported?.length || 0} config file(s)`);
    } catch {
      setNginxDiag({
        reason: 'Failed to parse the uploaded file. Expected a JSON export file ({ "name.conf": "content" }) or a full ServiceBay backup (.tar.gz).',
        debug: [],
      });
      setNginxDiagExpanded(false);
    } finally {
      setNginxImporting(false);
      if (nginxFileInputRef.current) nginxFileInputRef.current.value = '';
    }
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
  }, [nodes]);

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
  }, [restoringBackup]);

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
  }, [restoreSource]);

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
  }, [addToast, closeRestoreOverlay, fetchBackups, restorePreview, restoreSelectionState, restoreSource, restoringBackup]);

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
  }, [restorePreview, restoreSelectionState]);

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
  }, [backups, restoringLatest, addToast, fetchBackups]);

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

  return (
    <>
      {/* Primary CTA: one-click restore from latest snapshot. The selective
          flow stays available behind "Selective restore…" / per-row Restore. */}
      {backups.length > 0 && (
        <div className="bg-emerald-50 dark:bg-emerald-900/10 border border-emerald-200 dark:border-emerald-800 rounded-xl shadow-sm overflow-hidden w-full">
          <div className="p-5 flex flex-col md:flex-row md:items-center gap-4">
            <div className="p-3 bg-emerald-100 dark:bg-emerald-900/30 rounded-lg text-emerald-700 dark:text-emerald-200 shrink-0">
              <RotateCcw size={24} />
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="font-bold text-gray-900 dark:text-white">Restore latest snapshot</h3>
              <p className="text-sm text-gray-600 dark:text-gray-300 break-all">
                One-click restore of <span className="font-mono">{backups[0].fileName}</span>{' '}
                <span className="text-gray-500 dark:text-gray-400">
                  ({new Date(backups[0].createdAt).toLocaleString()}, {formatBytes(backups[0].size)})
                </span>
              </p>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                Need granular control?{' '}
                <button
                  type="button"
                  onClick={() => openRestoreOverlay(true)}
                  className="text-emerald-700 dark:text-emerald-300 underline"
                >
                  Selective restore…
                </button>
              </p>
            </div>
            <button
              onClick={() => setConfirmRestoreLatestOpen(true)}
              disabled={restoringLatest}
              className="shrink-0 inline-flex items-center gap-2 px-5 py-2.5 bg-emerald-600 text-white font-medium rounded-lg shadow-sm hover:bg-emerald-700 disabled:opacity-50 transition-colors"
            >
              {restoringLatest ? <Loader2 className="animate-spin" size={18} /> : <RotateCcw size={18} />}
              {restoringLatest ? 'Restoring…' : 'Restore'}
            </button>
          </div>
        </div>
      )}

      {/* System Backups */}
      <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm overflow-hidden w-full">
        <div className="p-4 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 flex flex-col gap-3 md:flex-row md:items-center">
          <div className="flex items-center gap-3 flex-1">
            <div className="p-2 bg-emerald-100 dark:bg-emerald-900/30 rounded-lg text-emerald-600 dark:text-emerald-300">
              <HardDrive size={20} />
            </div>
            <div>
              <h3 className="font-bold text-gray-900 dark:text-white">System Backups</h3>
              <p className="text-xs text-gray-500 dark:text-gray-400">Capture managed services and ServiceBay config into a restorable tarball.</p>
              {backupStatus !== 'idle' && (
                <div className="mt-1 flex items-center gap-2 text-[11px] text-gray-600 dark:text-gray-300">
                  {backupStatus === 'running' && (
                    <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-300">
                      <Loader2 className="w-3 h-3 animate-spin" /> Backup in progress
                    </span>
                  )}
                  {backupStatus === 'success' && (
                    <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-300">
                      <CheckCircle2 className="w-3 h-3" /> Latest run completed
                    </span>
                  )}
                  {backupStatus === 'error' && (
                    <span className="inline-flex items-center gap-1 text-red-600 dark:text-red-300">
                      <XCircle className="w-3 h-3" /> Last run failed
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>
          <div className="flex flex-col md:flex-row md:items-center gap-3">
            <p className="text-[11px] text-gray-500 dark:text-gray-400 bg-white/60 dark:bg-gray-900/40 px-3 py-1 rounded-md border border-gray-200 dark:border-gray-800">
              Archives stored under <span className="font-mono">~/.config/containers/systemd/backups</span>
            </p>
            <button
              onClick={() => openRestoreOverlay(true)}
              className="inline-flex items-center justify-center gap-2 px-4 py-2 bg-white dark:bg-gray-900 text-gray-700 dark:text-gray-200 text-sm rounded-lg border border-gray-300 dark:border-gray-700 shadow-sm hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
            >
              <UploadCloud size={16} /> Selective restore…
            </button>
            <button
              onClick={handleCreateBackup}
              disabled={creatingBackup}
              className="inline-flex items-center justify-center gap-2 px-4 py-2 bg-emerald-600 text-white text-sm rounded-lg shadow-sm hover:bg-emerald-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {creatingBackup ? <Loader2 className="animate-spin" size={16} /> : <Download size={16} />}
              {creatingBackup ? 'Creating Backup...' : 'Create Backup'}
            </button>
          </div>
        </div>
        <div className="p-6">
          {backupsLoading ? (
            <div className="flex items-center gap-3 text-sm text-gray-500 dark:text-gray-400">
              <Loader2 className="animate-spin" size={18} />
              Loading backups...
            </div>
          ) : backups.length === 0 ? (
            <div className="text-sm text-gray-500 dark:text-gray-400 italic">No backups found. Create one to snapshot your environment.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="text-left text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-800">
                    <th className="py-2 font-medium">Archive</th>
                    <th className="py-2 font-medium">Created</th>
                    <th className="py-2 font-medium">Size</th>
                    <th className="py-2 font-medium text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200 dark:divide-gray-800">
                  {backups.map(backup => (
                    <tr key={backup.fileName}>
                      <td className="py-3 font-mono text-xs text-blue-600 dark:text-blue-300 break-all">{backup.fileName}</td>
                      <td className="py-3 text-gray-700 dark:text-gray-300">{new Date(backup.createdAt).toLocaleString()}</td>
                      <td className="py-3 text-gray-700 dark:text-gray-300">{formatBytes(backup.size)}</td>
                      <td className="py-3">
                        <div className="flex justify-end gap-2">
                          <button onClick={() => handleDownloadBackup(backup.fileName)} className="text-xs px-3 py-1.5 rounded-md border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors flex items-center gap-1">
                            <Download size={14} /> Download
                          </button>
                          <button onClick={() => handleRestoreRequest(backup)} className="text-xs px-3 py-1.5 rounded-md border border-amber-300 text-amber-700 dark:text-amber-300 dark:border-amber-700 hover:bg-amber-50 dark:hover:bg-amber-900/20 transition-colors flex items-center gap-1">
                            <RotateCcw size={14} /> Restore
                          </button>
                          <button onClick={() => setDeleteTarget(backup)} disabled={deletingBackup} className="text-xs px-3 py-1.5 rounded-md border border-red-200 text-red-600 dark:text-red-400 dark:border-red-700 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors flex items-center gap-1 disabled:opacity-60">
                            <Trash2 size={14} /> Delete
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {(backupLog.length > 0 || backupStatus === 'running' || backupStatus === 'error') && (
            <div className="mt-6 border border-gray-200 dark:border-gray-800 rounded-lg p-4 bg-gray-50/60 dark:bg-gray-900/40">
              <div className="flex items-center justify-between mb-3">
                <span className="text-sm font-semibold text-gray-800 dark:text-gray-100">Backup Activity</span>
                {backupStatus === 'running' && (
                  <span className="inline-flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-300">
                    <Loader2 className="w-3 h-3 animate-spin" /> Streaming logs
                  </span>
                )}
                {backupStatus === 'error' && (
                  <span className="inline-flex items-center gap-1 text-xs text-red-600 dark:text-red-300">
                    <XCircle className="w-3 h-3" /> Check details below
                  </span>
                )}
                {backupStatus === 'success' && backupLog.length > 0 && (
                  <span className="inline-flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-300">
                    <CheckCircle2 className="w-3 h-3" /> Completed
                  </span>
                )}
              </div>
              <div className="max-h-48 overflow-y-auto pr-1 space-y-3">
                {backupLog.length === 0 ? (
                  <p className="text-xs text-gray-500 dark:text-gray-400 italic">Waiting for backup updates…</p>
                ) : (
                  backupLog.map((entry, idx) => (
                    <div key={`${entry.timestamp}-${idx}`} className="flex gap-3 text-xs">
                      <span className={`mt-1 h-2 w-2 rounded-full ${LOG_STATUS_DOTS[entry.status] ?? LOG_STATUS_DOTS.info}`}></span>
                      <div className="flex-1">
                        <div className="flex flex-wrap items-center gap-2 text-[11px] text-gray-500 dark:text-gray-400">
                          <span className="font-mono">{new Date(entry.timestamp).toLocaleTimeString()}</span>
                          {entry.node && <span className="uppercase tracking-wide text-gray-600 dark:text-gray-300">{entry.node}</span>}
                          <span className={`px-2 py-0.5 rounded ${LOG_STATUS_BADGES[entry.status] ?? LOG_STATUS_BADGES.info}`}>{entry.status.toUpperCase()}</span>
                        </div>
                        <p className="text-gray-700 dark:text-gray-200">{entry.message}</p>
                        {entry.target && <p className="text-[10px] font-mono text-gray-500 dark:text-gray-400 break-all">{entry.target}</p>}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Backup Sync */}
      <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm overflow-hidden w-full">
        <div className="p-4 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-blue-100 dark:bg-blue-900/30 rounded-lg text-blue-600 dark:text-blue-300">
              <UploadCloud size={20} />
            </div>
            <div className="flex-1">
              <h3 className="font-bold text-gray-900 dark:text-white">Backup Sync</h3>
              <p className="text-xs text-gray-500 dark:text-gray-400">Incrementally sync your data to an external target using rsync.</p>
            </div>
            <label className="flex items-center gap-2 cursor-pointer">
              <span className="text-xs text-gray-500 dark:text-gray-400">{backupSync.enabled ? 'Enabled' : 'Disabled'}</span>
              <div className="relative">
                <input type="checkbox" className="sr-only peer" checked={backupSync.enabled} onChange={e => setBackupSync(prev => ({ ...prev, enabled: e.target.checked }))} />
                <div className="w-9 h-5 bg-gray-200 peer-focus:outline-none rounded-full peer dark:bg-gray-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-blue-600"></div>
              </div>
            </label>
          </div>
          {backupSync.lastRun && (
            <div className="mt-2 text-xs text-gray-500 dark:text-gray-400 flex items-center gap-2">
              <Clock size={12} /> Last run: {new Date(backupSync.lastRun).toLocaleString()}
              {backupSync.lastStatus === 'success' && <span className="text-emerald-600"><CheckCircle2 size={12} className="inline" /></span>}
              {backupSync.lastStatus === 'error' && <span className="text-red-500"><XCircle size={12} className="inline" /></span>}
              {backupSync.lastDuration != null && <span>({backupSync.lastDuration}s)</span>}
            </div>
          )}
        </div>

        <div className="p-4 space-y-4">
          <div>
            <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Source Path</label>
            <input type="text" className="w-full px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white" value={backupSync.sourcePath} onChange={e => setBackupSync(prev => ({ ...prev, sourcePath: e.target.value }))} placeholder="/mnt/data" />
          </div>

          {/* Target picker — radio cards. The previous version used a row of
              terse text-only buttons that read more like filter chips than a
              "choose one of these and the form below changes" prompt. Cards
              with icons + a one-line "what this is" description make the
              relationship obvious and bring this control in line with how
              the rest of ServiceBay presents primary choices. */}
          <div>
            <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-2">Where should backups go?</label>
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
                    className={`flex items-start gap-2 px-3 py-2 text-left rounded-lg border-2 transition-colors ${active ? 'bg-blue-50 dark:bg-blue-900/20 border-blue-500 dark:border-blue-400' : 'border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700/50 hover:border-gray-300 dark:hover:border-gray-600'}`}
                  >
                    <Icon size={16} className={`mt-0.5 flex-shrink-0 ${active ? 'text-blue-600 dark:text-blue-300' : 'text-gray-400'}`} />
                    <div className="min-w-0">
                      <div className={`text-xs font-semibold ${active ? 'text-blue-700 dark:text-blue-300' : 'text-gray-700 dark:text-gray-200'}`}>{label}</div>
                      <div className={`text-[11px] leading-tight ${active ? 'text-blue-600/70 dark:text-blue-200/70' : 'text-gray-500 dark:text-gray-400'}`}>{hint}</div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Connection-details panel — the same fields as before, but wrapped
              in a labelled container so it's visually clear these inputs
              belong to the chosen target type. */}
          <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50/50 dark:bg-gray-900/30 p-3 space-y-3">
            <div className="text-[11px] uppercase tracking-wider font-semibold text-gray-500 dark:text-gray-400 flex items-center gap-1.5">
              <ChevronRight size={12} />
              {backupSync.targetType === 'local' ? 'Local target details' :
               backupSync.targetType === 'ssh'   ? 'SSH connection details' :
               backupSync.targetType === 'smb'   ? 'SMB share details'      :
                                                   'NFS export details'}
            </div>

          {backupSync.targetType === 'local' && (
            <div>
              <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Target Path</label>
              <input type="text" className="w-full px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white" value={backupSync.localPath} onChange={e => setBackupSync(prev => ({ ...prev, localPath: e.target.value }))} placeholder="/mnt/backup" />
              <p className="text-[11px] text-gray-400 mt-1">Mount your USB/external drive here first.</p>
            </div>
          )}

          {backupSync.targetType === 'ssh' && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Host</label>
                <input type="text" className="w-full px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white" value={backupSync.sshHost} onChange={e => setBackupSync(prev => ({ ...prev, sshHost: e.target.value }))} placeholder="192.168.1.100" />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Port</label>
                <input type="text" className="w-full px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white" value={backupSync.sshPort} onChange={e => setBackupSync(prev => ({ ...prev, sshPort: e.target.value }))} placeholder="22" />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">User</label>
                <input type="text" className="w-full px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white" value={backupSync.sshUser} onChange={e => setBackupSync(prev => ({ ...prev, sshUser: e.target.value }))} />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Remote Path</label>
                <input type="text" className="w-full px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white" value={backupSync.sshPath} onChange={e => setBackupSync(prev => ({ ...prev, sshPath: e.target.value }))} placeholder="/backup" />
              </div>
              <div className="col-span-2">
                <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Identity File</label>
                <input type="text" className="w-full px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white" value={backupSync.sshIdentityFile} onChange={e => setBackupSync(prev => ({ ...prev, sshIdentityFile: e.target.value }))} />
              </div>
            </div>
          )}

          {backupSync.targetType === 'smb' && (
            <div className="grid grid-cols-2 gap-3">
              <div><label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Host</label><input type="text" className="w-full px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white" value={backupSync.smbHost} onChange={e => setBackupSync(prev => ({ ...prev, smbHost: e.target.value }))} placeholder="nas.local" /></div>
              <div><label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Share Name</label><input type="text" className="w-full px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white" value={backupSync.smbShare} onChange={e => setBackupSync(prev => ({ ...prev, smbShare: e.target.value }))} placeholder="backup" /></div>
              <div><label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Subfolder (optional)</label><input type="text" className="w-full px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white" value={backupSync.smbPath} onChange={e => setBackupSync(prev => ({ ...prev, smbPath: e.target.value }))} /></div>
              <div><label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Username</label><input type="text" className="w-full px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white" value={backupSync.smbUsername} onChange={e => setBackupSync(prev => ({ ...prev, smbUsername: e.target.value }))} /></div>
              <div className="col-span-2"><label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Password</label><input type="password" className="w-full px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white" value={backupSync.smbPassword} onChange={e => setBackupSync(prev => ({ ...prev, smbPassword: e.target.value }))} /></div>
            </div>
          )}

          {backupSync.targetType === 'nfs' && (
            <div className="grid grid-cols-2 gap-3">
              <div><label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Host</label><input type="text" className="w-full px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white" value={backupSync.nfsHost} onChange={e => setBackupSync(prev => ({ ...prev, nfsHost: e.target.value }))} placeholder="nas.local" /></div>
              <div><label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Export Path</label><input type="text" className="w-full px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white" value={backupSync.nfsExport} onChange={e => setBackupSync(prev => ({ ...prev, nfsExport: e.target.value }))} placeholder="/volume1/backup" /></div>
              <div className="col-span-2"><label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Subfolder (optional)</label><input type="text" className="w-full px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white" value={backupSync.nfsPath} onChange={e => setBackupSync(prev => ({ ...prev, nfsPath: e.target.value }))} /></div>
            </div>
          )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Schedule</label>
              <select className="w-full px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white" value={backupSync.schedule} onChange={e => setBackupSync(prev => ({ ...prev, schedule: e.target.value as 'hourly' | 'daily' | 'weekly' | 'monthly' }))}>
                <option value="hourly">Hourly</option>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Time (UTC)</label>
              <input type="time" className="w-full px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white" value={backupSync.time} onChange={e => setBackupSync(prev => ({ ...prev, time: e.target.value }))} />
            </div>
            {backupSync.schedule === 'weekly' && (
              <div>
                <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Day of Week</label>
                <select className="w-full px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white" value={backupSync.dayOfWeek ?? 0} onChange={e => setBackupSync(prev => ({ ...prev, dayOfWeek: parseInt(e.target.value) }))}>
                  {['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((d, i) => (
                    <option key={i} value={i}>{d}</option>
                  ))}
                </select>
              </div>
            )}
            {backupSync.schedule === 'monthly' && (
              <div>
                <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Day of Month</label>
                <input type="number" min={1} max={28} className="w-full px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white" value={backupSync.dayOfMonth ?? 1} onChange={e => setBackupSync(prev => ({ ...prev, dayOfMonth: parseInt(e.target.value) || 1 }))} />
              </div>
            )}
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Exclude Patterns (one per line)</label>
            <textarea className="w-full px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white font-mono" rows={2} value={backupSync.excludePatterns} onChange={e => setBackupSync(prev => ({ ...prev, excludePatterns: e.target.value }))} placeholder="*.tmp&#10;*.log" />
          </div>

          {backupSyncTestResult && (
            <div className={`p-3 text-sm rounded-lg ${backupSyncTestResult.success ? 'bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-300' : 'bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300'}`}>
              {backupSyncTestResult.success ? <CheckCircle2 size={14} className="inline mr-1" /> : <XCircle size={14} className="inline mr-1" />}
              {backupSyncTestResult.message}
            </div>
          )}

          <div className="flex flex-wrap gap-2 pt-2 border-t border-gray-200 dark:border-gray-700">
            <button onClick={handleSaveBackupSync} disabled={backupSyncSaving} className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50">
              {backupSyncSaving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Save
            </button>
            <button onClick={handleTestBackupSync} disabled={backupSyncTesting} className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-200 bg-gray-100 dark:bg-gray-700 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600 disabled:opacity-50">
              {backupSyncTesting ? <Loader2 size={14} className="animate-spin" /> : <Activity size={14} />} Test Connection
            </button>
            <button onClick={handleRunBackupSync} disabled={backupSyncRunning} className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-emerald-600 rounded-lg hover:bg-emerald-700 disabled:opacity-50">
              {backupSyncRunning ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
              {backupSyncRunning ? 'Running...' : 'Run Now'}
            </button>
          </div>

          {backupSyncHistory.length > 0 && (
            <div className="pt-3 border-t border-gray-200 dark:border-gray-700">
              <h4 className="text-xs font-medium text-gray-700 dark:text-gray-300 mb-2">Recent Runs</h4>
              <div className="space-y-1 max-h-40 overflow-y-auto">
                {backupSyncHistory.slice(0, 10).map((h, i) => (
                  <div key={i} className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
                    {h.success ? <CheckCircle2 size={12} className="text-emerald-500 flex-shrink-0" /> : <XCircle size={12} className="text-red-500 flex-shrink-0" />}
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
      </div>

      {/* Nginx Config Export/Import */}
      {nginxInstalled && (
        <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm overflow-hidden w-full">
          <div className="p-4 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 flex flex-col gap-3 md:flex-row md:items-center">
            <div className="flex items-center gap-3 flex-1">
              <div className="p-2 bg-green-100 dark:bg-green-900/30 rounded-lg text-green-600 dark:text-green-300">
                <Shield size={20} />
              </div>
              <div>
                <h3 className="font-bold text-gray-900 dark:text-white">Nginx Configuration</h3>
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  Export or import reverse proxy server block configs{nginxNode && nginxNode !== 'Local' ? ` (${nginxNode})` : ''}.
                </p>
              </div>
            </div>
            <div className="flex flex-col md:flex-row md:items-center gap-3">
              <button onClick={handleNginxExport} disabled={nginxExporting} className="inline-flex items-center justify-center gap-2 px-4 py-2 bg-white dark:bg-gray-900 text-gray-700 dark:text-gray-200 text-sm rounded-lg border border-gray-300 dark:border-gray-700 shadow-sm hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors disabled:opacity-50">
                {nginxExporting ? <Loader2 className="animate-spin" size={16} /> : <Download size={16} />} Export Config
              </button>
              <label className="inline-flex items-center justify-center gap-2 px-4 py-2 bg-white dark:bg-gray-900 text-gray-700 dark:text-gray-200 text-sm rounded-lg border border-gray-300 dark:border-gray-700 shadow-sm hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors cursor-pointer">
                {nginxImporting ? <Loader2 className="animate-spin" size={16} /> : <Upload size={16} />} Import Config
                <input ref={nginxFileInputRef} type="file" accept=".json,.tar.gz,.tgz" onChange={handleNginxImport} className="hidden" />
              </label>
            </div>
          </div>
          {nginxDiag && (
            <div className="p-4 border-t border-red-200 dark:border-red-800/50 bg-red-50 dark:bg-red-900/20">
              <div className="flex items-start gap-3">
                <XCircle className="w-5 h-5 text-red-500 dark:text-red-400 shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-red-800 dark:text-red-200">{nginxDiag.reason}</p>
                  {(nginxDiag.node || nginxDiag.confDir) && (
                    <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-red-600 dark:text-red-300">
                      {nginxDiag.node && <span>Node: <span className="font-mono">{nginxDiag.node}</span></span>}
                      {nginxDiag.confDir && <span>conf.d: <span className="font-mono">{nginxDiag.confDir}</span></span>}
                    </div>
                  )}
                  {nginxDiag.debug.length > 0 && (
                    <div className="mt-2">
                      <button onClick={() => setNginxDiagExpanded(prev => !prev)} className="inline-flex items-center gap-1 text-xs text-red-600 dark:text-red-300 hover:text-red-800 dark:hover:text-red-100 transition-colors">
                        {nginxDiagExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                        Diagnostics ({nginxDiag.debug.length} steps)
                      </button>
                      {nginxDiagExpanded && (
                        <pre className="mt-1 p-2 rounded bg-red-100 dark:bg-red-900/40 text-[11px] font-mono text-red-700 dark:text-red-200 overflow-x-auto max-h-60 overflow-y-auto whitespace-pre-wrap break-words">
                          {nginxDiag.debug.join('\n')}
                        </pre>
                      )}
                    </div>
                  )}
                </div>
                <button onClick={() => setNginxDiag(null)} className="text-red-400 hover:text-red-600 dark:hover:text-red-200 transition-colors shrink-0">
                  <X size={16} />
                </button>
              </div>
            </div>
          )}
        </div>
      )}

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

      {restoreOverlayOpen && (
        <div className="fixed inset-0 z-[90] flex items-stretch justify-end" onMouseDown={stopRestoreEvent} onClick={stopRestoreEvent}>
          <div className="absolute inset-0 bg-gray-950/70 backdrop-blur-sm" onClick={handleRestoreBackdrop} />
          <aside className="relative z-10 w-full max-w-3xl h-full bg-white dark:bg-gray-950 border-l border-gray-200 dark:border-gray-800 shadow-2xl flex flex-col">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-gray-800">
              <div>
                <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Restore from Backup</h3>
                <p className="text-xs text-gray-500 dark:text-gray-400">Select what to restore before applying changes.</p>
              </div>
              <button type="button" onClick={closeRestoreOverlay} className="rounded-full p-2 text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-800" aria-label="Close restore panel">
                <X size={18} />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
              {!restorePreview ? (
                <div className="border-2 border-dashed border-gray-300 dark:border-gray-700 rounded-xl p-8 text-center bg-gray-50 dark:bg-gray-900/40" onDrop={handleRestoreDrop} onDragOver={handleRestoreDragOver}>
                  <UploadCloud className="mx-auto text-gray-400" size={28} />
                  <p className="mt-3 text-sm font-medium text-gray-700 dark:text-gray-200">Drop a backup archive here</p>
                  <p className="text-xs text-gray-500 dark:text-gray-400">Supports .tar.gz exports from ServiceBay.</p>
                  <div className="mt-4">
                    <label htmlFor="restore-backup-file" className="inline-flex items-center gap-2 px-4 py-2 bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-lg text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 cursor-pointer">
                      <UploadCloud size={16} /> Select file
                    </label>
                    <input id="restore-backup-file" type="file" accept=".tar.gz" className="hidden" onChange={(event) => handleRestoreFromFile(event.target.files?.[0] || null)} />
                  </div>
                  {restoreUploadError && (<p className="mt-3 text-xs text-red-600 dark:text-red-400">{restoreUploadError}</p>)}
                </div>
              ) : restoreSelectionState ? (
                <div className="space-y-3">
                  {/* Source & Summary */}
                  <div className="rounded-lg border border-gray-200 dark:border-gray-800 p-4 bg-gray-50 dark:bg-gray-900/40 flex flex-wrap items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-xs text-gray-500 dark:text-gray-400">Backup Source</p>
                      <p className="text-sm font-mono text-gray-800 dark:text-gray-200 truncate">
                        {restoreSource?.type === 'stored' ? restoreSource.fileName : 'Uploaded archive'}
                      </p>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="text-xs text-gray-500 dark:text-gray-400">{getRestoreSelectionSummary()}</span>
                      <button type="button" onClick={() => { selectAllRestoreItems(); void confirmRestoreBackup(); }} disabled={restoringBackup} className="inline-flex items-center gap-2 px-3 py-1.5 text-xs font-medium rounded-lg border border-emerald-500 text-emerald-700 dark:text-emerald-300 dark:border-emerald-700 hover:bg-emerald-50 dark:hover:bg-emerald-900/20 transition-colors">
                        <RotateCcw size={14} /> Restore all
                      </button>
                    </div>
                  </div>

                  {/* Settings */}
                  <div className="rounded-lg border border-gray-200 dark:border-gray-800 overflow-hidden">
                    <button type="button" onClick={() => toggleRestoreSection('settings')} className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-gray-50 dark:hover:bg-gray-900/40 transition-colors">
                      {restoreExpandedSections.settings ? <ChevronDown size={16} className="text-gray-400 shrink-0" /> : <ChevronRight size={16} className="text-gray-400 shrink-0" />}
                      <Settings size={16} className="text-gray-400 shrink-0" />
                      <div className="flex-1 min-w-0">
                        <span className="text-sm font-medium text-gray-900 dark:text-gray-100">Settings</span>
                        <span className="ml-2 text-xs text-gray-500 dark:text-gray-400">
                          {Object.values(restoreSelectionState.configFlags).filter(Boolean).length} of {Object.keys(restoreSelectionState.configFlags).length} selected
                        </span>
                      </div>
                    </button>
                    {restoreExpandedSections.settings && (
                      <div className="px-4 pb-4 pt-1 border-t border-gray-100 dark:border-gray-800/50 grid gap-2.5">
                        {([
                          { key: 'externalLinks' as const, label: 'External links', summary: restorePreview.config.externalLinks.length === 0 ? 'None' : `${restorePreview.config.externalLinks.length} link${restorePreview.config.externalLinks.length !== 1 ? 's' : ''}` },
                          { key: 'registries' as const, label: 'Registries', summary: restorePreview.config.registries.length === 0 ? 'None' : restorePreview.config.registries.map(r => r.name).join(', ') },
                          { key: 'gateway' as const, label: 'Gateway', summary: restorePreview.config.gateway?.host || 'Not configured' },
                          { key: 'notifications' as const, label: 'Notifications', summary: restorePreview.config.notifications ? `${restorePreview.config.notifications.host || 'SMTP'} → ${(restorePreview.config.notifications.to || []).join(', ') || 'no recipients'}` : 'Not configured' },
                          { key: 'templateSettings' as const, label: 'Template settings', summary: restorePreview.config.templateSettings.length === 0 ? 'None' : `${restorePreview.config.templateSettings.length} key${restorePreview.config.templateSettings.length !== 1 ? 's' : ''}` },
                          { key: 'logLevel' as const, label: 'Log level', summary: restorePreview.config.logLevel || 'default' },
                          { key: 'update' as const, label: 'Auto-update', summary: restorePreview.config.update ? (restorePreview.config.update.enabled === false ? 'Disabled' : 'Enabled') : 'Not configured' },
                        ]).map(item => (
                          <label key={item.key} className="flex items-center gap-3 text-sm text-gray-700 dark:text-gray-200 py-1">
                            <input type="checkbox" className="rounded" checked={restoreSelectionState.configFlags[item.key]} onChange={() => toggleRestoreConfigFlag(item.key)} />
                            <span className="font-medium min-w-[120px]">{item.label}</span>
                            <span className="text-xs text-gray-500 dark:text-gray-400 truncate">{item.summary}</span>
                          </label>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Nodes & Checks */}
                  <div className="rounded-lg border border-gray-200 dark:border-gray-800 overflow-hidden">
                    <button type="button" onClick={() => toggleRestoreSection('infrastructure')} className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-gray-50 dark:hover:bg-gray-900/40 transition-colors">
                      {restoreExpandedSections.infrastructure ? <ChevronDown size={16} className="text-gray-400 shrink-0" /> : <ChevronRight size={16} className="text-gray-400 shrink-0" />}
                      <Activity size={16} className="text-gray-400 shrink-0" />
                      <div className="flex-1 min-w-0">
                        <span className="text-sm font-medium text-gray-900 dark:text-gray-100">Nodes & Health</span>
                        <span className="ml-2 text-xs text-gray-500 dark:text-gray-400">
                          {Object.values(restoreSelectionState.nodes).filter(Boolean).length} node{Object.values(restoreSelectionState.nodes).filter(Boolean).length !== 1 ? 's' : ''},
                          {' '}{Object.values(restoreSelectionState.checks).filter(Boolean).length} check{Object.values(restoreSelectionState.checks).filter(Boolean).length !== 1 ? 's' : ''}
                        </span>
                      </div>
                    </button>
                    {restoreExpandedSections.infrastructure && (
                      <div className="px-4 pb-4 pt-1 border-t border-gray-100 dark:border-gray-800/50 space-y-4">
                        {restorePreview.config.nodes.length > 0 && (
                          <div>
                            <p className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-2">Nodes</p>
                            <div className="grid gap-2">
                              {restorePreview.config.nodes.map(node => (
                                <label key={node.name} className="flex items-center gap-3 text-sm text-gray-700 dark:text-gray-200">
                                  <input type="checkbox" className="rounded" checked={restoreSelectionState.nodes[node.name]} onChange={() => toggleRestoreNode(node.name)} />
                                  <Server size={14} className="text-gray-400 shrink-0" />
                                  <span className="font-medium">{node.name}</span>
                                  <span className="text-xs text-gray-500 dark:text-gray-400">{node.uri}{node.default ? ' · Default' : ''}</span>
                                </label>
                              ))}
                            </div>
                          </div>
                        )}
                        {restorePreview.config.checks.length > 0 && (
                          <div>
                            <p className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-2">Health Checks</p>
                            <div className="grid gap-2">
                              {restorePreview.config.checks.map(check => (
                                <label key={check.id} className="flex items-center gap-3 text-sm text-gray-700 dark:text-gray-200">
                                  <input type="checkbox" className="rounded" checked={restoreSelectionState.checks[check.id]} onChange={() => toggleRestoreCheck(check.id)} />
                                  <span className="font-medium">{check.name}</span>
                                  {check.type && <span className="text-[10px] uppercase px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400">{check.type}</span>}
                                  {check.target && <span className="text-xs text-gray-500 dark:text-gray-400">{check.target}</span>}
                                </label>
                              ))}
                            </div>
                          </div>
                        )}
                        {restorePreview.config.nodes.length === 0 && restorePreview.config.checks.length === 0 && (
                          <p className="text-xs text-gray-500 dark:text-gray-400 italic">No nodes or checks in this backup.</p>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Systemd Files */}
                  {restorePreview.nodeFiles.length > 0 && (
                    <div className="rounded-lg border border-gray-200 dark:border-gray-800 overflow-hidden">
                      <button type="button" onClick={() => toggleRestoreSection('files')} className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-gray-50 dark:hover:bg-gray-900/40 transition-colors">
                        {restoreExpandedSections.files ? <ChevronDown size={16} className="text-gray-400 shrink-0" /> : <ChevronRight size={16} className="text-gray-400 shrink-0" />}
                        <FolderOpen size={16} className="text-gray-400 shrink-0" />
                        <div className="flex-1 min-w-0">
                          <span className="text-sm font-medium text-gray-900 dark:text-gray-100">Systemd Files</span>
                          <span className="ml-2 text-xs text-gray-500 dark:text-gray-400">
                            {Object.values(restoreSelectionState.nodeFiles).reduce((sum, files) => sum + Object.values(files).filter(Boolean).length, 0)} of {restorePreview.nodeFiles.reduce((sum, g) => sum + g.files.length, 0)} files selected
                          </span>
                        </div>
                      </button>
                      {restoreExpandedSections.files && (
                        <div className="border-t border-gray-100 dark:border-gray-800/50">
                          {restorePreview.nodeFiles.map(group => {
                            const selectedCount = Object.values(restoreSelectionState.nodeFiles[group.nodeName] || {}).filter(Boolean).length;
                            const allSelected = selectedCount === group.files.length;
                            const serviceGroups = groupFilesByService(group.files);
                            return (
                              <div key={group.nodeName} className="border-b border-gray-100 dark:border-gray-800/50 last:border-b-0">
                                <div className="flex items-center justify-between gap-2 px-4 py-2.5 bg-gray-50/50 dark:bg-gray-900/20">
                                  <div className="flex items-center gap-3">
                                    <input type="checkbox" className="rounded" checked={allSelected} onChange={() => toggleAllNodeFiles(group.nodeName, !allSelected)} />
                                    <span className="text-sm font-medium text-gray-900 dark:text-gray-100">{group.nodeName}</span>
                                    <span className="text-xs text-gray-500 dark:text-gray-400">{selectedCount}/{group.files.length} files</span>
                                  </div>
                                  <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
                                    <span>Target:</span>
                                    <select value={restoreSelectionState.targetNodes[group.nodeName]} onChange={(event) => updateRestoreTargetNode(group.nodeName, event.target.value)} className="bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-200 rounded px-2 py-1 text-xs">
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
                                      <div key={sg.service} className="border-b border-gray-50 dark:border-gray-800/30 last:border-b-0">
                                        <div className="flex items-center gap-2 px-4 py-2 hover:bg-gray-50 dark:hover:bg-gray-900/30">
                                          <input type="checkbox" className="rounded" checked={sgAllSelected} onChange={() => toggleServiceGroupFiles(group.nodeName, sg.files, !sgAllSelected)} />
                                          <button type="button" onClick={() => toggleRestoreSection(sgKey)} className="flex items-center gap-1.5 flex-1 min-w-0 text-left">
                                            {sgExpanded ? <ChevronDown size={12} className="text-gray-400 shrink-0" /> : <ChevronRight size={12} className="text-gray-400 shrink-0" />}
                                            <span className="text-xs font-medium text-gray-800 dark:text-gray-200 capitalize">{displayName}</span>
                                            <span className="text-[10px] text-gray-400 dark:text-gray-500">{sgSelectedCount}/{sg.files.length}</span>
                                          </button>
                                        </div>
                                        {sgExpanded && (
                                          <div className="pl-10 pr-4 pb-1">
                                            {sg.files.map(file => (
                                              <div key={file.relativePath} className="flex items-center gap-3 py-1 text-xs text-gray-600 dark:text-gray-300">
                                                <input type="checkbox" className="rounded" checked={Boolean(restoreSelectionState.nodeFiles[group.nodeName]?.[file.relativePath])} onChange={() => toggleRestoreFile(group.nodeName, file.relativePath)} />
                                                <span className="flex-1 font-mono truncate">{file.fileName}</span>
                                                <button type="button" onClick={() => handleRestoreFilePreview(group.nodeName, file.relativePath)} className="shrink-0 p-1 rounded text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800" title="Preview file">
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
                    <div className="rounded-lg border border-gray-200 dark:border-gray-800 overflow-hidden">
                      <button type="button" onClick={() => toggleRestoreSection('serviceData')} className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-gray-50 dark:hover:bg-gray-900/40 transition-colors">
                        {restoreExpandedSections.serviceData ? <ChevronDown size={16} className="text-gray-400 shrink-0" /> : <ChevronRight size={16} className="text-gray-400 shrink-0" />}
                        <Database size={16} className="text-gray-400 shrink-0" />
                        <div className="flex-1 min-w-0">
                          <span className="text-sm font-medium text-gray-900 dark:text-gray-100">Service Data</span>
                          <span className="ml-2 text-xs text-gray-500 dark:text-gray-400">
                            {Object.values(restoreSelectionState.serviceData).reduce((sum, fm) => sum + Object.values(fm).filter(Boolean).length, 0)} file{Object.values(restoreSelectionState.serviceData).reduce((sum, fm) => sum + Object.values(fm).filter(Boolean).length, 0) !== 1 ? 's' : ''} selected
                          </span>
                        </div>
                      </button>
                      {restoreExpandedSections.serviceData && (
                        <div className="px-4 pb-4 pt-1 border-t border-gray-100 dark:border-gray-800/50 space-y-3">
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
                              <div key={sd.name} className="rounded border border-gray-100 dark:border-gray-800/50">
                                <div className="flex items-center gap-2 px-3 py-2">
                                  <input type="checkbox" className="rounded" checked={allSelected} onChange={() => setRestoreSelectionState(prev => {
                                    if (!prev) return prev;
                                    const newVal = !allSelected;
                                    return { ...prev, serviceData: { ...prev.serviceData, [sd.name]: Object.fromEntries(sd.files.map(f => [f, newVal])) } };
                                  })} />
                                  <button type="button" onClick={() => toggleRestoreSection(sdKey)} className="flex items-center gap-2 flex-1 min-w-0">
                                    {sdExpanded ? <ChevronDown size={14} className="text-gray-400 shrink-0" /> : <ChevronRight size={14} className="text-gray-400 shrink-0" />}
                                    <HardDrive size={14} className="text-gray-400 shrink-0" />
                                    <div className="flex flex-col items-start min-w-0">
                                      <div className="flex items-center gap-2">
                                        <span className="text-sm font-medium text-gray-900 dark:text-gray-100">{label}</span>
                                        <span className="text-xs text-gray-500 dark:text-gray-400">{selectedCount}/{sd.files.length}</span>
                                      </div>
                                      {(sd.sourcePath || sd.nodeName) && (
                                        <span className="text-[11px] text-gray-400 dark:text-gray-500 font-mono truncate max-w-full">
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
                                      })} className="px-1.5 py-0.5 text-xs rounded border border-gray-200 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors">
                                        {SERVICE_DATA_CATEGORY_ICONS[cat.category]}
                                      </button>
                                    ))}
                                  </div>
                                </div>

                                {sdExpanded && (
                                  <div className="px-3 pb-3 pt-1 border-t border-gray-100 dark:border-gray-800/50 space-y-2">
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
                                              {catExpanded ? <ChevronDown size={12} className="text-gray-400 shrink-0" /> : <ChevronRight size={12} className="text-gray-400 shrink-0" />}
                                              <span className="text-xs">{SERVICE_DATA_CATEGORY_ICONS[cat.category]}</span>
                                              <span className="text-xs font-medium text-gray-700 dark:text-gray-300">{SERVICE_DATA_CATEGORY_LABELS[cat.category]}</span>
                                              <span className="text-xs text-gray-500 dark:text-gray-400">{catSelectedCount}/{cat.files.length}</span>
                                            </button>
                                          </div>
                                          {catExpanded && (
                                            <div className="ml-6 mt-1 space-y-0.5">
                                              {cat.files.map(file => (
                                                <label key={file} className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-300 py-0.5">
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
              <div className="px-6 py-4 border-t border-gray-200 dark:border-gray-800 flex items-center justify-between">
                <p className="text-xs text-gray-500 dark:text-gray-400">{getRestoreSelectionSummary()}</p>
                <button onClick={confirmRestoreBackup} disabled={restoringBackup} className="inline-flex items-center gap-2 px-4 py-2 bg-emerald-600 text-white text-sm rounded-lg shadow-sm hover:bg-emerald-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
                  {restoringBackup ? <Loader2 className="animate-spin" size={16} /> : <RotateCcw size={16} />}
                  {restoringBackup ? 'Restoring...' : 'Restore Selected'}
                </button>
              </div>
            )}
          </aside>
        </div>
      )}

      {restoreFilePreview && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center" onMouseDown={stopRestoreEvent} onClick={stopRestoreEvent}>
          <div className="absolute inset-0 bg-gray-950/70 backdrop-blur-sm" onClick={() => setRestoreFilePreview(null)} />
          <div className="relative z-10 w-full max-w-5xl max-h-[85vh] bg-white dark:bg-gray-950 border border-gray-200 dark:border-gray-800 rounded-xl shadow-2xl overflow-hidden flex flex-col">
            <div className="flex items-center justify-between px-5 py-3 border-b border-gray-200 dark:border-gray-800">
              <div>
                <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">Backup File Preview</p>
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  {restoreFilePreview.nodeName} · <span className="font-mono">{restoreFilePreview.relativePath}</span>
                </p>
              </div>
              <button type="button" onClick={() => setRestoreFilePreview(null)} className="rounded-full p-2 text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-800" aria-label="Close file preview">
                <X size={18} />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto bg-gray-50 dark:bg-gray-900/40 p-4">
              {restoreFilePreview.loading ? (
                <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
                  <Loader2 size={16} className="animate-spin" /> Loading file...
                </div>
              ) : restoreFilePreviewError ? (
                <p className="text-sm text-red-600 dark:text-red-400">{restoreFilePreviewError}</p>
              ) : (
                <FileViewer content={restoreFilePreview.content} language={resolveFilePreviewLanguage(restoreFilePreview.relativePath)} />
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

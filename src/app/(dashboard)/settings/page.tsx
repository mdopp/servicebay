'use client';

import { useState, useEffect, useCallback } from 'react';
import { Save, Mail, Plus, Trash2, RefreshCw, Download, Clock, GitBranch, Loader2, CheckCircle2, XCircle, Server, Key, Terminal, Edit2, ShieldAlert, WifiOff, Globe, HardDrive, RotateCcw } from 'lucide-react';
import { useToast } from '@/providers/ToastProvider';
import PageHeader from '@/components/PageHeader';
import ConfirmModal from '@/components/ConfirmModal';
import SSHSetupModal from '@/components/SSHSetupModal';
import LogLevelControl from '@/components/LogLevelControl';
import { AppConfig } from '@/lib/config';
import { getNodes, createNode, editNode, deleteNode, setNodeAsDefault } from '@/app/actions/nodes';
import { checkConnection, checkFullConnection } from '@/app/actions/ssh';
import { PodmanConnection } from '@/lib/nodes';
import type { BackupLogEntry, BackupLogStatus } from '@/lib/systemBackup';

type TemplateSettingsSchemaEntry = {
  default: string;
  description?: string;
  required?: boolean;
};

const DEFAULT_TEMPLATE_SCHEMA: Record<string, TemplateSettingsSchemaEntry> = {
  DATA_DIR: {
    default: '/mnt/data',
    description: 'Base directory used by all templates for persistent data. Applies to new deployments.',
    required: true
  }
};

interface AppUpdateStatus {
  hasUpdate: boolean;
  current: string;
  latest: {
    version: string;
    url: string;
    date: string;
    notes: string;
  } | null;
  config: {
    autoUpdate: {
      enabled: boolean;
      schedule: string;
      channel?: 'stable' | 'test' | 'dev';
    }
  };
}

interface SystemBackupEntrySummary {
  fileName: string;
  createdAt: string;
  size: number;
}

type BackupStreamEvent =
  | { type: 'log'; entry: BackupLogEntry }
  | { type: 'done'; backup: SystemBackupEntrySummary }
  | { type: 'error'; message: string };

type SettingsOverrides = Partial<{
  templateValues: Record<string, string>;
  registriesEnabled: boolean;
  registries: { name: string; url: string; branch?: string }[];
}> & {
  email?: Partial<{
    enabled: boolean;
    host: string;
    port: number;
    secure: boolean;
    user: string;
    pass: string;
    from: string;
    to: string[];
  }>;
};

const LOG_STATUS_BADGES: Record<BackupLogStatus, string> = {
  info: 'text-slate-600 bg-slate-100 dark:text-slate-300 dark:bg-slate-800',
  success: 'text-emerald-700 bg-emerald-100 dark:text-emerald-300 dark:bg-emerald-900/30',
  error: 'text-red-700 bg-red-100 dark:text-red-300 dark:bg-red-900/30',
  skip: 'text-amber-700 bg-amber-100 dark:text-amber-300 dark:bg-amber-900/30'
};

const LOG_STATUS_DOTS: Record<BackupLogStatus, string> = {
  info: 'bg-slate-400',
  success: 'bg-emerald-500',
  error: 'bg-red-500',
  skip: 'bg-amber-500'
};

const formatBytes = (size: number): string => {
  if (!Number.isFinite(size) || size <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = size;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  const precision = value >= 10 ? 0 : 1;
  return `${value.toFixed(precision)} ${units[unitIndex]}`;
};

export default function SettingsPage() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [configReady, setConfigReady] = useState(false);
  const { addToast } = useToast();

  // App Update State
  const [appUpdate, setAppUpdate] = useState<AppUpdateStatus | null>(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [isUpdateModalOpen, setIsUpdateModalOpen] = useState(false);
  
  // Update Progress State
  const [updateStatus, setUpdateStatus] = useState<'idle' | 'updating' | 'restarting' | 'error' | 'success'>('idle');
  const [updateProgress, setUpdateProgress] = useState(0);
  const [updateMessage, setUpdateMessage] = useState('');
  const [updateError, setUpdateError] = useState('');

  // Backup State
  const [backups, setBackups] = useState<SystemBackupEntrySummary[]>([]);
  const [backupsLoading, setBackupsLoading] = useState(true);
  const [creatingBackup, setCreatingBackup] = useState(false);
  const [restoreTarget, setRestoreTarget] = useState<SystemBackupEntrySummary | null>(null);
  const [restoringBackup, setRestoringBackup] = useState(false);
  const [backupLog, setBackupLog] = useState<BackupLogEntry[]>([]);
  const [backupStatus, setBackupStatus] = useState<'idle' | 'running' | 'success' | 'error'>('idle');
  const [deleteTarget, setDeleteTarget] = useState<SystemBackupEntrySummary | null>(null);
  const [deletingBackup, setDeletingBackup] = useState(false);

  // Email Form State
  const [emailEnabled, setEmailEnabled] = useState(false);
  const [emailHost, setEmailHost] = useState('');
  const [emailPort, setEmailPort] = useState(587);
  const [emailSecure, setEmailSecure] = useState(false);
  const [emailUser, setEmailUser] = useState('');
  const [emailPass, setEmailPass] = useState('');
  const [emailFrom, setEmailFrom] = useState('');
  const [emailRecipients, setEmailRecipients] = useState<string[]>([]);
  const [newRecipient, setNewRecipient] = useState('');

  // Registry State
  const [registriesEnabled, setRegistriesEnabled] = useState(true);
  const [registries, setRegistries] = useState<{name: string, url: string, branch?: string}[]>([]);
  const [newRegName, setNewRegName] = useState('');
  const [newRegUrl, setNewRegUrl] = useState('');
  const [newRegBranch, setNewRegBranch] = useState('');

  // Template Settings
  const [templateSchema, setTemplateSchema] = useState<Record<string, TemplateSettingsSchemaEntry>>(DEFAULT_TEMPLATE_SCHEMA);
  const [templateValues, setTemplateValues] = useState<Record<string, string>>({ DATA_DIR: DEFAULT_TEMPLATE_SCHEMA.DATA_DIR.default });
  const [newVarKey, setNewVarKey] = useState('');
  const [newVarValue, setNewVarValue] = useState('');

  // Nodes State
  const [nodes, setNodes] = useState<PodmanConnection[]>([]);
  const [newNodeName, setNewNodeName] = useState('');
  const [newNodeDest, setNewNodeDest] = useState('');
  const [newNodeIdentity, setNewNodeIdentity] = useState('/app/data/ssh/id_rsa');
  const [addingNode, setAddingNode] = useState(false);
  const [editingNode, setEditingNode] = useState<string | null>(null);
  const [nodeDraft, setNodeDraft] = useState<{ name: string; destination: string; identity: string }>({
    name: '',
    destination: '',
    identity: '/app/data/ssh/id_rsa'
  });
  const [savingNode, setSavingNode] = useState(false);
  const [nodeHealth, setNodeHealth] = useState<Record<string, { loading: boolean; online: boolean; auth: boolean; error?: string }>>({});

  // SSH Setup Modal
  const [isSSHModalOpen, setIsSSHModalOpen] = useState(false);
  const [sshModalDefaults, setSshModalDefaults] = useState({ host: '', port: 22, user: 'root' });

  // Update sshModalDefaults when adding node inputs change, to have valid defaults if user clicks the sidebar button manually
  useEffect(() => {
    let host = '', port = 22, user = 'root';
    try {
        if (newNodeDest) {
            const urlStr = newNodeDest.includes('://') ? newNodeDest : `ssh://${newNodeDest}`;
            const url = new URL(urlStr);
            host = url.hostname;
            port = url.port ? parseInt(url.port) : 22;
            user = url.username || 'root';
            setSshModalDefaults({ host, port, user });
        }
    } catch {
        // Ignore parse error
    }
  }, [newNodeDest]);

  const fetchConfig = useCallback(async () => {
    try {
      const [res, updateRes] = await Promise.all([
        fetch('/api/settings'),
        fetch('/api/system/update')
      ]);
      
      if (!res.ok) throw new Error('Failed to fetch config');
      const data: AppConfig = await res.json();
      
      if (updateRes.ok) {
        setAppUpdate(await updateRes.json());
      } else if (data.autoUpdate) {
        // Fallback if update API fails but we have config
        setAppUpdate({
            hasUpdate: false,
            current: 'Unknown',
            latest: null,
            config: { autoUpdate: data.autoUpdate }
        });
      }
      
      // Initialize form
      if (data.registries) {
        if (Array.isArray(data.registries)) {
            setRegistries(data.registries);
            setRegistriesEnabled(true);
        } else {
            setRegistries(data.registries.items);
            setRegistriesEnabled(data.registries.enabled);
        }
      }

      const response = data as AppConfig & { templateSettingsSchema?: Record<string, TemplateSettingsSchemaEntry> };
      const schema = response.templateSettingsSchema || DEFAULT_TEMPLATE_SCHEMA;
      const defaults = Object.fromEntries(Object.entries(schema).map(([k, v]) => [k, v.default ?? ''])) as Record<string, string>;
      const persisted = (data as AppConfig).templateSettings || {};
      const merged = { ...defaults, ...persisted };
      setTemplateSchema(schema);
      setTemplateValues(merged);

      // Fetch nodes
      try {
        const nodesList = await getNodes();
        setNodes(nodesList);
      } catch (e) {
        console.error('Failed to fetch nodes', e);
      }

      if (data.notifications?.email) {
        const e = data.notifications.email;
        setEmailEnabled(e.enabled);
        setEmailHost(e.host);
        setEmailPort(e.port);
        setEmailSecure(e.secure);
        setEmailUser(e.user);
        setEmailPass(e.pass);
        setEmailFrom(e.from);
        setEmailRecipients(e.to || []);
      }

      setConfigReady(true);
    } catch (error) {
      console.error(error);
      addToast('error', 'Failed to load settings');
    } finally {
      setLoading(false);
    }
  }, [addToast]);

  useEffect(() => {
    fetchConfig();
  }, [fetchConfig]);

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

  useEffect(() => {
    fetchBackups();
  }, [fetchBackups]);

  const persistSettings = useCallback(async (overrides?: SettingsOverrides) => {
    if (!configReady || saving) return;
    setSaving(true);
    try {
      const templateDefaults = Object.fromEntries(
        Object.entries(templateSchema).map(([key, meta]) => [key, meta.default ?? ''])
      ) as Record<string, string>;
      const effectiveTemplateValues = overrides?.templateValues ?? templateValues;
      const enforcedTemplateValues = {
        ...templateDefaults,
        ...effectiveTemplateValues
      } as Record<string, string>;

      const effectiveRegistries = overrides?.registries ?? registries;
      const effectiveRegistriesEnabled = overrides?.registriesEnabled ?? registriesEnabled;

      const emailOverrides = overrides?.email ?? {};
      const emailConfig = {
        enabled: emailOverrides.enabled ?? emailEnabled,
        host: emailOverrides.host ?? emailHost,
        port: emailOverrides.port ?? emailPort,
        secure: emailOverrides.secure ?? emailSecure,
        user: emailOverrides.user ?? emailUser,
        pass: emailOverrides.pass ?? emailPass,
        from: emailOverrides.from ?? emailFrom,
        to: emailOverrides.to ?? emailRecipients
      };

      const newConfig: Partial<AppConfig> = {
        templateSettings: enforcedTemplateValues,
        registries: {
          enabled: effectiveRegistriesEnabled,
          items: effectiveRegistries
        },
        notifications: {
          email: emailConfig
        }
      };

      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newConfig)
      });

      if (!res.ok) {
        const errorBody = await res.json().catch(() => ({}));
        throw new Error(errorBody.error || 'Failed to save settings');
      }

      addToast('success', 'Settings saved', 'Your changes were stored.');
    } catch (error) {
      console.error(error);
      addToast('error', 'Failed to save settings', error instanceof Error ? error.message : undefined);
    } finally {
      setSaving(false);
    }
  }, [addToast, configReady, emailEnabled, emailFrom, emailHost, emailPass, emailPort, emailRecipients, emailSecure, emailUser, registries, registriesEnabled, saving, templateSchema, templateValues]);

  const handleAddRecipient = () => {
    if (newRecipient && !emailRecipients.includes(newRecipient)) {
      const updatedRecipients = [...emailRecipients, newRecipient];
      setEmailRecipients(updatedRecipients);
      setNewRecipient('');
      void persistSettings({ email: { to: updatedRecipients } });
    }
  };

  const handleRemoveRecipient = (email: string) => {
    const updatedRecipients = emailRecipients.filter(e => e !== email);
    setEmailRecipients(updatedRecipients);
    void persistSettings({ email: { to: updatedRecipients } });
  };

  const handleEmailEnabledToggle = (enabled: boolean) => {
    setEmailEnabled(enabled);
    void persistSettings({ email: { enabled } });
  };

  const handleEmailSecureToggle = (secure: boolean) => {
    setEmailSecure(secure);
    void persistSettings({ email: { secure } });
  };

  const handleAddNode = () => {
    void submitNode('create', {
      name: newNodeName.trim(),
      destination: newNodeDest.trim(),
      identity: newNodeIdentity.trim()
    });
  };

  const startEditingNode = (node: PodmanConnection) => {
    setEditingNode(node.Name);
    setNodeDraft({ name: node.Name, destination: node.URI, identity: node.Identity });
  };

  const cancelInlineEdit = () => {
    setEditingNode(null);
    setNodeDraft({ name: '', destination: '', identity: '/app/data/ssh/id_rsa' });
  };

  const handleInlineSave = () => {
    if (!editingNode) return;
    void submitNode('edit', {
      originalName: editingNode,
      name: nodeDraft.name.trim(),
      destination: nodeDraft.destination.trim(),
      identity: nodeDraft.identity.trim()
    });
  };

  const parseDestination = (destination: string) => {
    let host = '', port = 22, user = 'root';
    try {
      const urlStr = destination.includes('://') ? destination : `ssh://${destination}`;
      const parsed = new URL(urlStr);
      host = parsed.hostname;
      port = parsed.port ? parseInt(parsed.port) : 22;
      user = parsed.username || 'root';
    } catch {
      // ignore
    }
    return { host, port, user };
  };

  const submitNode = useCallback(async (mode: 'create' | 'edit', payload: { name: string; destination: string; identity: string; originalName?: string }) => {
    if (!payload.name || !payload.destination || !payload.identity) return false;

    const { host, port, user } = parseDestination(payload.destination);
    const setBusy = mode === 'create' ? setAddingNode : setSavingNode;
    setBusy(true);

    if (host) {
      const check = await checkConnection(host, port);
      if (!check.success || !check.isOpen) {
        addToast('error', 'Connection Failed', `Could not connect to ${host}:${port}. Is the server reachable?`);
        setBusy(false);
        return false;
      }
    }

    try {
      const result = mode === 'edit' && payload.originalName
        ? await editNode(payload.originalName, payload.name, payload.destination, payload.identity)
        : await createNode(payload.name, payload.destination, payload.identity);

      if (result.success) {
        setNodes(await getNodes());
        if (mode === 'create') {
          setNewNodeName('');
          setNewNodeDest('');
          setNewNodeIdentity('/app/data/ssh/id_rsa');
        } else {
          setEditingNode(null);
          setNodeDraft({ name: '', destination: '', identity: '/app/data/ssh/id_rsa' });
        }

        const warning = (result as { warning?: string }).warning;
        if (warning) {
          if (warning.includes('timed out') || warning.includes('Permission denied') || warning.includes('password') || warning.includes('publickey')) {
            addToast('warning', 'SSH Connection Failed', 'The node was saved, but we could not connect. It seems password-less SSH is not configured.');
            if (host) {
              setSshModalDefaults({ host, port, user });
              setIsSSHModalOpen(true);
            }
          } else {
            addToast('warning', mode === 'edit' ? 'Node updated with warning' : 'Node added with warning', warning);
          }
        } else {
          addToast('success', mode === 'edit' ? 'Node updated' : 'Node added');
        }

        return true;
      }

      addToast('error', mode === 'edit' ? 'Failed to update node' : 'Failed to add node', (result as { error?: string }).error);
      return false;
    } catch (error) {
      addToast('error', mode === 'edit' ? 'Failed to update node' : 'Failed to add node', error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      setBusy(false);
    }
  }, [addToast, checkConnection, editNode, createNode, getNodes, setSshModalDefaults]);

  const handleAddRegistry = () => {
    if (newRegName && newRegUrl) {
      const updatedRegistries = [...registries, { name: newRegName, url: newRegUrl, branch: newRegBranch || undefined }];
      setRegistries(updatedRegistries);
      setNewRegName('');
      setNewRegUrl('');
      setNewRegBranch('');
      void persistSettings({ registries: updatedRegistries });
    }
  };

  const handleRemoveRegistry = (name: string) => {
    const updatedRegistries = registries.filter(r => r.name !== name);
    setRegistries(updatedRegistries);
    void persistSettings({ registries: updatedRegistries });
  };

  const handleRegistriesToggle = (enabled: boolean) => {
    setRegistriesEnabled(enabled);
    void persistSettings({ registriesEnabled: enabled });
  };

  const handleTemplateValueChange = (key: string, value: string) => {
    setTemplateValues(prev => ({ ...prev, [key]: value }));
  };

  const handleAddTemplateVariable = () => {
    if (!newVarKey.trim()) return;
    const key = newVarKey.trim();
    const updated = { ...templateValues, [key]: newVarValue };
    setTemplateValues(updated);
    setNewVarKey('');
    setNewVarValue('');
    void persistSettings({ templateValues: updated });
  };

  const handleRemoveTemplateVariable = (key: string) => {
    const meta = templateSchema[key];
    if (meta?.required) return;
    setTemplateValues(prev => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { [key]: _removed, ...rest } = prev;
      void persistSettings({ templateValues: rest });
      return rest;
    });
  };

  const checkHealth = useCallback(async (nodeName: string) => {
    setNodeHealth(prev => ({ ...prev, [nodeName]: { loading: true, online: false, auth: false } }));
    
    const node = nodes.find(n => n.Name === nodeName);
    if (!node) return;
    
    // Quick local check
    if (node.URI === 'local') {
         setNodeHealth(prev => ({ ...prev, [nodeName]: { loading: false, online: true, auth: true } }));
         return;
    }

    try {
      let host = '', port = 22, user = 'root';
      
      if (node.URI.startsWith('ssh://')) {
          const url = new URL(node.URI);
          host = url.hostname;
          port = url.port ? parseInt(url.port) : 22;
          user = url.username || 'root';
      } else {
           const parts = node.URI.split('@');
           if (parts.length === 2) {
               user = parts[0];
               host = parts[1];
           } else {
               host = node.URI;
           }
      }

      const res = await checkFullConnection(host, port, user, node.Identity);
      
      setNodeHealth(prev => ({ 
         ...prev, 
         [nodeName]: { 
             loading: false, 
             online: res.success || (res.stage === 'auth'), 
             auth: res.success,
             error: res.error 
         } 
      }));
    } catch (e) {
       setNodeHealth(prev => ({ ...prev, [nodeName]: { loading: false, online: false, auth: false, error: String(e) } }));
    }
  }, [nodes]);

  useEffect(() => {
    if (nodes.length > 0) {
        nodes.forEach(n => {
            // Only check if not already checked or if previously failed/loading (optional)
            // Ideally only check on mount or when nodes change
            if (!nodeHealth[n.Name]) checkHealth(n.Name);
        });
    }
  }, [nodes, checkHealth, nodeHealth]);

  const handleDeleteNode = async (name: string) => {
    const res = await deleteNode(name);
    if (res.success) {
      setNodes(await getNodes());
      addToast('success', 'Node removed');
    } else {
      addToast('error', 'Failed to remove node');
    }
  };

  const handleSetDefaultNode = async (name: string) => {
    const res = await setNodeAsDefault(name);
    if (res.success) {
      setNodes(await getNodes());
      addToast('success', 'Default node updated');
    } else {
      addToast('error', 'Failed to set default node');
    }
  };

  const handleCheckUpdate = async () => {
    setCheckingUpdate(true);
    try {
        const res = await fetch('/api/system/update');
        if (res.ok) {
            const data = await res.json();
            setAppUpdate(data);
            const latestVer = data.latest?.version || 'Unknown';
            if (data.hasUpdate) {
                addToast('success', 'Update available', `Version ${latestVer} is available.`);
            } else {
                addToast('info', 'System up to date', `You are using the latest version (${latestVer}).`);
            }
        } else {
             const errorData = await res.json().catch(() => ({}));
             const errorMessage = errorData.error || `Server error (${res.status})`;
             throw new Error(errorMessage);
        }
    } catch (e) {
        console.error(e);
        const msg = e instanceof Error ? e.message : 'Unknown error';
        addToast('error', 'Update Check Failed', msg);
    } finally {
        setCheckingUpdate(false);
    }
  };

  const handleAppUpdate = () => {
    if (!appUpdate?.latest) return;
    setIsUpdateModalOpen(true);
  };

  const confirmAppUpdate = async () => {
    if (!appUpdate?.latest) return;
    
    setIsUpdateModalOpen(false);
    setUpdateStatus('updating');
    setUpdateProgress(0);
    setUpdateMessage('Initializing update...');
    
    try {
      // Connect to socket for progress updates
      const { io } = await import('socket.io-client');
      const socket = io();

      socket.on('update:progress', (data: { step: string, progress: number, message: string }) => {
          setUpdateProgress(data.progress);
          setUpdateMessage(data.message);
          if (data.step === 'restart') {
              setUpdateStatus('restarting');
              setUpdateMessage('Service is restarting. This page will reload automatically...');
              
              // Wait a bit then try to reload
              setTimeout(() => {
                  window.location.reload();
              }, 5000);
          }
      });

      socket.on('update:error', (data: { error: string }) => {
          setUpdateStatus('error');
          setUpdateError(data.error);
          socket.disconnect();
      });

      const res = await fetch('/api/system/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'update', version: appUpdate.latest.version })
      });
      
      if (!res.ok) {
        throw new Error('Update failed to start');
      }
    } catch (e) {
      setUpdateStatus('error');
      setUpdateError(e instanceof Error ? e.message : 'Unknown error');
    }
  };

  const toggleAutoUpdate = async () => {
    if (!appUpdate) return;
    const newState = !appUpdate.config.autoUpdate.enabled;
    
    try {
      const res = await fetch('/api/system/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
            action: 'configure', 
            autoUpdate: { enabled: newState } 
        })
      });
      
      if (res.ok) {
        const data = await res.json();
        setAppUpdate(prev => prev ? { ...prev, config: data.config } : null);
        addToast('success', 'Settings saved', `Auto-update ${newState ? 'enabled' : 'disabled'}.`);
      }
    } catch {
      addToast('error', 'Error', 'Failed to save settings.');
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

  const handleRestoreRequest = (entry: SystemBackupEntrySummary) => {
    setRestoreTarget(entry);
  };

  const confirmRestoreBackup = async () => {
    if (!restoreTarget || restoringBackup) return;
    setRestoringBackup(true);
    try {
      const res = await fetch('/api/settings/backups/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileName: restoreTarget.fileName })
      });
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.error || 'Unable to restore backup');
      }
      addToast('success', 'Backup restored', 'ServiceBay config and managed services were restored.');
      await fetchBackups();
    } catch (error) {
      console.error(error);
      const message = error instanceof Error ? error.message : 'Unknown error';
      addToast('error', 'Restore failed', message);
    } finally {
      setRestoringBackup(false);
      setRestoreTarget(null);
    }
  };

  const closeRestoreModal = () => {
    if (restoringBackup) return;
    setRestoreTarget(null);
  };

  const confirmDeleteBackup = async () => {
    if (!deleteTarget || deletingBackup) return;
    setDeletingBackup(true);
    try {
      const res = await fetch('/api/settings/backups', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileName: deleteTarget.fileName })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || 'Unable to delete backup');
      }
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

  if (loading) {
    return <div className="p-8 text-center text-gray-500">Loading settings...</div>;
  }

  return (
    <div className="h-full overflow-y-auto space-y-6">
      <PageHeader 
        title="Settings" 
        showBack={false}
        actions={
          <span className="text-sm text-gray-500 dark:text-gray-400 inline-flex items-center gap-2">
            {saving ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Saving changes…
              </>
            ) : (
              'All changes saved'
            )}
          </span>
        }
      />

      <div className="px-4 pb-8 w-full space-y-6">
        {/* ServiceBay Updates */}
        {appUpdate && (
            <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm overflow-hidden w-full">
                <div className="p-4 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 flex items-center gap-3">
                  <div className="p-2 bg-purple-100 dark:bg-purple-900/30 rounded-lg text-purple-600 dark:text-purple-400">
                    <RefreshCw size={20} className={(updateStatus === 'updating') || checkingUpdate ? 'animate-spin' : ''} />
                  </div>
                  <div>
                    <h3 className="font-bold text-gray-900 dark:text-white">ServiceBay Updates</h3>
                    <p className="text-xs text-gray-500 dark:text-gray-400">Manage application updates</p>
                  </div>
                    <div className="ml-auto flex items-center gap-4">
                        <div className="flex items-center gap-2 text-sm">
                            <span className="text-gray-500 dark:text-gray-400">Channel:</span>
                            <select 
                                value={appUpdate.config.autoUpdate.channel || 'stable'}
                                onChange={async (e) => {
                                    const newChannel = e.target.value as 'stable' | 'test' | 'dev';
                                    try {
                                        const res = await fetch('/api/system/update', {
                                            method: 'POST',
                                            headers: { 'Content-Type': 'application/json' },
                                            body: JSON.stringify({ 
                                                action: 'configure', 
                                                autoUpdate: { 
                                                    enabled: appUpdate.config.autoUpdate.enabled,
                                                    channel: newChannel
                                                } 
                                            })
                                        });
                                        if (res.ok) {
                                            const data = await res.json();
                                            setAppUpdate(prev => prev ? { ...prev, config: data.config } : null);
                                            addToast('success', 'Release channel updated', `Switched to ${newChannel} channel. Check for updates to apply.`);
                                        }
                                    } catch {
                                        addToast('error', 'Failed to update release channel');
                                    }
                                }}
                                className="bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 rounded px-2 py-1 text-xs focus:ring-2 focus:ring-purple-500 focus:border-transparent outline-none cursor-pointer"
                            >
                                <option value="stable">Stable</option>
                                <option value="test">Test</option>
                                <option value="dev">Dev</option>
                            </select>
                        </div>
                        <div className="h-4 w-px bg-gray-300 dark:bg-gray-600"></div>
                        <button
                            onClick={handleCheckUpdate}
                            disabled={checkingUpdate || (updateStatus === 'updating')}
                            className="text-xs text-purple-600 dark:text-purple-400 hover:underline disabled:opacity-50"
                        >
                            {checkingUpdate ? 'Checking...' : 'Check Now'}
                        </button>
                        <div className="h-4 w-px bg-gray-300 dark:bg-gray-600"></div>
                        <label className="relative inline-flex items-center cursor-pointer" title="Enable Auto-Updates">
                            <input 
                                type="checkbox" 
                                className="sr-only peer" 
                                checked={appUpdate.config.autoUpdate.enabled}
                                onChange={toggleAutoUpdate}
                            />
                            <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-purple-300 dark:peer-focus:ring-purple-800 rounded-full peer dark:bg-gray-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-gray-600 peer-checked:bg-purple-600"></div>
                        </label>
                    </div>
                </div>
                <div className="p-6">
                    <div className="flex flex-col md:flex-row gap-6 items-start md:items-center justify-between">
                        <div className="space-y-1">
                            <div className="flex items-center gap-2">
                                <span className="text-sm text-gray-500 dark:text-gray-400">Current Version:</span>
                                <span className="font-mono font-medium text-gray-900 dark:text-white">{appUpdate.current}</span>
                            </div>
                            {appUpdate.hasUpdate && appUpdate.latest ? (
                                <div className="flex items-center gap-2 text-green-600 dark:text-green-400">
                                    <Download size={16} />
                                    <span className="text-sm font-medium">New version available: {appUpdate.latest.version}</span>
                                </div>
                            ) : (
                                <div className="flex items-center gap-2 text-gray-500 dark:text-gray-400">
                                    <Clock size={16} />
                                    <span className="text-sm">You are on the latest version</span>
                                </div>
                            )}
                        </div>
                        
                        {appUpdate.hasUpdate && appUpdate.latest && (
                            <button 
                                onClick={handleAppUpdate}
                                disabled={updateStatus === 'updating'}
                                className="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors shadow-sm flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                <Download size={18} />
                                {updateStatus === 'updating' ? 'Updating...' : 'Update Now'}
                            </button>
                        )}
                    </div>
                    
                    {appUpdate.hasUpdate && appUpdate.latest && appUpdate.latest.notes && (
                        <div className="mt-4 p-4 bg-gray-50 dark:bg-gray-900/50 rounded-lg border border-gray-200 dark:border-gray-700">
                            <h4 className="text-sm font-bold text-gray-900 dark:text-white mb-2">Release Notes</h4>
                            <p className="text-sm text-gray-600 dark:text-gray-300 whitespace-pre-wrap">{appUpdate.latest.notes}</p>
                        </div>
                    )}
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
                        <Loader2 className="w-3 h-3 animate-spin" />
                        Backup in progress
                      </span>
                    )}
                    {backupStatus === 'success' && (
                      <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-300">
                        <CheckCircle2 className="w-3 h-3" />
                        Latest run completed
                      </span>
                    )}
                    {backupStatus === 'error' && (
                      <span className="inline-flex items-center gap-1 text-red-600 dark:text-red-300">
                        <XCircle className="w-3 h-3" />
                        Last run failed
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
                            <button
                              onClick={() => handleDownloadBackup(backup.fileName)}
                              className="text-xs px-3 py-1.5 rounded-md border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors flex items-center gap-1"
                            >
                              <Download size={14} />
                              Download
                            </button>
                            <button
                              onClick={() => handleRestoreRequest(backup)}
                              className="text-xs px-3 py-1.5 rounded-md border border-amber-300 text-amber-700 dark:text-amber-300 dark:border-amber-700 hover:bg-amber-50 dark:hover:bg-amber-900/20 transition-colors flex items-center gap-1"
                            >
                              <RotateCcw size={14} />
                              Restore
                            </button>
                                <button
                                  onClick={() => setDeleteTarget(backup)}
                                  disabled={deletingBackup}
                                  className="text-xs px-3 py-1.5 rounded-md border border-red-200 text-red-600 dark:text-red-400 dark:border-red-700 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors flex items-center gap-1 disabled:opacity-60"
                                >
                                  <Trash2 size={14} />
                                  Delete
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
                          <Loader2 className="w-3 h-3 animate-spin" />
                          Streaming logs
                        </span>
                      )}
                      {backupStatus === 'error' && (
                        <span className="inline-flex items-center gap-1 text-xs text-red-600 dark:text-red-300">
                          <XCircle className="w-3 h-3" />
                          Check details below
                        </span>
                      )}
                      {backupStatus === 'success' && backupLog.length > 0 && (
                        <span className="inline-flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-300">
                          <CheckCircle2 className="w-3 h-3" />
                          Completed
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
                                <span className={`px-2 py-0.5 rounded ${LOG_STATUS_BADGES[entry.status] ?? LOG_STATUS_BADGES.info}`}>
                                  {entry.status.toUpperCase()}
                                </span>
                              </div>
                              <p className="text-gray-700 dark:text-gray-200">{entry.message}</p>
                              {entry.target && (
                                <p className="text-[10px] font-mono text-gray-500 dark:text-gray-400 break-all">{entry.target}</p>
                              )}
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                )}
          </div>
        </div>

        {/* Template Settings Section */}
        <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm overflow-hidden w-full">
          <div className="p-4 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 flex items-center gap-3">
            <div className="p-2 bg-indigo-100 dark:bg-indigo-900/30 rounded-lg text-indigo-600 dark:text-indigo-400">
              <Server size={20} />
            </div>
            <div>
              <h3 className="font-bold text-gray-900 dark:text-white">Template Settings</h3>
              <p className="text-xs text-gray-500 dark:text-gray-400">Define global variables used when rendering new stacks (e.g., DATA_DIR). Updates affect future deployments only.</p>
            </div>
          </div>
          <div className="p-6 space-y-6">
            <div className="space-y-4">
              <div className="p-4 border border-gray-200 dark:border-gray-700 rounded-lg bg-gradient-to-r from-indigo-50 via-white to-white dark:from-gray-900 dark:via-gray-900 dark:to-gray-900 flex flex-col md:flex-row md:items-center md:gap-4">
                <div className="flex-1">
                  <p className="text-sm font-semibold text-gray-900 dark:text-white mb-2">Add Variable</p>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <input
                      type="text"
                      value={newVarKey}
                      onChange={e => setNewVarKey(e.target.value)}
                      disabled={saving}
                      className="w-full p-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white focus:ring-2 focus:ring-indigo-500 outline-none"
                      placeholder="VAR_NAME"
                    />
                    <input
                      type="text"
                      value={newVarValue}
                      onChange={e => setNewVarValue(e.target.value)}
                      disabled={saving}
                      className="w-full p-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white focus:ring-2 focus:ring-indigo-500 outline-none"
                      placeholder="value"
                    />
                  </div>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">Variables appear below immediately after you add them.</p>
                </div>
                <button
                  onClick={handleAddTemplateVariable}
                  disabled={saving || !newVarKey.trim()}
                  className="w-full md:w-auto px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors shadow-sm flex items-center gap-2 justify-center disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Plus size={16} />
                  Add Variable
                </button>
              </div>

              {Object.keys(templateValues).sort().map(key => {
                const meta = templateSchema[key];
                const isRequired = meta?.required;
                return (
                  <div key={key} className="p-4 border border-gray-200 dark:border-gray-700 rounded-lg bg-gray-50 dark:bg-gray-900 flex flex-col md:flex-row md:items-center md:gap-4">
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="font-semibold text-gray-900 dark:text-white">{key}</span>
                        {isRequired && (
                          <span className="text-xs px-2 py-0.5 rounded bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-200">Required</span>
                        )}
                      </div>
                      <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">
                        {meta?.description || 'Template variable'}
                        {meta?.default ? ` (default: ${meta.default})` : ''}
                      </p>
                      <input
                        type="text"
                        value={templateValues[key] || ''}
                        onChange={e => handleTemplateValueChange(key, e.target.value)}
                        onBlur={() => persistSettings()}
                        disabled={saving}
                        className="w-full p-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white focus:ring-2 focus:ring-indigo-500 outline-none"
                        placeholder={meta?.default || ''}
                      />
                    </div>
                    {!isRequired && (
                      <button
                        onClick={() => handleRemoveTemplateVariable(key)}
                        disabled={saving}
                        className="mt-3 md:mt-0 text-gray-400 hover:text-red-500 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                        aria-label={`Remove ${key}`}
                      >
                        <Trash2 size={18} />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>

          </div>
        </div>


  {/* System Connections (Nodes) */}
        <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm overflow-hidden w-full">
            <div className="p-4 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 flex items-center gap-3">
                <div className="p-2 bg-blue-100 dark:bg-blue-900/30 rounded-lg text-blue-600 dark:text-blue-400">
                    <Server size={20} />
                </div>
                <div>
                    <h3 className="font-bold text-gray-900 dark:text-white">System Connections</h3>
                    <p className="text-xs text-gray-500 dark:text-gray-400">Manage remote Podman nodes</p>
                </div>
                <div className="ml-auto">
                    <button 
                        onClick={() => setIsSSHModalOpen(true)}
                        className="text-xs flex items-center gap-1 text-blue-600 dark:text-blue-400 hover:underline"
                    >
                        <Terminal size={14} />
                        Setup SSH Keys
                    </button>
                </div>
            </div>
            
            <div className="p-6 space-y-6">
                <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-3 flex gap-3 items-start">
                    <div className="mt-0.5 text-blue-600 dark:text-blue-400">
                        <Key size={16} />
                    </div>
                    <div className="text-sm text-blue-800 dark:text-blue-200">
                        <p className="font-medium mb-1">SSH Access Required</p>
                        <p className="opacity-90 text-xs">
                            ServiceBay requires password-less SSH access to remote nodes. 
                            If you haven&apos;t set this up, use the 
                            <button onClick={() => setIsSSHModalOpen(true)} className="mx-1 underline font-medium hover:text-blue-600">Setup SSH Keys</button> 
                            tool to copy your public key to the server.
                        </p>
                    </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-12 gap-4 items-end mb-6" id="node-form">
                    <div className="md:col-span-3">
                        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Name</label>
                        <input 
                            type="text" 
                            value={newNodeName}
                        onChange={e => setNewNodeName(e.target.value)}
                        disabled={addingNode}
                            className="w-full p-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none disabled:opacity-50"
                            placeholder="my-node"
                        />
                    </div>
                    <div className="md:col-span-5">
                        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Destination (SSH)</label>
                        <input 
                            type="text" 
                            value={newNodeDest}
                        onChange={e => setNewNodeDest(e.target.value)}
                            disabled={addingNode}
                            className="w-full p-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none disabled:opacity-50 disabled:cursor-not-allowed"
                            placeholder="ssh://user@host:port"
                        />
                    </div>
                    <div className="md:col-span-3">
                        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Identity File</label>
                        <div className="relative">
                            <Key className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                            <input 
                                type="text" 
                                value={newNodeIdentity}
                              onChange={e => setNewNodeIdentity(e.target.value)}
                                disabled={addingNode}
                                className="w-full pl-9 pr-2 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none disabled:opacity-50 disabled:cursor-not-allowed"
                                placeholder="/app/data/ssh/id_rsa"
                            />
                        </div>
                    </div>
                    <div className="md:col-span-1 flex gap-2">
                        <button 
                            onClick={handleAddNode}
                            disabled={addingNode || !newNodeName.trim() || !newNodeDest.trim() || !newNodeIdentity.trim()}
                            className={`w-full p-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex justify-center items-center gap-2`}
                            title="Add Node"
                        >
                            {addingNode ? <Loader2 className="animate-spin" size={20} /> : <Plus size={20} />}
                        </button>
                    </div>
                </div>

                <div className="space-y-2">
                  {nodes.map(node => {
                    const health = nodeHealth[node.Name] || { loading: false, online: false, auth: false };
                    const isEditing = editingNode === node.Name;
                    const displayName = isEditing ? (nodeDraft.name || node.Name) : node.Name;
                    const inlineDisabled = savingNode || !nodeDraft.name.trim() || !nodeDraft.destination.trim() || !nodeDraft.identity.trim();

                    return (
                    <div key={node.Name} className={`flex flex-col gap-4 md:flex-row md:items-start md:justify-between p-4 rounded-lg border transition-colors ${isEditing ? 'bg-blue-50 border-blue-200 dark:bg-blue-900/20 dark:border-blue-800' : 'bg-gray-50 dark:bg-gray-900/50 border-gray-200 dark:border-gray-700'}`}>
                      <div className="flex-1 space-y-3">
                        <div className="flex items-center gap-3">
                          <div className={`w-2 h-2 rounded-full ${node.Default ? 'bg-green-500' : 'bg-gray-300 dark:bg-gray-600'}`} title={node.Default ? 'Default Node' : ''} />
                          <div>
                            <div className="font-medium text-gray-900 dark:text-white flex flex-wrap items-center gap-2">
                              {displayName}
                              {node.Default && <span className="text-[10px] bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400 px-1.5 py-0.5 rounded uppercase font-bold">Default</span>}
                              <div className="flex items-center gap-1 ml-1" title={health.error || (health.online ? (health.auth ? 'Online & Authenticated' : 'Online but Auth Failed') : 'Unreachable')}>
                                {health.loading ? (
                                  <Loader2 size={14} className="animate-spin text-gray-400" />
                                ) : health.online && health.auth ? (
                                  <div className="flex items-center text-green-500 gap-1 text-[10px] bg-white dark:bg-gray-800 px-1.5 py-0.5 rounded border border-gray-200 dark:border-gray-700 shadow-sm">
                                    <Globe size={10} />
                                    <span>Connected</span>
                                  </div>
                                ) : health.online && !health.auth ? (
                                  <div className="flex items-center text-yellow-500 gap-1 text-[10px] bg-white dark:bg-gray-800 px-1.5 py-0.5 rounded border border-gray-200 dark:border-gray-700 shadow-sm cursor-help">
                                    <ShieldAlert size={10} />
                                    <span>Auth Failed</span>
                                  </div>
                                ) : (
                                  <div className="flex items-center text-red-500 gap-1 text-[10px] bg-white dark:bg-gray-800 px-1.5 py-0.5 rounded border border-gray-200 dark:border-gray-700 shadow-sm cursor-help">
                                    <WifiOff size={10} />
                                    <span>Offline</span>
                                  </div>
                                )}
                              </div>
                            </div>
                            {!isEditing && <div className="text-xs text-gray-500 dark:text-gray-400 font-mono">{node.URI}</div>}
                          </div>
                        </div>

                        {isEditing && (
                          <div className="grid grid-cols-1 md:grid-cols-12 gap-3">
                            <div className="md:col-span-3">
                              <label className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">Name</label>
                              <input
                                type="text"
                                value={nodeDraft.name}
                                onChange={e => setNodeDraft(prev => ({ ...prev, name: e.target.value }))}
                                disabled={savingNode}
                                className="w-full p-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-blue-500 outline-none disabled:opacity-50 disabled:cursor-not-allowed"
                                placeholder="my-node"
                              />
                            </div>
                            <div className="md:col-span-5">
                              <label className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">Destination (SSH)</label>
                              <input
                                type="text"
                                value={nodeDraft.destination}
                                onChange={e => setNodeDraft(prev => ({ ...prev, destination: e.target.value }))}
                                disabled={savingNode}
                                className="w-full p-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-blue-500 outline-none disabled:opacity-50 disabled:cursor-not-allowed"
                                placeholder="ssh://user@host:port"
                              />
                            </div>
                            <div className="md:col-span-4">
                              <label className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">Identity File</label>
                              <input
                                type="text"
                                value={nodeDraft.identity}
                                onChange={e => setNodeDraft(prev => ({ ...prev, identity: e.target.value }))}
                                disabled={savingNode}
                                className="w-full p-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white text-sm focus:ring-2 focus:ring-blue-500 outline-none disabled:opacity-50 disabled:cursor-not-allowed"
                                placeholder="/app/data/ssh/id_rsa"
                              />
                            </div>
                          </div>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        {isEditing ? (
                          <>
                            <button
                              onClick={handleInlineSave}
                              disabled={inlineDisabled}
                              className="p-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                              title="Save changes"
                            >
                              {savingNode ? <Loader2 size={18} className="animate-spin" /> : <Save size={18} />}
                            </button>
                            <button
                              onClick={cancelInlineEdit}
                              className="p-2 bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
                              title="Cancel"
                            >
                              <XCircle size={18} />
                            </button>
                          </>
                        ) : (
                          <>
                            {!node.Default && (
                              <button 
                                onClick={() => handleSetDefaultNode(node.Name)}
                                className="p-2 text-gray-500 hover:text-green-600 hover:bg-green-50 dark:hover:bg-green-900/20 rounded transition-colors"
                                title="Set as Default"
                              >
                                <CheckCircle2 size={16} />
                              </button>
                            )}
                            <button 
                              onClick={() => startEditingNode(node)}
                              className="p-2 text-gray-500 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded transition-colors"
                              title="Edit Node settings"
                            >
                              <Edit2 size={16} />
                            </button>
                            <button 
                              onClick={() => handleDeleteNode(node.Name)}
                              className="p-2 text-gray-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 rounded transition-colors"
                              title="Remove Node"
                            >
                              <Trash2 size={16} />
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  );
                  })}
                    {nodes.length === 0 && (
                        <div className="text-center py-4 text-gray-500 dark:text-gray-400 text-sm italic">
                            No remote nodes configured. ServiceBay is running in local mode.
                        </div>
                    )}
                </div>
            </div>
        </div>

        {/* Template Registries */}
        <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm overflow-hidden w-full">
            <div className="p-4 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 flex items-center gap-3">
                <div className="p-2 bg-indigo-100 dark:bg-indigo-900/30 rounded-lg text-indigo-600 dark:text-indigo-400">
                    <GitBranch size={20} />
                </div>
                <div>
                    <h3 className="font-bold text-gray-900 dark:text-white">Template Registries</h3>
                  <p className="text-xs text-gray-500 dark:text-gray-400">Connect Git repositories that supply ServiceBay templates and stacks.</p>
                </div>
                <div className="ml-auto">
                    <label className="relative inline-flex items-center cursor-pointer">
                        <input 
                            type="checkbox" 
                            className="sr-only peer" 
                            checked={registriesEnabled}
                      onChange={e => handleRegistriesToggle(e.target.checked)}
                      disabled={saving}
                        />
                        <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-indigo-300 dark:peer-focus:ring-indigo-800 rounded-full peer dark:bg-gray-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-gray-600 peer-checked:bg-indigo-600"></div>
                    </label>
                </div>
            </div>
            
            {registriesEnabled && (
                <div className="p-6 space-y-6">
                    <div className="grid grid-cols-1 md:grid-cols-12 gap-4 items-end">
                        <div className="md:col-span-3">
                            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Name</label>
                            <input 
                                type="text" 
                                value={newRegName}
                                onChange={e => setNewRegName(e.target.value)}
                              disabled={saving}
                                className="w-full p-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white focus:ring-2 focus:ring-indigo-500 outline-none"
                                placeholder="my-registry"
                            />
                        </div>
                        <div className="md:col-span-5">
                            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Git URL</label>
                            <input 
                                type="text" 
                                value={newRegUrl}
                                onChange={e => setNewRegUrl(e.target.value)}
                              disabled={saving}
                                className="w-full p-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white focus:ring-2 focus:ring-indigo-500 outline-none"
                                placeholder="https://github.com/user/repo.git"
                            />
                        </div>
                        <div className="md:col-span-3">
                            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Branch (Optional)</label>
                            <input 
                                type="text" 
                                value={newRegBranch}
                                onChange={e => setNewRegBranch(e.target.value)}
                              disabled={saving}
                                className="w-full p-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white focus:ring-2 focus:ring-indigo-500 outline-none"
                                placeholder="main"
                            />
                        </div>
                        <div className="md:col-span-1">
                            <button 
                                onClick={handleAddRegistry}
                              disabled={saving || !newRegName || !newRegUrl}
                              className="w-full p-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex justify-center"
                            >
                                <Plus size={20} />
                            </button>
                        </div>
                    </div>

                    <div className="space-y-2">
                        {registries.map(reg => (
                            <div key={reg.name} className="flex items-center justify-between p-3 bg-gray-50 dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700">
                                <div className="flex items-center gap-4">
                                    <div className="font-medium text-gray-900 dark:text-white">{reg.name}</div>
                                    <div className="text-sm text-gray-500 dark:text-gray-400 font-mono">{reg.url}</div>
                                    {reg.branch && (
                                        <div className="text-xs px-2 py-1 bg-gray-200 dark:bg-gray-800 rounded text-gray-600 dark:text-gray-300 font-mono">
                                            {reg.branch}
                                        </div>
                                    )}
                                </div>
                                <button 
                                    onClick={() => handleRemoveRegistry(reg.name)}
                                  disabled={saving}
                                  className="text-gray-400 hover:text-red-500 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                                >
                                    <Trash2 size={18} />
                                </button>
                            </div>
                        ))}
                        {registries.length === 0 && (
                            <p className="text-sm text-gray-500 italic text-center py-4">No external registries configured. Only built-in templates are available.</p>
                        )}
                    </div>
                </div>
            )}
        </div>



        {/* Email Notifications Section */}
        <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm overflow-hidden w-full">
            <div className="p-4 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 flex items-center gap-3">
                <div className="p-2 bg-blue-100 dark:bg-blue-900/30 rounded-lg text-blue-600 dark:text-blue-400">
                    <Mail size={20} />
                </div>
                <div>
                    <h3 className="font-bold text-gray-900 dark:text-white">Email Notifications</h3>
                    <p className="text-xs text-gray-500 dark:text-gray-400">Configure SMTP settings for alerts</p>
                </div>
                <div className="ml-auto">
                    <label className="relative inline-flex items-center cursor-pointer">
                        <input 
                            type="checkbox" 
                            className="sr-only peer" 
                            checked={emailEnabled}
                      onChange={e => handleEmailEnabledToggle(e.target.checked)}
                      disabled={saving}
                        />
                        <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-300 dark:peer-focus:ring-blue-800 rounded-full peer dark:bg-gray-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-gray-600 peer-checked:bg-blue-600"></div>
                    </label>
                </div>
            </div>
            
            {emailEnabled && (
                <div className="p-6 space-y-6">
                    <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-4 text-sm text-blue-800 dark:text-blue-200">
                        <p className="font-medium mb-1">Need help finding these settings?</p>
                        <ul className="list-disc list-inside space-y-1 opacity-90">
                            <li><strong>Gmail:</strong> Host: <code>smtp.gmail.com</code>, Port: <code>587</code>. Use an <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noopener noreferrer" className="underline hover:text-blue-600">App Password</a> if 2FA is enabled.</li>
                            <li><strong>Outlook:</strong> Host: <code>smtp.office365.com</code>, Port: <code>587</code>.</li>
                            <li><strong>GMX:</strong> Host: <code>mail.gmx.net</code>, Port: <code>587</code>.</li>
                        </ul>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                        <div>
                            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">SMTP Host</label>
                            <input 
                                type="text" 
                                value={emailHost}
                              onChange={e => setEmailHost(e.target.value)}
                              onBlur={() => persistSettings()}
                              disabled={saving}
                                className="w-full p-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
                                placeholder="smtp.gmail.com"
                            />
                        </div>
                        <div>
                            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">SMTP Port</label>
                            <input 
                                type="number" 
                                value={emailPort}
                              onChange={e => setEmailPort(parseInt(e.target.value) || 0)}
                              onBlur={() => persistSettings()}
                              disabled={saving}
                                className="w-full p-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
                                placeholder="587"
                            />
                        </div>
                        <div>
                            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Username</label>
                            <input 
                                type="text" 
                                value={emailUser}
                              onChange={e => setEmailUser(e.target.value)}
                              onBlur={() => persistSettings()}
                              disabled={saving}
                                className="w-full p-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
                                placeholder="user@example.com"
                            />
                        </div>
                        <div>
                            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Password</label>
                            <input 
                                type="password" 
                                value={emailPass}
                              onChange={e => setEmailPass(e.target.value)}
                              onBlur={() => persistSettings()}
                              disabled={saving}
                                className="w-full p-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
                                placeholder="••••••••"
                            />
                        </div>
                        <div className="md:col-span-2">
                            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">From Address</label>
                            <input 
                                type="text" 
                                value={emailFrom}
                              onChange={e => setEmailFrom(e.target.value)}
                              onBlur={() => persistSettings()}
                              disabled={saving}
                                className="w-full p-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
                                placeholder="ServiceBay <alerts@example.com>"
                            />
                        </div>
                        <div className="md:col-span-2">
                            <label className="flex items-center gap-2 cursor-pointer">
                                <input 
                                    type="checkbox" 
                                    checked={emailSecure}
                                onChange={e => handleEmailSecureToggle(e.target.checked)}
                                disabled={saving}
                                    className="w-4 h-4 text-blue-600 rounded border-gray-300 focus:ring-blue-500 dark:focus:ring-blue-600 dark:ring-offset-gray-800 focus:ring-2 dark:bg-gray-700 dark:border-gray-600"
                                />
                                <span className="text-sm text-gray-700 dark:text-gray-300">Use Secure Connection (TLS/SSL)</span>
                            </label>
                        </div>
                    </div>

                    <div className="border-t border-gray-200 dark:border-gray-700 pt-6">
                        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Recipients</label>
                        <div className="flex gap-2 mb-3">
                            <input 
                                type="email" 
                                value={newRecipient}
                                onChange={e => setNewRecipient(e.target.value)}
                                onKeyDown={e => e.key === 'Enter' && handleAddRecipient()}
                              disabled={saving}
                                className="flex-1 p-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
                                placeholder="Add email address..."
                            />
                            <button 
                                onClick={handleAddRecipient}
                              disabled={saving || !newRecipient}
                              className="p-2 bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                <Plus size={20} />
                            </button>
                        </div>
                        <div className="space-y-2">
                            {emailRecipients.map(email => (
                                <div key={email} className="flex items-center justify-between p-2 bg-gray-50 dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700">
                                    <span className="text-sm text-gray-700 dark:text-gray-300">{email}</span>
                                    <button 
                                        onClick={() => handleRemoveRecipient(email)}
                                  disabled={saving}
                                  className="text-gray-400 hover:text-red-500 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                                    >
                                        <Trash2 size={16} />
                                    </button>
                                </div>
                            ))}
                            {emailRecipients.length === 0 && (
                                <p className="text-sm text-gray-500 italic">No recipients added.</p>
                            )}
                        </div>
                    </div>
                </div>
            )}
        </div>

        {/* Log Level Control */}
        <LogLevelControl />
      </div>

      {/* Update Progress Modal */}
      {updateStatus !== 'idle' && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-[70] flex items-center justify-center p-4">
          <div className="bg-white dark:bg-gray-900 rounded-xl shadow-2xl max-w-md w-full border border-gray-200 dark:border-gray-800 overflow-hidden">
            <div className="p-6 text-center space-y-6">
              {updateStatus === 'error' ? (
                <div className="w-16 h-16 bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400 rounded-full flex items-center justify-center mx-auto">
                  <XCircle size={32} />
                </div>
              ) : updateStatus === 'restarting' ? (
                <div className="w-16 h-16 bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400 rounded-full flex items-center justify-center mx-auto animate-pulse">
                  <CheckCircle2 size={32} />
                </div>
              ) : (
                <div className="w-16 h-16 bg-purple-100 dark:bg-purple-900/30 text-purple-600 dark:text-purple-400 rounded-full flex items-center justify-center mx-auto">
                  <Loader2 size={32} className="animate-spin" />
                </div>
              )}
              
              <div>
                <h3 className="text-xl font-bold text-gray-900 dark:text-white mb-2">
                  {updateStatus === 'error' ? 'Update Failed' : 
                   updateStatus === 'restarting' ? 'Update Complete' : 
                   'Updating ServiceBay'}
                </h3>
                <p className="text-gray-500 dark:text-gray-400 text-sm">
                  {updateStatus === 'error' ? updateError : updateMessage}
                </p>
              </div>

              {updateStatus === 'updating' && (
                <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2.5 overflow-hidden">
                  <div 
                    className="bg-purple-600 h-2.5 rounded-full transition-all duration-300 ease-out" 
                    style={{ width: `${updateProgress}%` }}
                  ></div>
                </div>
              )}

              {updateStatus === 'error' && (
                <button
                  onClick={() => setUpdateStatus('idle')}
                  className="px-4 py-2 bg-gray-100 dark:bg-gray-800 text-gray-900 dark:text-white rounded-lg hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors font-medium text-sm"
                >
                  Close
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      <ConfirmModal
        isOpen={isUpdateModalOpen}
        title="Update ServiceBay"
        message={`Are you sure you want to update ServiceBay to version ${appUpdate?.latest?.version}? The service will restart automatically.`}
        confirmText="Update Now"
        onConfirm={confirmAppUpdate}
        onCancel={() => setIsUpdateModalOpen(false)}
      />

      <ConfirmModal
        isOpen={!!restoreTarget}
        title="Restore Backup"
        message={`Restoring ${restoreTarget?.fileName || ''} will overwrite existing managed services and ServiceBay configuration. Proceed only if you have noted current changes.`}
        confirmText={restoringBackup ? 'Restoring...' : 'Restore Backup'}
        confirmDisabled={restoringBackup}
        isDestructive
        onConfirm={confirmRestoreBackup}
        onCancel={closeRestoreModal}
      />

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

      <SSHSetupModal 
        isOpen={isSSHModalOpen}
        onClose={() => setIsSSHModalOpen(false)}
        initialHost={sshModalDefaults.host}
        initialPort={sshModalDefaults.port}
        initialUser={sshModalDefaults.user}
      />
    </div>
  );
}

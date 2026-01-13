'use client';

import { useState, useEffect, useCallback } from 'react';
import { Save, Mail, Plus, Trash2, RefreshCw, Download, Clock, GitBranch, Loader2, CheckCircle2, XCircle, Server, Key, Terminal, Edit2, ShieldCheck, ShieldAlert, Wifi, WifiOff, Globe } from 'lucide-react';
import { useToast } from '@/providers/ToastProvider';
import PageHeader from '@/components/PageHeader';
import ConfirmModal from '@/components/ConfirmModal';
import SSHSetupModal from '@/components/SSHSetupModal';
import LogLevelControl from '@/components/LogLevelControl';
import { AppConfig } from '@/lib/config';
import { getNodes, createNode, editNode, deleteNode, setNodeAsDefault, checkNodeStatus } from '@/app/actions/nodes';
import { checkConnection, checkFullConnection } from '@/app/actions/ssh';
import { PodmanConnection } from '@/lib/nodes';

type TemplateSettingsSchemaEntry = {
  default: string;
  description?: string;
  required?: boolean;
};

const DEFAULT_TEMPLATE_SCHEMA: Record<string, TemplateSettingsSchemaEntry> = {
  STACKS_DIR: {
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

export default function SettingsPage() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
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
  const [templateValues, setTemplateValues] = useState<Record<string, string>>({ STACKS_DIR: DEFAULT_TEMPLATE_SCHEMA.STACKS_DIR.default });
  const [newVarKey, setNewVarKey] = useState('');
  const [newVarValue, setNewVarValue] = useState('');

  // Nodes State
  const [nodes, setNodes] = useState<PodmanConnection[]>([]);
  const [newNodeName, setNewNodeName] = useState('');
  const [newNodeDest, setNewNodeDest] = useState('');
  const [newNodeIdentity, setNewNodeIdentity] = useState('/app/data/ssh/id_rsa');
  const [addingNode, setAddingNode] = useState(false);
  const [editingNode, setEditingNode] = useState<string | null>(null);
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

  const handleAddRecipient = () => {
    if (newRecipient && !emailRecipients.includes(newRecipient)) {
      setEmailRecipients([...emailRecipients, newRecipient]);
      setNewRecipient('');
    }
  };

  const handleRemoveRecipient = (email: string) => {
    setEmailRecipients(emailRecipients.filter(e => e !== email));
  };

  const handleAddRegistry = () => {
    if (newRegName && newRegUrl) {
      setRegistries([...registries, { name: newRegName, url: newRegUrl, branch: newRegBranch || undefined }]);
      setNewRegName('');
      setNewRegUrl('');
      setNewRegBranch('');
    }
  };

  const handleRemoveRegistry = (name: string) => {
    setRegistries(registries.filter(r => r.name !== name));
  };

  const handleTemplateValueChange = (key: string, value: string) => {
    setTemplateValues(prev => ({ ...prev, [key]: value }));
  };

  const handleAddTemplateVariable = () => {
    if (!newVarKey.trim()) return;
    setTemplateValues(prev => ({ ...prev, [newVarKey.trim()]: newVarValue }));
    setNewVarKey('');
    setNewVarValue('');
  };

  const handleRemoveTemplateVariable = (key: string) => {
    const meta = templateSchema[key];
    if (meta?.required) return;
    setTemplateValues(prev => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { [key]: _removed, ...rest } = prev;
      return rest;
    });
  };

  const handleSaveNode = async () => {
    if (!newNodeName || !newNodeDest || !newNodeIdentity) return;

    // Parse URL for pre-check
    let host = '', port = 22, user = 'root';
    try {
        const urlStr = newNodeDest.includes('://') ? newNodeDest : `ssh://${newNodeDest}`;
        const url = new URL(urlStr);
        host = url.hostname;
        port = url.port ? parseInt(url.port) : 22;
        user = url.username || 'root';
    } catch {
        // Ignore parse error
    }

    setAddingNode(true);

    // Pre-check TCP connection
    if (host) {
        const check = await checkConnection(host, port);
        if (!check.success || !check.isOpen) {
            addToast('error', 'Connection Failed', `Could not connect to ${host}:${port}. Is the server reachable?`);
            setAddingNode(false);
            return;
        }
    }

    try {
      let res;
      if (editingNode) {
          res = await editNode(editingNode, newNodeName, newNodeDest, newNodeIdentity);
      } else {
          res = await createNode(newNodeName, newNodeDest, newNodeIdentity);
      }

      if (res.success) {
        setNodes(await getNodes());
        setNewNodeName('');
        setNewNodeDest('');
        setNewNodeIdentity('/app/data/ssh/id_rsa');
        setEditingNode(null);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const resultAny = res as any;
        if (resultAny.warning) {
             
            const warning = resultAny.warning as string;
            
            // Check for common SSH issues
            if (warning.includes('timed out') || warning.includes('Permission denied') || warning.includes('password') || warning.includes('publickey')) {
                addToast('warning', 'SSH Connection Failed', 
                    'The node was saved, but we could not connect. It seems password-less SSH is not configured.'
                );
                // Pre-fill and open modal
                if (host) {
                    setSshModalDefaults({ host, port, user });
                    setIsSSHModalOpen(true);
                }
            } else {
                addToast('warning', editingNode ? 'Node updated with warning' : 'Node added with warning', warning);
            }
        } else {
            addToast('success', editingNode ? 'Node updated' : 'Node added');
        }
        
        // Retrigger health check
        await new Promise(r => setTimeout(r, 1000));
        // We can't easily re-call checkHealth specifically for the new node because of closure, 
        // but useEffect will pick it up or we can force it.
        // Actually, just let the user see the status.
      } else {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        addToast('error', editingNode ? 'Failed to update node' : 'Failed to add node', (res as any).error);
      }
    } catch (e) {
        addToast('error', editingNode ? 'Failed to save node' : 'Failed to add node', String(e));
    } finally {
      setAddingNode(false);
    }
  };

  const handleEditClick = (node: PodmanConnection) => {
    setNewNodeName(node.Name);
    setNewNodeDest(node.URI);
    setNewNodeIdentity(node.Identity);
    setEditingNode(node.Name);
    // Scroll to top or form (simple approach)
    const form = document.getElementById('node-form');
    if (form) form.scrollIntoView({ behavior: 'smooth' });
  };
  
  const handleCancelEdit = () => {
    setNewNodeName('');
    setNewNodeDest('');
    setNewNodeIdentity('/app/data/ssh/id_rsa');
    setEditingNode(null);
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

  const handleSave = async () => {
    setSaving(true);
    try {
      const enforcedTemplateValues = {
        ...Object.fromEntries(
          Object.entries(templateSchema).map(([k, v]) => [k, v.default ?? ''])
        ),
        ...templateValues
      } as Record<string, string>;

      const newConfig: Partial<AppConfig> = {
        templateSettings: enforcedTemplateValues,
        registries: {
            enabled: registriesEnabled,
            items: registries
        },
        notifications: {
          email: {
            enabled: emailEnabled,
            host: emailHost,
            port: emailPort,
            secure: emailSecure,
            user: emailUser,
            pass: emailPass,
            from: emailFrom,
            to: emailRecipients
          }
        }
      };

      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newConfig)
      });

      if (!res.ok) throw new Error('Failed to save settings');
      
      addToast('success', 'Settings saved successfully');
      // Refresh config to ensure sync
      fetchConfig();
    } catch (error) {
      console.error(error);
      addToast('error', 'Failed to save settings');
    } finally {
      setSaving(false);
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
            <button 
                onClick={handleSave}
                disabled={saving}
                className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 shadow-sm transition-colors font-medium disabled:opacity-50"
            >
                <Save className="w-4 h-4" />
                {saving ? 'Saving...' : 'Save Changes'}
            </button>
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
              {/* Template Settings Section */}
              <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm overflow-hidden w-full">
                <div className="p-4 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 flex items-center gap-3">
                  <div className="p-2 bg-indigo-100 dark:bg-indigo-900/30 rounded-lg text-indigo-600 dark:text-indigo-400">
                    <Server size={20} />
                  </div>
                  <div>
                    <h3 className="font-bold text-gray-900 dark:text-white">Template Settings</h3>
                    <p className="text-xs text-gray-500 dark:text-gray-400">Environment variables for template rendering. Changes apply to new deployments.</p>
                  </div>
                </div>
                <div className="p-6 space-y-6">
                  <div className="space-y-4">
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
                              className="w-full p-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white focus:ring-2 focus:ring-indigo-500 outline-none"
                              placeholder={meta?.default || ''}
                            />
                          </div>
                          {!isRequired && (
                            <button
                              onClick={() => handleRemoveTemplateVariable(key)}
                              className="mt-3 md:mt-0 text-gray-400 hover:text-red-500 transition-colors"
                              aria-label={`Remove ${key}`}
                            >
                              <Trash2 size={18} />
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>

                  <div className="border-t border-gray-200 dark:border-gray-700 pt-4">
                    <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">Add custom variables to persist additional template settings. They will appear here after saving.</p>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-center">
                      <input
                        type="text"
                        value={newVarKey}
                        onChange={e => setNewVarKey(e.target.value)}
                        className="w-full p-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white focus:ring-2 focus:ring-indigo-500 outline-none"
                        placeholder="VAR_NAME"
                      />
                      <input
                        type="text"
                        value={newVarValue}
                        onChange={e => setNewVarValue(e.target.value)}
                        className="w-full p-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white focus:ring-2 focus:ring-indigo-500 outline-none"
                        placeholder="value"
                      />
                      <button
                        onClick={handleAddTemplateVariable}
                        className="w-full md:w-auto px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors shadow-sm flex items-center gap-2 justify-center"
                      >
                        <Plus size={16} />
                        Add Variable
                      </button>
                    </div>
                  </div>
                </div>
              </div>


              {/* Email Notifications Section */}
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
                            disabled={!!editingNode} 
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
                            className="w-full p-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
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
                                className="w-full pl-9 pr-2 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
                                placeholder="/app/data/ssh/id_rsa"
                            />
                        </div>
                    </div>
                    <div className="md:col-span-1 flex gap-2">
                        <button 
                            onClick={handleSaveNode}
                            disabled={!newNodeName || !newNodeDest || !newNodeIdentity || addingNode}
                            className={`w-full p-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex justify-center items-center gap-2`}
                            title={editingNode ? 'Update Node' : 'Add Node'}
                        >
                            {addingNode ? <Loader2 className="animate-spin" size={20} /> : (editingNode ? <Save size={20} /> : <Plus size={20} />)}
                        </button>
                        {editingNode && (
                            <button 
                                onClick={handleCancelEdit}
                                className="p-2 bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
                                title="Cancel Edit"
                            >
                                <XCircle size={20} />
                            </button>
                        )}
                    </div>
                </div>

                <div className="space-y-2">
                    {nodes.map(node => {
                        const health = nodeHealth[node.Name] || { loading: false, online: false, auth: false };
                        return (
                        <div key={node.Name} className={`flex items-center justify-between p-3 rounded-lg border transition-colors ${editingNode === node.Name ? 'bg-blue-50 border-blue-200 dark:bg-blue-900/20 dark:border-blue-800' : 'bg-gray-50 dark:bg-gray-900/50 border-gray-200 dark:border-gray-700'}`}>
                            <div className="flex items-center gap-3">
                                <div className={`w-2 h-2 rounded-full ${node.Default ? 'bg-green-500' : 'bg-gray-300 dark:bg-gray-600'}`} title={node.Default ? 'Default Node' : ''} />
                                <div>
                                    <div className="font-medium text-gray-900 dark:text-white flex items-center gap-2">
                                        {node.Name}
                                        {node.Default && <span className="text-[10px] bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400 px-1.5 py-0.5 rounded uppercase font-bold">Default</span>}
                                        
                                        {/* Health Status */}
                                        <div className="flex items-center gap-1 ml-2" title={health.error || (health.online ? (health.auth ? 'Online & Authenticated' : 'Online but Auth Failed') : 'Unreachable')}>
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
                                    <div className="text-xs text-gray-500 dark:text-gray-400 font-mono">{node.URI}</div>
                                </div>
                            </div>
                            <div className="flex items-center gap-2">
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
                                    onClick={() => handleEditClick(node)}
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
                    <p className="text-xs text-gray-500 dark:text-gray-400">Manage external template sources</p>
                </div>
                <div className="ml-auto">
                    <label className="relative inline-flex items-center cursor-pointer">
                        <input 
                            type="checkbox" 
                            className="sr-only peer" 
                            checked={registriesEnabled}
                            onChange={e => setRegistriesEnabled(e.target.checked)}
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
                                className="w-full p-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white focus:ring-2 focus:ring-indigo-500 outline-none"
                                placeholder="main"
                            />
                        </div>
                        <div className="md:col-span-1">
                            <button 
                                onClick={handleAddRegistry}
                                disabled={!newRegName || !newRegUrl}
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
                                    className="text-gray-400 hover:text-red-500 transition-colors"
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
                            onChange={e => setEmailEnabled(e.target.checked)}
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
                                className="w-full p-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
                                placeholder="smtp.gmail.com"
                            />
                        </div>
                        <div>
                            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">SMTP Port</label>
                            <input 
                                type="number" 
                                value={emailPort}
                                onChange={e => setEmailPort(parseInt(e.target.value))}
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
                                className="w-full p-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
                                placeholder="ServiceBay <alerts@example.com>"
                            />
                        </div>
                        <div className="md:col-span-2">
                            <label className="flex items-center gap-2 cursor-pointer">
                                <input 
                                    type="checkbox" 
                                    checked={emailSecure}
                                    onChange={e => setEmailSecure(e.target.checked)}
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
                                className="flex-1 p-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
                                placeholder="Add email address..."
                            />
                            <button 
                                onClick={handleAddRecipient}
                                className="p-2 bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors"
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
                                        className="text-gray-400 hover:text-red-500 transition-colors"
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

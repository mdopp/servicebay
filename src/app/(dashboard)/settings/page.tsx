'use client';

import { useState, useEffect, useCallback } from 'react';
import { Save, Mail, Plus, Trash2, RefreshCw, Download, Clock, GitBranch } from 'lucide-react';
import { useToast } from '@/providers/ToastProvider';
import PageHeader from '@/components/PageHeader';
import ConfirmModal from '@/components/ConfirmModal';
import { AppConfig } from '@/lib/config';

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
    }
  };
}

export default function SettingsPage() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const { addToast } = useToast();

  // App Update State
  const [appUpdate, setAppUpdate] = useState<AppUpdateStatus | null>(null);
  const [updating, setUpdating] = useState(false);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [isUpdateModalOpen, setIsUpdateModalOpen] = useState(false);

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

  const handleCheckUpdate = async () => {
    setCheckingUpdate(true);
    try {
        const res = await fetch('/api/system/update');
        if (res.ok) {
            const data = await res.json();
            setAppUpdate(data);
            if (data.hasUpdate) {
                addToast('success', 'Update available', `Version ${data.latest.version} is available.`);
            } else {
                addToast('info', 'No updates', 'You are on the latest version.');
            }
        }
    } catch {
        addToast('error', 'Failed to check for updates');
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
    
    setUpdating(true);
    try {
      const res = await fetch('/api/system/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'update', version: appUpdate.latest.version })
      });
      
      if (res.ok) {
        addToast('success', 'Update started', 'Service is restarting. Please reload the page in a few seconds.');
      } else {
        throw new Error('Update failed');
      }
    } catch {
      addToast('error', 'Update failed');
    } finally {
      setUpdating(false);
      setIsUpdateModalOpen(false);
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
      const newConfig: Partial<AppConfig> = {
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
      <PageHeader title="Settings" showBack={false}>
        <button 
            onClick={handleSave}
            disabled={saving}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 shadow-sm transition-colors font-medium disabled:opacity-50"
        >
            <Save className="w-4 h-4" />
            {saving ? 'Saving...' : 'Save Changes'}
        </button>
      </PageHeader>

      <div className="px-4 pb-8 w-full space-y-6">
        {/* ServiceBay Updates */}
        {appUpdate && (
            <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm overflow-hidden w-full">
                <div className="p-4 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 flex items-center gap-3">
                    <div className="p-2 bg-purple-100 dark:bg-purple-900/30 rounded-lg text-purple-600 dark:text-purple-400">
                        <RefreshCw size={20} className={updating || checkingUpdate ? 'animate-spin' : ''} />
                    </div>
                    <div>
                        <h3 className="font-bold text-gray-900 dark:text-white">ServiceBay Updates</h3>
                        <p className="text-xs text-gray-500 dark:text-gray-400">Manage application updates</p>
                    </div>
                    <div className="ml-auto flex items-center gap-4">
                        <button
                            onClick={handleCheckUpdate}
                            disabled={checkingUpdate || updating}
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
                                disabled={updating}
                                className="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors shadow-sm flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                <Download size={18} />
                                {updating ? 'Updating...' : 'Update Now'}
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
      </div>

      <ConfirmModal
        isOpen={isUpdateModalOpen}
        title="Update ServiceBay"
        message={`Are you sure you want to update ServiceBay to version ${appUpdate?.latest?.version}? The service will restart automatically.`}
        confirmText="Update Now"
        onConfirm={confirmAppUpdate}
        onCancel={() => setIsUpdateModalOpen(false)}
      />
    </div>
  );
}

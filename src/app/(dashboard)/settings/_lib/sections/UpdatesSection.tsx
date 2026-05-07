'use client';

import { useEffect, useState } from 'react';
import { CheckCircle2, Clock, Download, Loader2, RefreshCw, XCircle } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import ConfirmModal from '@/components/ConfirmModal';
import { useToast } from '@/providers/ToastProvider';
import type { AppUpdateStatus } from '../helpers';

export default function UpdatesSection() {
  const { addToast } = useToast();
  const [appUpdate, setAppUpdate] = useState<AppUpdateStatus | null>(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [isUpdateModalOpen, setIsUpdateModalOpen] = useState(false);

  const [updateStatus, setUpdateStatus] = useState<'idle' | 'updating' | 'restarting' | 'error' | 'success'>('idle');
  const [updateProgress, setUpdateProgress] = useState(0);
  const [updateMessage, setUpdateMessage] = useState('');
  const [updateError, setUpdateError] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/system/update');
        if (!res.ok) return;
        const data: AppUpdateStatus = await res.json();
        if (!cancelled) setAppUpdate(data);
      } catch {
        // ignore — keeps null and user can hit Check Now
      }
    })();
    return () => { cancelled = true; };
  }, []);

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
      const { io } = await import('socket.io-client');
      const socket = io();

      socket.on('update:progress', (data: { step: string; progress: number; message: string }) => {
        setUpdateProgress(data.progress);
        setUpdateMessage(data.message);
        if (data.step === 'restart') {
          setUpdateStatus('restarting');
          setUpdateMessage('Service is restarting. This page will reload automatically...');
          setTimeout(() => { window.location.reload(); }, 5000);
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
        body: JSON.stringify({ action: 'update', version: appUpdate.latest.version }),
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
        body: JSON.stringify({ action: 'configure', autoUpdate: { enabled: newState } }),
      });

      if (res.ok) {
        const data = await res.json();
        setAppUpdate(prev => (prev ? { ...prev, config: data.config } : null));
        addToast('success', 'Settings saved', `Auto-update ${newState ? 'enabled' : 'disabled'}.`);
      }
    } catch {
      addToast('error', 'Error', 'Failed to save settings.');
    }
  };

  const handleChannelChange = async (newChannel: 'stable' | 'test' | 'dev') => {
    if (!appUpdate) return;
    try {
      const res = await fetch('/api/system/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'configure',
          autoUpdate: {
            enabled: appUpdate.config.autoUpdate.enabled,
            channel: newChannel,
          },
        }),
      });
      if (res.ok) {
        const data = await res.json();
        setAppUpdate(prev => (prev ? { ...prev, config: data.config } : null));
        addToast('success', 'Release channel updated', `Switched to ${newChannel} channel. Check for updates to apply.`);
      }
    } catch {
      addToast('error', 'Failed to update release channel');
    }
  };

  if (!appUpdate) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm p-6 text-sm text-gray-500 dark:text-gray-400">
        <Loader2 className="w-4 h-4 animate-spin inline mr-2" />
        Loading update status…
      </div>
    );
  }

  return (
    <>
      <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm overflow-hidden w-full">
        <div className="p-4 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 flex items-center gap-3">
          <div className="p-2 bg-purple-100 dark:bg-purple-900/30 rounded-lg text-purple-600 dark:text-purple-400">
            <RefreshCw size={20} className={updateStatus === 'updating' || checkingUpdate ? 'animate-spin' : ''} />
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
                onChange={e => handleChannelChange(e.target.value as 'stable' | 'test' | 'dev')}
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
              disabled={checkingUpdate || updateStatus === 'updating'}
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
              <div className="prose prose-sm dark:prose-invert max-w-none text-gray-600 dark:text-gray-300">
                <ReactMarkdown>{appUpdate.latest.notes}</ReactMarkdown>
              </div>
            </div>
          )}
        </div>
      </div>

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
                  <div className="bg-purple-600 h-2.5 rounded-full transition-all duration-300 ease-out" style={{ width: `${updateProgress}%` }}></div>
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
    </>
  );
}

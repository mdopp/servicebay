'use client';

import { useEffect, useState } from 'react';
import { CheckCircle2, Clock, Download, Loader2, RefreshCw, XCircle, AlertTriangle, Power } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import ConfirmModal from '@/components/ConfirmModal';
import { useToast } from '@/providers/ToastProvider';
import type { AppUpdateStatus } from '../helpers';

export default function UpdatesSection() {
  const { addToast } = useToast();
  const [appUpdate, setAppUpdate] = useState<AppUpdateStatus | null>(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [isUpdateModalOpen, setIsUpdateModalOpen] = useState(false);

  const [updateStatus, setUpdateStatus] = useState<'idle' | 'updating' | 'restarting' | 'error' | 'success' | 'building'>('idle');
  const [updateProgress, setUpdateProgress] = useState(0);
  const [updateMessage, setUpdateMessage] = useState('');
  const [updateError, setUpdateError] = useState('');

  const [bootStatus, setBootStatus] = useState<{
    entries: Array<{ bootNum: string; name: string; active: boolean; description: string; current: boolean }>;
    candidates: Array<{ bootNum: string; name: string; active: boolean; description: string; current: boolean }>;
    bootNext: string | null;
    bootCurrent: string | null;
    bootOrder: string[];
  } | null>(null);
  const [isReinstallModalOpen, setIsReinstallModalOpen] = useState(false);
  const [armingBoot, setArmingBoot] = useState(false);
  const [cancellingBoot, setCancellingBoot] = useState(false);
  const [rebooting, setRebooting] = useState(false);

  const fetchBootStatus = async () => {
    try {
      const res = await fetch('/api/system/boot/usb-next');
      if (res.ok) {
        const data = await res.json();
        setBootStatus(data);
      }
    } catch (e) {
      console.error('Failed to fetch boot status:', e);
    }
  };

  const confirmReinstall = async () => {
    setIsReinstallModalOpen(false);
    setArmingBoot(true);
    try {
      const res = await fetch('/api/system/boot/usb-next', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reboot: true }),
      });
      if (res.ok) {
        addToast('success', 'USB Boot Armed', 'System is rebooting to USB installation medium...');
        setRebooting(true);
        setTimeout(() => { window.location.reload(); }, 8000);
      } else {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to arm USB Boot');
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      addToast('error', 'Boot Arming Failed', msg);
    } finally {
      setArmingBoot(false);
      fetchBootStatus();
    }
  };

  const cancelUsbBoot = async () => {
    setCancellingBoot(true);
    try {
      const res = await fetch('/api/system/boot/usb-next', {
        method: 'DELETE',
      });
      if (res.ok) {
        addToast('success', 'USB Boot Cancelled', 'One-shot BootNext cleared. SSD boot restored.');
        fetchBootStatus();
      } else {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to clear BootNext');
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      addToast('error', 'Cancellation Failed', msg);
    } finally {
      setCancellingBoot(false);
    }
  };

  const triggerManualReboot = async () => {
    setRebooting(true);
    try {
      const res = await fetch('/api/system/boot/usb-next', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reboot: true, bootNum: bootStatus?.bootNext || undefined }),
      });
      if (res.ok) {
        addToast('success', 'Rebooting', 'System reboot command sent...');
      } else {
        throw new Error('Failed to trigger reboot');
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      addToast('error', 'Reboot Failed', msg);
      setRebooting(false);
    }
  };

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
    fetchBootStatus();
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
        } else if (data.imageBuilding) {
          addToast('info', 'New version building', `Version ${latestVer} was released but its image is still building. Try again shortly.`);
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

      socket.on('update:noop', (data: { message: string }) => {
        // The pull found no newer image (the tag raced ahead of the image
        // push). Report it honestly instead of leaving the spinner running or
        // claiming success — no silent no-op (feedback_dont_mask_failures).
        setUpdateStatus('building');
        setUpdateMessage(data.message);
        socket.disconnect();
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
              ) : appUpdate.imageBuilding && appUpdate.latest ? (
                <div className="flex items-center gap-2 text-amber-600 dark:text-amber-400">
                  <Clock size={16} />
                  <span className="text-sm font-medium">Version {appUpdate.latest.version} released — image still building, try again shortly</span>
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
              ) : updateStatus === 'building' ? (
                <div className="w-16 h-16 bg-amber-100 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400 rounded-full flex items-center justify-center mx-auto">
                  <Clock size={32} />
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
                    updateStatus === 'building' ? 'New Version Still Building' :
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

              {(updateStatus === 'error' || updateStatus === 'building') && (
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

      {/* Reinstall Operating System Section */}
      <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm overflow-hidden w-full mt-6">
        <div className="p-4 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 flex items-center gap-3">
          <div className="p-2 bg-red-100 dark:bg-red-900/30 rounded-lg text-red-600 dark:text-red-400">
            <Power size={20} className={rebooting ? 'animate-pulse' : ''} />
          </div>
          <div>
            <h3 className="font-bold text-gray-900 dark:text-white">Operating System Reinstallation</h3>
            <p className="text-xs text-gray-500 dark:text-gray-400">Reinstall or recover the base operating system</p>
          </div>
        </div>
        <div className="p-6 space-y-4">
          <p className="text-sm text-gray-600 dark:text-gray-300 leading-relaxed">
            Configure the server to boot into a connected installation USB to perform a fresh operating system reinstallation. 
            This process will clear the base system files, but your personal data and stack volumes will be preserved.
          </p>

          {/* Active BootNext Warning Banner */}
          {bootStatus?.bootNext && bootStatus.entries.some(e => e.bootNum === bootStatus.bootNext) ? (
            (() => {
              const armedEntry = bootStatus.entries.find(e => e.bootNum === bootStatus.bootNext);
              const armedDesc = armedEntry ? armedEntry.description : `Boot${bootStatus.bootNext}`;
              return (
                <div className="p-4 bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-900/50 rounded-lg flex flex-col sm:flex-row sm:items-center justify-between gap-4 animate-pulse">
                  <div className="flex items-start gap-3">
                    <AlertTriangle className="w-5 h-5 text-amber-600 dark:text-amber-400 mt-0.5 flex-shrink-0" />
                    <div>
                      <h4 className="text-sm font-bold text-amber-800 dark:text-amber-400">USB Installation Boot Armed</h4>
                      <p className="text-xs text-amber-700 dark:text-amber-500 mt-1">
                        The system is configured to boot from the installation USB next: <span className="font-semibold font-mono">{armedDesc} ({bootStatus.bootNext})</span>.
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <button
                      onClick={cancelUsbBoot}
                      disabled={cancellingBoot || rebooting}
                      className="px-3 py-1.5 text-xs bg-white dark:bg-gray-800 border border-amber-300 dark:border-amber-800 text-amber-800 dark:text-amber-400 rounded hover:bg-amber-100 dark:hover:bg-amber-900/30 transition disabled:opacity-50"
                    >
                      {cancellingBoot ? 'Cancelling...' : 'Cancel USB Boot'}
                    </button>
                    <button
                      onClick={triggerManualReboot}
                      disabled={cancellingBoot || rebooting}
                      className="px-3 py-1.5 text-xs bg-amber-600 text-white rounded hover:bg-amber-700 transition disabled:opacity-50"
                    >
                      {rebooting ? 'Rebooting...' : 'Reboot Now'}
                    </button>
                  </div>
                </div>
              );
            })()
          ) : (
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pt-2">
              <div className="text-xs text-gray-500 dark:text-gray-400">
                {bootStatus?.candidates && bootStatus.candidates.length > 0 ? (
                  <span className="text-green-600 dark:text-green-400 font-medium">
                    ✓ Detected {bootStatus.candidates.length} bootable installation medium candidate(s).
                  </span>
                ) : (
                  <span className="text-amber-600 dark:text-amber-500 font-medium">
                    ⚠ No bootable USB installation media detected in UEFI boot entries. Plug in the USB to start.
                  </span>
                )}
              </div>
              <button
                onClick={() => setIsReinstallModalOpen(true)}
                disabled={armingBoot || rebooting || !bootStatus?.candidates || bootStatus.candidates.length === 0}
                className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors shadow-sm font-medium text-sm disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
              >
                <Power size={16} />
                {armingBoot ? 'Arming...' : 'Arm USB Boot & Reinstall'}
              </button>
            </div>
          )}
        </div>
      </div>

      <ConfirmModal
        isOpen={isReinstallModalOpen}
        title="Reinstall Operating System"
        message="Are you sure you want to arm the next boot to use the installation USB? The system will reboot immediately to start the installation process."
        confirmText="Confirm & Reboot"
        onConfirm={confirmReinstall}
        onCancel={() => setIsReinstallModalOpen(false)}
      />
    </>
  );
}

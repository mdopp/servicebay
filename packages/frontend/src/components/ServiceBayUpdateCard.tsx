'use client';

import { useEffect, useState } from 'react';
import { CheckCircle2, Clock, Download, Loader2, RefreshCw, XCircle } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import ConfirmModal from '@/components/ConfirmModal';
import { useToast } from '@/providers/ToastProvider';
import { Button, Card, StatusDot } from '@/components/ui';

/**
 * ServiceBay self-update status.
 *
 * Lives here (not in the settings `_lib/helpers`) so both the Settings →
 * System tab AND the Home overview can share this card without duplicating the
 * shape (#2082 consolidates the updater onto Home). Re-exported from
 * settings `_lib/helpers` for backward-compat with its existing importers.
 */
export interface AppUpdateStatus {
  hasUpdate: boolean;
  current: string;
  /**
   * Release tag is ahead but the `:latest` image hasn't been published yet
   * (release-please cuts the tag before the Release workflow pushes the image).
   * Shown as "new version building" rather than an actionable update.
   */
  imageBuilding?: boolean;
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
    };
  };
}

/**
 * ServiceBay self-updater card (#2082).
 *
 * The version-update half of the old `UpdatesSection` — current version,
 * "Check Now", the auto-update toggle, "Update Now" + its progress modal —
 * extracted into one shared component so it can sit on BOTH the Settings →
 * System tab and the Home overview's consolidated "Updates" area without
 * duplicating the `GET/POST /api/system/update` logic.
 *
 * Self-contained: owns its own status fetch (on mount + on "Check Now") and
 * the update progress/confirm modals. Renders nothing destructive — the
 * OS-reinstall block stays in `UpdatesSection` (settings only).
 *
 * Migrated onto the design-system primitives (#2093): the surface is a `Card`,
 * the actions are `Button`s, the version state uses `StatusDot` + status/accent
 * tokens (no raw purple/green/amber literals). Dark-mode-correct by
 * construction — every colour resolves through a semantic CSS variable.
 */
export default function ServiceBayUpdateCard() {
  const { addToast } = useToast();
  const [appUpdate, setAppUpdate] = useState<AppUpdateStatus | null>(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [isUpdateModalOpen, setIsUpdateModalOpen] = useState(false);

  const [updateStatus, setUpdateStatus] = useState<'idle' | 'updating' | 'restarting' | 'error' | 'success' | 'building'>('idle');
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
      <Card padding="md" className="flex items-center gap-space-2 text-sm text-text-muted">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading update status…
      </Card>
    );
  }

  const updateAvailable = appUpdate.hasUpdate && appUpdate.latest;

  return (
    <>
      <Card padding="none" className={updateAvailable ? 'border-accent/40' : undefined}>
        <div className="flex items-center gap-space-3 border-b border-border bg-surface-2 px-space-4 py-space-3">
          <div className="rounded-card bg-accent/10 p-2 text-accent">
            <RefreshCw size={20} className={updateStatus === 'updating' || checkingUpdate ? 'animate-spin' : ''} />
          </div>
          <div>
            <h3 className="font-bold text-text">ServiceBay Updates</h3>
            <p className="text-xs text-text-muted">Manage application updates</p>
          </div>
          <div className="ml-auto flex items-center gap-space-3">
            <Button
              variant="ghost"
              size="sm"
              onClick={handleCheckUpdate}
              disabled={checkingUpdate || updateStatus === 'updating'}
            >
              {checkingUpdate ? 'Checking...' : 'Check Now'}
            </Button>
            <div className="h-4 w-px bg-border"></div>
            <label className="relative inline-flex cursor-pointer items-center" title="Enable Auto-Updates">
              <input
                type="checkbox"
                className="peer sr-only"
                checked={appUpdate.config.autoUpdate.enabled}
                onChange={toggleAutoUpdate}
              />
              <div className="peer h-6 w-11 rounded-full bg-surface-muted after:absolute after:left-[2px] after:top-[2px] after:h-5 after:w-5 after:rounded-full after:border after:border-border after:bg-surface after:transition-all after:content-[''] peer-checked:bg-accent peer-checked:after:translate-x-full peer-checked:after:border-on-accent peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-accent"></div>
            </label>
          </div>
        </div>
        <div className="p-space-5">
          <div className="flex flex-col items-start justify-between gap-space-5 md:flex-row md:items-center">
            <div className="space-y-1">
              <div className="flex items-center gap-space-2">
                <span className="text-sm text-text-muted">Current Version:</span>
                <span className="font-mono font-medium text-text">{appUpdate.current}</span>
              </div>
              {updateAvailable ? (
                <div className="flex items-center gap-space-2 text-status-ok">
                  <StatusDot state="ok" label="Update available" />
                  <Download size={16} />
                  <span className="text-sm font-medium">New version available: {appUpdate.latest!.version}</span>
                </div>
              ) : appUpdate.imageBuilding && appUpdate.latest ? (
                <div className="flex items-center gap-space-2 text-status-warn">
                  <StatusDot state="warn" label="Image building" />
                  <Clock size={16} />
                  <span className="text-sm font-medium">Version {appUpdate.latest.version} released — image still building, try again shortly</span>
                </div>
              ) : (
                <div className="flex items-center gap-space-2 text-text-muted">
                  <StatusDot state="ok" label="Up to date" />
                  <Clock size={16} />
                  <span className="text-sm">You are on the latest version</span>
                </div>
              )}
            </div>

            {updateAvailable && (
              <Button onClick={handleAppUpdate} disabled={updateStatus === 'updating'}>
                <Download size={18} />
                {updateStatus === 'updating' ? 'Updating...' : 'Update Now'}
              </Button>
            )}
          </div>

          {updateAvailable && appUpdate.latest!.notes && (
            <Card padding="md" className="mt-space-4 bg-surface-muted">
              <h4 className="mb-2 text-sm font-bold text-text">Release Notes</h4>
              <div className="prose prose-sm dark:prose-invert max-w-none text-text-muted">
                <ReactMarkdown>{appUpdate.latest!.notes}</ReactMarkdown>
              </div>
            </Card>
          )}
        </div>
      </Card>

      {updateStatus !== 'idle' && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm">
          <Card padding="none" className="w-full max-w-md overflow-hidden shadow-2xl">
            <div className="space-y-6 p-space-5 text-center">
              {updateStatus === 'error' ? (
                <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-status-fail/10 text-status-fail">
                  <XCircle size={32} />
                </div>
              ) : updateStatus === 'building' ? (
                <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-status-warn/10 text-status-warn">
                  <Clock size={32} />
                </div>
              ) : updateStatus === 'restarting' ? (
                <div className="mx-auto flex h-16 w-16 animate-pulse items-center justify-center rounded-full bg-status-ok/10 text-status-ok">
                  <CheckCircle2 size={32} />
                </div>
              ) : (
                <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-accent/10 text-accent">
                  <Loader2 size={32} className="animate-spin" />
                </div>
              )}

              <div>
                <h3 className="mb-2 text-xl font-bold text-text">
                  {updateStatus === 'error' ? 'Update Failed' :
                    updateStatus === 'building' ? 'New Version Still Building' :
                      updateStatus === 'restarting' ? 'Update Complete' :
                        'Updating ServiceBay'}
                </h3>
                <p className="text-sm text-text-muted">
                  {updateStatus === 'error' ? updateError : updateMessage}
                </p>
              </div>

              {updateStatus === 'updating' && (
                <div className="h-2.5 w-full overflow-hidden rounded-full bg-surface-2">
                  <div className="h-2.5 rounded-full bg-accent transition-all duration-300 ease-out" style={{ width: `${updateProgress}%` }}></div>
                </div>
              )}

              {(updateStatus === 'error' || updateStatus === 'building') && (
                <Button variant="secondary" size="sm" onClick={() => setUpdateStatus('idle')}>
                  Close
                </Button>
              )}
            </div>
          </Card>
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

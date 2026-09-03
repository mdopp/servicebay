'use client';

import { useCallback, useEffect, useRef } from 'react';
import {
  Save,
  Trash2,
  RefreshCw,
  Clock,
  Loader2,
  CheckCircle2,
  XCircle,
  UploadCloud,
  ChevronRight,
  Activity,
  Usb,
  Network,
  Folder,
  Cloud,
  Plus,
} from 'lucide-react';
import { useToast } from '@/providers/ToastProvider';
import { Button, Field, Input, Select, Textarea } from '@/components/ui';
import LocalTargetPicker from './LocalTargetPicker';
import type { BackupState } from './useBackupState';

interface Props {
  state: BackupState;
}

/**
 * Backend 3 of 3: **Backup Sync** — the scheduled bulk-data rsync to a
 * local/SSH/SMB/NFS target, with its sources list, connection test and run
 * history. Split out of backup/page.tsx (#2743).
 */
export default function BackupSyncPanel({ state }: Props) {
  const { addToast } = useToast();
  const {
    backupSync, setBackupSync,
    backupSyncHistory, setBackupSyncHistory,
    backupSyncRunning, setBackupSyncRunning,
    backupSyncTesting, setBackupSyncTesting,
    backupSyncSaving, setBackupSyncSaving,
    backupSyncTestResult, setBackupSyncTestResult,
    fetchBackupSync,
  } = state;

  // ─── Backup Sync handlers ─────────────────────────────────────────
  // The "Run Now" progress poller lives in a ref so it can be stopped from
  // anywhere — most importantly on unmount. Before #2459 the 5s interval was
  // created inline and never cleared, so navigating away mid-sync left it firing
  // forever against a view that no longer exists.
  const syncPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const stopSyncPoll = useCallback(() => {
    if (syncPollRef.current !== null) {
      clearInterval(syncPollRef.current);
      syncPollRef.current = null;
    }
  }, []);
  useEffect(() => stopSyncPoll, [stopSyncPoll]);

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
      // Only ever one sync poller (a second Run Now replaces the first), and it
      // dies with the page — see stopSyncPoll / the unmount effect (#2459).
      stopSyncPoll();
      const poll = setInterval(async () => {
        try {
          const r = await fetch('/api/settings/backup-sync');
          const data = await r.json();
          // The interval was cleared while this request was in flight (unmount, or
          // a newer run) — drop the answer instead of writing state for a view
          // that is gone (#2459).
          if (syncPollRef.current !== poll) return;
          if (!data.running) {
            stopSyncPoll();
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
      syncPollRef.current = poll;
    } catch (e) {
      setBackupSyncRunning(false);
      addToast('error', 'Backup Failed', e instanceof Error ? e.message : 'Unknown error');
    }
  };

  return (
    <>
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
                <Input type="checkbox" className="sr-only peer" checked={backupSync.enabled} onChange={e => setBackupSync(prev => ({ ...prev, enabled: e.target.checked }))} />
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
              <Button onClick={addBackupSource} className="inline-flex items-center gap-1 text-xs font-medium text-accent hover:text-accent-strong">
                <Plus size={14} /> Add source
              </Button>
            </div>
            <div className="space-y-3">
              {backupSync.sources.length === 0 && (
                <p className="text-[11px] text-text-muted italic">No sources configured. Add at least one directory to sync.</p>
              )}
              {backupSync.sources.map((src, i) => (
                <div key={i} className="rounded-card border border-border bg-surface-muted p-3 space-y-2">
                  <div className="flex items-center gap-2">
                    <Input
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
                    <Field label="Exclude patterns (one per line)">
                      {(props) => (
                        <Textarea
                          {...props}
                          className="w-full px-3 py-2 text-sm rounded-card border border-border bg-surface-2 text-text font-mono"
                          rows={2}
                          value={src.excludePatterns}
                          onChange={e => updateBackupSource(i, { excludePatterns: e.target.value })}
                          placeholder="*.tmp&#10;cache/"
                        />
                      )}
                    </Field>
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
                  <Button
                    key={val}
                    onClick={() => setBackupSync(prev => ({ ...prev, targetType: val }))}
                    aria-pressed={active}
                    className={`flex items-start gap-2 px-3 py-2 text-left rounded-card border-2 transition-colors ${active ? 'bg-accent/10 border-accent' : 'border-border hover:bg-surface-2 hover:border-border-strong'}`}
                  >
                    <Icon size={16} className={`mt-0.5 flex-shrink-0 ${active ? 'text-accent' : 'text-text-subtle'}`} />
                    <div className="min-w-0">
                      <div className={`text-xs font-semibold ${active ? 'text-accent' : 'text-text'}`}>{label}</div>
                      <div className={`text-[11px] leading-tight ${active ? 'text-accent/70' : 'text-text-muted'}`}>{hint}</div>
                    </div>
                  </Button>
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
              <Field label="Host">
                {(props) => (
                  <Input type="text" {...props} className="w-full px-3 py-2 text-sm rounded-card border border-border bg-surface-2 text-text" value={backupSync.sshHost} onChange={e => setBackupSync(prev => ({ ...prev, sshHost: e.target.value }))} placeholder="192.168.1.100" />
                )}
              </Field>
              <Field label="Port">
                {(props) => (
                  <Input type="text" {...props} className="w-full px-3 py-2 text-sm rounded-card border border-border bg-surface-2 text-text" value={backupSync.sshPort} onChange={e => setBackupSync(prev => ({ ...prev, sshPort: e.target.value }))} placeholder="22" />
                )}
              </Field>
              <Field label="User">
                {(props) => (
                  <Input type="text" {...props} className="w-full px-3 py-2 text-sm rounded-card border border-border bg-surface-2 text-text" value={backupSync.sshUser} onChange={e => setBackupSync(prev => ({ ...prev, sshUser: e.target.value }))} />
                )}
              </Field>
              <Field label="Remote Path">
                {(props) => (
                  <Input type="text" {...props} className="w-full px-3 py-2 text-sm rounded-card border border-border bg-surface-2 text-text" value={backupSync.sshPath} onChange={e => setBackupSync(prev => ({ ...prev, sshPath: e.target.value }))} placeholder="/backup" />
                )}
              </Field>
              <div className="col-span-2">
                <Field label="Identity File">
                  {(props) => (
                    <Input type="text" {...props} className="w-full px-3 py-2 text-sm rounded-card border border-border bg-surface-2 text-text" value={backupSync.sshIdentityFile} onChange={e => setBackupSync(prev => ({ ...prev, sshIdentityFile: e.target.value }))} />
                  )}
                </Field>
              </div>
            </div>
          )}

          {backupSync.targetType === 'smb' && (
            <div className="grid grid-cols-2 gap-3">
              <Field label="Host">
                {(props) => (
                  <Input type="text" {...props} className="w-full px-3 py-2 text-sm rounded-card border border-border bg-surface-2 text-text" value={backupSync.smbHost} onChange={e => setBackupSync(prev => ({ ...prev, smbHost: e.target.value }))} placeholder="nas.local" />
                )}
              </Field>
              <Field label="Share Name">
                {(props) => (
                  <Input type="text" {...props} className="w-full px-3 py-2 text-sm rounded-card border border-border bg-surface-2 text-text" value={backupSync.smbShare} onChange={e => setBackupSync(prev => ({ ...prev, smbShare: e.target.value }))} placeholder="backup" />
                )}
              </Field>
              <Field label="Subfolder (optional)">
                {(props) => (
                  <Input type="text" {...props} className="w-full px-3 py-2 text-sm rounded-card border border-border bg-surface-2 text-text" value={backupSync.smbPath} onChange={e => setBackupSync(prev => ({ ...prev, smbPath: e.target.value }))} />
                )}
              </Field>
              <Field label="Username">
                {(props) => (
                  <Input type="text" {...props} className="w-full px-3 py-2 text-sm rounded-card border border-border bg-surface-2 text-text" value={backupSync.smbUsername} onChange={e => setBackupSync(prev => ({ ...prev, smbUsername: e.target.value }))} />
                )}
              </Field>
              <div className="col-span-2">
                <Field label="Password">
                  {(props) => (
                    <Input type="password" {...props} className="w-full px-3 py-2 text-sm rounded-card border border-border bg-surface-2 text-text" value={backupSync.smbPassword} onChange={e => setBackupSync(prev => ({ ...prev, smbPassword: e.target.value }))} />
                  )}
                </Field>
              </div>
            </div>
          )}

          {backupSync.targetType === 'nfs' && (
            <div className="grid grid-cols-2 gap-3">
              <Field label="Host">
                {(props) => (
                  <Input type="text" {...props} className="w-full px-3 py-2 text-sm rounded-card border border-border bg-surface-2 text-text" value={backupSync.nfsHost} onChange={e => setBackupSync(prev => ({ ...prev, nfsHost: e.target.value }))} placeholder="nas.local" />
                )}
              </Field>
              <Field label="Export Path">
                {(props) => (
                  <Input type="text" {...props} className="w-full px-3 py-2 text-sm rounded-card border border-border bg-surface-2 text-text" value={backupSync.nfsExport} onChange={e => setBackupSync(prev => ({ ...prev, nfsExport: e.target.value }))} placeholder="/volume1/backup" />
                )}
              </Field>
              <div className="col-span-2">
                <Field label="Subfolder (optional)">
                  {(props) => (
                    <Input type="text" {...props} className="w-full px-3 py-2 text-sm rounded-card border border-border bg-surface-2 text-text" value={backupSync.nfsPath} onChange={e => setBackupSync(prev => ({ ...prev, nfsPath: e.target.value }))} />
                  )}
                </Field>
              </div>
            </div>
          )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Schedule">
              {(props) => (
                <Select {...props} className="w-full px-3 py-2 text-sm rounded-card border border-border bg-surface-2 text-text" value={backupSync.schedule} onChange={e => setBackupSync(prev => ({ ...prev, schedule: e.target.value as 'hourly' | 'daily' | 'weekly' | 'monthly' }))}>
                  <option value="hourly">Hourly</option>
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                  <option value="monthly">Monthly</option>
                </Select>
              )}
            </Field>
            <Field label="Time (UTC)">
              {(props) => (
                <Input type="time" {...props} className="w-full px-3 py-2 text-sm rounded-card border border-border bg-surface-2 text-text" value={backupSync.time} onChange={e => setBackupSync(prev => ({ ...prev, time: e.target.value }))} />
              )}
            </Field>
            {backupSync.schedule === 'weekly' && (
              <Field label="Day of Week">
                {(props) => (
                  <Select {...props} className="w-full px-3 py-2 text-sm rounded-card border border-border bg-surface-2 text-text" value={backupSync.dayOfWeek ?? 0} onChange={e => setBackupSync(prev => ({ ...prev, dayOfWeek: parseInt(e.target.value) }))}>
                    {['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((d, i) => (
                      <option key={i} value={i}>{d}</option>
                    ))}
                  </Select>
                )}
              </Field>
            )}
            {backupSync.schedule === 'monthly' && (
              <Field label="Day of Month">
                {(props) => (
                  <Input type="number" min={1} max={28} {...props} className="w-full px-3 py-2 text-sm rounded-card border border-border bg-surface-2 text-text" value={backupSync.dayOfMonth ?? 1} onChange={e => setBackupSync(prev => ({ ...prev, dayOfMonth: parseInt(e.target.value) || 1 }))} />
                )}
              </Field>
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
    </>
  );
}


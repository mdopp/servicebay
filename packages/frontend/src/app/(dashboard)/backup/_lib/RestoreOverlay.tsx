'use client';

import {
  Loader2,
  Server,
  RotateCcw,
  UploadCloud,
  X,
  ChevronDown,
  ChevronRight,
  Settings,
  Activity,
} from 'lucide-react';
import { Button, Field, Input } from '@/components/ui';
import FileViewer from '@/components/FileViewer';
import { resolveFilePreviewLanguage } from './helpers';
import RestoreSystemdFilesSection from './RestoreSystemdFilesSection';
import RestoreServiceDataSection from './RestoreServiceDataSection';
import type { BackupState } from './useBackupState';
import type { RestoreFlow } from './useRestoreFlow';

interface Props {
  state: BackupState;
  restore: RestoreFlow;
}

/**
 * The selective-restore side panel and the file-preview modal that hangs off
 * it. Renders the flow from `useRestoreFlow`; the two big per-file accordions
 * live in their own components. Split out of backup/page.tsx (#2743).
 */
export default function RestoreOverlay({ state, restore }: Props) {
  const {
    restoreOverlayOpen,
    restoringBackup,
    restorePreview,
    restoreSource,
    restoreUploadError,
    restoreSelectionState,
    restoreExpandedSections,
    restoreFilePreview, setRestoreFilePreview,
    restoreFilePreviewError,
  } = state;
  const {
    closeRestoreOverlay,
    handleRestoreFromFile,
    confirmRestoreBackup,
    selectAllRestoreItems,
    handleRestoreDrop,
    handleRestoreDragOver,
    stopRestoreEvent,
    handleRestoreBackdrop,
    toggleRestoreConfigFlag,
    toggleRestoreNode,
    toggleRestoreCheck,
    toggleRestoreSection,
    getRestoreSelectionSummary,
  } = restore;

  return (
    <>
      {restoreOverlayOpen && (
        <div className="fixed inset-0 z-[90] flex items-stretch justify-end" onMouseDown={stopRestoreEvent} onClick={stopRestoreEvent}>
          <div className="absolute inset-0 bg-background/70 backdrop-blur-sm" onClick={handleRestoreBackdrop} />
          <aside className="relative z-10 w-full max-w-3xl h-full bg-surface border-l border-border shadow-2xl flex flex-col">
            <div className="flex items-center justify-between px-6 py-4 border-b border-border">
              <div>
                <h3 className="text-lg font-semibold text-text">Restore from Backup</h3>
                <p className="text-xs text-text-muted">Select what to restore before applying changes.</p>
              </div>
              <Button onClick={closeRestoreOverlay} className="rounded-full p-2 text-text-muted hover:text-text hover:bg-surface-2" aria-label="Close restore panel">
                <X size={18} />
              </Button>
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
                    <Input id="restore-backup-file" type="file" accept=".tar.gz" className="hidden" onChange={(event) => handleRestoreFromFile(event.target.files?.[0] || null)} />
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
                    <Button onClick={() => toggleRestoreSection('settings')} className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-surface-2 transition-colors">
                      {restoreExpandedSections.settings ? <ChevronDown size={16} className="text-text-subtle shrink-0" /> : <ChevronRight size={16} className="text-text-subtle shrink-0" />}
                      <Settings size={16} className="text-text-subtle shrink-0" />
                      <div className="flex-1 min-w-0">
                        <span className="text-sm font-medium text-text">Settings</span>
                        <span className="ml-2 text-xs text-text-muted">
                          {Object.values(restoreSelectionState.configFlags).filter(Boolean).length} of {Object.keys(restoreSelectionState.configFlags).length} selected
                        </span>
                      </div>
                    </Button>
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
                            <Field label="">
                              {(props) => (
                                <Input type="checkbox" {...props} className="rounded" checked={restoreSelectionState.configFlags[item.key]} onChange={() => toggleRestoreConfigFlag(item.key)} />
                              )}
                            </Field>
                            <span className="font-medium min-w-[120px]">{item.label}</span>
                            <span className="text-xs text-text-muted truncate">{item.summary}</span>
                          </label>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Nodes & Checks */}
                  <div className="rounded-card border border-border overflow-hidden">
                    <Button onClick={() => toggleRestoreSection('infrastructure')} className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-surface-2 transition-colors">
                      {restoreExpandedSections.infrastructure ? <ChevronDown size={16} className="text-text-subtle shrink-0" /> : <ChevronRight size={16} className="text-text-subtle shrink-0" />}
                      <Activity size={16} className="text-text-subtle shrink-0" />
                      <div className="flex-1 min-w-0">
                        <span className="text-sm font-medium text-text">Nodes & Health</span>
                        <span className="ml-2 text-xs text-text-muted">
                          {Object.values(restoreSelectionState.nodes).filter(Boolean).length} node{Object.values(restoreSelectionState.nodes).filter(Boolean).length !== 1 ? 's' : ''},
                          {' '}{Object.values(restoreSelectionState.checks).filter(Boolean).length} check{Object.values(restoreSelectionState.checks).filter(Boolean).length !== 1 ? 's' : ''}
                        </span>
                      </div>
                    </Button>
                    {restoreExpandedSections.infrastructure && (
                      <div className="px-4 pb-4 pt-1 border-t border-border space-y-4">
                        {restorePreview.config.nodes.length > 0 && (
                          <div>
                            <p className="text-xs font-medium text-text-muted uppercase tracking-wide mb-2">Nodes</p>
                            <div className="grid gap-2">
                              {restorePreview.config.nodes.map(node => (
                                <div key={node.name} className="flex items-center gap-3 text-sm text-text">
                                  <Field label="">
                                    {(props) => (
                                      <Input type="checkbox" {...props} className="rounded" checked={restoreSelectionState.nodes[node.name]} onChange={() => toggleRestoreNode(node.name)} />
                                    )}
                                  </Field>
                                  <Server size={14} className="text-text-subtle shrink-0" />
                                  <span className="font-medium">{node.name}</span>
                                  <span className="text-xs text-text-muted">{node.uri}{node.default ? ' · Default' : ''}</span>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                        {restorePreview.config.checks.length > 0 && (
                          <div>
                            <p className="text-xs font-medium text-text-muted uppercase tracking-wide mb-2">Health Checks</p>
                            <div className="grid gap-2">
                              {restorePreview.config.checks.map(check => (
                                <div key={check.id} className="flex items-center gap-3 text-sm text-text">
                                  <Field label="">
                                    {(props) => (
                                      <Input type="checkbox" {...props} className="rounded" checked={restoreSelectionState.checks[check.id]} onChange={() => toggleRestoreCheck(check.id)} />
                                    )}
                                  </Field>
                                  <span className="font-medium">{check.name}</span>
                                  {check.type && <span className="text-[10px] uppercase px-1.5 py-0.5 rounded bg-surface-2 text-text-muted">{check.type}</span>}
                                  {check.target && <span className="text-xs text-text-muted">{check.target}</span>}
                                </div>
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
                  <RestoreSystemdFilesSection state={state} restore={restore} />
                  <RestoreServiceDataSection state={state} restore={restore} />
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
          <div className="absolute inset-0 bg-background/70 backdrop-blur-sm" onClick={() => setRestoreFilePreview(null)} />
          <div className="relative z-10 w-full max-w-5xl max-h-[85vh] bg-surface border border-border rounded-card shadow-2xl overflow-hidden flex flex-col">
            <div className="flex items-center justify-between px-5 py-3 border-b border-border">
              <div>
                <p className="text-sm font-semibold text-text">Backup File Preview</p>
                <p className="text-xs text-text-muted">
                  {restoreFilePreview.nodeName} · <span className="font-mono">{restoreFilePreview.relativePath}</span>
                </p>
              </div>
              <Button onClick={() => setRestoreFilePreview(null)} className="rounded-full p-2 text-text-muted hover:text-text hover:bg-surface-2" aria-label="Close file preview">
                <X size={18} />
              </Button>
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
    </>
  );
}


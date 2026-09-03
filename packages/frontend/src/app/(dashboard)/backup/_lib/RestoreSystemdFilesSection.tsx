'use client';

import { Eye, ChevronDown, ChevronRight, FolderOpen } from 'lucide-react';
import { Button, Field, Input, Select } from '@/components/ui';
import { groupFilesByService } from './helpers';
import type { BackupState } from './useBackupState';
import type { RestoreFlow } from './useRestoreFlow';

interface Props {
  state: BackupState;
  restore: RestoreFlow;
}

/**
 * The "Systemd Files" accordion of the restore overlay — per node, per service,
 * per file selection plus the target-node picker. Split out of
 * backup/page.tsx (#2743).
 */
export default function RestoreSystemdFilesSection({ state, restore }: Props) {
  const { restorePreview, restoreSelectionState, restoreExpandedSections } = state;
  const {
    handleRestoreFilePreview,
    availableRestoreTargets,
    toggleRestoreFile,
    updateRestoreTargetNode,
    toggleRestoreSection,
    toggleAllNodeFiles,
    toggleServiceGroupFiles,
  } = restore;
  if (!restorePreview || !restoreSelectionState) return null;

  return (
    <>
      {/* Systemd Files */}
      {restorePreview.nodeFiles.length > 0 && (
        <div className="rounded-card border border-border overflow-hidden">
          <Button onClick={() => toggleRestoreSection('files')} className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-surface-2 transition-colors">
            {restoreExpandedSections.files ? <ChevronDown size={16} className="text-text-subtle shrink-0" /> : <ChevronRight size={16} className="text-text-subtle shrink-0" />}
            <FolderOpen size={16} className="text-text-subtle shrink-0" />
            <div className="flex-1 min-w-0">
              <span className="text-sm font-medium text-text">Systemd Files</span>
              <span className="ml-2 text-xs text-text-muted">
                {Object.values(restoreSelectionState.nodeFiles).reduce((sum, files) => sum + Object.values(files).filter(Boolean).length, 0)} of {restorePreview.nodeFiles.reduce((sum, g) => sum + g.files.length, 0)} files selected
              </span>
            </div>
          </Button>
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
                        <Field label="">
                          {(props) => (
                            <Input type="checkbox" {...props} className="rounded" checked={allSelected} onChange={() => toggleAllNodeFiles(group.nodeName, !allSelected)} />
                          )}
                        </Field>
                        <span className="text-sm font-medium text-text">{group.nodeName}</span>
                        <span className="text-xs text-text-muted">{selectedCount}/{group.files.length} files</span>
                      </div>
                      <div className="flex items-center gap-2 text-xs text-text-muted">
                        <span>Target:</span>
                        <Field label="">
                          {(props) => (
                            <Select {...props} value={restoreSelectionState.targetNodes[group.nodeName]} onChange={(event) => updateRestoreTargetNode(group.nodeName, event.target.value)} className="bg-surface-2 border border-border text-text rounded px-2 py-1 text-xs">
                              {availableRestoreTargets.map(target => (<option key={target} value={target}>{target}</option>))}
                            </Select>
                          )}
                        </Field>
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
                              <Field label="">
                                {(props) => (
                                  <Input type="checkbox" {...props} className="rounded" checked={sgAllSelected} onChange={() => toggleServiceGroupFiles(group.nodeName, sg.files, !sgAllSelected)} />
                                )}
                              </Field>
                              <Button onClick={() => toggleRestoreSection(sgKey)} className="flex items-center gap-1.5 flex-1 min-w-0 text-left">
                                {sgExpanded ? <ChevronDown size={12} className="text-text-subtle shrink-0" /> : <ChevronRight size={12} className="text-text-subtle shrink-0" />}
                                <span className="text-xs font-medium text-text capitalize">{displayName}</span>
                                <span className="text-[10px] text-text-subtle">{sgSelectedCount}/{sg.files.length}</span>
                              </Button>
                            </div>
                            {sgExpanded && (
                              <div className="pl-10 pr-4 pb-1">
                                {sg.files.map(file => (
                                  <div key={file.relativePath} className="flex items-center gap-3 py-1 text-xs text-text-muted">
                                    <Field label="">
                                      {(props) => (
                                        <Input type="checkbox" {...props} className="rounded" checked={Boolean(restoreSelectionState.nodeFiles[group.nodeName]?.[file.relativePath])} onChange={() => toggleRestoreFile(group.nodeName, file.relativePath)} />
                                      )}
                                    </Field>
                                    <span className="flex-1 font-mono truncate">{file.fileName}</span>
                                    <Button onClick={() => handleRestoreFilePreview(group.nodeName, file.relativePath)} className="shrink-0 p-1 rounded text-text-subtle hover:text-text hover:bg-surface-2" title="Preview file">
                                      <Eye size={14} />
                                    </Button>
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
    </>
  );
}


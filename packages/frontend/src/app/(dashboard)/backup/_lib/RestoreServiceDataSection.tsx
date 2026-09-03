'use client';

import { HardDrive, ChevronDown, ChevronRight, Database } from 'lucide-react';
import { Button, Field, Input } from '@/components/ui';
import {
  groupServiceDataFiles,
  SERVICE_DATA_CATEGORY_ICONS,
  SERVICE_DATA_CATEGORY_LABELS,
} from './helpers';
import RestoreServiceDataCategories from './RestoreServiceDataCategories';
import type { BackupState } from './useBackupState';
import type { RestoreFlow } from './useRestoreFlow';

interface Props {
  state: BackupState;
  restore: RestoreFlow;
}

/**
 * The "Service Config" accordion of the restore overlay — per service, per
 * category, per file selection of the service-data payload. Split out of
 * backup/page.tsx (#2743).
 */
export default function RestoreServiceDataSection({ state, restore }: Props) {
  const { restorePreview, restoreSelectionState, restoreExpandedSections, setRestoreSelectionState } = state;
  const { toggleRestoreSection } = restore;
  if (!restorePreview || !restoreSelectionState) return null;

  return (
    <>
      {restorePreview.serviceData && restorePreview.serviceData.length > 0 && (
        <div className="rounded-card border border-border overflow-hidden">
          <Button onClick={() => toggleRestoreSection('serviceData')} className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-surface-2 transition-colors">
            {restoreExpandedSections.serviceData ? <ChevronDown size={16} className="text-text-subtle shrink-0" /> : <ChevronRight size={16} className="text-text-subtle shrink-0" />}
            <Database size={16} className="text-text-subtle shrink-0" />
            <div className="flex-1 min-w-0">
              <span className="text-sm font-medium text-text">Service Config</span>
              <span className="ml-2 text-xs text-text-muted">
                {Object.values(restoreSelectionState.serviceData).reduce((sum, fm) => sum + Object.values(fm).filter(Boolean).length, 0)} file{Object.values(restoreSelectionState.serviceData).reduce((sum, fm) => sum + Object.values(fm).filter(Boolean).length, 0) !== 1 ? 's' : ''} selected
              </span>
            </div>
          </Button>
          {restoreExpandedSections.serviceData && (
            <div className="px-4 pb-4 pt-1 border-t border-border space-y-3">
              <p className="text-xs text-status-warn bg-status-warn/10 border border-status-warn/30 rounded-card px-3 py-2">
                This is each service&apos;s <span className="font-semibold">config</span> — Home Assistant&apos;s automations and <span className="font-mono">.storage</span> registries, the Z-Wave network keys, AdGuard / Authelia / Syncthing / nginx settings, and so on. It is <span className="font-semibold">not</span> bulk data (the Immich photo library, the recorder history DB, the Z-Wave mesh DB) — that stays on disk on a wipe-configs reinstall and is Backup Sync&apos;s job. A wipe-configs reinstall does <span className="font-semibold">not</span> pull this config back automatically; select it here to recover it, or services come up with default settings.
              </p>
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
                  <div key={sd.name} className="rounded border border-border">
                    <div className="flex items-center gap-2 px-3 py-2">
                      <Field label="">
                        {(props) => (
                          <Input type="checkbox" {...props} className="rounded" checked={allSelected} onChange={() => setRestoreSelectionState(prev => {
                            if (!prev) return prev;
                            const newVal = !allSelected;
                            return { ...prev, serviceData: { ...prev.serviceData, [sd.name]: Object.fromEntries(sd.files.map(f => [f, newVal])) } };
                          })} />
                        )}
                      </Field>
                      <Button onClick={() => toggleRestoreSection(sdKey)} className="flex items-center gap-2 flex-1 min-w-0">
                        {sdExpanded ? <ChevronDown size={14} className="text-text-subtle shrink-0" /> : <ChevronRight size={14} className="text-text-subtle shrink-0" />}
                        <HardDrive size={14} className="text-text-subtle shrink-0" />
                        <div className="flex flex-col items-start min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium text-text">{label}</span>
                            <span className="text-xs text-text-muted">{selectedCount}/{sd.files.length}</span>
                          </div>
                          {(sd.sourcePath || sd.nodeName) && (
                            <span className="text-[11px] text-text-subtle font-mono truncate max-w-full">
                              → {sd.nodeName ? `${sd.nodeName}:` : ''}{sd.sourcePath}
                            </span>
                          )}
                        </div>
                      </Button>
                      <div className="flex items-center gap-1 shrink-0">
                        {fileCategories.map(cat => (
                          <Button key={cat.category} title={`Select only ${SERVICE_DATA_CATEGORY_LABELS[cat.category].toLowerCase()} (${cat.files.length} files)`} onClick={() => setRestoreSelectionState(prev => {
                            if (!prev) return prev;
                            const newFiles: Record<string, boolean> = {};
                            for (const f of sd.files) newFiles[f] = false;
                            for (const f of cat.files) newFiles[f] = true;
                            return { ...prev, serviceData: { ...prev.serviceData, [sd.name]: newFiles } };
                          })} className="px-1.5 py-0.5 text-xs rounded border border-border hover:bg-surface-2 transition-colors">
                            {SERVICE_DATA_CATEGORY_ICONS[cat.category]}
                          </Button>
                        ))}
                      </div>
                    </div>

                    {sdExpanded && (
                      <RestoreServiceDataCategories
                        sd={sd}
                        fileCategories={fileCategories}
                        restoreExpandedSections={restoreExpandedSections}
                        restoreSelectionState={restoreSelectionState}
                        setRestoreSelectionState={setRestoreSelectionState}
                        toggleRestoreSection={toggleRestoreSection}
                      />
                    )}
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


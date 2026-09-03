'use client';

import { ChevronDown, ChevronRight } from 'lucide-react';
import { Button, Field, Input } from '@/components/ui';
import type { BackupPreviewResult } from '@/lib/systemBackup';
import {
  groupServiceDataFiles,
  SERVICE_DATA_CATEGORY_ICONS,
  SERVICE_DATA_CATEGORY_LABELS,
} from './helpers';
import type { BackupState } from './useBackupState';

type ServiceDataEntry = NonNullable<BackupPreviewResult['serviceData']>[number];

interface Props {
  sd: ServiceDataEntry;
  fileCategories: ReturnType<typeof groupServiceDataFiles>;
  restoreExpandedSections: BackupState['restoreExpandedSections'];
  restoreSelectionState: NonNullable<BackupState['restoreSelectionState']>;
  setRestoreSelectionState: BackupState['setRestoreSelectionState'];
  toggleRestoreSection: (section: string) => void;
}

/**
 * The expanded body of one service in the restore overlay's "Service Config"
 * accordion: one collapsible row per file category, each with a per-file list.
 * Its own component so the category cascade is readable and does not repeat the
 * service-level closing structure (#2743).
 */
export default function RestoreServiceDataCategories({
  sd,
  fileCategories,
  restoreExpandedSections,
  restoreSelectionState,
  setRestoreSelectionState,
  toggleRestoreSection,
}: Props) {
  return (
      <div className="px-3 pb-3 pt-1 border-t border-border space-y-2">
        {fileCategories.map(cat => {
          const catKey = `sd-${sd.name}-${cat.category}`;
          const catExpanded = restoreExpandedSections[catKey];
          const catSelectedCount = cat.files.filter(f => restoreSelectionState.serviceData[sd.name]?.[f]).length;
          const catAllSelected = catSelectedCount === cat.files.length;
          return (
            <div key={cat.category}>
              <div className="flex items-center gap-2">
                <Field label="">
                  {(props) => (
                    <Input type="checkbox" {...props} className="rounded" checked={catAllSelected} onChange={() => setRestoreSelectionState(prev => {
                      if (!prev) return prev;
                      const updated = { ...prev.serviceData[sd.name] };
                      const newVal = !catAllSelected;
                      for (const f of cat.files) updated[f] = newVal;
                      return { ...prev, serviceData: { ...prev.serviceData, [sd.name]: updated } };
                    })} />
                  )}
                </Field>
                <Button onClick={() => toggleRestoreSection(catKey)} className="flex items-center gap-1.5 flex-1 min-w-0">
                  {catExpanded ? <ChevronDown size={12} className="text-text-subtle shrink-0" /> : <ChevronRight size={12} className="text-text-subtle shrink-0" />}
                  <span className="text-xs">{SERVICE_DATA_CATEGORY_ICONS[cat.category]}</span>
                  <span className="text-xs font-medium text-text-muted">{SERVICE_DATA_CATEGORY_LABELS[cat.category]}</span>
                  <span className="text-xs text-text-muted">{catSelectedCount}/{cat.files.length}</span>
                </Button>
              </div>
              {catExpanded && (
                <div className="ml-6 mt-1 space-y-0.5">
                  {cat.files.map(file => (
                    <div key={file} className="flex items-center gap-2 text-xs text-text-muted py-0.5">
                      <Field label="">
                        {(props) => (
                          <Input type="checkbox" {...props} className="rounded" checked={Boolean(restoreSelectionState.serviceData[sd.name]?.[file])} onChange={() => setRestoreSelectionState(prev => {
                            if (!prev) return prev;
                            const updated = { ...prev.serviceData[sd.name] };
                            updated[file] = !updated[file];
                            return { ...prev, serviceData: { ...prev.serviceData, [sd.name]: updated } };
                          })} />
                        )}
                      </Field>
                      <span className="font-mono truncate">{file}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
  );
}

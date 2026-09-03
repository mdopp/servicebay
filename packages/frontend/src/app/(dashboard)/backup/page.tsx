'use client';

import { useEffect, useState } from 'react';
import PageHeader from '@/components/PageHeader';
import { fetchNodes } from '@servicebay/api-client';
import type { PodmanConnection } from '@/lib/nodes';
import { useBackupState } from './_lib/useBackupState';
import { useRestoreFlow } from './_lib/useRestoreFlow';
import SystemSnapshotPanel from './_lib/SystemSnapshotPanel';
import NasBackupPanel from './_lib/NasBackupPanel';
import BackupSyncPanel from './_lib/BackupSyncPanel';
import RestoreOverlay from './_lib/RestoreOverlay';

/**
 * Backup & restore — one panel per backend (local system tar / external NAS /
 * scheduled Backup Sync) plus the shared selective-restore overlay. The page
 * itself only owns the node list, the shared state bag and the layout; every
 * panel is its own component under `_lib/` (#2743).
 */
export default function BackupPage() {
  // Backup is its own app now (#1958), outside the settings <SettingsProvider>,
  // so it loads the node list directly instead of reading the settings context.
  const [nodes, setNodes] = useState<PodmanConnection[]>([]);
  useEffect(() => {
    void fetchNodes().then(setNodes).catch(() => {});
  }, []);

  const state = useBackupState();
  const restore = useRestoreFlow(state, nodes);
  const { fetchBackups, fetchBackupSync, fetchNasOverview, nasOverview } = state;

  useEffect(() => { void fetchNasOverview(); }, [fetchNasOverview]);
  useEffect(() => { void fetchBackups(); }, [fetchBackups]);
  useEffect(() => { void fetchBackupSync(); }, [fetchBackupSync]);

  // The nightly NAS-backup schedule (#1890), surfaced on both sections so the
  // operator sees the real time + next run instead of a vague "nightly".
  const schedule = nasOverview?.schedule;
  const scheduleLine = !schedule
    ? null
    : !schedule.enabled
      ? 'Nightly NAS backup is disabled.'
      : `Runs nightly at ${schedule.time} UTC` +
        (schedule.nextRunAt ? ` · next run ${new Date(schedule.nextRunAt).toLocaleString()}` : '');

  return (
    <div className="h-full flex flex-col min-h-0">
      <PageHeader title="Backup & restore" helpId="backups" />
      <div id="backups" className="flex-1 overflow-y-auto p-4 md:p-6 space-y-6 scroll-mt-24">
        <SystemSnapshotPanel
          state={state}
          scheduleLine={scheduleLine}
          openRestoreOverlay={restore.openRestoreOverlay}
          handleRestoreRequest={restore.handleRestoreRequest}
        />
        <NasBackupPanel state={state} scheduleLine={scheduleLine} />
        <BackupSyncPanel state={state} />
        <RestoreOverlay state={state} restore={restore} />
      </div>
    </div>
  );
}

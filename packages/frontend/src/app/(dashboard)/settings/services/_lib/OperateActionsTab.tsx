'use client';

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { PlayCircle, Power, RotateCw, RefreshCw, Trash2, DatabaseBackup, Loader2 } from 'lucide-react';
import { logger, type ServiceViewModel } from '@servicebay/api-client';
import ActionProgressModal from '@/components/ActionProgressModal';
import ConfirmModal from '@/components/ConfirmModal';
import { useToast } from '@/providers/ToastProvider';
import { Button, SectionHeading } from '@/components/ui';

/**
 * Actions tab of a service's Operate page (#1957). The lifecycle controls that
 * used to live behind the Services-dashboard "Actions" modal, co-located with
 * the service's Health and Settings: start / stop / restart / update, back up
 * config to NAS, and delete.
 */
export default function OperateActionsTab({
  service,
  deletedHref = '/settings/services',
}: {
  service: ServiceViewModel;
  /** Where to navigate after the service is deleted (defaults to the settings
   *  services index; the primary `/services/[name]` Operate page passes `/services`). */
  deletedHref?: string;
}) {
  const router = useRouter();
  const { addToast, updateToast } = useToast();
  const serviceName = service.id || service.name;
  const baseName = serviceName.replace(/\.(service|scope|socket|timer)$/, '');
  const nodeParam = service.nodeName && service.nodeName !== 'Local' ? service.nodeName : '';

  const [currentAction, setCurrentAction] = useState<'start' | 'stop' | 'restart' | null>(null);
  const [actionModalOpen, setActionModalOpen] = useState(false);
  const [runningAction, setRunningAction] = useState<string | null>(null);
  const [backingUp, setBackingUp] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteInFlight, setDeleteInFlight] = useState(false);

  const openLifecycle = useCallback((action: 'start' | 'stop' | 'restart') => {
    setCurrentAction(action);
    setActionModalOpen(true);
  }, []);

  const runUpdate = useCallback(async () => {
    setRunningAction('update');
    const toastId = addToast('loading', 'Action in progress', `Updating ${service.name}…`, 0);
    try {
      const query = nodeParam ? `?node=${nodeParam}` : '';
      const res = await fetch(`/api/services/${encodeURIComponent(serviceName)}/action${query}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'update' }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        updateToast(toastId, 'error', 'Action failed', data.error || `HTTP ${res.status}`);
      } else {
        updateToast(toastId, 'success', 'Update initiated', `update command sent to ${service.name}`);
      }
    } catch (e) {
      logger.error('OperateActionsTab', 'update failed', e);
      updateToast(toastId, 'error', 'Action failed', 'An unexpected error occurred.');
    } finally {
      setRunningAction(null);
    }
  }, [addToast, updateToast, service.name, serviceName, nodeParam]);

  const handleBackup = useCallback(async () => {
    setBackingUp(true);
    const toastId = addToast('loading', 'Backing up config', service.name, 0);
    try {
      const res = await fetch('/api/system/external-backup/backup-now', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ service: baseName }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.ok === false) {
        updateToast(toastId, 'error', 'Backup failed', data?.error || undefined);
      } else {
        updateToast(toastId, 'success', 'Config backed up to NAS');
      }
    } catch (e) {
      updateToast(toastId, 'error', 'Backup failed', e instanceof Error ? e.message : undefined);
    } finally {
      setBackingUp(false);
    }
  }, [addToast, updateToast, service.name, baseName]);

  const handleDelete = useCallback(async () => {
    if (deleteInFlight) return;
    setDeleteInFlight(true);
    const toastId = addToast('loading', 'Deleting service…', `Removing ${service.name}`, 0);
    try {
      const query = nodeParam ? `?node=${nodeParam}` : '';
      const res = await fetch(`/api/services/${encodeURIComponent(serviceName)}${query}`, { method: 'DELETE' });
      if (res.ok) {
        updateToast(toastId, 'success', 'Service deleted', `${service.name} has been removed.`);
        router.push(deletedHref);
      } else {
        const data = await res.json().catch(() => ({}));
        updateToast(toastId, 'error', 'Delete failed', data.error);
      }
    } catch {
      updateToast(toastId, 'error', 'Delete failed', 'An unexpected error occurred.');
    } finally {
      setDeleteInFlight(false);
      setDeleteOpen(false);
    }
  }, [addToast, updateToast, deleteInFlight, router, service.name, serviceName, nodeParam, deletedHref]);

  return (
    // Consistent layout (#2078): every action is the same <Button> primitive on a
    // uniform 2-col grid, grouped under <SectionHeading> sections, so the controls
    // share one size/rhythm instead of the old mixed 2-col/full-width/oversized mix
    // that read 'deplaziert'.
    <div className="space-y-6 max-w-xl">
      <section className="space-y-3" aria-label="Lifecycle actions">
        <SectionHeading as="h3">Lifecycle</SectionHeading>
        <div className="grid grid-cols-2 gap-2">
          <ActionButton onClick={() => openLifecycle('start')} icon={<PlayCircle size={16} />} label="Start" />
          <ActionButton onClick={() => openLifecycle('stop')} icon={<Power size={16} />} label="Stop" />
          <ActionButton onClick={() => openLifecycle('restart')} icon={<RotateCw size={16} />} label="Restart" />
          <ActionButton onClick={runUpdate} running={runningAction === 'update'} icon={<RefreshCw size={16} />} label="Update & Restart" />
        </div>
      </section>

      <section className="space-y-3" aria-label="Data actions">
        <SectionHeading as="h3">Data</SectionHeading>
        <div className="grid grid-cols-2 gap-2">
          <ActionButton onClick={handleBackup} running={backingUp} icon={<DatabaseBackup size={16} />} label="Back up config to NAS" />
        </div>
      </section>

      <section className="space-y-3" aria-label="Danger zone actions">
        <SectionHeading as="h3" tone="danger">Danger zone</SectionHeading>
        <div className="grid grid-cols-2 gap-2">
          <Button variant="danger" onClick={() => setDeleteOpen(true)} className="w-full">
            <Trash2 size={16} /> Delete service
          </Button>
        </div>
      </section>

      <OperateActionModals
        service={service}
        serviceName={serviceName}
        currentAction={currentAction}
        actionModalOpen={actionModalOpen}
        onActionClose={() => setActionModalOpen(false)}
        onActionComplete={() => {
          const past = currentAction === 'stop' ? 'stopped' : currentAction === 'start' ? 'started' : 'restarted';
          addToast('success', `Service ${past} successfully`);
        }}
        deleteOpen={deleteOpen}
        deleteInFlight={deleteInFlight}
        onDelete={handleDelete}
        onDeleteCancel={() => { if (!deleteInFlight) setDeleteOpen(false); }}
      />
    </div>
  );
}

function OperateActionModals({
  service,
  serviceName,
  currentAction,
  actionModalOpen,
  onActionClose,
  onActionComplete,
  deleteOpen,
  deleteInFlight,
  onDelete,
  onDeleteCancel,
}: {
  service: ServiceViewModel;
  serviceName: string;
  currentAction: 'start' | 'stop' | 'restart' | null;
  actionModalOpen: boolean;
  onActionClose: () => void;
  onActionComplete: () => void;
  deleteOpen: boolean;
  deleteInFlight: boolean;
  onDelete: () => void;
  onDeleteCancel: () => void;
}) {
  return (
    <>
      {currentAction && (
        <ActionProgressModal
          isOpen={actionModalOpen}
          onClose={onActionClose}
          serviceName={serviceName}
          nodeName={service.nodeName}
          action={currentAction}
          onComplete={onActionComplete}
        />
      )}

      <ConfirmModal
        isOpen={deleteOpen}
        title={`Delete ${service.name}`}
        message={
          <div className="space-y-3">
            <p className="text-sm text-gray-600 dark:text-gray-300">
              You are about to delete <strong className="text-gray-900 dark:text-white">{service.name}</strong>.
              This will permanently stop the service and remove all of its configuration files.
            </p>
            <div className="p-3 rounded-lg bg-blue-500/10 border border-blue-500/20 text-xs text-blue-700 dark:text-blue-300">
              ℹ️ <strong>Safety Net Active:</strong> ServiceBay snapshots your configuration before deleting. Restore it any time from <strong>Settings &rarr; Backups</strong>.
            </div>
          </div>
        }
        confirmText="Permanently Delete"
        isDestructive
        resourceName={service.name}
        requireTypedConfirm
        isLoading={deleteInFlight}
        onConfirm={onDelete}
        onCancel={onDeleteCancel}
      />
    </>
  );
}

/** A lifecycle/data action — the shared <Button secondary> primitive at a
 *  uniform full-cell width, so every action in the grid has identical sizing. */
function ActionButton({
  onClick,
  running,
  icon,
  label,
}: {
  onClick: () => void;
  running?: boolean;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <Button variant="secondary" onClick={onClick} disabled={running} className="w-full">
      {running ? <Loader2 size={16} className="animate-spin" /> : icon}
      {running ? 'Running…' : label}
    </Button>
  );
}

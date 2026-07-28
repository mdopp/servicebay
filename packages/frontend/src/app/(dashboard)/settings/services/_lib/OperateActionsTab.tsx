'use client';

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { PlayCircle, Power, RefreshCw, Trash2, DatabaseBackup, Loader2, Download, PackageX } from 'lucide-react';
import { logger, type ServiceViewModel } from '@servicebay/api-client';
import ActionProgressModal from '@/components/ActionProgressModal';
import ConfirmModal from '@/components/ConfirmModal';
import { useToast, type ToastType } from '@/providers/ToastProvider';
import { Button, SectionHeading } from '@/components/ui';

/**
 * Narrow mirror of the backend's `ForceUpdateResult`
 * (packages/backend/src/lib/services/forceUpdate.ts) — only the fields this tab
 * reports on. Same convention as `useImageUpdates.ts` mirroring
 * `ServiceImageUpdate`.
 */
export interface ForceUpdateReport {
  changed?: boolean;
  stale?: boolean;
  mode?: 'pull' | 'fresh';
  images?: { image: string; changed?: boolean; stale?: boolean; error?: string }[];
  error?: string;
}

/**
 * Turn a force-update report into the toast the operator sees (#2397).
 *
 * The point is to never say "update sent" when nothing moved — the report
 * carries before/registry/after digests precisely so a no-op reads as a no-op.
 * Order matters: a failed pull is the headline even if another image advanced.
 * Pure + exported so the wording is unit-testable without a DOM.
 */
export function describeForceUpdate(report: ForceUpdateReport): { type: ToastType; title: string; message: string } {
  const images = report.images ?? [];
  const failed = images.filter((i) => i.error).map((i) => i.image);
  const updated = images.filter((i) => i.changed).map((i) => i.image);
  if (failed.length > 0) {
    return { type: 'error', title: 'Pull failed', message: `Could not pull ${failed.join(', ')}. The service was left on its current image.` };
  }
  if (report.changed) {
    return { type: 'success', title: 'New image pulled', message: `${updated.join(', ')} — the containers were recreated on it.` };
  }
  if (report.stale) {
    return {
      type: 'warning',
      title: 'Image did not update',
      message: 'The registry serves a newer image but the local one did not change. Try the fresh pull below.',
    };
  }
  return {
    type: 'success',
    title: 'Already on the newest image',
    message: 'The registry has nothing newer; the containers were recreated anyway.',
  };
}

/**
 * Actions tab of a service's Operate page (#1957). The lifecycle controls that
 * used to live behind the Services-dashboard "Actions" modal, co-located with
 * the service's Health and Settings: start / stop / update / force update, back
 * up config to NAS, and delete.
 *
 * "Force update" (#2397) is the manual image refresh: neither a restart nor
 * "Update & Restart" proves the container came back on a newer image, and
 * `podman-auto-update.timer` is masked until an operator sets an update window,
 * so this is the one control that re-checks the registry on demand and reports
 * the digests. Its "Fresh pull" fallback appears only after a force update
 * fails to land a new image.
 *
 * Restart deliberately does NOT appear here (#2393). The page header's
 * "Quick actions" section — rendered on *every* tab, including this one — is
 * the single home of Restart, so a second copy in this grid was a duplicate of
 * a control already on screen. This tab owns the actions that have no quick
 * equivalent.
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

  const [currentAction, setCurrentAction] = useState<'start' | 'stop' | null>(null);
  const [actionModalOpen, setActionModalOpen] = useState(false);
  const [runningAction, setRunningAction] = useState<string | null>(null);
  const [backingUp, setBackingUp] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteInFlight, setDeleteInFlight] = useState(false);
  // #2397: the fresh-pull fallback is revealed only once a plain force update
  // has failed to land a new image — it is the second line of defence for a
  // stuck image, not a control to reach for first.
  const [offerFreshPull, setOfferFreshPull] = useState(false);
  const [freshOpen, setFreshOpen] = useState(false);

  const openLifecycle = useCallback((action: 'start' | 'stop') => {
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

  /**
   * Force update (#2397): re-check the registry, re-pull, and force-recreate the
   * containers — the manual path that does not depend on
   * `podman-auto-update.timer` (masked until an update window is configured).
   * `fresh` additionally deletes the local image first, for a stuck one.
   */
  const runForceUpdate = useCallback(async (fresh: boolean) => {
    setFreshOpen(false);
    setRunningAction(fresh ? 'force-fresh' : 'force-update');
    const toastId = addToast(
      'loading',
      fresh ? 'Deleting the local image and pulling it fresh…' : 'Re-checking the registry…',
      `${service.name} — this can take a few minutes on a large image.`,
      0,
    );
    try {
      const query = nodeParam ? `?node=${nodeParam}` : '';
      const res = await fetch(`/api/services/${encodeURIComponent(serviceName)}/action${query}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'force-update', mode: fresh ? 'fresh' : 'pull' }),
      });
      const report: ForceUpdateReport = await res.json().catch(() => ({}));
      if (!res.ok) {
        updateToast(toastId, 'error', 'Force update failed', report.error || `HTTP ${res.status}`);
        setOfferFreshPull(true);
        return;
      }
      const { type, title, message } = describeForceUpdate(report);
      updateToast(toastId, type, title, message);
      // Nothing landed → keep (or reveal) the fallback. A confirmed new image
      // means the plain path worked, so put the fallback away again.
      setOfferFreshPull(!report.changed);
    } catch (e) {
      logger.error('OperateActionsTab', 'force update failed', e);
      updateToast(toastId, 'error', 'Force update failed', 'An unexpected error occurred.');
      setOfferFreshPull(true);
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
        <SectionHeading as="h3" description="Restart lives in Quick actions at the top of this page">
          Lifecycle
        </SectionHeading>
        <div className="grid grid-cols-2 gap-2">
          <ActionButton onClick={() => openLifecycle('start')} icon={<PlayCircle size={16} />} label="Start" />
          <ActionButton onClick={() => openLifecycle('stop')} icon={<Power size={16} />} label="Stop" />
          <ActionButton onClick={runUpdate} running={runningAction === 'update'} icon={<RefreshCw size={16} />} label="Update & Restart" />
          {/* #2397 — a restart (and "Update & Restart") never proves the image
              moved; this one re-checks the registry digest, recreates the
              containers, and reports what actually changed. */}
          <ActionButton
            onClick={() => void runForceUpdate(false)}
            running={runningAction === 'force-update'}
            icon={<Download size={16} />}
            label="Force update"
          />
          {offerFreshPull && (
            <ActionButton
              onClick={() => setFreshOpen(true)}
              running={runningAction === 'force-fresh'}
              icon={<PackageX size={16} />}
              label="Fresh pull"
            />
          )}
        </div>
        {offerFreshPull && (
          <p className="text-xs text-text-subtle">
            The force update did not land a new image. <strong>Fresh pull</strong> deletes the local
            image and downloads it again — use it when an image is stuck.
          </p>
        )}
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

      <ConfirmModal
        isOpen={freshOpen}
        title={`Fresh pull for ${service.name}`}
        message={
          <div className="space-y-3">
            <p className="text-sm text-text-muted">
              This stops <strong className="text-text">{service.name}</strong>, deletes its
              container(s) and its <strong>local image</strong>, then downloads the image again from the
              registry and starts the service.
            </p>
            <p className="text-xs text-text-subtle">
              The service is down for the length of the download. An image another service is also
              running is kept rather than deleted. No volumes or config are touched.
            </p>
          </div>
        }
        confirmText="Delete image and pull"
        isDestructive
        isLoading={runningAction === 'force-fresh'}
        onConfirm={() => void runForceUpdate(true)}
        onCancel={() => setFreshOpen(false)}
      />

      <OperateActionModals
        service={service}
        serviceName={serviceName}
        currentAction={currentAction}
        actionModalOpen={actionModalOpen}
        onActionClose={() => setActionModalOpen(false)}
        onActionComplete={() => {
          addToast('success', `Service ${currentAction === 'stop' ? 'stopped' : 'started'} successfully`);
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
  currentAction: 'start' | 'stop' | null;
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

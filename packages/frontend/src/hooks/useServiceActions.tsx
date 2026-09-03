'use client';

import { useCallback, useMemo, useState } from 'react';
import { z } from 'zod';
import { Box, ArrowLeft, PlayCircle, Power, RotateCw, RefreshCw, Trash2, X, Loader2 } from 'lucide-react';
import WorkspaceDrawer from '@/components/WorkspaceDrawer';
import ServiceMonitor from '@/components/ServiceMonitor';
import ServiceForm, { ServiceFormInitialData } from '@/components/ServiceForm';
import ActionProgressModal from '@/components/ActionProgressModal';
import ConfirmModal from '@/components/ConfirmModal';
import { useToast } from '@/providers/ToastProvider';
import type { ToastType } from '@/providers/ToastProvider';
import { ServiceViewModel, typedFetch, mutateApi } from '@servicebay/api-client';
import { logger } from '@servicebay/api-client';
import { useEscapeKey } from '@/hooks/useEscapeKey';

interface UseServiceActionsOptions {
  onRefresh?: () => void;
}

type DrawerState = { mode: 'monitor' | 'edit'; service: ServiceViewModel } | null;

const ServiceFilesResponseSchema = z.object({
  kubeContent: z.string().optional(),
  yamlContent: z.string().optional(),
  serviceContent: z.string().optional(),
  kubePath: z.string().optional(),
  yamlPath: z.string().optional(),
  servicePath: z.string().optional(),
});

const ServiceActionResponseSchema = z.object({}).passthrough();

const ServiceDeleteResponseSchema = z.object({
  error: z.string().optional(),
}).passthrough();

export function useServiceActions({ onRefresh }: UseServiceActionsOptions = {}) {
  const { addToast, updateToast } = useToast();

  const [drawerState, setDrawerState] = useState<DrawerState>(null);
  const [drawerLoading, setDrawerLoading] = useState(false);
  const [editInitialData, setEditInitialData] = useState<ServiceFormInitialData | null>(null);

  const [showActions, setShowActions] = useState(false);
  const [selectedService, setSelectedService] = useState<ServiceViewModel | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  // Which non-modal action is in flight — drives the per-button spinner /
  // "Running…" label so the operator knows which action is awaiting and
  // doesn't double-click. Modal-opening actions (start/stop/restart) get
  // a brief flash of this before the modal takes over visibility. (#805)
  const [runningAction, setRunningAction] = useState<string | null>(null);

  const [actionService, setActionService] = useState<ServiceViewModel | null>(null);
  const [currentAction, setCurrentAction] = useState<'start' | 'stop' | 'restart' | null>(null);
  const [actionModalOpen, setActionModalOpen] = useState(false);

  const [serviceToDelete, setServiceToDelete] = useState<ServiceViewModel | null>(null);
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [deleteInFlight, setDeleteInFlight] = useState(false);

  const closeDrawer = useCallback(() => {
    setDrawerState(null);
    setDrawerLoading(false);
    setEditInitialData(null);
  }, []);

  const closeOverlays = useCallback(() => {
    setShowActions(false);
    setSelectedService(null);
    setServiceToDelete(null);
    setDeleteModalOpen(false);
    setActionModalOpen(false);
    setActionService(null);
    setCurrentAction(null);
    closeDrawer();
  }, [closeDrawer]);

  const overlayIsActive = Boolean(drawerState || showActions || deleteModalOpen || actionModalOpen);
  useEscapeKey(closeOverlays, overlayIsActive, true);

  const fetchEditData = useCallback(async (service: ServiceViewModel) => {
    const serviceName = service.id || service.name;
    setDrawerState({ mode: 'edit', service });
    setDrawerLoading(true);
    setEditInitialData(null);

    try {
      const nodeParam = service.nodeName && service.nodeName !== 'Local' ? `?node=${service.nodeName}` : '';
      const files = await typedFetch(`/api/services/${encodeURIComponent(serviceName)}${nodeParam}`, ServiceFilesResponseSchema, { cache: 'no-store' });
      const yamlFileName = service.yamlBasename || `${service.displayName}.yml`;
      const initialData: ServiceFormInitialData = {
        name: service.displayName,
        kubeContent: files.kubeContent || '',
        yamlContent: files.yamlContent || '',
        yamlFileName,
        serviceContent: files.serviceContent,
        kubePath: files.kubePath,
        yamlPath: files.yamlPath,
        servicePath: files.servicePath,
      };
      setEditInitialData(initialData);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load service files';
      addToast('error', message);
      setDrawerState(null);
    } finally {
      setDrawerLoading(false);
    }
  }, [addToast]);

  const openMonitorDrawer = useCallback((service: ServiceViewModel) => {
    setDrawerState({ mode: 'monitor', service });
  }, []);

  const openEditDrawer = useCallback((service: ServiceViewModel) => {
    if (service.type !== 'kube') return;
    fetchEditData(service);
  }, [fetchEditData]);

  const openActions = useCallback((service: ServiceViewModel) => {
    setSelectedService(service);
    setShowActions(true);
  }, []);

  // Inline-restart entry point used by the "Service is failed" banner on the
  // service card. Skips the actions menu — selects the service and opens the
  // ActionProgressModal directly.
  const triggerRestart = useCallback((service: ServiceViewModel) => {
    setSelectedService(service);
    setActionService(service);
    setCurrentAction('restart');
    setActionModalOpen(true);
  }, []);

  const requestDelete = useCallback((service: ServiceViewModel) => {
    setServiceToDelete(service);
    setDeleteModalOpen(true);
  }, []);

  const handleDelete = useCallback(async () => {
    if (!serviceToDelete || deleteInFlight) return;
    setDeleteInFlight(true);
    const toastId = addToast('loading', 'Deleting service...', `Removing ${serviceToDelete.name}`, 0);

    try {
      const serviceName = serviceToDelete.id || serviceToDelete.name;
      const nodeParam = serviceToDelete.type === 'link' || serviceToDelete.type === 'gateway'
        ? ''
        : serviceToDelete.nodeName && serviceToDelete.nodeName !== 'Local'
          ? serviceToDelete.nodeName
          : '';
      const query = nodeParam ? `?node=${nodeParam}` : '';
      await mutateApi(`/api/services/${encodeURIComponent(serviceName)}${query}`, ServiceDeleteResponseSchema, undefined, 'DELETE');
      updateToast(toastId, 'success', 'Service deleted', `Service ${serviceToDelete.name} has been removed.`);
      onRefresh?.();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'An unexpected error occurred.';
      updateToast(toastId, 'error', 'Delete failed', message);
    } finally {
      setDeleteInFlight(false);
      setDeleteModalOpen(false);
    }
  }, [addToast, deleteInFlight, onRefresh, serviceToDelete, updateToast]);

  // Pull-the-latest-image action for the "Update available" surfaces (the
  // ImageUpdatesPendingBanner button + the per-card/row badge, #1860). This is
  // the SAME mechanism the actions menu's "Update & Restart" uses — POST the
  // `update` action, which re-deploys the service: `updateAndRestartService`
  // pulls each image referenced in the service YAML, then stop/starts the unit.
  // We expose it as a direct callback (not via the actions modal) so the badge
  // and banner can trigger it inline. Returns true on success so a caller
  // updating several services can stop the loop or skip the refresh on failure.
  //
  // Honesty (feedback_dont_mask_failures): a non-ok response or a thrown error
  // surfaces a real error toast — we never reclassify a failed pull as success.
  const updateServiceImage = useCallback(async (service: ServiceViewModel): Promise<boolean> => {
    const serviceName = service.id || service.name;
    const nodeName = service.nodeName === 'Local' ? '' : service.nodeName;
    const query = nodeName ? `?node=${nodeName}` : '';
    const toastId = addToast('loading', 'Updating service', `Pulling the latest image for ${service.displayName || service.name}…`, 0);

    try {
      await mutateApi(`/api/services/${encodeURIComponent(serviceName)}/action${query}`, ServiceActionResponseSchema, { action: 'update' }, 'POST');
      updateToast(toastId, 'success', 'Service updated', `${service.displayName || service.name} re-deployed with its latest image.`);
      onRefresh?.();
      return true;
    } catch (error) {
      logger.error('useServiceActions', 'Image update failed', error);
      const message = error instanceof Error ? error.message : 'An unexpected connection error occurred.';
      updateToast(toastId, 'error', 'Update failed', message);
      return false;
    }
  }, [addToast, onRefresh, updateToast]);

  const handleAction = useCallback(async (action: string) => {
    if (!selectedService) return;

    if (action === 'start' || action === 'stop' || action === 'restart') {
      setActionService(selectedService);
      setCurrentAction(action);
      setActionModalOpen(true);
      setShowActions(false);
      return;
    }

    setActionLoading(true);
    setRunningAction(action);
    const toastId = addToast('loading', 'Action in progress', `Executing ${action} on ${selectedService.name}...`, 0);

    try {
      const serviceName = selectedService.id || selectedService.name;
      const nodeParam = selectedService.nodeName === 'Local' ? '' : selectedService.nodeName;
      const query = nodeParam ? `?node=${nodeParam}` : '';
      await mutateApi(`/api/services/${encodeURIComponent(serviceName)}/action${query}`, ServiceActionResponseSchema, { action }, 'POST');
      setShowActions(false);
      updateToast(toastId, 'success', 'Action initiated', `${action} command sent to ${selectedService.name}`);
      setTimeout(() => onRefresh?.(), 1000);
    } catch (error) {
      logger.error('useServiceActions', 'Action failed', error);
      const message = error instanceof Error ? error.message : 'An unexpected connection error occurred.';
      updateToast(toastId, 'error', 'Action failed', message);
    } finally {
      setActionLoading(false);
      setRunningAction(null);
    }
  }, [addToast, onRefresh, selectedService, updateToast]);

  const actionOverlays = (
    <ServiceActionOverlays
      deleteModalOpen={deleteModalOpen}
      serviceToDelete={serviceToDelete}
      deleteInFlight={deleteInFlight}
      handleDelete={handleDelete}
      actionService={actionService}
      currentAction={currentAction}
      actionModalOpen={actionModalOpen}
      onRefresh={onRefresh}
      addToast={addToast}
      showActions={showActions}
      selectedService={selectedService}
      actionLoading={actionLoading}
      runningAction={runningAction}
      handleAction={handleAction}
      requestDelete={requestDelete}
      drawerState={drawerState}
      closeDrawer={closeDrawer}
      drawerLoading={drawerLoading}
      editInitialData={editInitialData}
      setShowActions={setShowActions}
      setActionModalOpen={setActionModalOpen}
    />
  );

  const hasOverlayOpen = useMemo(
    () => Boolean(drawerState || showActions || deleteModalOpen || actionModalOpen),
    [drawerState, showActions, deleteModalOpen, actionModalOpen]
  );

  return {
    openMonitorDrawer,
    openEditDrawer,
    openActions,
    triggerRestart,
    updateServiceImage,
    requestDelete,
    actionLoading,
    overlays: actionOverlays,
    closeOverlays,
    hasOpenOverlay: hasOverlayOpen,
  };
}

interface ServiceActionOverlaysProps {
  deleteModalOpen: boolean;
  serviceToDelete: ServiceViewModel | null;
  deleteInFlight: boolean;
  handleDelete: () => void;
  actionService: ServiceViewModel | null;
  currentAction: 'start' | 'stop' | 'restart' | null;
  actionModalOpen: boolean;
  onRefresh?: () => void;
  addToast: (type: ToastType, title: string, message?: string, duration?: number) => string;
  showActions: boolean;
  selectedService: ServiceViewModel | null;
  actionLoading: boolean;
  runningAction: string | null;
  handleAction: (action: string) => void;
  requestDelete: (service: ServiceViewModel) => void;
  drawerState: DrawerState;
  closeDrawer: () => void;
  drawerLoading: boolean;
  editInitialData: ServiceFormInitialData | null;
  setShowActions: (value: boolean) => void;
  setActionModalOpen: (value: boolean) => void;
}

function ServiceActionOverlays({
  deleteModalOpen,
  serviceToDelete,
  deleteInFlight,
  handleDelete,
  actionService,
  currentAction,
  actionModalOpen,
  onRefresh,
  addToast,
  showActions,
  selectedService,
  actionLoading,
  runningAction,
  handleAction,
  requestDelete,
  drawerState,
  closeDrawer,
  drawerLoading,
  editInitialData,
  setShowActions,
  setActionModalOpen,
}: ServiceActionOverlaysProps) {
  return (
    <>
      <ConfirmModal
        isOpen={deleteModalOpen}
        title={`Delete ${serviceToDelete?.name || 'Service'}`}
        message={
          <div className="space-y-3">
            <p className="text-sm text-text-muted">
              You are about to delete <strong className="text-text">{serviceToDelete?.name}</strong>.
              This will permanently stop the service and remove all of its configuration files.
            </p>
            <div className="p-3 rounded-lg bg-status-info/10 border border-status-info/20 text-xs text-status-info">
              ℹ️ <strong>Safety Net Active:</strong> ServiceBay will automatically create a snapshot backup of your configuration before deleting. You can restore this at any time from <strong>Settings &rarr; Backups</strong>.
            </div>
            <p className="text-xs text-status-fail font-medium">
              To proceed, type the name of the service below to confirm deletion.
            </p>
          </div>
        }
        confirmText="Permanently Delete"
        isDestructive
        resourceName={serviceToDelete?.name ?? ''}
        requireTypedConfirm={Boolean(serviceToDelete?.name)}
        isLoading={deleteInFlight}
        onConfirm={handleDelete}
        onCancel={() => { /* parent handles state */ }}
      />

      {actionService && currentAction && (
        <ActionProgressModal
          isOpen={actionModalOpen}
          onClose={() => setActionModalOpen(false)}
          serviceName={actionService.id || actionService.name}
          nodeName={actionService.nodeName}
          action={currentAction}
          onComplete={() => {
            onRefresh?.();
            const actionPast = currentAction === 'stop' ? 'stopped' : currentAction === 'start' ? 'started' : 'restarted';
            addToast('success', `Service ${actionPast} successfully`);
          }}
        />
      )}

      {showActions && selectedService && (
        <ServiceActionsModal
          selectedService={selectedService}
          actionLoading={actionLoading}
          runningAction={runningAction}
          handleAction={handleAction}
          requestDelete={requestDelete}
          setShowActions={setShowActions}
        />
      )}

      <WorkspaceDrawer
        isOpen={Boolean(drawerState)}
        onClose={closeDrawer}
        header={drawerState && <ServiceDrawerHeader service={drawerState.service} mode={drawerState.mode} />}
      >
        {drawerState && <ServiceDrawerContent
          mode={drawerState.mode}
          service={drawerState.service}
          drawerLoading={drawerLoading}
          editInitialData={editInitialData}
          closeDrawer={closeDrawer}
        />}
      </WorkspaceDrawer>
    </>
  );
}

function ServiceActionsModal({
  selectedService,
  actionLoading,
  runningAction,
  handleAction,
  requestDelete,
  setShowActions,
}: {
  selectedService: ServiceViewModel;
  actionLoading: boolean;
  runningAction: string | null;
  handleAction: (action: string) => void;
  requestDelete: (service: ServiceViewModel) => void;
  setShowActions: (value: boolean) => void;
}) {
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div className="bg-surface rounded-lg shadow-xl w-full max-w-md border border-border p-6">
        <div className="flex justify-between items-center mb-6">
          <div className="flex items-center gap-4">
            <button onClick={() => setShowActions(false)} className="text-text-muted hover:text-text flex items-center gap-1 text-sm font-medium">
              <ArrowLeft size={18} />
              Back
            </button>
            <h3 className="text-lg font-bold">Service Actions</h3>
          </div>
          <button
            onClick={() => setShowActions(false)}
            className="text-text-muted hover:text-text"
            aria-label="Close service actions"
          >
            <X size={20} />
          </button>
        </div>

        <div className="mb-6">
          <div className="flex items-center gap-3 p-3 bg-surface-2 rounded-lg">
            <Box className="text-status-info" />
            <div>
              <div className="font-medium text-text">{selectedService.name}</div>
              <div className="text-xs text-text-muted font-mono">Systemd Service</div>
            </div>
          </div>
        </div>

        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <ActionButton
              onClick={() => handleAction('start')}
              disabled={actionLoading}
              running={runningAction === 'start'}
              icon={<PlayCircle size={18} className="text-status-ok" />}
              label="Start"
            />
            <ActionButton
              onClick={() => handleAction('stop')}
              disabled={actionLoading}
              running={runningAction === 'stop'}
              icon={<Power size={18} className="text-status-fail" />}
              label="Stop"
            />
          </div>

          <ActionButton
            onClick={() => handleAction('restart')}
            disabled={actionLoading}
            running={runningAction === 'restart'}
            icon={<RotateCw size={18} className="text-status-info" />}
            label="Restart Service"
            fullWidth
          />

          <ActionButton
            onClick={() => handleAction('update')}
            disabled={actionLoading}
            running={runningAction === 'update'}
            icon={<RefreshCw size={18} className="text-status-warn" />}
            label="Update & Restart"
            fullWidth
          />

          <button
            onClick={() => {
              setShowActions(false);
              requestDelete(selectedService);
            }}
            disabled={actionLoading}
            className="w-full flex items-center justify-center gap-2 p-3 rounded-lg border border-status-fail/20 bg-status-fail/10 hover:bg-status-fail/20 transition-colors text-status-fail disabled:opacity-60"
          >
            <Trash2 size={18} />
            <span className="font-medium">Delete Service</span>
          </button>
        </div>
      </div>
    </div>
  );
}

function ServiceDrawerHeader({
  service,
  mode,
}: {
  service: ServiceViewModel;
  mode: 'monitor' | 'edit';
}) {
  return (
    <>
      <p className="text-xs uppercase tracking-[0.2em] text-text-muted">
        {mode === 'monitor' ? 'Service Monitor' : 'Edit Service'}
      </p>
      <h3 className="text-2xl font-semibold text-text mt-1 flex items-center gap-2">
        {service.displayName}
        {service.nodeName && (
          <span className="px-2 py-0.5 rounded-full text-xs bg-status-info/10 text-status-info border border-status-info/20">
            {service.nodeName}
          </span>
        )}
      </h3>
      {service.description && (
        <p className="text-sm text-text-muted mt-1 max-w-2xl">
          {service.description}
        </p>
      )}
    </>
  );
}

function ServiceDrawerContent({
  mode,
  service,
  drawerLoading,
  editInitialData,
  closeDrawer,
}: {
  mode: 'monitor' | 'edit';
  service: ServiceViewModel;
  drawerLoading: boolean;
  editInitialData: ServiceFormInitialData | null;
  closeDrawer: () => void;
}) {
  if (mode === 'monitor') {
    return (
      <ServiceMonitor
        serviceName={service.id || service.name}
        initialNode={service.nodeName}
        onBack={closeDrawer}
        variant="embedded"
      />
    );
  }

  if (drawerLoading || !editInitialData) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-3 text-text-muted">
        <RefreshCw className="animate-spin" />
        Loading configuration...
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto p-6 bg-surface-2">
      <ServiceForm
        key={`${service.id || service.name}-${service.nodeName || 'Local'}`}
        initialData={editInitialData}
        isEdit
        defaultNode={service.nodeName && service.nodeName !== 'Local' ? service.nodeName : ''}
        onClose={closeDrawer}
        variant="embedded"
      />
    </div>
  );
}

/**
 * Service-action button with a built-in "Running…" state (#805 acceptance:
 *   action buttons display a disabled loading state to prevent double-clicks).
 * `running` shows the spinner + Running… label on the one in-flight button;
 * `disabled` greys all of them while any action is in flight.
 */
function ActionButton({
  onClick,
  disabled,
  running,
  icon,
  label,
  fullWidth,
}: {
  onClick: () => void;
  disabled: boolean;
  running: boolean;
  icon: React.ReactNode;
  label: string;
  fullWidth?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`${fullWidth ? 'w-full ' : ''}flex items-center justify-center gap-2 p-3 rounded-lg border border-border hover:bg-surface-2 transition-colors disabled:opacity-60 disabled:cursor-not-allowed`}
    >
      {running ? <Loader2 size={18} className="animate-spin text-status-info" /> : icon}
      <span className="font-medium">{running ? 'Running…' : label}</span>
    </button>
  );
}

'use client';

import { useCallback, useMemo, useState } from 'react';
import { Box, ArrowLeft, PlayCircle, Power, RotateCw, RefreshCw, Trash2, X, Loader2 } from 'lucide-react';
import WorkspaceDrawer from '@/components/WorkspaceDrawer';
import ServiceMonitor from '@/components/ServiceMonitor';
import ServiceForm, { ServiceFormInitialData } from '@/components/ServiceForm';
import ActionProgressModal from '@/components/ActionProgressModal';
import ConfirmModal from '@/components/ConfirmModal';
import { useToast } from '@/providers/ToastProvider';
import type { ToastType } from '@/providers/ToastProvider';
import { ServiceViewModel } from '@servicebay/api-client';
import { logger } from '@servicebay/api-client';
import { useEscapeKey } from '@/hooks/useEscapeKey';

interface UseServiceActionsOptions {
  onRefresh?: () => void;
}

type DrawerState = { mode: 'monitor' | 'edit'; service: ServiceViewModel } | null;

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
      const res = await fetch(`/api/services/${encodeURIComponent(serviceName)}${nodeParam}`, { cache: 'no-store' });
      if (!res.ok) {
        throw new Error('Failed to load service files');
      }

      const files = await res.json();
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
      const res = await fetch(`/api/services/${encodeURIComponent(serviceName)}${query}`, { method: 'DELETE' });
      if (res.ok) {
        updateToast(toastId, 'success', 'Service deleted', `Service ${serviceToDelete.name} has been removed.`);
        onRefresh?.();
      } else {
        const data = await res.json();
        updateToast(toastId, 'error', 'Delete failed', data.error);
      }
    } catch {
      updateToast(toastId, 'error', 'Delete failed', 'An unexpected error occurred.');
    } finally {
      setDeleteInFlight(false);
      setDeleteModalOpen(false);
    }
  }, [addToast, deleteInFlight, onRefresh, serviceToDelete, updateToast]);

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
      const res = await fetch(`/api/services/${encodeURIComponent(serviceName)}/action${query}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });

      const traceId = res.headers.get('x-trace-id');
      const traceMsg = traceId ? ` [Trace: ${traceId}]` : '';

      if (!res.ok) {
        const data = await res.json();
        updateToast(toastId, 'error', 'Action failed', `${data.error || 'HTTP ' + res.status}${traceMsg}`);
      } else {
        setShowActions(false);
        updateToast(toastId, 'success', 'Action initiated', `${action} command sent to ${selectedService.name}`);
        setTimeout(() => onRefresh?.(), 1000);
      }
    } catch (error) {
      logger.error('useServiceActions', 'Action failed', error);
      updateToast(toastId, 'error', 'Action failed', 'An unexpected connection error occurred.');
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
            <p className="text-sm text-gray-600 dark:text-gray-300">
              You are about to delete <strong className="text-gray-900 dark:text-white">{serviceToDelete?.name}</strong>.
              This will permanently stop the service and remove all of its configuration files.
            </p>
            <div className="p-3 rounded-lg bg-blue-500/10 border border-blue-500/20 text-xs text-blue-700 dark:text-blue-300">
              ℹ️ <strong>Safety Net Active:</strong> ServiceBay will automatically create a snapshot backup of your configuration before deleting. You can restore this at any time from <strong>Settings &rarr; Backups</strong>.
            </div>
            <p className="text-xs text-red-600 dark:text-red-400 font-medium">
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
      <div className="bg-white dark:bg-gray-900 rounded-lg shadow-xl w-full max-w-md border border-gray-200 dark:border-gray-800 p-6">
        <div className="flex justify-between items-center mb-6">
          <div className="flex items-center gap-4">
            <button onClick={() => setShowActions(false)} className="text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 flex items-center gap-1 text-sm font-medium">
              <ArrowLeft size={18} />
              Back
            </button>
            <h3 className="text-lg font-bold">Service Actions</h3>
          </div>
          <button
            onClick={() => setShowActions(false)}
            className="text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
            aria-label="Close service actions"
          >
            <X size={20} />
          </button>
        </div>

        <div className="mb-6">
          <div className="flex items-center gap-3 p-3 bg-gray-50 dark:bg-gray-800 rounded-lg">
            <Box className="text-blue-500" />
            <div>
              <div className="font-medium text-gray-900 dark:text-gray-100">{selectedService.name}</div>
              <div className="text-xs text-gray-500 font-mono">Systemd Service</div>
            </div>
          </div>
        </div>

        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <ActionButton
              onClick={() => handleAction('start')}
              disabled={actionLoading}
              running={runningAction === 'start'}
              icon={<PlayCircle size={18} className="text-green-500" />}
              label="Start"
            />
            <ActionButton
              onClick={() => handleAction('stop')}
              disabled={actionLoading}
              running={runningAction === 'stop'}
              icon={<Power size={18} className="text-red-500" />}
              label="Stop"
            />
          </div>

          <ActionButton
            onClick={() => handleAction('restart')}
            disabled={actionLoading}
            running={runningAction === 'restart'}
            icon={<RotateCw size={18} className="text-blue-500" />}
            label="Restart Service"
            fullWidth
          />

          <ActionButton
            onClick={() => handleAction('update')}
            disabled={actionLoading}
            running={runningAction === 'update'}
            icon={<RefreshCw size={18} className="text-orange-500" />}
            label="Update & Restart"
            fullWidth
          />

          <button
            onClick={() => {
              setShowActions(false);
              requestDelete(selectedService);
            }}
            disabled={actionLoading}
            className="w-full flex items-center justify-center gap-2 p-3 rounded-lg border border-red-200 dark:border-red-900/50 bg-red-50 dark:bg-red-900/20 hover:bg-red-100 dark:hover:bg-red-900/40 transition-colors text-red-600 dark:text-red-400 disabled:opacity-60"
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
      <p className="text-xs uppercase tracking-[0.2em] text-gray-500 dark:text-gray-400">
        {mode === 'monitor' ? 'Service Monitor' : 'Edit Service'}
      </p>
      <h3 className="text-2xl font-semibold text-gray-900 dark:text-gray-100 mt-1 flex items-center gap-2">
        {service.displayName}
        {service.nodeName && (
          <span className="px-2 py-0.5 rounded-full text-xs bg-blue-100 dark:bg-blue-900/30 text-blue-800 dark:text-blue-300 border border-blue-200 dark:border-blue-800">
            {service.nodeName}
          </span>
        )}
      </h3>
      {service.description && (
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1 max-w-2xl">
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
      <div className="h-full flex flex-col items-center justify-center gap-3 text-gray-500 dark:text-gray-400">
        <RefreshCw className="animate-spin" />
        Loading configuration...
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto p-6 bg-gray-50 dark:bg-gray-950/30">
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
      className={`${fullWidth ? 'w-full ' : ''}flex items-center justify-center gap-2 p-3 rounded-lg border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors disabled:opacity-60 disabled:cursor-not-allowed`}
    >
      {running ? <Loader2 size={18} className="animate-spin text-blue-500" /> : icon}
      <span className="font-medium">{running ? 'Running…' : label}</span>
    </button>
  );
}

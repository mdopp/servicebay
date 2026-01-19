'use client';

import { useCallback, useMemo, useState } from 'react';
import { Box, ArrowLeft, PlayCircle, Power, RotateCw, RefreshCw, Trash2, X } from 'lucide-react';
import ServiceMonitor from '@/components/ServiceMonitor';
import ServiceForm, { ServiceFormInitialData } from '@/components/ServiceForm';
import ActionProgressModal from '@/components/ActionProgressModal';
import ConfirmModal from '@/components/ConfirmModal';
import { useToast } from '@/providers/ToastProvider';
import { ServiceViewModel } from '@/types/serviceView';
import { logger } from '@/lib/logger';
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

  const [actionService, setActionService] = useState<ServiceViewModel | null>(null);
  const [currentAction, setCurrentAction] = useState<'start' | 'stop' | 'restart' | null>(null);
  const [actionModalOpen, setActionModalOpen] = useState(false);

  const [serviceToDelete, setServiceToDelete] = useState<ServiceViewModel | null>(null);
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);

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
      const yamlFileName = files.yamlPath?.split('/').pop() || `${serviceName.replace('.service', '')}.yml`;
      const initialData: ServiceFormInitialData = {
        name: service.name.replace('.service', ''),
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

  const requestDelete = useCallback((service: ServiceViewModel) => {
    setServiceToDelete(service);
    setDeleteModalOpen(true);
  }, []);

  const handleDelete = useCallback(async () => {
    if (!serviceToDelete) return;
    setDeleteModalOpen(false);
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
    }
  }, [addToast, onRefresh, serviceToDelete, updateToast]);

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

      if (!res.ok) {
        const data = await res.json();
        updateToast(toastId, 'error', 'Action failed', data.error);
      } else {
        setShowActions(false);
        updateToast(toastId, 'success', 'Action initiated', `${action} command sent to ${selectedService.name}`);
        setTimeout(() => onRefresh?.(), 1000);
      }
    } catch (error) {
      logger.error('useServiceActions', 'Action failed', error);
      updateToast(addToast('error', 'Action failed', 'An unexpected error occurred.'), 'error', 'Action failed', '');
    } finally {
      setActionLoading(false);
    }
  }, [addToast, onRefresh, selectedService, updateToast]);

  const actionOverlays = useMemo(() => (
    <>
      <ConfirmModal
        isOpen={deleteModalOpen}
        title="Delete Service"
        message={`Are you sure you want to delete service "${serviceToDelete?.name ?? ''}"? This action cannot be undone.`}
        confirmText="Delete"
        isDestructive
        onConfirm={handleDelete}
        onCancel={() => setDeleteModalOpen(false)}
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
                <button
                  onClick={() => handleAction('start')}
                  disabled={actionLoading}
                  className="flex items-center justify-center gap-2 p-3 rounded-lg border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
                >
                  <PlayCircle size={18} className="text-green-500" />
                  <span className="font-medium">Start</span>
                </button>
                <button
                  onClick={() => handleAction('stop')}
                  disabled={actionLoading}
                  className="flex items-center justify-center gap-2 p-3 rounded-lg border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
                >
                  <Power size={18} className="text-red-500" />
                  <span className="font-medium">Stop</span>
                </button>
              </div>

              <button
                onClick={() => handleAction('restart')}
                disabled={actionLoading}
                className="w-full flex items-center justify-center gap-2 p-3 rounded-lg border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
              >
                <RotateCw size={18} className="text-blue-500" />
                <span className="font-medium">Restart Service</span>
              </button>

              <button
                onClick={() => handleAction('update')}
                disabled={actionLoading}
                className="w-full flex items-center justify-center gap-2 p-3 rounded-lg border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
              >
                <RefreshCw size={18} className="text-orange-500" />
                <span className="font-medium">Update & Restart</span>
              </button>

              <button
                onClick={() => {
                  setShowActions(false);
                  requestDelete(selectedService);
                }}
                disabled={actionLoading}
                className="w-full flex items-center justify-center gap-2 p-3 rounded-lg border border-red-200 dark:border-red-900/50 bg-red-50 dark:bg-red-900/20 hover:bg-red-100 dark:hover:bg-red-900/40 transition-colors text-red-600 dark:text-red-400"
              >
                <Trash2 size={18} />
                <span className="font-medium">Delete Service</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {drawerState && (
        <div className="fixed inset-0 z-[70] flex justify-end bg-gray-950/70 backdrop-blur-sm">
          <div className="w-full max-w-6xl h-full bg-white dark:bg-gray-950 border-l border-gray-200 dark:border-gray-800 shadow-2xl flex flex-col">
            <div className="flex items-start justify-between px-6 py-4 border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/50">
              <div>
                <p className="text-xs uppercase tracking-[0.2em] text-gray-500 dark:text-gray-400">
                  {drawerState.mode === 'monitor' ? 'Service Monitor' : 'Edit Service'}
                </p>
                <h3 className="text-2xl font-semibold text-gray-900 dark:text-gray-100 mt-1 flex items-center gap-2">
                  {drawerState.service.name.replace('.service', '')}
                  {drawerState.service.nodeName && (
                    <span className="px-2 py-0.5 rounded-full text-xs bg-blue-100 dark:bg-blue-900/30 text-blue-800 dark:text-blue-300 border border-blue-200 dark:border-blue-800">
                      {drawerState.service.nodeName}
                    </span>
                  )}
                </h3>
                {drawerState.service.description && (
                  <p className="text-sm text-gray-500 dark:text-gray-400 mt-1 max-w-2xl">
                    {drawerState.service.description}
                  </p>
                )}
              </div>
              <button
                type="button"
                onClick={closeDrawer}
                className="p-2 rounded-full text-gray-500 hover:text-gray-900 dark:hover:text-gray-100 hover:bg-gray-200 dark:hover:bg-gray-800"
                aria-label="Close drawer"
              >
                <X size={20} />
              </button>
            </div>
            <div className="flex-1 overflow-hidden">
              {drawerState.mode === 'monitor' ? (
                <ServiceMonitor
                  serviceName={drawerState.service.id || drawerState.service.name}
                  initialNode={drawerState.service.nodeName}
                  onBack={closeDrawer}
                  variant="embedded"
                />
              ) : drawerLoading || !editInitialData ? (
                <div className="h-full flex flex-col items-center justify-center gap-3 text-gray-500 dark:text-gray-400">
                  <RefreshCw className="animate-spin" />
                  Loading configuration...
                </div>
              ) : (
                <div className="h-full overflow-y-auto p-6 bg-gray-50 dark:bg-gray-950/30">
                  <ServiceForm
                    key={`${drawerState.service.id || drawerState.service.name}-${drawerState.service.nodeName || 'Local'}`}
                    initialData={editInitialData}
                    isEdit
                    defaultNode={drawerState.service.nodeName && drawerState.service.nodeName !== 'Local' ? drawerState.service.nodeName : ''}
                    onClose={closeDrawer}
                    variant="embedded"
                  />
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  ), [
    actionLoading,
    actionModalOpen,
    actionService,
    addToast,
    closeDrawer,
    currentAction,
    deleteModalOpen,
    drawerLoading,
    drawerState,
    editInitialData,
    handleAction,
    handleDelete,
    onRefresh,
    requestDelete,
    selectedService,
    serviceToDelete,
    showActions,
  ]);

  const hasOverlayOpen = useMemo(
    () => Boolean(drawerState || showActions || deleteModalOpen || actionModalOpen),
    [drawerState, showActions, deleteModalOpen, actionModalOpen]
  );

  return {
    openMonitorDrawer,
    openEditDrawer,
    openActions,
    requestDelete,
    actionLoading,
    overlays: actionOverlays,
    closeOverlays,
    hasOpenOverlay: hasOverlayOpen,
  };
}

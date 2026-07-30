'use client';

import { useCallback, useMemo, useState } from 'react';
import { ArrowLeft, Box, Power, RotateCw, Trash2, AlertTriangle, RefreshCw, X } from 'lucide-react';
import ConfirmModal from '@/components/ConfirmModal';
import { useToast } from '@/providers/ToastProvider';
import { logger } from '@servicebay/api-client';
import { useEscapeKey } from '@/hooks/useEscapeKey';

export interface ContainerActionTarget {
  id: string;
  name: string;
  nodeName?: string | null;
}

interface UseContainerActionsOptions {
  onActionComplete?: () => void;
}

export function useContainerActions({ onActionComplete }: UseContainerActionsOptions = {}) {
  const { addToast, updateToast } = useToast();
  const [selectedContainer, setSelectedContainer] = useState<ContainerActionTarget | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);

  const closeActions = useCallback(() => {
    setSelectedContainer(null);
    setIsOpen(false);
    setDeleteModalOpen(false);
    setActionLoading(false);
  }, []);

  const openActions = useCallback((container: ContainerActionTarget) => {
    setSelectedContainer(container);
    setIsOpen(true);
  }, []);

  const handleAction = useCallback(async (action: string) => {
    if (!selectedContainer) return;

    if (action === 'delete' && !deleteModalOpen) {
      setDeleteModalOpen(true);
      return;
    }

    if (action === 'delete') {
      setDeleteModalOpen(false);
    }

    setActionLoading(true);
    const toastId = addToast('loading', 'Action in progress', `Executing ${action} on container...`, 0);

    try {
      const nodeParam = selectedContainer.nodeName && selectedContainer.nodeName !== 'Local'
        ? `?node=${encodeURIComponent(selectedContainer.nodeName)}`
        : '';
      const res = await fetch(`/api/containers/${selectedContainer.id}/action${nodeParam}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });

      if (!res.ok) {
        const data = await res.json();
        updateToast(toastId, 'error', 'Action failed', data.error);
      } else {
        updateToast(toastId, 'success', 'Action initiated', `${action} command sent to container`);
        onActionComplete?.();
        closeActions();
      }
    } catch (error) {
      logger.error('useContainerActions', 'Action failed', error);
      updateToast(toastId, 'error', 'Action failed', 'An unexpected error occurred.');
    } finally {
      setActionLoading(false);
    }
  }, [addToast, closeActions, deleteModalOpen, onActionComplete, selectedContainer, updateToast]);

  useEscapeKey(closeActions, isOpen, true);

  const overlay = useMemo(() => {
    if (!isOpen || !selectedContainer) return null;

    const shortId = selectedContainer.id.slice(0, 12);

    return (
      <>
        <ConfirmModal
          isOpen={deleteModalOpen}
          title="Delete container"
          message="The container will be removed and any unmounted volumes will be lost. Type the container name to confirm."
          confirmText="Delete"
          isDestructive
          resourceName={selectedContainer.name}
          requireTypedConfirm
          isLoading={actionLoading}
          onConfirm={() => handleAction('delete')}
          onCancel={() => { if (!actionLoading) setDeleteModalOpen(false); }}
        />
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-[70] flex items-center justify-center p-4">
          <div className="relative bg-surface rounded-lg shadow-xl w-full max-w-md border border-border p-5">
            <div className="flex justify-between items-center mb-5">
              <div className="flex items-center gap-3">
                <button onClick={closeActions} className="text-text-muted hover:text-text flex items-center gap-1 text-sm font-medium">
                  <ArrowLeft size={18} />
                  Back
                </button>
                <h3 className="text-lg font-bold text-text">Container Actions</h3>
              </div>
              <button onClick={closeActions} className="text-text-muted hover:text-text">
                <X size={20} />
              </button>
            </div>
            <div className="flex items-center gap-3 p-3 bg-surface-2 rounded-lg mb-5">
              <Box className="text-status-info" />
              <div>
                <div className="font-medium text-text">{selectedContainer.name}</div>
                <div className="text-xs text-text-muted font-mono">{shortId}</div>
              </div>
            </div>
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <button
                  onClick={() => handleAction('stop')}
                  disabled={actionLoading}
                  className="flex items-center justify-center gap-2 p-3 rounded-lg border border-border hover:bg-surface-2 transition-colors"
                >
                  <Power size={18} className="text-status-warn" />
                  <span>Stop</span>
                </button>
                <button
                  onClick={() => handleAction('restart')}
                  disabled={actionLoading}
                  className="flex items-center justify-center gap-2 p-3 rounded-lg border border-border hover:bg-surface-2 transition-colors"
                >
                  <RotateCw size={18} className="text-status-info" />
                  <span>Restart</span>
                </button>
              </div>
              <div className="border-t border-border pt-4">
                <h4 className="text-xs font-semibold text-text-muted uppercase mb-3 flex items-center gap-2">
                  <AlertTriangle size={12} />
                  Destructive Actions
                </h4>
                <div className="grid grid-cols-2 gap-3">
                  <button
                    onClick={() => handleAction('force-stop')}
                    disabled={actionLoading}
                    className="flex items-center justify-center gap-2 p-3 rounded-lg border border-status-fail/20 bg-status-fail/10 hover:bg-status-fail/20 text-status-fail transition-colors"
                  >
                    <Power size={18} />
                    <span>Force Stop</span>
                  </button>
                  <button
                    onClick={() => handleAction('force-restart')}
                    disabled={actionLoading}
                    className="flex items-center justify-center gap-2 p-3 rounded-lg border border-status-fail/20 bg-status-fail/10 hover:bg-status-fail/20 text-status-fail transition-colors"
                  >
                    <RotateCw size={18} />
                    <span>Force Restart</span>
                  </button>
                </div>
                <button
                  onClick={() => handleAction('delete')}
                  disabled={actionLoading}
                  className="w-full mt-3 flex items-center justify-center gap-2 p-3 rounded-lg border border-status-fail/20 bg-status-fail/10 hover:bg-status-fail/20 text-status-fail transition-colors"
                >
                  <Trash2 size={18} />
                  <span>Delete Container</span>
                </button>
              </div>
            </div>
            {actionLoading && (
              <div className="absolute inset-0 bg-surface/60 flex items-center justify-center rounded-lg">
                <RefreshCw className="animate-spin text-status-info" size={32} />
              </div>
            )}
          </div>
        </div>
      </>
    );
  }, [actionLoading, deleteModalOpen, handleAction, isOpen, selectedContainer, closeActions]);

  return {
    openActions,
    closeActions,
    overlay,
    isOpen,
    actionLoading,
  };
}

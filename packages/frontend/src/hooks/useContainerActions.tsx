'use client';

import { useCallback, useMemo, useState } from 'react';
import { z } from 'zod';
import { ArrowLeft, Box, Power, RotateCw, Trash2, AlertTriangle, RefreshCw, X } from 'lucide-react';
import ConfirmModal from '@/components/ConfirmModal';
import { Button } from '@/components/ui';
import { useToast } from '@/providers/ToastProvider';
import { logger, mutateApi } from '@servicebay/api-client';
import { useEscapeKey } from '@/hooks/useEscapeKey';

export interface ContainerActionTarget {
  id: string;
  name: string;
  nodeName?: string | null;
}

interface UseContainerActionsOptions {
  onActionComplete?: () => void;
}

const ContainerActionResponseSchema = z.object({
  // The action endpoint returns minimal response; schema is permissive
}).passthrough();

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
      await mutateApi(
        `/api/containers/${selectedContainer.id}/action${nodeParam}`,
        ContainerActionResponseSchema,
        { action },
        'POST',
      );
      updateToast(toastId, 'success', 'Action initiated', `${action} command sent to container`);
      onActionComplete?.();
      closeActions();
    } catch (error) {
      logger.error('useContainerActions', 'Action failed', error);
      const message = error instanceof Error ? error.message : 'An unexpected error occurred.';
      updateToast(toastId, 'error', 'Action failed', message);
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
                <Button variant="ghost" size="sm" onClick={closeActions} className="gap-1 font-medium">
                  <ArrowLeft size={18} />
                  Back
                </Button>
                <h3 className="text-lg font-bold text-text">Container Actions</h3>
              </div>
              <Button variant="ghost" onClick={closeActions}>
                <X size={20} />
              </Button>
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
                <Button
                  variant="ghost"
                  onClick={() => handleAction('stop')}
                  disabled={actionLoading}
                  className="gap-2 !p-3 !rounded-lg border border-border"
                >
                  <Power size={18} className="text-status-warn" />
                  <span>Stop</span>
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => handleAction('restart')}
                  disabled={actionLoading}
                  className="gap-2 !p-3 !rounded-lg border border-border"
                >
                  <RotateCw size={18} className="text-status-info" />
                  <span>Restart</span>
                </Button>
              </div>
              <div className="border-t border-border pt-4">
                <h4 className="text-xs font-semibold text-text-muted uppercase mb-3 flex items-center gap-2">
                  <AlertTriangle size={12} />
                  Destructive Actions
                </h4>
                <div className="grid grid-cols-2 gap-3">
                  <Button
                    variant="danger"
                    onClick={() => handleAction('force-stop')}
                    disabled={actionLoading}
                    className="gap-2 !p-3 !rounded-lg"
                  >
                    <Power size={18} />
                    <span>Force Stop</span>
                  </Button>
                  <Button
                    variant="danger"
                    onClick={() => handleAction('force-restart')}
                    disabled={actionLoading}
                    className="gap-2 !p-3 !rounded-lg"
                  >
                    <RotateCw size={18} />
                    <span>Force Restart</span>
                  </Button>
                </div>
                <Button
                  variant="danger"
                  onClick={() => handleAction('delete')}
                  disabled={actionLoading}
                  className="!w-full mt-3 gap-2 !p-3 !rounded-lg"
                >
                  <Trash2 size={18} />
                  <span>Delete Container</span>
                </Button>
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

'use client';

import { useCallback } from 'react';
import { useToast } from '@/providers/ToastProvider';
import { useEscapeKey } from '@/hooks/useEscapeKey';
import { previewSystemBackup, fetchBackupFile, restoreSystemBackup } from '@servicebay/api-client';
import type { BackupPreviewResult, BackupRestoreSelection } from '@/lib/systemBackup';
import type { PodmanConnection } from '@/lib/nodes';
import type { SystemBackupEntrySummary } from './helpers';
import type { BackupState } from './useBackupState';

/**
 * The selective-restore flow: preview fetch, per-item selection, and apply.
 * Shared by the System Snapshot panel (which opens it) and RestoreOverlay
 * (which renders it), so it lives in a hook rather than in either component.
 * Split out of backup/page.tsx (#2743).
 */
export function useRestoreFlow(state: BackupState, nodes: PodmanConnection[]) {
  const { addToast } = useToast();
  const {
    restoreOverlayOpen, setRestoreOverlayOpen,
    restoringBackup, setRestoringBackup,
    restorePreview, setRestorePreview,
    restoreSource, setRestoreSource,
    setRestoreUploadError,
    restoreFilePreview, setRestoreFilePreview,
    setRestoreFilePreviewError,
    restoreSelectionState, setRestoreSelectionState,
    setRestoreExpandedSections,
    fetchBackups,
  } = state;

  // Restore overlay
  const buildDefaultRestoreState = useCallback((preview: BackupPreviewResult) => {
    const nodesState = Object.fromEntries(preview.config.nodes.map(node => [node.name, true]));
    const checksState = Object.fromEntries(preview.config.checks.map(check => [check.id, true]));
    const nodeFilesState: Record<string, Record<string, boolean>> = {};
    const targetNodes: Record<string, string> = {};

    const availableTargets = ['Local', ...nodes.map(node => node.Name)];

    preview.nodeFiles.forEach(group => {
      nodeFilesState[group.nodeName] = Object.fromEntries(group.files.map(file => [file.relativePath, true]));
      targetNodes[group.nodeName] = availableTargets.includes(group.nodeName) ? group.nodeName : 'Local';
    });

    const serviceDataState: Record<string, Record<string, boolean>> = {};
    (preview.serviceData || []).forEach(sd => {
      serviceDataState[sd.name] = Object.fromEntries(sd.files.map(f => [f, true]));
    });

    setRestoreSelectionState({
      nodes: nodesState,
      checks: checksState,
      configFlags: {
        externalLinks: preview.config.externalLinks.length > 0,
        registries: preview.config.registries.length > 0,
        gateway: Boolean(preview.config.gateway),
        notifications: Boolean(preview.config.notifications),
        templateSettings: preview.config.templateSettings.length > 0,
        logLevel: Boolean(preview.config.logLevel),
        update: Boolean(preview.config.update),
      },
      nodeFiles: nodeFilesState,
      targetNodes,
      serviceData: serviceDataState,
    });
  }, [nodes, setRestoreSelectionState]);

  const openRestoreOverlay = (reset = false) => {
    if (reset) {
      setRestorePreview(null);
      setRestoreSource(null);
      setRestoreSelectionState(null);
      setRestoreUploadError(null);
      setRestoreFilePreview(null);
      setRestoreFilePreviewError(null);
    }
    setRestoreOverlayOpen(true);
    setRestoreUploadError(null);
    setRestoreExpandedSections({});
  };

  const closeRestoreOverlay = useCallback(() => {
    if (restoringBackup) return;
    setRestoreOverlayOpen(false);
    setRestorePreview(null);
    setRestoreSource(null);
    setRestoreUploadError(null);
    setRestoreSelectionState(null);
    setRestoreFilePreview(null);
    setRestoreFilePreviewError(null);
  }, [restoringBackup, setRestoreOverlayOpen, setRestorePreview, setRestoreSource, setRestoreUploadError, setRestoreSelectionState, setRestoreFilePreview, setRestoreFilePreviewError]);

  useEscapeKey(closeRestoreOverlay, restoreOverlayOpen, true);
  useEscapeKey(() => setRestoreFilePreview(null), Boolean(restoreFilePreview), true);

  const handleRestorePreviewRequest = async (payload: { file?: File; fileName?: string }) => {
    setRestoreUploadError(null);
    setRestorePreview(null);
    setRestoreSource(null);
    setRestoreSelectionState(null);
    setRestoreFilePreview(null);
    setRestoreFilePreviewError(null);

    try {
      let input: { fileName: string } | FormData;
      if (payload.file) {
        const formData = new FormData();
        formData.append('file', payload.file);
        input = formData;
      } else if (payload.fileName) {
        input = { fileName: payload.fileName };
      } else {
        throw new Error('No backup selected');
      }

      const data = await previewSystemBackup(input);
      setRestorePreview(data.preview as BackupPreviewResult);
      setRestoreSource(data.source);
      buildDefaultRestoreState(data.preview as BackupPreviewResult);
      openRestoreOverlay(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load backup preview';
      setRestoreUploadError(message);
      addToast('error', 'Restore preview failed', message);
    }
  };

  const handleRestoreFilePreview = useCallback(async (nodeName: string, relativePath: string) => {
    if (!restoreSource) return;
    setRestoreFilePreview({ nodeName, relativePath, content: '', loading: true });
    setRestoreFilePreviewError(null);
    try {
      const fileName = restoreSource.type === 'stored' ? restoreSource.fileName : undefined;
      const uploadToken = restoreSource.type === 'upload' ? restoreSource.token : undefined;
      const data = await fetchBackupFile(fileName, uploadToken, nodeName, relativePath);
      setRestoreFilePreview({ nodeName, relativePath, content: data.content ?? '', loading: false });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to load file preview';
      setRestoreFilePreviewError(message);
      setRestoreFilePreview({ nodeName, relativePath, content: '', loading: false });
    }
  }, [restoreSource, setRestoreFilePreview, setRestoreFilePreviewError]);

  const handleRestoreRequest = (entry: SystemBackupEntrySummary) => {
    void handleRestorePreviewRequest({ fileName: entry.fileName });
  };

  const handleRestoreFromFile = (file: File | null) => {
    if (!file) return;
    void handleRestorePreviewRequest({ file });
  };

  const confirmRestoreBackup = useCallback(async () => {
    if (!restorePreview || !restoreSource || !restoreSelectionState || restoringBackup) return;
    setRestoringBackup(true);
    try {
      const selectedNodes = Object.entries(restoreSelectionState.nodes).filter(([, v]) => v).map(([name]) => name);
      const selectedChecks = Object.entries(restoreSelectionState.checks).filter(([, v]) => v).map(([id]) => id);
      const nodeFiles = Object.entries(restoreSelectionState.nodeFiles)
        .map(([sourceNode, filesMap]) => {
          const files = Object.entries(filesMap).filter(([, v]) => v).map(([path]) => path);
          const targetNode = restoreSelectionState.targetNodes[sourceNode];
          return { sourceNode, targetNode, files };
        })
        .filter(group => group.files.length > 0 && group.targetNode);

      const selectedServiceData: { name: string; files?: string[] }[] = [];
      for (const [name, filesMap] of Object.entries(restoreSelectionState.serviceData)) {
        const selectedFiles = Object.entries(filesMap).filter(([, v]) => v).map(([f]) => f);
        if (selectedFiles.length === 0) continue;
        const sdPreview = restorePreview.serviceData?.find(sd => sd.name === name);
        if (sdPreview && selectedFiles.length === sdPreview.files.length) {
          selectedServiceData.push({ name });
        } else {
          selectedServiceData.push({ name, files: selectedFiles });
        }
      }

      const selection: BackupRestoreSelection = {
        config: {
          nodes: selectedNodes,
          checks: selectedChecks,
          externalLinks: restoreSelectionState.configFlags.externalLinks,
          registries: restoreSelectionState.configFlags.registries,
          gateway: restoreSelectionState.configFlags.gateway,
          notifications: restoreSelectionState.configFlags.notifications,
          templateSettings: restoreSelectionState.configFlags.templateSettings,
          logLevel: restoreSelectionState.configFlags.logLevel,
          update: restoreSelectionState.configFlags.update,
        },
        nodeFiles,
        serviceData: selectedServiceData.length > 0 ? selectedServiceData : undefined,
      };

      const fileName = restoreSource.type === 'stored' ? restoreSource.fileName : undefined;
      const uploadToken = restoreSource.type === 'upload' ? restoreSource.token : undefined;

      await restoreSystemBackup({
        fileName,
        uploadToken,
        selection,
      });

      addToast('success', 'Restore complete', 'Selected settings and files were restored.');
      await fetchBackups();
      closeRestoreOverlay();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Restore failed';
      addToast('error', 'Restore failed', message);
    } finally {
      setRestoringBackup(false);
    }
  }, [addToast, closeRestoreOverlay, fetchBackups, restorePreview, restoreSelectionState, restoreSource, restoringBackup, setRestoringBackup]);

  const selectAllRestoreItems = useCallback(() => {
    if (!restorePreview || !restoreSelectionState) return;
    setRestoreSelectionState({
      nodes: Object.fromEntries(restorePreview.config.nodes.map(node => [node.name, true])),
      checks: Object.fromEntries(restorePreview.config.checks.map(check => [check.id, true])),
      configFlags: {
        externalLinks: restorePreview.config.externalLinks.length > 0,
        registries: restorePreview.config.registries.length > 0,
        gateway: Boolean(restorePreview.config.gateway),
        notifications: Boolean(restorePreview.config.notifications),
        templateSettings: restorePreview.config.templateSettings.length > 0,
        logLevel: Boolean(restorePreview.config.logLevel),
        update: Boolean(restorePreview.config.update),
      },
      nodeFiles: Object.fromEntries(
        restorePreview.nodeFiles.map(group => [
          group.nodeName,
          Object.fromEntries(group.files.map(file => [file.relativePath, true])),
        ]),
      ),
      targetNodes: restoreSelectionState.targetNodes,
      serviceData: Object.fromEntries((restorePreview.serviceData || []).map(sd => [sd.name, Object.fromEntries(sd.files.map(f => [f, true]))])),
    });
  }, [restorePreview, restoreSelectionState, setRestoreSelectionState]);

  const availableRestoreTargets = Array.from(new Set(['Local', ...nodes.map(node => node.Name)]));

  const handleRestoreDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (event.dataTransfer.files && event.dataTransfer.files[0]) {
      handleRestoreFromFile(event.dataTransfer.files[0]);
    }
  };
  const handleRestoreDragOver = (event: React.DragEvent<HTMLDivElement>) => { event.preventDefault(); };
  const stopRestoreEvent = useCallback((event: React.MouseEvent) => { event.stopPropagation(); }, []);
  const handleRestoreBackdrop = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    event.stopPropagation();
    closeRestoreOverlay();
  }, [closeRestoreOverlay]);

  const toggleRestoreConfigFlag = (key: keyof BackupRestoreSelection['config']) => {
    setRestoreSelectionState(prev => {
      if (!prev) return prev;
      if (key === 'nodes' || key === 'checks') return prev;
      return {
        ...prev,
        configFlags: { ...prev.configFlags, [key]: !prev.configFlags[key as keyof typeof prev.configFlags] },
      };
    });
  };
  const toggleRestoreNode = (name: string) => {
    setRestoreSelectionState(prev => prev ? { ...prev, nodes: { ...prev.nodes, [name]: !prev.nodes[name] } } : prev);
  };
  const toggleRestoreCheck = (id: string) => {
    setRestoreSelectionState(prev => prev ? { ...prev, checks: { ...prev.checks, [id]: !prev.checks[id] } } : prev);
  };
  const toggleRestoreFile = (nodeName: string, filePath: string) => {
    setRestoreSelectionState(prev => prev ? {
      ...prev,
      nodeFiles: {
        ...prev.nodeFiles,
        [nodeName]: { ...prev.nodeFiles[nodeName], [filePath]: !prev.nodeFiles[nodeName]?.[filePath] },
      },
    } : prev);
  };
  const updateRestoreTargetNode = (sourceNode: string, targetNode: string) => {
    setRestoreSelectionState(prev => prev ? { ...prev, targetNodes: { ...prev.targetNodes, [sourceNode]: targetNode } } : prev);
  };
  const toggleRestoreSection = (section: string) => {
    setRestoreExpandedSections(prev => ({ ...prev, [section]: !prev[section] }));
  };
  const toggleAllNodeFiles = (nodeName: string, selected: boolean) => {
    if (!restorePreview) return;
    const group = restorePreview.nodeFiles.find(g => g.nodeName === nodeName);
    if (!group) return;
    setRestoreSelectionState(prev => prev ? {
      ...prev,
      nodeFiles: { ...prev.nodeFiles, [nodeName]: Object.fromEntries(group.files.map(f => [f.relativePath, selected])) },
    } : prev);
  };
  const toggleServiceGroupFiles = (nodeName: string, files: { relativePath: string }[], selected: boolean) => {
    setRestoreSelectionState(prev => {
      if (!prev) return prev;
      const updated = { ...prev.nodeFiles[nodeName] };
      for (const f of files) updated[f.relativePath] = selected;
      return { ...prev, nodeFiles: { ...prev.nodeFiles, [nodeName]: updated } };
    });
  };

  const getRestoreSelectionSummary = () => {
    if (!restorePreview || !restoreSelectionState) return null;
    const configCount = Object.values(restoreSelectionState.configFlags).filter(Boolean).length;
    const nodeCount = Object.values(restoreSelectionState.nodes).filter(Boolean).length;
    const checkCount = Object.values(restoreSelectionState.checks).filter(Boolean).length;
    const fileCount = Object.values(restoreSelectionState.nodeFiles).reduce(
      (sum, files) => sum + Object.values(files).filter(Boolean).length, 0,
    );
    const dataCount = Object.values(restoreSelectionState.serviceData).reduce(
      (sum, filesMap) => sum + Object.values(filesMap).filter(Boolean).length, 0,
    );
    const parts: string[] = [];
    if (configCount > 0) parts.push(`${configCount} setting${configCount !== 1 ? 's' : ''}`);
    if (nodeCount > 0) parts.push(`${nodeCount} node${nodeCount !== 1 ? 's' : ''}`);
    if (checkCount > 0) parts.push(`${checkCount} check${checkCount !== 1 ? 's' : ''}`);
    if (fileCount > 0) parts.push(`${fileCount} file${fileCount !== 1 ? 's' : ''}`);
    if (dataCount > 0) parts.push(`${dataCount} data file${dataCount !== 1 ? 's' : ''}`);
    return parts.length > 0 ? parts.join(', ') : 'Nothing selected';
  };

  // The nightly NAS-backup schedule (#1890), surfaced on both sections so the

  return {
    buildDefaultRestoreState,
    openRestoreOverlay,
    closeRestoreOverlay,
    handleRestorePreviewRequest,
    handleRestoreFilePreview,
    handleRestoreRequest,
    handleRestoreFromFile,
    confirmRestoreBackup,
    selectAllRestoreItems,
    availableRestoreTargets,
    handleRestoreDrop,
    handleRestoreDragOver,
    stopRestoreEvent,
    handleRestoreBackdrop,
    toggleRestoreConfigFlag,
    toggleRestoreNode,
    toggleRestoreCheck,
    toggleRestoreFile,
    updateRestoreTargetNode,
    toggleRestoreSection,
    toggleAllNodeFiles,
    toggleServiceGroupFiles,
    getRestoreSelectionSummary,
  };
}

export type RestoreFlow = ReturnType<typeof useRestoreFlow>;


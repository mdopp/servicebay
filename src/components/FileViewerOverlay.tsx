'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertCircle, FileText, RefreshCw, X } from 'lucide-react';
import FileViewer from '@/components/FileViewer';
import { useEscapeKey } from '@/hooks/useEscapeKey';

interface FileViewerOverlayProps {
  isOpen: boolean;
  path: string;
  nodeName?: string;
  onClose: () => void;
}

const determineLanguage = (path: string): string => {
  const lower = path.toLowerCase();
  if (lower.endsWith('.md')) return 'markdown';
  if (lower.endsWith('.yml') || lower.endsWith('.yaml')) return 'yaml';
  if (/(\.service|\.container|\.kube|\.network|\.volume)$/.test(lower)) return 'ini';
  if (lower.endsWith('.json')) return 'json';
  if (lower.endsWith('.sh')) return 'bash';
  return 'text';
};

type FileState = {
  key: string | null;
  content: string;
  error: string | null;
};

export default function FileViewerOverlay({ isOpen, path, nodeName, onClose }: FileViewerOverlayProps) {
  const [fileState, setFileState] = useState<FileState>({ key: null, content: '', error: null });

  const language = useMemo(() => determineLanguage(path), [path]);
  const nodeLabel = nodeName || 'Local';
  const activeRequest = useMemo(() => {
    if (!isOpen || !path) return null;
    const key = `${nodeLabel}::${path}`;
    const remoteNode = nodeName && nodeName !== 'Local' ? nodeName : undefined;
    return { key, path, node: remoteNode };
  }, [isOpen, nodeLabel, nodeName, path]);

  const fetchContent = useCallback(async (activePath: string, activeNode?: string, signal?: AbortSignal) => {
    const params = new URLSearchParams({ path: activePath });
    if (activeNode && activeNode !== 'Local') {
      params.set('node', activeNode);
    }

    const res = await fetch(`/api/system/files?${params.toString()}`, {
      cache: 'no-store',
      signal
    });

    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(payload.error || 'Unable to read file');
    }

    return payload.content || '';
  }, []);

  useEffect(() => {
    if (!activeRequest) return;

    const controller = new AbortController();
    let cancelled = false;

    fetchContent(activeRequest.path, activeRequest.node, controller.signal)
      .then(content => {
        if (cancelled) return;
        setFileState({ key: activeRequest.key, content, error: null });
      })
      .catch(error => {
        if (cancelled || controller.signal.aborted) return;
        const message = error instanceof Error ? error.message : 'Failed to load file';
        setFileState({ key: activeRequest.key, content: '', error: message });
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [activeRequest, fetchContent]);

  const isLoading = Boolean(activeRequest && fileState.key !== activeRequest.key);
  const activeError = activeRequest && fileState.key === activeRequest.key ? fileState.error : null;
  const activeContent = activeRequest && fileState.key === activeRequest.key ? fileState.content : '';

  const closeViewer = useCallback(() => {
    onClose();
  }, [onClose]);

  useEscapeKey(closeViewer, isOpen, true);

    const stopEventPropagation = useCallback((event: React.MouseEvent) => {
      event.stopPropagation();
    }, []);

    const handleBackdropClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
      event.stopPropagation();
      closeViewer();
    }, [closeViewer]);

  if (!isOpen || !path) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-[120] flex items-stretch justify-center p-0 md:p-6" onMouseDown={stopEventPropagation} onClick={stopEventPropagation}>
      <div className="absolute inset-0 bg-gray-950/70 backdrop-blur-sm" onMouseDown={stopEventPropagation} onClick={handleBackdropClick} />
      <div className="relative z-10 flex w-full h-full max-w-full flex-col rounded-none border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 shadow-2xl md:h-auto md:max-h-[90vh] md:max-w-5xl md:rounded-2xl">
        <div className="flex items-center justify-between border-b border-gray-200 dark:border-gray-800 px-5 py-4">
          <div className="flex flex-col gap-1 text-sm">
            <div className="flex items-center gap-2 text-gray-600 dark:text-gray-300">
              <FileText size={16} />
              <span className="font-medium text-gray-900 dark:text-gray-100 text-sm md:text-base whitespace-normal break-all max-w-full" title={path}>
                {path}
              </span>
            </div>
            <span className="text-xs uppercase tracking-wide text-gray-400">Node: {nodeLabel}</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-2 text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-800"
            aria-label="Close file viewer"
          >
            <X size={18} />
          </button>
        </div>
        <div className="flex-1 overflow-hidden">
          {isLoading ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-gray-500">
              <RefreshCw className="animate-spin" />
              Loading file...
            </div>
          ) : activeError ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-red-600 dark:text-red-400 px-6 text-center">
              <AlertCircle size={20} />
              <p className="text-sm">{activeError}</p>
            </div>
          ) : (
            <div className="h-full overflow-auto">
              <FileViewer content={activeContent} language={language} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

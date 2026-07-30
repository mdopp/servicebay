'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { fetchTemplates, syncAllRegistries } from '@/app/actions';
import { Template } from '@servicebay/api-client';
import RegistryBrowser from '@/components/RegistryBrowser';
import { Loader2, RefreshCw, DownloadCloud } from 'lucide-react';
import PageHeader from '@/components/PageHeader';
import { useToast } from '@/providers/ToastProvider';

interface RegistryDashboardProps {
    variant?: 'page' | 'embedded';
}

export default function RegistryDashboard({ variant = 'page' }: RegistryDashboardProps) {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const isFetchingRef = useRef(false);
  const { addToast } = useToast();

  const loadData = async () => {
    if (isFetchingRef.current) return;
    isFetchingRef.current = true;
    setLoading(true);
    try {
      const data = await fetchTemplates();
      setTemplates(data);
    } finally {
      setLoading(false);
      isFetchingRef.current = false;
    }
  };

  // A rejected load used to be swallowed by try/finally: the spinner cleared
  // and the operator was left staring at an empty registry with no clue
  // anything failed. Report it like every sibling dashboard does (#2462). The
  // handler sits here rather than inside `loadData` so the mount effect doesn't
  // reach a synchronous setState-in-catch (react-hooks/set-state-in-effect).
  const refresh = useCallback(() => {
    void loadData().catch(e =>
      addToast('error', 'Failed to load registry', e instanceof Error ? e.message : String(e)),
    );
  }, [addToast]);

  const handleSync = async () => {
      setSyncing(true);
      try {
          await syncAllRegistries();
          await loadData();
      } catch (e) {
          addToast('error', 'Registry sync failed', e instanceof Error ? e.message : String(e));
      } finally {
          setSyncing(false);
      }
  };

  useEffect(() => {
    refresh();
  }, [refresh]);

  const actionButtons = (
    <div className="flex items-center gap-2">
        <button
            onClick={handleSync}
            disabled={syncing}
            className="flex items-center gap-2 px-3 py-2 text-sm font-medium text-on-accent bg-accent rounded hover:bg-accent-strong shadow-sm transition-colors disabled:opacity-50"
        >
            <DownloadCloud size={16} className={syncing ? 'animate-pulse' : ''} />
            {syncing ? 'Syncing...' : 'Sync Registries'}
        </button>
        <button
            onClick={refresh}
            className="p-2 text-text bg-surface border border-border rounded hover:bg-surface-2 shadow-sm transition-colors"
            title="Refresh"
        >
            <RefreshCw size={18} className={loading ? 'animate-spin' : ''} />
        </button>
    </div>
  );

  return (
    <div className={`h-full flex flex-col ${variant === 'embedded' ? 'bg-surface' : ''}`}>
        {variant === 'page' ? (
            <PageHeader
                title="Service Registry"
                helpId="registry"
                actions={actionButtons}
            />
        ) : (
            <div className="px-6 py-4 border-b border-border bg-surface">
                <div className="flex items-center justify-between">
                    <div>
                        <p className="text-xs uppercase tracking-[0.2em] text-text-subtle">Registry Controls</p>
                        <h3 className="text-lg font-semibold text-text">Sync templates & install stacks</h3>
                    </div>
                    {actionButtons}
                </div>
            </div>
        )}
        <div className="flex-1 min-h-0">
            {loading ? (
                <div className="h-full flex items-center justify-center">
                    <Loader2 className="animate-spin text-text-subtle" size={32} />
                </div>
            ) : (
                <RegistryBrowser templates={templates} />
            )}
        </div>
    </div>
  );
}

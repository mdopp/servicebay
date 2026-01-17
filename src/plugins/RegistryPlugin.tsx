'use client';

import { useState, useEffect, useRef } from 'react';
import { fetchTemplates, syncAllRegistries } from '@/app/actions';
import { Template } from '@/lib/registry';
import RegistryBrowser from '@/components/RegistryBrowser';
import { Loader2, RefreshCw, DownloadCloud } from 'lucide-react';
import PageHeader from '@/components/PageHeader';

interface RegistryPluginProps {
    variant?: 'page' | 'embedded';
}

export default function RegistryPlugin({ variant = 'page' }: RegistryPluginProps) {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const isFetchingRef = useRef(false);

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

  const handleSync = async () => {
      setSyncing(true);
      try {
          await syncAllRegistries();
          await loadData();
      } finally {
          setSyncing(false);
      }
  };

  useEffect(() => {
    loadData();
  }, []);

  const actionButtons = (
    <div className="flex items-center gap-2">
        <button 
            onClick={handleSync}
            disabled={syncing}
            className="flex items-center gap-2 px-3 py-2 text-sm font-medium text-white bg-indigo-600 rounded hover:bg-indigo-700 shadow-sm transition-colors disabled:opacity-50"
        >
            <DownloadCloud size={16} className={syncing ? 'animate-pulse' : ''} />
            {syncing ? 'Syncing...' : 'Sync Registries'}
        </button>
        <button 
            onClick={loadData}
            className="p-2 text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded hover:bg-gray-50 dark:hover:bg-gray-700 shadow-sm transition-colors"
            title="Refresh"
        >
            <RefreshCw size={18} className={loading ? 'animate-spin' : ''} />
        </button>
    </div>
  );

  return (
    <div className={`h-full flex flex-col ${variant === 'embedded' ? 'bg-white dark:bg-gray-950' : ''}`}>
        {variant === 'page' ? (
            <PageHeader 
                title="Service Registry" 
                helpId="registry"
                actions={actionButtons}
            />
        ) : (
            <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950">
                <div className="flex items-center justify-between">
                    <div>
                        <p className="text-xs uppercase tracking-[0.2em] text-gray-500 dark:text-gray-400">Registry Controls</p>
                        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Sync templates & install stacks</h3>
                    </div>
                    {actionButtons}
                </div>
            </div>
        )}
        <div className="flex-1 min-h-0">
            {loading ? (
                <div className="h-full flex items-center justify-center">
                    <Loader2 className="animate-spin text-gray-400" size={32} />
                </div>
            ) : (
                <RegistryBrowser templates={templates} />
            )}
        </div>
    </div>
  );
}

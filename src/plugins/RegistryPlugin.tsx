'use client';

import { useState, useEffect } from 'react';
import { fetchTemplates, syncAllRegistries } from '@/app/actions';
import { Template } from '@/lib/registry';
import RegistryBrowser from '@/components/RegistryBrowser';
import { Loader2, RefreshCw, DownloadCloud } from 'lucide-react';
import PageHeader from '@/components/PageHeader';

export default function RegistryPlugin() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);

  const loadData = async () => {
    setLoading(true);
    try {
      const data = await fetchTemplates();
      setTemplates(data);
    } finally {
      setLoading(false);
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

  return (
    <div className="h-full flex flex-col">
        <PageHeader title="Service Registry" helpId="registry">
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
        </PageHeader>
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

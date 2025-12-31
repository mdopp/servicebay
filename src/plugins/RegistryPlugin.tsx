'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { fetchTemplates } from '@/app/actions';
import { Template } from '@/lib/registry';
import RegistryBrowser from '@/components/RegistryBrowser';
import { Loader2, ArrowLeft, RefreshCw } from 'lucide-react';

export default function RegistryPlugin() {
  const router = useRouter();
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);

  const loadData = async () => {
    setLoading(true);
    try {
      const data = await fetchTemplates();
      setTemplates(data);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  return (
    <div className="h-full flex flex-col">
        <div className="p-4 border-b border-gray-200 dark:border-gray-800 flex items-center justify-between bg-gray-50 dark:bg-gray-900/50">
            <div className="flex items-center gap-4">
                <button 
                    onClick={() => router.back()}
                    className="p-2 hover:bg-gray-200 dark:hover:bg-gray-700 rounded-full transition-colors"
                    title="Go Back"
                >
                    <ArrowLeft size={20} className="text-gray-600 dark:text-gray-300" />
                </button>
                <h2 className="text-xl font-bold text-gray-900 dark:text-white">Service Registry</h2>
            </div>
            <button 
                onClick={loadData}
                className="p-2 text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded hover:bg-gray-50 dark:hover:bg-gray-700 shadow-sm transition-colors"
                title="Refresh"
            >
                <RefreshCw size={18} className={loading ? 'animate-spin' : ''} />
            </button>
        </div>
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

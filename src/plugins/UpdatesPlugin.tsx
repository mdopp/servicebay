'use client';

import { useState, useEffect } from 'react';
import { getSystemUpdates } from '@/app/actions/system';
import { RefreshCw, CheckCircle, AlertTriangle } from 'lucide-react';

export default function UpdatesPlugin() {
  const [updates, setUpdates] = useState<{ count: number; list: string[] } | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchData = async () => {
    setLoading(true);
    try {
      const data = await getSystemUpdates();
      setUpdates(data);
    } catch (error) {
      console.error('Failed to fetch updates', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  return (
    <div className="h-full flex flex-col">
      <div className="flex justify-between items-center mb-6 p-4 border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/50">
        <h2 className="text-xl font-bold text-gray-900 dark:text-white">System Updates</h2>
        <button onClick={fetchData} className="p-2 text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded hover:bg-gray-50 dark:hover:bg-gray-700 shadow-sm transition-colors" title="Refresh">
            <RefreshCw size={18} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {loading ? (
            <div className="text-center text-gray-500 mt-10">Checking for updates...</div>
        ) : !updates ? (
            <div className="text-center text-red-500 mt-10">Failed to check updates.</div>
        ) : updates.count === 0 ? (
            <div className="flex flex-col items-center justify-center h-64 text-green-600 dark:text-green-400">
                <CheckCircle size={48} className="mb-4" />
                <p className="text-lg font-medium">System is up to date</p>
            </div>
        ) : (
            <div>
                <div className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg p-4 mb-6 flex items-center gap-3">
                    <AlertTriangle className="text-yellow-600 dark:text-yellow-400" size={24} />
                    <div>
                        <h3 className="font-bold text-yellow-800 dark:text-yellow-200">{updates.count} Updates Available</h3>
                        <p className="text-sm text-yellow-700 dark:text-yellow-300">Security patches and software updates are waiting.</p>
                    </div>
                </div>

                <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg overflow-hidden">
                    <div className="p-3 bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 font-medium text-sm">
                        Package List (Top 10)
                    </div>
                    <ul className="divide-y divide-gray-100 dark:divide-gray-800">
                        {updates.list.map((pkg, i) => (
                            <li key={i} className="p-3 text-sm font-mono text-gray-700 dark:text-gray-300">
                                {pkg}
                            </li>
                        ))}
                    </ul>
                    {updates.count > 10 && (
                        <div className="p-3 text-center text-xs text-gray-500 bg-gray-50 dark:bg-gray-800/50">
                            ...and {updates.count - 10} more
                        </div>
                    )}
                </div>
                
                <div className="mt-6 text-center">
                    <p className="text-sm text-gray-500 mb-2">To install updates, run this in your terminal:</p>
                    <code className="bg-gray-100 dark:bg-gray-800 px-3 py-2 rounded text-sm font-mono block w-full md:w-auto mx-auto max-w-md">
                        sudo apt update && sudo apt upgrade
                    </code>
                </div>
            </div>
        )}
      </div>
    </div>
  );
}

'use client';

import { Server } from 'lucide-react';
import { useSettings } from '../SettingsContext';

export default function ServerIdentitySection() {
  const { saving, serverName, setServerName, persistSettings } = useSettings();

  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm overflow-hidden w-full">
      <div className="p-4 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 flex items-center gap-3">
        <div className="p-2 bg-indigo-100 dark:bg-indigo-900/30 rounded-lg text-indigo-600 dark:text-indigo-400">
          <Server size={20} />
        </div>
        <div>
          <h3 className="font-bold text-gray-900 dark:text-white">Server Identity</h3>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Custom display name shown in the browser tab and system info instead of the detected hostname.
          </p>
        </div>
      </div>
      <div className="p-6">
        <div className="flex items-center gap-3">
          <input
            type="text"
            value={serverName}
            onChange={e => setServerName(e.target.value)}
            disabled={saving}
            className="flex-1 p-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white focus:ring-2 focus:ring-indigo-500 outline-none"
            placeholder="e.g. HomeServer, NAS, Production"
          />
          <button
            onClick={() => persistSettings()}
            disabled={saving}
            className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 transition-colors text-sm font-medium"
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

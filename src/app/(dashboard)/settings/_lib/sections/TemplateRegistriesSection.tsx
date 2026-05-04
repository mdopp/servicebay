'use client';

import { useState } from 'react';
import { GitBranch, Plus, Trash2 } from 'lucide-react';
import { useSettings } from '../SettingsContext';

export default function TemplateRegistriesSection() {
  const { saving, persistSettings, registriesEnabled, setRegistriesEnabled, registries, setRegistries } = useSettings();
  const [newRegName, setNewRegName] = useState('');
  const [newRegUrl, setNewRegUrl] = useState('');
  const [newRegBranch, setNewRegBranch] = useState('');

  const handleToggle = (enabled: boolean) => {
    setRegistriesEnabled(enabled);
    void persistSettings({ registriesEnabled: enabled });
  };

  const handleAdd = () => {
    if (!newRegName || !newRegUrl) return;
    const updated = [...registries, { name: newRegName, url: newRegUrl, branch: newRegBranch || undefined }];
    setRegistries(updated);
    setNewRegName('');
    setNewRegUrl('');
    setNewRegBranch('');
    void persistSettings({ registries: updated });
  };

  const handleRemove = (name: string) => {
    const updated = registries.filter(r => r.name !== name);
    setRegistries(updated);
    void persistSettings({ registries: updated });
  };

  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm overflow-hidden w-full">
      <div className="p-4 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 flex items-center gap-3">
        <div className="p-2 bg-indigo-100 dark:bg-indigo-900/30 rounded-lg text-indigo-600 dark:text-indigo-400">
          <GitBranch size={20} />
        </div>
        <div>
          <h3 className="font-bold text-gray-900 dark:text-white">Template Registries</h3>
          <p className="text-xs text-gray-500 dark:text-gray-400">Connect Git repositories that supply ServiceBay templates and stacks.</p>
        </div>
        <div className="ml-auto">
          <label className="relative inline-flex items-center cursor-pointer">
            <input
              type="checkbox"
              className="sr-only peer"
              checked={registriesEnabled}
              onChange={e => handleToggle(e.target.checked)}
              disabled={saving}
            />
            <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-indigo-300 dark:peer-focus:ring-indigo-800 rounded-full peer dark:bg-gray-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-gray-600 peer-checked:bg-indigo-600"></div>
          </label>
        </div>
      </div>

      {registriesEnabled && (
        <div className="p-6 space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-12 gap-4 items-end">
            <div className="md:col-span-3">
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Name</label>
              <input
                type="text"
                value={newRegName}
                onChange={e => setNewRegName(e.target.value)}
                disabled={saving}
                className="w-full p-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white focus:ring-2 focus:ring-indigo-500 outline-none"
                placeholder="my-registry"
              />
            </div>
            <div className="md:col-span-5">
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Git URL</label>
              <input
                type="text"
                value={newRegUrl}
                onChange={e => setNewRegUrl(e.target.value)}
                disabled={saving}
                className="w-full p-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white focus:ring-2 focus:ring-indigo-500 outline-none"
                placeholder="https://github.com/user/repo.git"
              />
            </div>
            <div className="md:col-span-3">
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Branch (Optional)</label>
              <input
                type="text"
                value={newRegBranch}
                onChange={e => setNewRegBranch(e.target.value)}
                disabled={saving}
                className="w-full p-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white focus:ring-2 focus:ring-indigo-500 outline-none"
                placeholder="main"
              />
            </div>
            <div className="md:col-span-1">
              <button
                onClick={handleAdd}
                disabled={saving || !newRegName || !newRegUrl}
                className="w-full p-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex justify-center"
              >
                <Plus size={20} />
              </button>
            </div>
          </div>

          <div className="space-y-2">
            {registries.map(reg => (
              <div key={reg.name} className="flex items-center justify-between p-3 bg-gray-50 dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700">
                <div className="flex items-center gap-4">
                  <div className="font-medium text-gray-900 dark:text-white">{reg.name}</div>
                  <div className="text-sm text-gray-500 dark:text-gray-400 font-mono">{reg.url}</div>
                  {reg.branch && (
                    <div className="text-xs px-2 py-1 bg-gray-200 dark:bg-gray-800 rounded text-gray-600 dark:text-gray-300 font-mono">
                      {reg.branch}
                    </div>
                  )}
                </div>
                <button
                  onClick={() => handleRemove(reg.name)}
                  disabled={saving}
                  className="text-gray-400 hover:text-red-500 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <Trash2 size={18} />
                </button>
              </div>
            ))}
            {registries.length === 0 && (
              <p className="text-sm text-gray-500 italic text-center py-4">No external registries configured. Only built-in templates are available.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

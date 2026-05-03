'use client';

import { useState } from 'react';
import { Server, Plus, Trash2, GitBranch } from 'lucide-react';
import LogLevelControl from '@/components/LogLevelControl';
import { useSettings } from '../_lib/SettingsContext';

export default function AdvancedSettingsPage() {
  const {
    saving,
    serverName,
    setServerName,
    persistSettings,
    templateSchema,
    templateValues,
    setTemplateValues,
    registriesEnabled,
    setRegistriesEnabled,
    registries,
    setRegistries,
  } = useSettings();

  const [newVarKey, setNewVarKey] = useState('');
  const [newVarValue, setNewVarValue] = useState('');
  const [newRegName, setNewRegName] = useState('');
  const [newRegUrl, setNewRegUrl] = useState('');
  const [newRegBranch, setNewRegBranch] = useState('');

  const handleTemplateValueChange = (key: string, value: string) => {
    setTemplateValues(prev => ({ ...prev, [key]: value }));
  };

  const handleAddTemplateVariable = () => {
    if (!newVarKey.trim()) return;
    const key = newVarKey.trim();
    const updated = { ...templateValues, [key]: newVarValue };
    setTemplateValues(updated);
    setNewVarKey('');
    setNewVarValue('');
    void persistSettings({ templateValues: updated });
  };

  const handleRemoveTemplateVariable = (key: string) => {
    const meta = templateSchema[key];
    if (meta?.required) return;
    setTemplateValues(prev => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { [key]: _removed, ...rest } = prev;
      void persistSettings({ templateValues: rest });
      return rest;
    });
  };

  const handleRegistriesToggle = (enabled: boolean) => {
    setRegistriesEnabled(enabled);
    void persistSettings({ registriesEnabled: enabled });
  };

  const handleAddRegistry = () => {
    if (!newRegName || !newRegUrl) return;
    const updated = [...registries, { name: newRegName, url: newRegUrl, branch: newRegBranch || undefined }];
    setRegistries(updated);
    setNewRegName('');
    setNewRegUrl('');
    setNewRegBranch('');
    void persistSettings({ registries: updated });
  };

  const handleRemoveRegistry = (name: string) => {
    const updated = registries.filter(r => r.name !== name);
    setRegistries(updated);
    void persistSettings({ registries: updated });
  };

  return (
    <>
      {/* Server Identity */}
      <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm overflow-hidden w-full">
        <div className="p-4 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 flex items-center gap-3">
          <div className="p-2 bg-indigo-100 dark:bg-indigo-900/30 rounded-lg text-indigo-600 dark:text-indigo-400">
            <Server size={20} />
          </div>
          <div>
            <h3 className="font-bold text-gray-900 dark:text-white">Server Identity</h3>
            <p className="text-xs text-gray-500 dark:text-gray-400">Custom display name shown in the browser tab and system info instead of the detected hostname.</p>
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

      {/* Template Settings */}
      <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm overflow-hidden w-full">
        <div className="p-4 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 flex items-center gap-3">
          <div className="p-2 bg-indigo-100 dark:bg-indigo-900/30 rounded-lg text-indigo-600 dark:text-indigo-400">
            <Server size={20} />
          </div>
          <div>
            <h3 className="font-bold text-gray-900 dark:text-white">Template Settings</h3>
            <p className="text-xs text-gray-500 dark:text-gray-400">Define global variables used when rendering new stacks (e.g., DATA_DIR). Updates affect future deployments only.</p>
          </div>
        </div>
        <div className="p-6 space-y-6">
          <div className="space-y-4">
            <div className="p-4 border border-gray-200 dark:border-gray-700 rounded-lg bg-gradient-to-r from-indigo-50 via-white to-white dark:from-gray-900 dark:via-gray-900 dark:to-gray-900 flex flex-col md:flex-row md:items-center md:gap-4">
              <div className="flex-1">
                <p className="text-sm font-semibold text-gray-900 dark:text-white mb-2">Add Variable</p>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <input
                    type="text"
                    value={newVarKey}
                    onChange={e => setNewVarKey(e.target.value)}
                    disabled={saving}
                    className="w-full p-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white focus:ring-2 focus:ring-indigo-500 outline-none"
                    placeholder="VAR_NAME"
                  />
                  <input
                    type="text"
                    value={newVarValue}
                    onChange={e => setNewVarValue(e.target.value)}
                    disabled={saving}
                    className="w-full p-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white focus:ring-2 focus:ring-indigo-500 outline-none"
                    placeholder="value"
                  />
                </div>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">Variables appear below immediately after you add them.</p>
              </div>
              <button
                onClick={handleAddTemplateVariable}
                disabled={saving || !newVarKey.trim()}
                className="w-full md:w-auto px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors shadow-sm flex items-center gap-2 justify-center disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Plus size={16} />
                Add Variable
              </button>
            </div>

            {Object.keys(templateValues).sort().map(key => {
              const meta = templateSchema[key];
              const isRequired = meta?.required;
              return (
                <div key={key} className="p-4 border border-gray-200 dark:border-gray-700 rounded-lg bg-gray-50 dark:bg-gray-900 flex flex-col md:flex-row md:items-center md:gap-4">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-semibold text-gray-900 dark:text-white">{key}</span>
                      {isRequired && (
                        <span className="text-xs px-2 py-0.5 rounded bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-200">Required</span>
                      )}
                    </div>
                    <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">
                      {meta?.description || 'Template variable'}
                      {meta?.default ? ` (default: ${meta.default})` : ''}
                    </p>
                    <input
                      type="text"
                      value={templateValues[key] || ''}
                      onChange={e => handleTemplateValueChange(key, e.target.value)}
                      onBlur={() => persistSettings()}
                      disabled={saving}
                      className="w-full p-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white focus:ring-2 focus:ring-indigo-500 outline-none"
                      placeholder={meta?.default || ''}
                    />
                  </div>
                  {!isRequired && (
                    <button
                      onClick={() => handleRemoveTemplateVariable(key)}
                      disabled={saving}
                      className="mt-3 md:mt-0 text-gray-400 hover:text-red-500 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                      aria-label={`Remove ${key}`}
                    >
                      <Trash2 size={18} />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Template Registries */}
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
                onChange={e => handleRegistriesToggle(e.target.checked)}
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
                  onClick={handleAddRegistry}
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
                    onClick={() => handleRemoveRegistry(reg.name)}
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

      {/* Log Level Control */}
      <LogLevelControl />
    </>
  );
}

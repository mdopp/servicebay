'use client';

import { useState } from 'react';
import { Plus, Server, Trash2 } from 'lucide-react';
import { useSettings } from '../SettingsContext';

export default function TemplateVariablesSection() {
  const { saving, persistSettings, templateSchema, templateValues, setTemplateValues } = useSettings();
  const [newVarKey, setNewVarKey] = useState('');
  const [newVarValue, setNewVarValue] = useState('');

  const handleTemplateValueChange = (key: string, value: string) => {
    setTemplateValues(prev => ({ ...prev, [key]: value }));
  };

  const handleAdd = () => {
    if (!newVarKey.trim()) return;
    const key = newVarKey.trim();
    const updated = { ...templateValues, [key]: newVarValue };
    setTemplateValues(updated);
    setNewVarKey('');
    setNewVarValue('');
    void persistSettings({ templateValues: updated });
  };

  const handleRemove = (key: string) => {
    const meta = templateSchema[key];
    if (meta?.required) return;
    setTemplateValues(prev => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { [key]: _removed, ...rest } = prev;
      void persistSettings({ templateValues: rest });
      return rest;
    });
  };

  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm overflow-hidden w-full">
      <div className="p-4 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 flex items-center gap-3">
        <div className="p-2 bg-indigo-100 dark:bg-indigo-900/30 rounded-lg text-indigo-600 dark:text-indigo-400">
          <Server size={20} />
        </div>
        <div>
          <h3 className="font-bold text-gray-900 dark:text-white">Template Variables</h3>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Define global variables used when rendering new stacks (e.g., DATA_DIR). Updates affect future deployments only.
          </p>
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
              onClick={handleAdd}
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
                    onClick={() => handleRemove(key)}
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
  );
}

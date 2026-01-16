'use client';

import { useState, useEffect } from 'react';
import { Settings, Save, AlertCircle } from 'lucide-react';
import { useToast } from '@/providers/ToastProvider';

interface LogLevelControlProps {
  onSave?: () => void;
}

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * LogLevelControl Component
 * Allows users to change the global log level
 */
export default function LogLevelControl({ onSave }: LogLevelControlProps) {
  const [logLevel, setLogLevel] = useState<LogLevel>('info');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const { addToast } = useToast();

  // Load current log level
  useEffect(() => {
    const loadLogLevel = async () => {
      try {
        const response = await fetch('/api/settings/logLevel');
        const data = await response.json();
        if (data.success) {
          setLogLevel(data.logLevel);
        }
      } catch (err) {
        console.error('Failed to load log level:', err);
      } finally {
        setLoading(false);
      }
    };

    loadLogLevel();
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      const response = await fetch('/api/settings/logLevel', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ logLevel })
      });

      const data = await response.json();
      if (data.success) {
        addToast('success', 'Log Level Updated', `Log level changed to ${logLevel}`);
        onSave?.();
      } else {
        addToast('error', 'Failed to Update Log Level', data.error);
      }
    } catch (err) {
      addToast('error', 'Failed to Update Log Level', String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bg-white dark:bg-slate-900 rounded-lg border border-slate-200 dark:border-slate-800 p-5">
      <div className="flex items-center gap-2 mb-4">
        <Settings className="w-5 h-5 text-slate-700 dark:text-slate-300" />
        <h3 className="text-lg font-semibold text-slate-900 dark:text-white">Log Level</h3>
      </div>

      <div className="space-y-4">
        {/* Info Box */}
        <div className="flex gap-2 p-3 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded text-sm text-blue-900 dark:text-blue-300">
          <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <p>
            Control the verbosity of system logs. Lower levels include all higher levels.
            <br />
            <span className="text-xs opacity-75 mt-1 block">
              Debug includes everything, Error shows only critical issues.
            </span>
          </p>
        </div>

        {/* Log Level Selector */}
        <div>
          <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">
            Verbosity Level
          </label>
          <select
            value={logLevel}
            onChange={e => setLogLevel(e.target.value as LogLevel)}
            disabled={loading || saving}
            className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded-md bg-white dark:bg-slate-800 text-slate-900 dark:text-white font-medium disabled:opacity-50"
          >
            <option value="debug">Debug - All messages including verbose logs</option>
            <option value="info">Info - Normal operation messages (default)</option>
            <option value="warn">Warn - Warnings and errors only</option>
            <option value="error">Error - Errors only</option>
          </select>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-2">
            Current level: <span className="font-mono font-semibold">{logLevel.toUpperCase()}</span>
          </p>
        </div>

        {/* Save Button */}
        <div className="flex gap-2">
          <button
            onClick={handleSave}
            disabled={loading || saving}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-slate-400 text-white rounded-md font-medium transition-colors"
          >
            {saving ? (
              <>
                <div className="animate-spin">
                  <Settings className="w-4 h-4" />
                </div>
                Saving...
              </>
            ) : (
              <>
                <Save className="w-4 h-4" />
                Save Log Level
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

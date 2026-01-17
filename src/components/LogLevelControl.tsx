'use client';

import { useState, useEffect } from 'react';
import { Settings, AlertCircle, Loader2 } from 'lucide-react';
import { useToast } from '@/providers/ToastProvider';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * LogLevelControl Component
 * Allows users to change the global log level
 */
export default function LogLevelControl() {
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

  const persistLogLevel = async (nextLevel: LogLevel) => {
    setSaving(true);
    try {
      const response = await fetch('/api/settings/logLevel', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ logLevel: nextLevel })
      });

      const data = await response.json();
      if (data.success) {
        addToast('success', 'Log Level Updated', `Log level changed to ${nextLevel}`);
      } else {
        addToast('error', 'Failed to Update Log Level', data.error);
      }
    } catch (err) {
      addToast('error', 'Failed to Update Log Level', String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleLevelChange = (value: LogLevel) => {
    setLogLevel(value);
    void persistLogLevel(value);
  };

  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm overflow-hidden w-full">
      <div className="p-4 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-slate-100 dark:bg-slate-900/40 rounded-lg text-slate-700 dark:text-slate-200">
            <Settings className="w-5 h-5" />
          </div>
          <div>
            <h3 className="font-bold text-gray-900 dark:text-white">Log Level</h3>
            <p className="text-xs text-gray-500 dark:text-gray-400">Control how verbose ServiceBay logging should be.</p>
          </div>
        </div>
        <span className="text-xs text-gray-500 dark:text-gray-400 inline-flex items-center gap-1">
          {saving ? (
            <>
              <Loader2 className="w-3 h-3 animate-spin" />
              Saving…
            </>
          ) : (
            'Auto-saved'
          )}
        </span>
      </div>

      <div className="p-6 space-y-4">
        <div className="flex gap-2 p-3 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded text-sm text-blue-900 dark:text-blue-300">
          <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <p>
            Lower levels include all higher levels. Debug is the noisiest, Error only shows critical issues.
          </p>
        </div>

        <div>
          <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">
            Verbosity Level
          </label>
          <select
            value={logLevel}
            onChange={e => handleLevelChange(e.target.value as LogLevel)}
            disabled={loading || saving}
            className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded-md bg-white dark:bg-slate-800 text-slate-900 dark:text-white font-medium disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <option value="debug">Debug - All messages including verbose logs</option>
            <option value="info">Info - Normal operation messages (default)</option>
            <option value="warn">Warn - Warnings and errors only</option>
            <option value="error">Error - Errors only</option>
          </select>
        </div>
      </div>
    </div>
  );
}

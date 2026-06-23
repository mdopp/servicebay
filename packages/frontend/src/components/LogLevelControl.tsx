'use client';

import { useState, useEffect } from 'react';
import { Settings, AlertCircle, Loader2 } from 'lucide-react';
import { useToast } from '@/providers/ToastProvider';
import { humanizeError } from '@servicebay/api-client';
import { Field } from '@/components/ui';

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
      const { title, detail } = humanizeError(err, 'Failed to Update Log Level');
      addToast('error', title, detail);
    } finally {
      setSaving(false);
    }
  };

  const handleLevelChange = (value: LogLevel) => {
    setLogLevel(value);
    void persistLogLevel(value);
  };

  return (
    <div className="bg-surface border border-border rounded-card overflow-hidden w-full">
      <div className="p-space-4 border-b border-border bg-surface-2 flex items-center justify-between gap-space-3">
        <div className="flex items-center gap-space-3">
          <div className="p-space-2 bg-surface-muted rounded-card text-text-muted">
            <Settings className="w-5 h-5" />
          </div>
          <div>
            <h3 className="font-bold text-text">Log Level</h3>
            <p className="text-xs text-text-muted">Control how verbose ServiceBay logging should be.</p>
          </div>
        </div>
        <span className="text-xs text-text-muted inline-flex items-center gap-space-1">
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

      <div className="p-space-5 space-y-space-4">
        <div className="flex gap-space-2 p-space-3 bg-status-info/10 border border-status-info/20 rounded-card text-sm text-status-info">
          <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <p>
            Lower levels include all higher levels. Debug is the noisiest, Error only shows critical issues.
          </p>
        </div>

        <Field label="Verbosity Level">
          {({ id, ...aria }) => (
            <select
              id={id}
              {...aria}
              value={logLevel}
              onChange={e => handleLevelChange(e.target.value as LogLevel)}
              disabled={loading || saving}
              className="w-full px-space-3 py-2 border border-border rounded-card bg-surface-2 text-text font-medium disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <option value="debug">Debug - All messages including verbose logs</option>
              <option value="info">Info - Normal operation messages (default)</option>
              <option value="warn">Warn - Warnings and errors only</option>
              <option value="error">Error - Errors only</option>
            </select>
          )}
        </Field>
      </div>
    </div>
  );
}

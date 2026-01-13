'use client';

import { useState, useEffect, useRef } from 'react';
import { RefreshCw, Download, Filter, X, AlertCircle, Info } from 'lucide-react';
import { useToast } from '@/providers/ToastProvider';

interface LogEntry {
  timestamp: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  tag: string;
  message: string;
  args?: Record<string, unknown>;
}

interface LogFilter {
  level?: string;
  tag?: string;
  search?: string;
  limit: number;
}

const LOG_LEVEL_COLORS: Record<string, string> = {
  debug: 'text-gray-500',
  info: 'text-blue-600',
  warn: 'text-yellow-600',
  error: 'text-red-600'
};

const LOG_LEVEL_BG: Record<string, string> = {
  debug: 'bg-gray-100 dark:bg-gray-800',
  info: 'bg-blue-50 dark:bg-blue-900/20',
  warn: 'bg-yellow-50 dark:bg-yellow-900/20',
  error: 'bg-red-50 dark:bg-red-900/20'
};

export interface LogViewerProps {
  file?: string;
}

/**
 * LogViewer Component
 * Real-time log viewer with filtering capabilities
 */
export default function LogViewer({ file }: LogViewerProps) {
  const [logFiles, setLogFiles] = useState<Array<{ name: string; path: string }>>([]);
  const [selectedFile, setSelectedFile] = useState<string>(file || '');
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [filteredLogs, setFilteredLogs] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<LogFilter>({
    level: undefined,
    tag: undefined,
    search: undefined,
    limit: 500
  });
  const [autoRefresh, setAutoRefresh] = useState(true);
  const logContainerRef = useRef<HTMLDivElement>(null);
  const { addToast } = useToast();

  // Load log files on mount
  useEffect(() => {
    loadLogFiles();
  }, []);

  // Auto-scroll to bottom when logs update
  useEffect(() => {
    if (autoRefresh && logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [filteredLogs, autoRefresh]);

  // Auto-refresh logs periodically
  useEffect(() => {
    if (!autoRefresh || !selectedFile) return;

    const interval = setInterval(() => {
      loadLogs(selectedFile);
    }, 5000);

    return () => clearInterval(interval);
  }, [autoRefresh, selectedFile]);

  // Apply filters when logs or filter changes
  useEffect(() => {
    let filtered = logs;

    if (filter.level) {
      filtered = filtered.filter(log => log.level === filter.level);
    }
    if (filter.tag) {
      filtered = filtered.filter(log => log.tag.toLowerCase().includes(filter.tag!.toLowerCase()));
    }
    if (filter.search) {
      filtered = filtered.filter(log =>
        log.message.toLowerCase().includes(filter.search!.toLowerCase()) ||
        log.tag.toLowerCase().includes(filter.search!.toLowerCase())
      );
    }

    setFilteredLogs(filtered.slice(-filter.limit));
  }, [logs, filter]);

  const loadLogFiles = async () => {
    try {
      const response = await fetch('/api/logs/list');
      const data = await response.json();
      if (data.success) {
        setLogFiles(data.files);
        if (data.files.length > 0 && !selectedFile) {
          setSelectedFile(data.files[0].name);
        }
      }
    } catch (err) {
      console.error('Failed to load log files:', err);
      addToast('error', 'Failed to load log files', String(err));
    }
  };

  const loadLogs = async (filename: string) => {
    if (!filename) return;

    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (filter.level) params.append('level', filter.level);
      if (filter.tag) params.append('tag', filter.tag);
      if (filter.search) params.append('search', filter.search);
      params.append('limit', String(filter.limit));

      const response = await fetch(`/api/logs/${encodeURIComponent(filename)}?${params}`);
      const data = await response.json();

      if (data.success) {
        setLogs(data.logs);
      } else {
        addToast('error', 'Failed to load logs', data.error);
      }
    } catch (err) {
      console.error('Failed to load logs:', err);
      addToast('error', 'Failed to load logs', String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleFileChange = (filename: string) => {
    setSelectedFile(filename);
    loadLogs(filename);
  };

  const handleRefresh = () => {
    if (selectedFile) {
      loadLogs(selectedFile);
    }
  };

  const handleDownload = () => {
    const text = filteredLogs
      .map(log => `${log.timestamp} [${log.level.toUpperCase()}] [${log.tag}] ${log.message}`)
      .join('\n');

    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `logs-${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleClearFilter = () => {
    setFilter({
      level: undefined,
      tag: undefined,
      search: undefined,
      limit: 500
    });
  };

  const hasActiveFilter = filter.level || filter.tag || filter.search;

  // Extract time only from timestamp (HH:MM:SS.mmm)
  const extractTime = (timestamp: string): string => {
    const match = timestamp.match(/(\d{2}:\d{2}:\d{2}(?:\.\d{3})?)/);
    return match ? match[1] : timestamp;
  };

  return (
    <div className="flex flex-col h-full bg-white dark:bg-slate-950 rounded-lg border border-slate-200 dark:border-slate-800">
      {/* Header */}
      <div className="p-4 border-b border-slate-200 dark:border-slate-800">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-slate-900 dark:text-white">System Logs</h2>
          <div className="flex gap-2">
            <button
              onClick={handleRefresh}
              disabled={loading || !selectedFile}
              className="p-2 hover:bg-slate-100 dark:hover:bg-slate-800 rounded disabled:opacity-50"
              title="Refresh logs"
            >
              <RefreshCw className="w-4 h-4" />
            </button>
            <button
              onClick={handleDownload}
              disabled={filteredLogs.length === 0}
              className="p-2 hover:bg-slate-100 dark:hover:bg-slate-800 rounded disabled:opacity-50"
              title="Download logs"
            >
              <Download className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* File Selection */}
        <div className="mb-3">
          <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
            Log File
          </label>
          <select
            value={selectedFile}
            onChange={e => handleFileChange(e.target.value)}
            className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded-md bg-white dark:bg-slate-800 text-slate-900 dark:text-white"
          >
            <option value="">Select a log file...</option>
            {logFiles.map(f => (
              <option key={f.name} value={f.name}>
                {f.name}
              </option>
            ))}
          </select>
        </div>

        {/* Filters */}
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Filter className="w-4 h-4 text-slate-600 dark:text-slate-400" />
            <span className="text-sm font-medium text-slate-700 dark:text-slate-300">Filters</span>
            {hasActiveFilter && (
              <button
                onClick={handleClearFilter}
                className="ml-auto text-xs px-2 py-1 rounded bg-slate-200 dark:bg-slate-700 hover:bg-slate-300 dark:hover:bg-slate-600"
              >
                Clear
              </button>
            )}
          </div>

          <div className="grid grid-cols-3 gap-2">
            <div>
              <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">
                Level
              </label>
              <select
                value={filter.level || ''}
                onChange={e => setFilter({ ...filter, level: e.target.value || undefined })}
                className="w-full px-2 py-1 text-sm border border-slate-300 dark:border-slate-600 rounded bg-white dark:bg-slate-800 text-slate-900 dark:text-white"
              >
                <option value="">All Levels</option>
                <option value="debug">Debug</option>
                <option value="info">Info</option>
                <option value="warn">Warn</option>
                <option value="error">Error</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">
                Tag
              </label>
              <input
                type="text"
                value={filter.tag || ''}
                onChange={e => setFilter({ ...filter, tag: e.target.value || undefined })}
                placeholder="e.g., Agent"
                className="w-full px-2 py-1 text-sm border border-slate-300 dark:border-slate-600 rounded bg-white dark:bg-slate-800 text-slate-900 dark:text-white"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">
                Limit
              </label>
              <input
                type="number"
                value={filter.limit}
                onChange={e => setFilter({ ...filter, limit: parseInt(e.target.value) || 100 })}
                min="10"
                max="5000"
                className="w-full px-2 py-1 text-sm border border-slate-300 dark:border-slate-600 rounded bg-white dark:bg-slate-800 text-slate-900 dark:text-white"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">
              Search
            </label>
            <input
              type="text"
              value={filter.search || ''}
              onChange={e => setFilter({ ...filter, search: e.target.value || undefined })}
              placeholder="Search in message or tag..."
              className="w-full px-2 py-1 text-sm border border-slate-300 dark:border-slate-600 rounded bg-white dark:bg-slate-800 text-slate-900 dark:text-white"
            />
          </div>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={e => setAutoRefresh(e.target.checked)}
              className="w-4 h-4"
            />
            <span className="text-slate-700 dark:text-slate-300">Auto-refresh</span>
          </label>
        </div>
      </div>

      {/* Log Container */}
      <div
        ref={logContainerRef}
        className="flex-1 overflow-auto p-4 space-y-1 font-mono text-sm"
      >
        {filteredLogs.length === 0 && !loading && (
          <div className="flex items-center justify-center h-full text-slate-500 dark:text-slate-400">
            <div className="text-center">
              <Info className="w-8 h-8 mx-auto mb-2 opacity-50" />
              <p>No logs to display</p>
              {selectedFile && <p className="text-xs mt-1">Try adjusting your filters</p>}
            </div>
          </div>
        )}

        {loading && (
          <div className="flex items-center justify-center h-full text-slate-500 dark:text-slate-400">
            <RefreshCw className="w-4 h-4 animate-spin mr-2" />
            <span>Loading logs...</span>
          </div>
        )}

        {filteredLogs.map((log, idx) => (
          <div
            key={idx}
            className={`px-2 py-1.5 rounded-sm border-l-2 ${LOG_LEVEL_BG[log.level]} hover:brightness-95 transition-all`}
            style={{ borderLeftColor: log.level === 'error' ? '#dc2626' : log.level === 'warn' ? '#ca8a04' : log.level === 'info' ? '#2563eb' : '#6b7280' }}
          >
            <div className="flex flex-col md:flex-row md:items-baseline gap-2 md:gap-2 text-xs leading-relaxed">
              <div className="flex gap-2 items-baseline flex-shrink-0">
                <span className="font-mono opacity-70 flex-shrink-0 w-24">
                  {extractTime(log.timestamp)}
                </span>
                <span className={`font-bold flex-shrink-0 w-14 uppercase ${LOG_LEVEL_COLORS[log.level]}`}>
                  {log.level}
                </span>
                <span className="font-semibold flex-shrink-0 w-40 text-slate-700 dark:text-slate-300 truncate" title={log.tag}>
                  [{log.tag}]
                </span>
              </div>
              <span className="flex-1 text-slate-800 dark:text-slate-200 break-words">{log.message}</span>
            </div>
            {log.args && Object.keys(log.args).length > 0 && (
              <div className="text-[10px] opacity-60 mt-1 ml-28 font-mono text-slate-600 dark:text-slate-400">
                {JSON.stringify(log.args)}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Footer */}
      <div className="px-4 py-2 border-t border-slate-200 dark:border-slate-800 text-xs text-slate-600 dark:text-slate-400">
        Showing {filteredLogs.length} of {logs.length} logs
        {hasActiveFilter && <span> (filtered)</span>}
      </div>
    </div>
  );
}

'use client';

import { useState, useEffect, useCallback } from 'react';
import { RefreshCw, Download, ChevronRight, ChevronDown, Info, Settings } from 'lucide-react';
import Link from 'next/link';
import { useToast } from '@/providers/ToastProvider';
import { useSocket } from '@/hooks/useSocket';
import { MultiSelect } from './MultiSelect';

interface LogEntry {
  id: number;
  timestamp: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  tag: string;
  message: string;
  args?: unknown[];
}

interface LogFilter {
  date: string; // 'live' or YYYY-MM-DD
  level?: string;
  tags?: string[];
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

const RUN_ID_PREFIX_REGEX = /^\[([A-Za-z0-9:-]+)\]\s+(.*)$/s;

const stripRunIdPrefix = (message: string) => {
  const match = message.match(RUN_ID_PREFIX_REGEX);
  if (match) {
    return { runId: match[1], strippedMessage: match[2] || '' };
  }
  return { runId: undefined, strippedMessage: message };
};

const extractRunIdFromJson = (message: string): string | undefined => {
  const trimmed = message.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && typeof parsed.runId === 'string') {
      return parsed.runId;
    }
  } catch {
    return undefined;
  }
  return undefined;
};

const formatBytes = (bytes: number, decimals = 1) => {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
};

const LogMessage = ({ message }: { message: string }) => {
  const [expanded, setExpanded] = useState(false);

  // Try to parse the message as JSON if it looks like one
  const trimmed = message.trim();
  const isJsonLike = (trimmed.startsWith('{') && trimmed.endsWith('}')) || 
                     (trimmed.startsWith('[') && trimmed.endsWith(']'));

  let parsedJson = null;
  let jsonSize = 0;
  let isParsed = false;

  if (isJsonLike) {
    try {
      parsedJson = JSON.parse(trimmed);
      jsonSize = new TextEncoder().encode(trimmed).length;
      isParsed = true;
    } catch {
      // Failed to parse
    }
  }

  if (isParsed) {
      const summaryLabel = (parsedJson && typeof parsedJson === 'object' && !Array.isArray(parsedJson) && 'event' in parsedJson)
        ? `event: ${String((parsedJson as Record<string, unknown>).event)}`
        : 'Structured JSON payload';
      return (
        <div className="mt-1 space-y-1">
          <span className="text-xs text-slate-500 dark:text-slate-400 font-medium tracking-tight">{summaryLabel}</span>
          <button 
            onClick={() => setExpanded(!expanded)} 
            className="flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200 transition-colors select-none"
          >
            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            <span className="font-mono">JSON Payload <span className="text-slate-400">({formatBytes(jsonSize)})</span> {expanded ? '' : '(click to expand)'}</span>
          </button>
          
          {expanded && (
            <pre className="mt-1 p-2 bg-slate-100 dark:bg-slate-900 rounded overflow-x-auto text-xs border border-slate-200 dark:border-slate-700 animate-in fade-in slide-in-from-top-1 duration-200">
              <code>{JSON.stringify(parsedJson, null, 2)}</code>
            </pre>
          )}
        </div>
      );
  }

  // Check for JSON embedded after a prefix (e.g. "Payload: {...}")
  const jsonStart = message.search(/[{\[]/);
  
  let prefix = '';
  let embeddedJson = null;
  let embeddedSize = 0;
  let hasEmbedded = false;

  if (jsonStart > 0) {
    const potentialJson = message.slice(jsonStart).trim();
    if ((potentialJson.startsWith('{') && potentialJson.endsWith('}')) || 
        (potentialJson.startsWith('[') && potentialJson.endsWith(']'))) {
      try {
        embeddedJson = JSON.parse(potentialJson);
        embeddedSize = new TextEncoder().encode(potentialJson).length;
        prefix = message.slice(0, jsonStart);
        hasEmbedded = true;
      } catch {
        // Failed to parse
      }
    }
  }

  if (hasEmbedded) {
        return (
          <div className="flex flex-col gap-1">
            <span className="whitespace-pre-wrap">{prefix}</span>
            <div className="mt-0.5">
              <button 
                onClick={() => setExpanded(!expanded)} 
                className="flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200 transition-colors select-none"
              >
                {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                <span className="font-mono">JSON Data <span className="text-slate-400">({formatBytes(embeddedSize)})</span></span>
              </button>
              
              {expanded && (
                <pre className="mt-1 p-2 bg-slate-100 dark:bg-slate-900 rounded overflow-x-auto text-xs border border-slate-200 dark:border-slate-700 animate-in fade-in slide-in-from-top-1 duration-200">
                  <code>{JSON.stringify(embeddedJson, null, 2)}</code>
                </pre>
              )}
            </div>
          </div>
        );
  }

  // Use whitespace-pre-wrap to respect newlines in non-JSON messages (like stack traces or pre-formatted text)
  return <span className="whitespace-pre-wrap">{message}</span>;
};

export interface LogViewerProps {
  file?: string;
  searchQuery?: string;
}

/**
 * LogViewer Component
 * Real-time log viewer with filtering capabilities
 */
export default function LogViewer({ file, searchQuery }: LogViewerProps) {
  const [logDates, setLogDates] = useState<string[]>([]);
  const [availableTags, setAvailableTags] = useState<string[]>([]);
  const [selectedDate, setSelectedDate] = useState<string>(file || 'live');
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [currentSystemLogLevel, setCurrentSystemLogLevel] = useState<string>('info');
  const [filter, setFilter] = useState<Omit<LogFilter, 'date'>>({
    level: undefined,
    tags: [],
    search: undefined,
    limit: 100
  });
  
  const { socket, isConnected } = useSocket();
  const { addToast } = useToast();

  // Load available log dates and tags
  useEffect(() => {
    loadLogDates();
    loadTags();
    loadSystemLogLevel();
  }, []);

  const loadSystemLogLevel = async () => {
      try {
          const res = await fetch('/api/settings/logLevel');
          const data = await res.json();
          if (data.success && data.logLevel) {
              setCurrentSystemLogLevel(data.logLevel);
          }
      } catch (e) {
          console.error('Failed to fetch system log level', e);
      }
  };

  const loadTags = async () => {
    try {
        const response = await fetch('/api/logs/tags');
        const data = await response.json();
        if (data.success) {
            setAvailableTags(data.tags);
        }
    } catch (err) {
        console.error('Failed to load tags:', err);
    }
  };

  const loadLogDates = async () => {
    try {
      const response = await fetch('/api/logs/list');
      const data = await response.json();
      if (data.success) {
        // API returns dates directly
        setLogDates(data.files.map((f: {name: string}) => f.name));
      }
    } catch (err) {
        console.error('Failed to load log dates:', err);
    }
  };

  const fetchLogs = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      params.append('date', selectedDate);
      if (filter.level) params.append('level', filter.level);
      if (filter.tags && filter.tags.length > 0) {
          filter.tags.forEach(t => params.append('tag', t));
      }
      
      const effectiveSearch = searchQuery || filter.search;
      if (effectiveSearch) params.append('search', effectiveSearch);
      
      params.append('limit', String(filter.limit));

      const response = await fetch(`/api/logs/query?${params}`);
      const data = await response.json();

      if (data.success) {
        setLogs(data.logs);
      } else {
        setLogs([]);
      }
    } catch (err) {
      console.error('Failed to load logs:', err);
      addToast('error', 'Failed to load logs', String(err));
    } finally {
      setLoading(false);
    }
  }, [selectedDate, filter, searchQuery, addToast]);

  // Fetch logs when date, filter, or search changes
  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  // Live streaming logic
  useEffect(() => {
    if (selectedDate !== 'live' || !socket || !isConnected) return;

    socket.emit('logs:subscribe');

    const handleLogEntry = (entry: LogEntry) => {
        // Apply frontend filters to stream
        if (filter.level && entry.level !== filter.level) return; // Simple check, exact match
        if (filter.tags && filter.tags.length > 0) {
            const matches = filter.tags.some(t => entry.tag.includes(t));
            if (!matches) return;
        }
        
        const effectiveSearch = searchQuery || filter.search;
        if (effectiveSearch) {
             const term = effectiveSearch.toLowerCase();
             if (!entry.message.toLowerCase().includes(term) && !entry.tag.toLowerCase().includes(term)) return;
        }

        setLogs(prev => [entry, ...prev].slice(0, filter.limit));
    };

    socket.on('log:entry', handleLogEntry);

    return () => {
        socket.emit('logs:unsubscribe');
        socket.off('log:entry', handleLogEntry);
    };
  }, [selectedDate, socket, isConnected, filter, searchQuery]);

  const handleRefresh = () => {
    fetchLogs();
  };

  const handleDownload = () => {
    const text = logs
      .map(log => `${log.timestamp} [${log.level.toUpperCase()}] [${log.tag}] ${log.message}`)
      .join('\n');

    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `logs-${selectedDate}-${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleClearFilter = () => {
    setFilter({
      level: undefined,
      tags: [],
      search: undefined,
      limit: 100
    });
  };

  const hasActiveFilter = filter.level || (filter.tags && filter.tags.length > 0) || filter.search || searchQuery;

  // Extract time only from timestamp (HH:MM:SS.mmm)
  const extractTime = (timestamp: string): string => {
    const match = timestamp.match(/(\d{2}:\d{2}:\d{2}(?:\.\d{3})?)/);
    return match ? match[1] : timestamp;
  };

  return (
    <div className="flex flex-col h-full bg-white dark:bg-slate-950 rounded-lg border border-slate-200 dark:border-slate-800">
      {/* Toolbar */}
      <div className="p-3 border-b border-slate-200 dark:border-slate-800 flex flex-col lg:flex-row lg:items-end gap-3 z-10 bg-inherit">

        {/* Date Selection */}
        <div className="w-full lg:w-40 shrink-0">
          <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">
            Date
          </label>
          <select
            value={selectedDate}
            onChange={e => setSelectedDate(e.target.value)}
            className="w-full px-2 py-1.5 text-sm border border-slate-300 dark:border-slate-600 rounded bg-white dark:bg-slate-800 text-slate-900 dark:text-white cursor-pointer"
          >
            <option value="live">Live Log Stream</option>
            {logDates.map(date => (
              <option key={date} value={date}>
                {date}
              </option>
            ))}
          </select>
        </div>

        {/* Filters Group */}
        <div className="flex gap-2 min-w-0">
          <div className="w-24 shrink-0">
            <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">
              Level
            </label>
            <select
              value={filter.level || ''}
              onChange={e => setFilter({ ...filter, level: e.target.value || undefined })}
              className="w-full px-2 py-1.5 text-sm border border-slate-300 dark:border-slate-600 rounded bg-white dark:bg-slate-800 text-slate-900 dark:text-white cursor-pointer"
            >
              <option value="">All</option>
              <option value="debug">Debug</option>
              <option value="info">Info</option>
              <option value="warn">Warn</option>
              <option value="error">Error</option>
            </select>
          </div>

          {/* Tag Filter */}
          <div className="w-64 shrink-1 min-w-0">
            <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">
              Tag
            </label>
            <MultiSelect
              options={availableTags}
              value={filter.tags || []}
              onChange={(tags) => setFilter({ ...filter, tags })}
              placeholder="Tag..."
              className="w-full"
            />
          </div>

          {/* Limit */}
          <div className="w-20 shrink-0">
            <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">
              Limit
            </label>
            <input
              type="number"
              value={filter.limit}
              onChange={e => setFilter({ ...filter, limit: parseInt(e.target.value) || 100 })}
              className="w-full px-2 py-1.5 text-sm border border-slate-300 dark:border-slate-600 rounded bg-white dark:bg-slate-800 text-slate-900 dark:text-white"
            />
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2 ml-auto pb-1">
          <Link href="/settings" title="Change max Log Level" className="hidden xl:flex items-center gap-2 px-2 py-1.5 text-xs text-slate-500 hover:text-blue-600 dark:text-slate-400 dark:hover:text-blue-400 bg-slate-50 hover:bg-slate-100 dark:bg-slate-800/50 dark:hover:bg-slate-800 rounded border border-transparent hover:border-slate-300 dark:hover:border-slate-700 transition-all">
             <Settings className="w-3 h-3" />
             <span>Max Level: <span className="font-semibold uppercase">{currentSystemLogLevel}</span></span>
          </Link>

          <button
            onClick={handleRefresh}
            disabled={loading || selectedDate === 'live'}
            className="p-1.5 text-slate-500 hover:text-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 rounded transition-colors disabled:opacity-50"
            title="Refresh logs"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
          
          <button
            onClick={handleDownload}
            disabled={logs.length === 0}
            className="p-1.5 text-slate-500 hover:text-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 rounded transition-colors disabled:opacity-50"
            title="Download logs"
          >
            <Download className="w-4 h-4" />
          </button>
          
          {hasActiveFilter && (
            <button
               onClick={handleClearFilter}
               className="ml-1 text-xs px-2 py-1 rounded bg-slate-100 dark:bg-slate-800 text-slate-600 hover:bg-slate-200"
               title="Clear filters"
            >
              Clear
            </button>
          )}
        </div>
      </div>

      {/* Log Container */}
      <div
        className="flex-1 overflow-auto p-4 space-y-1 font-mono text-sm"
      >
        {logs.length === 0 && !loading && (
          <div className="flex items-center justify-center h-full text-slate-500 dark:text-slate-400">
            <div className="text-center">
              <Info className="w-8 h-8 mx-auto mb-2 opacity-50" />
              <p>No logs to display</p>
              {selectedDate === 'live' && <p className="text-xs mt-1">Waiting for new logs...</p>}
            </div>
          </div>
        )}

        {loading && logs.length === 0 && (
          <div className="flex items-center justify-center h-full text-slate-500 dark:text-slate-400">
            <RefreshCw className="w-4 h-4 animate-spin mr-2" />
            <span>Loading logs...</span>
          </div>
        )}

        {logs.map((log) => {
          const { runId: prefixRunId, strippedMessage } = stripRunIdPrefix(log.message);
          const jsonRunId = prefixRunId ? undefined : extractRunIdFromJson(log.message);
          const effectiveRunId = prefixRunId || jsonRunId;
          const displayMessage = prefixRunId ? strippedMessage : log.message;
          return (
            <div
              key={log.id || log.timestamp} // Fallback for transition
              className={`px-2 py-1.5 rounded-sm border-l-2 ${LOG_LEVEL_BG[log.level]} hover:brightness-95 transition-all`}
              style={{ borderLeftColor: log.level === 'error' ? '#dc2626' : log.level === 'warn' ? '#ca8a04' : log.level === 'info' ? '#2563eb' : '#6b7280' }}
            >
              <div className="flex flex-col md:flex-row md:items-baseline gap-2 md:gap-2 text-xs leading-relaxed">
                <div className="flex gap-2 items-start flex-shrink-0">
                  <span className="font-mono opacity-70 flex-shrink-0 w-24">
                    {extractTime(log.timestamp)}
                  </span>
                  <span className={`font-bold flex-shrink-0 w-14 uppercase ${LOG_LEVEL_COLORS[log.level]}`}>
                    {log.level}
                  </span>
                  <div className="flex flex-col flex-shrink-0 w-48 text-slate-700 dark:text-slate-300">
                    <span className="font-semibold truncate" title={log.tag}>
                      [{log.tag}]
                    </span>
                    {effectiveRunId && (
                      <span
                        className="mt-0.5 px-1.5 py-0.5 rounded bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-200 text-[10px] font-mono break-all"
                        title={effectiveRunId}
                      >
                        {effectiveRunId}
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex-1 text-slate-800 dark:text-slate-200 break-words min-w-0">
                  <LogMessage message={displayMessage} />
                </div>
              </div>
              {log.args && Object.keys(log.args).length > 0 && (
                <div className="text-[10px] opacity-60 mt-1 ml-28 font-mono text-slate-600 dark:text-slate-400">
                  {JSON.stringify(log.args)}
                </div>
              )}
            </div>
          );
        })}
        {/* Helper for auto-scroll if needed, though usually top is better for live stream reading */}
      </div>

      {/* Footer */}
      <div className="px-4 py-2 border-t border-slate-200 dark:border-slate-800 text-xs text-slate-600 dark:text-slate-400 flex justify-between">
        <span>Showing {logs.length} logs</span>
        <span>{selectedDate === 'live' ? 'Live Stream Active' : 'Historical View'}</span>
      </div>
    </div>
  );
}

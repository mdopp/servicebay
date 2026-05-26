'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { RefreshCw, Download, ChevronRight, ChevronDown, Info, Settings, Copy, Pause, Play, ListFilter } from 'lucide-react';
import Link from 'next/link';
import { useToast } from '@/providers/ToastProvider';
import { useSocket } from '@/hooks/useSocket';
import { humanizeError } from '@servicebay/api-client';
import { MultiSelect } from './MultiSelect';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogEntry {
  id: number;
  timestamp: string;
  level: LogLevel;
  tag: string;
  message: string;
  args?: unknown[];
  traceId?: string;
}

interface LogFilter {
  date: string; // 'live' or YYYY-MM-DD
  level?: string;
  tags?: string[];
  search?: string;
  limit: number;
}

const LEVEL_STYLES: Record<LogLevel, { label: string; accent: string; runId: string }> = {
  debug: {
    label: 'text-slate-400',
    accent: 'border-l-4 border-emerald-200',
    runId: 'bg-slate-200/80 dark:bg-slate-800/80 text-slate-500 dark:text-slate-200'
  },
  info: {
    label: 'text-emerald-400',
    accent: 'border-l-4 border-emerald-300',
    runId: 'bg-slate-200/80 dark:bg-slate-800/80 text-slate-600 dark:text-slate-200'
  },
  warn: {
    label: 'text-emerald-500',
    accent: 'border-l-4 border-emerald-500',
    runId: 'bg-slate-200/70 dark:bg-slate-800/70 text-slate-700 dark:text-slate-100'
  },
  error: {
    label: 'text-emerald-700',
    accent: 'border-l-4 border-emerald-700',
    runId: 'bg-slate-200/70 dark:bg-slate-800/70 text-slate-800 dark:text-white'
  }
};

const RUN_ID_PREFIX_REGEX = /^\[([A-Za-z0-9:-]+)\]\s+([\s\S]*)$/;

// Lifecycle-keyword allowlist for Summary mode (#728). A log line
// passes the summary filter if its level is warn/error OR its
// message matches one of these patterns. The list is intentionally
// short — the goal is "what changed?", not "everything that might
// matter someday" — and biased toward state transitions the operator
// can map back to a UI affordance.
const SUMMARY_LIFECYCLE_RE = new RegExp(
  [
    'deployed', 'undeployed', 'restarted', 'crashed', 'started', 'stopped',
    'created', 'removed', 'installed', 'uninstalled', 'enabled', 'disabled',
    'pulled', 'pulling', 'downloading', 'self.?heal', 'self.?healed',
    'reconciled', 'provisioned', 'configured', 'bootstrap', 'wizard',
    'failure', 'aborted', 'healthy', 'unhealthy', 'login', 'logged',
  ].join('|'),
  'i',
);

const SUMMARY_EMOJI_RE = /[✅⚠️❌🔄ℹ️🔐]/;

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
  const contentRef = useRef<HTMLDivElement>(null);
  const embeddedRef = useRef<HTMLDivElement>(null);
  const [contentHeight, setContentHeight] = useState<number | string>(0);
  const [embeddedHeight, setEmbeddedHeight] = useState<number | string>(0);

  useEffect(() => {
    const handle = requestAnimationFrame(() => {
      if (expanded) {
        setContentHeight(contentRef.current?.scrollHeight ?? 'auto');
        setEmbeddedHeight(embeddedRef.current?.scrollHeight ?? 'auto');
      } else {
        setContentHeight(0);
        setEmbeddedHeight(0);
      }
    });
    return () => cancelAnimationFrame(handle);
  }, [expanded]);

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
          
          <div
            ref={contentRef}
            className="overflow-hidden"
            style={{
              maxHeight: expanded ? (contentHeight === 'auto' ? 'auto' : `${contentHeight}px`) : '0px',
              opacity: expanded ? 1 : 0,
              transition: 'max-height 300ms cubic-bezier(0.16, 1, 0.3, 1), opacity 250ms cubic-bezier(0.16, 1, 0.3, 1)'
            }}
          >
            <pre className="mt-1 p-2 bg-slate-100 dark:bg-slate-900 rounded overflow-x-auto text-xs border border-slate-200 dark:border-slate-700">
              <code>{JSON.stringify(parsedJson, null, 2)}</code>
            </pre>
          </div>
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
              
              <div
                ref={embeddedRef}
                className="overflow-hidden"
                style={{
                  maxHeight: expanded ? (embeddedHeight === 'auto' ? 'auto' : `${embeddedHeight}px`) : '0px',
                  opacity: expanded ? 1 : 0,
                  transition: 'max-height 300ms cubic-bezier(0.16, 1, 0.3, 1), opacity 250ms cubic-bezier(0.16, 1, 0.3, 1)'
                }}
              >
                <pre className="mt-1 p-2 bg-slate-100 dark:bg-slate-900 rounded overflow-x-auto text-xs border border-slate-200 dark:border-slate-700">
                  <code>{JSON.stringify(embeddedJson, null, 2)}</code>
                </pre>
              </div>
            </div>
          </div>
        );
  }

  // Use whitespace-pre-wrap to respect newlines in non-JSON messages (like stack traces or pre-formatted text)
  return <span className="whitespace-pre-wrap">{message}</span>;
};

interface LogViewerProps {
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
  const [livePaused, setLivePaused] = useState(false);
  // Summary mode (#728): collapses the firehose to lifecycle-only
  // events. Drops debug + info noise unless the message matches a
  // small allowlist of meaningful state transitions (deployed /
  // started / healthy / failed / restart / installed). Errors and
  // warnings always pass through. The raw filter remains the default
  // so deep debugging is one click away.
  const [summaryMode, setSummaryMode] = useState(false);

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
          // Background prefetch — toast would spam if the API is briefly
          // unavailable on first render. Keep dev-only.
          console.error('[LogViewer] Failed to fetch system log level', e);
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
        // Tag filter is a convenience; failure degrades to free-text only.
        console.error('[LogViewer] Failed to load tags:', err);
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
        // Date picker fallback is empty list — visible to operator.
        console.error('[LogViewer] Failed to load log dates:', err);
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
      const { title, detail } = humanizeError(err, 'Failed to load logs');
      addToast('error', title, detail);
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
    if (livePaused) return;

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
  }, [selectedDate, socket, isConnected, filter, searchQuery, livePaused]);

  const handleRefresh = () => {
    fetchLogs();
  };

  const formatLogsAsText = () =>
    logs
      .slice()
      .reverse() // logs are stored newest-first; export oldest-first for readability
      .map(log => `${log.timestamp} [${log.level.toUpperCase()}] [${log.tag}] ${log.message}`)
      .join('\n');

  const handleDownload = () => {
    const text = formatLogsAsText();

    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `logs-${selectedDate}-${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleCopy = async () => {
    if (logs.length === 0) return;
    const text = formatLogsAsText();
    try {
      await navigator.clipboard.writeText(text);
      addToast('success', 'Copied', `${logs.length} log entries copied to clipboard.`);
    } catch (err) {
      console.error('Copy failed:', err);
      addToast('error', 'Copy failed', 'Could not access the clipboard. Try downloading instead.');
    }
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

  const controlInputClass = 'w-full h-10 px-3 text-sm border border-slate-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-800 text-slate-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none transition-colors';
  const baseButtonClass = 'h-10 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:text-blue-600 dark:hover:text-blue-300 hover:border-blue-300 dark:hover:border-blue-500 transition-colors disabled:opacity-50';

  return (
    <div className="flex flex-col h-full bg-white dark:bg-slate-950 rounded-lg border border-slate-200 dark:border-slate-800">
      {/* Toolbar */}
      <div className="p-4 border-b border-slate-200 dark:border-slate-800 bg-inherit">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-[180px_120px_minmax(0,1fr)_110px_auto] items-end">
          {/* Date Selection */}
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-slate-500 dark:text-slate-400">
              Date
            </label>
            <select
              value={selectedDate}
              onChange={e => setSelectedDate(e.target.value)}
              className={`${controlInputClass} cursor-pointer`}
            >
              <option value="live">Live Log Stream</option>
              {logDates.map(date => (
                <option key={date} value={date}>
                  {date}
                </option>
              ))}
            </select>
          </div>

          {/* Level Filter */}
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-slate-500 dark:text-slate-400">
              Level
            </label>
            <select
              value={filter.level || ''}
              onChange={e => setFilter({ ...filter, level: e.target.value || undefined })}
              className={`${controlInputClass} cursor-pointer`}
            >
              <option value="">All</option>
              <option value="debug">Debug</option>
              <option value="info">Info</option>
              <option value="warn">Warn</option>
              <option value="error">Error</option>
            </select>
          </div>

          {/* Tag Filter */}
          <div className="flex flex-col gap-1 min-w-0">
            <label className="text-xs font-medium text-slate-500 dark:text-slate-400">
              Tag
            </label>
            <MultiSelect
              options={availableTags}
              value={filter.tags || []}
              onChange={(tags) => setFilter({ ...filter, tags })}
              placeholder="Tag..."
              className="w-full min-w-0 [&>div:first-child]:min-h-[40px]"
            />
          </div>

          {/* Limit */}
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-slate-500 dark:text-slate-400">
              Limit
            </label>
            <input
              type="number"
              value={filter.limit}
              onChange={e => setFilter({ ...filter, limit: parseInt(e.target.value) || 100 })}
              className={controlInputClass}
            />
          </div>

          {/* Actions */}
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
              Actions
            </span>
            <div className="flex flex-wrap items-center gap-2">
              <Link
                href="/settings"
                title="Change max Log Level"
                className={`hidden xl:inline-flex items-center gap-2 px-3 text-xs ${baseButtonClass}`}
              >
                 <Settings className="w-3 h-3" />
                 <span>Max Level: <span className="font-semibold uppercase">{currentSystemLogLevel}</span></span>
              </Link>

              <button
                onClick={() => setSummaryMode(s => !s)}
                className={`inline-flex items-center gap-2 px-3 text-xs ${baseButtonClass} ${
                  summaryMode ? 'border-blue-500 text-blue-600 dark:text-blue-300' : ''
                }`}
                title={summaryMode
                  ? 'Summary mode: showing lifecycle events + warnings/errors only. Click to see raw logs.'
                  : 'Switch to summary mode (lifecycle events + warnings/errors only).'}
                aria-pressed={summaryMode}
              >
                <ListFilter className="w-3 h-3" />
                <span>{summaryMode ? 'Summary' : 'Raw'}</span>
              </button>

              <button
                onClick={handleRefresh}
                disabled={loading || selectedDate === 'live'}
                className={`inline-flex items-center justify-center w-10 ${baseButtonClass}`}
                title={selectedDate === 'live' ? 'Refresh disabled in live mode' : 'Refresh logs'}
              >
                <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
              </button>
              
              <button
                onClick={handleCopy}
                disabled={logs.length === 0}
                className={`inline-flex items-center justify-center w-10 ${baseButtonClass}`}
                title="Copy visible logs to clipboard"
                aria-label="Copy logs"
              >
                <Copy className="w-4 h-4" />
              </button>

              <button
                onClick={handleDownload}
                disabled={logs.length === 0}
                className={`inline-flex items-center justify-center w-10 ${baseButtonClass}`}
                title="Download logs"
              >
                <Download className="w-4 h-4" />
              </button>

              {selectedDate === 'live' && (
                <button
                  onClick={() => setLivePaused(p => !p)}
                  className={`inline-flex items-center justify-center w-10 ${baseButtonClass}`}
                  title={livePaused ? 'Resume live stream' : 'Pause live stream'}
                  aria-label={livePaused ? 'Resume live stream' : 'Pause live stream'}
                >
                  {livePaused ? <Play className="w-4 h-4" /> : <Pause className="w-4 h-4" />}
                </button>
              )}

              {hasActiveFilter && (
                <button
                   onClick={handleClearFilter}
                   className={`inline-flex items-center justify-center px-3 text-xs font-medium ${baseButtonClass}`}
                   title="Clear filters"
                >
                  Clear
                </button>
              )}
            </div>
          </div>
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

        {logs
          .filter((log) => {
            if (!summaryMode) return true;
            if (log.level === 'warn' || log.level === 'error') return true;
            if (SUMMARY_EMOJI_RE.test(log.message)) return true;
            return SUMMARY_LIFECYCLE_RE.test(log.message);
          })
          .map((log) => {
          const { runId: prefixRunId, strippedMessage } = stripRunIdPrefix(log.message);
          const jsonRunId = prefixRunId ? undefined : extractRunIdFromJson(log.message);
          const effectiveRunId = prefixRunId || jsonRunId;
          const displayMessage = prefixRunId ? strippedMessage : log.message;
          const levelStyle = LEVEL_STYLES[log.level];

          return (
            <div
              key={log.id || log.timestamp}
              className={`px-3 py-2 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/30 shadow-sm transition-colors hover:border-emerald-400/60 ${levelStyle.accent}`}
            >
              <div className="flex flex-col md:flex-row md:items-baseline gap-3 text-xs leading-relaxed">
                <div className="flex gap-3 items-start flex-shrink-0">
                  <span className="font-mono text-slate-500 dark:text-slate-400 w-24">
                    {extractTime(log.timestamp)}
                  </span>
                  <span className={`font-semibold tracking-wide uppercase w-12 ${levelStyle.label}`}>
                    {log.level}
                  </span>
                  <div className="flex flex-col flex-shrink-0 w-48 text-slate-700 dark:text-slate-200">
                    <span className="font-semibold truncate" title={log.tag}>
                      [{log.tag}]
                    </span>
                    {effectiveRunId && (
                      <span
                        className={`mt-0.5 px-2 py-0.5 rounded-full text-[10px] font-mono break-all ${levelStyle.runId}`}
                        title={effectiveRunId}
                      >
                        {effectiveRunId}
                      </span>
                    )}
                    {log.traceId && (
                      <button
                        type="button"
                        onClick={() => {
                          setFilter(f => ({ ...f, search: log.traceId }));
                          addToast('success', 'Trace ID Filtered', `Isolating transaction: ${log.traceId}`);
                        }}
                        className="mt-1 inline-flex items-center justify-center px-2 py-0.5 rounded-full text-[9px] font-mono break-all bg-blue-500/10 border border-blue-500/20 text-blue-600 dark:text-blue-400 hover:bg-blue-500/20 transition-all select-all text-left"
                        title={`Click to filter logs by Trace ID: ${log.traceId}`}
                      >
                        trace: {log.traceId.slice(0, 8)}...
                      </button>
                    )}
                  </div>
                </div>
                <div className="flex-1 text-slate-800 dark:text-slate-50 break-words min-w-0">
                  <LogMessage message={displayMessage} />
                </div>
              </div>
              {log.args && Object.keys(log.args).length > 0 && (
                <div className="text-[10px] mt-2 font-mono text-slate-500 dark:text-slate-400">
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
        <span>
          {selectedDate === 'live'
            ? (livePaused ? 'Live Stream Paused' : 'Live Stream Active')
            : 'Historical View'}
        </span>
      </div>
    </div>
  );
}

'use client';

import { useState, useEffect } from 'react';
import { Activity, AlertCircle, CheckCircle2, Clock, BarChart3, AlertTriangle } from 'lucide-react';
import { useToast } from '@/providers/ToastProvider';

interface AgentHealth {
  nodeName: string;
  isConnected: boolean;
  lastSync: number;
  messageCount: number;
  errorCount: number;
  lastError?: string;
}

export interface AgentHealthMonitorProps {
  refreshInterval?: number;
}

/**
 * AgentHealthMonitor Component
 * Displays real-time health status of all connected agents
 */
export default function AgentHealthMonitor({ refreshInterval = 10000 }: AgentHealthMonitorProps) {
  const [health, setHealth] = useState<AgentHealth[]>([]);
  const [loading, setLoading] = useState(true);
  const [timestamp, setTimestamp] = useState<number>(0);
  const { addToast } = useToast();

  // Load health data
  const loadHealth = async () => {
    try {
      const response = await fetch('/api/system/health');
      const data = await response.json();

      if (data.success) {
        setHealth(data.agents);
        setTimestamp(data.timestamp);
      } else {
        console.error('Failed to load health:', data.error);
      }
    } catch (err) {
      console.error('Failed to load agent health:', err);
    } finally {
      setLoading(false);
    }
  };

  // Initial load
  useEffect(() => {
    loadHealth();
  }, []);

  // Periodic refresh
  useEffect(() => {
    const interval = setInterval(loadHealth, refreshInterval);
    return () => clearInterval(interval);
  }, [refreshInterval]);

  const formatTime = (ms: number) => {
    if (!ms) return 'Never';
    const ago = Date.now() - ms;
    if (ago < 1000) return 'Just now';
    if (ago < 60000) return `${Math.floor(ago / 1000)}s ago`;
    if (ago < 3600000) return `${Math.floor(ago / 60000)}m ago`;
    return `${Math.floor(ago / 3600000)}h ago`;
  };

  const getStatusColor = (agent: AgentHealth) => {
    if (!agent.isConnected) return 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800';
    if (agent.errorCount > 5) return 'bg-yellow-50 dark:bg-yellow-900/20 border-yellow-200 dark:border-yellow-800';
    return 'bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800';
  };

  const getStatusIcon = (agent: AgentHealth) => {
    if (!agent.isConnected) return <AlertCircle className="w-5 h-5 text-red-600 dark:text-red-400" />;
    if (agent.errorCount > 5) return <AlertTriangle className="w-5 h-5 text-yellow-600 dark:text-yellow-400" />;
    return <CheckCircle2 className="w-5 h-5 text-green-600 dark:text-green-400" />;
  };

  return (
    <div className="bg-white dark:bg-slate-950 rounded-lg border border-slate-200 dark:border-slate-800 p-4">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Activity className="w-5 h-5 text-slate-700 dark:text-slate-300" />
          <h2 className="text-lg font-semibold text-slate-900 dark:text-white">Agent Health</h2>
        </div>
        <div className="text-xs text-slate-500 dark:text-slate-400">
          Updated {timestamp ? formatTime(timestamp) : 'loading...'}
        </div>
      </div>

      {loading && health.length === 0 ? (
        <div className="flex items-center justify-center py-8 text-slate-500 dark:text-slate-400">
          <div className="animate-spin mr-2">
            <Activity className="w-4 h-4" />
          </div>
          Loading agent health...
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {health.map(agent => (
            <div
              key={agent.nodeName}
              className={`p-3 rounded-lg border ${getStatusColor(agent)}`}
            >
              <div className="flex items-start justify-between mb-2">
                <div className="flex items-center gap-2">
                  {getStatusIcon(agent)}
                  <div>
                    <h3 className="font-semibold text-slate-900 dark:text-white">
                      {agent.nodeName}
                    </h3>
                    <p className="text-xs text-slate-600 dark:text-slate-400">
                      {agent.isConnected ? 'Connected' : 'Disconnected'}
                    </p>
                  </div>
                </div>
              </div>

              <div className="space-y-1 text-sm text-slate-700 dark:text-slate-300">
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-1">
                    <Clock className="w-3 h-3" />
                    Last Sync
                  </span>
                  <span className="font-mono text-xs">{formatTime(agent.lastSync)}</span>
                </div>

                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-1">
                    <BarChart3 className="w-3 h-3" />
                    Messages
                  </span>
                  <span className="font-mono text-xs">{agent.messageCount}</span>
                </div>

                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-1">
                    <AlertCircle className="w-3 h-3" />
                    Errors
                  </span>
                  <span className={`font-mono text-xs ${agent.errorCount > 0 ? 'text-red-600 dark:text-red-400' : 'text-green-600 dark:text-green-400'}`}>
                    {agent.errorCount}
                  </span>
                </div>

                {agent.lastError && (
                  <div className="mt-2 pt-2 border-t border-current/20">
                    <p className="text-xs opacity-75 line-clamp-2">
                      <span className="font-semibold">Last Error:</span> {agent.lastError}
                    </p>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {health.length === 0 && !loading && (
        <div className="text-center py-8 text-slate-500 dark:text-slate-400">
          No agents connected
        </div>
      )}
    </div>
  );
}

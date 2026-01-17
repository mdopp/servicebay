'use client';

import { useEffect, useState } from 'react';
import { Box, RefreshCw, X } from 'lucide-react';
import { logger } from '@/lib/logger';

type ContainerMount = string | { Source?: string; Destination?: string; Type?: string };

interface ContainerLogsPanelProps {
  container: {
    id: string;
    name: string;
    image?: string;
    state?: string;
    status?: string;
    created?: number;
    ports?: { hostIp?: string; containerPort: number; hostPort?: number; protocol?: string }[];
    mounts?: ContainerMount[];
    hideMeta?: boolean;
  };
  nodeName?: string;
  onClose: () => void;
}

export type ContainerLogsPanelData = ContainerLogsPanelProps['container'];

export default function ContainerLogsPanel({ container, nodeName, onClose }: ContainerLogsPanelProps) {
  const [details, setDetails] = useState<unknown>(null);
  const [logs, setLogs] = useState('');
  const [logsLoading, setLogsLoading] = useState(false);

  useEffect(() => {
    const query = nodeName && nodeName !== 'Local' ? `?node=${encodeURIComponent(nodeName)}` : '';
    setDetails(null);

    fetch(`/api/containers/${container.id}${query}`)
      .then(res => (res.ok ? res.json() : null))
      .then(data => {
        if (data) setDetails(data);
      })
      .catch((error) => logger.error('ContainerLogsPanel', 'Failed to load details', error));
  }, [container.id, nodeName]);

  useEffect(() => {
    const controller = new AbortController();
    const query = nodeName && nodeName !== 'Local' ? `?node=${encodeURIComponent(nodeName)}` : '';
    setLogs('');
    setLogsLoading(true);

    const streamLogs = async () => {
      try {
        const response = await fetch(`/api/containers/${container.id}/logs/stream${query}`, {
          signal: controller.signal,
        });

        if (!response.body) {
          setLogsLoading(false);
          return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        setLogsLoading(false);

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          const text = decoder.decode(value, { stream: true });
          setLogs((prev) => prev + text);
        }
      } catch (error) {
        if ((error as Error).name !== 'AbortError') {
          logger.error('ContainerLogsPanel', 'Stream failed', error);
          setLogs((prev) => prev + '\n[Error: Connection lost]');
        }
      } finally {
        setLogsLoading(false);
      }
    };

    streamLogs();
    return () => controller.abort();
  }, [container.id, nodeName]);

  const envValues = Array.isArray((details as { Config?: { Env?: string[] } })?.Config?.Env)
    ? ((details as { Config?: { Env?: string[] } }).Config?.Env as string[])
    : [];
  const filteredEnvEntries = envValues.filter((entry) =>
    ['POD', 'NODE_ENV', 'PORT'].some((key) => entry.startsWith(`${key}=`))
  );

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between border-b border-gray-200 dark:border-gray-800 px-6 py-4 bg-white dark:bg-gray-950">
        <div className="flex flex-col">
          <div className="flex items-center gap-3 text-gray-900 dark:text-gray-100">
            <Box size={22} />
            <span className="font-semibold text-lg">{container.name}</span>
            {!container.hideMeta && (
              <span className="text-xs font-mono text-gray-500">{container.id.slice(0, 12)}</span>
            )}
          </div>
          {container.status && (
            <p className="text-xs text-gray-500 mt-1">{container.status}</p>
          )}
        </div>
        <button
          onClick={onClose}
          className="p-2 rounded-full text-gray-500 hover:text-gray-900 dark:hover:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-800"
          aria-label="Close logs"
        >
          <X size={18} />
        </button>
      </div>

      <div className="flex-1 flex flex-col lg:flex-row overflow-hidden">
        <div className="w-full lg:w-1/3 border-b lg:border-b-0 lg:border-r border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/40 p-4 overflow-y-auto">
          <h4 className="text-xs uppercase tracking-wider text-gray-500 dark:text-gray-400 font-semibold mb-3">Container Info</h4>
          <div className="space-y-3 text-sm text-gray-800 dark:text-gray-100">
            <div>
              <span className="block text-xs text-gray-500">Image</span>
              <span className="break-all text-gray-900 dark:text-gray-50">{container.image || 'Unknown'}</span>
            </div>
            <div>
              <span className="block text-xs text-gray-500">State</span>
              <span
                className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium mt-1 ${
                  container.state === 'running'
                    ? 'bg-green-100 dark:bg-green-900/30 text-green-800 dark:text-green-300'
                    : 'bg-gray-200 dark:bg-gray-800 text-gray-700 dark:text-gray-200'
                }`}
              >
                {container.state || 'unknown'}
              </span>
            </div>
            <div>
              <span className="block text-xs text-gray-500">Created</span>
              <span>
                {container.created
                  ? new Date(container.created * 1000).toLocaleString()
                  : 'Unknown'}
              </span>
            </div>

            {/* Details such as env vars */}
            {filteredEnvEntries.length > 0 && (
              <div>
                <span className="block text-xs text-gray-500">Environment</span>
                <div className="space-y-1 mt-1">
                  {filteredEnvEntries.map((entry, index) => (
                    <div
                      key={`${entry}-${index}`}
                      className="font-mono text-xs bg-gray-200 dark:bg-gray-800 px-2 py-1 rounded break-all"
                    >
                      {entry}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {container.ports && container.ports.length > 0 && (
              <div>
                <span className="block text-xs text-gray-500">Ports</span>
                <div className="space-y-1 mt-1">
                  {container.ports.map((port, index) => (
                    <div
                      key={`${port.containerPort}-${index}`}
                      className="font-mono text-xs bg-gray-100 dark:bg-gray-800 px-2 py-1 rounded"
                    >
                      {port.hostPort ? `${port.hostPort}:` : ''}
                      {port.containerPort}/{(port.protocol || 'tcp').toLowerCase()}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {container.mounts && container.mounts.length > 0 && (
              <div>
                <span className="block text-xs text-gray-500">Mounts</span>
                <div className="space-y-1 mt-1">
                  {container.mounts.map((mount, index) => (
                    <div
                      key={index}
                      className="text-xs bg-gray-100 dark:bg-gray-800 px-2 py-1 rounded break-all"
                    >
                      {typeof mount === 'string'
                        ? mount
                        : `${mount.Source || ''} → ${mount.Destination || ''}`}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="flex-1 flex flex-col bg-gray-950 text-gray-200">
          <div className="flex items-center justify-between px-4 py-2 border-b border-gray-800 text-xs text-gray-400 uppercase tracking-wide">
            <span>Live Logs</span>
            {logsLoading && <RefreshCw size={14} className="animate-spin" />}
          </div>
          <div className="flex-1 overflow-auto p-4 whitespace-pre-wrap font-mono text-xs">
            {logs ? logs : logsLoading ? 'Connecting to log stream...' : 'No logs available yet.'}
          </div>
        </div>
      </div>
    </div>
  );
}

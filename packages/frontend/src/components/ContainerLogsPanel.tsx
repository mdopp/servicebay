'use client';

import { useEffect, useState } from 'react';
import { Box, RefreshCw, X, Copy, Check } from 'lucide-react';
import { logger } from '@servicebay/api-client';
import { Badge, Button, SectionHeading } from '@/components/ui';

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
  const [copied, setCopied] = useState(false);

  const handleCopyLogs = () => {
    if (logs) {
      navigator.clipboard.writeText(logs);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  useEffect(() => {
    const query = nodeName && nodeName !== 'Local' ? `?node=${encodeURIComponent(nodeName)}` : '';
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async container-detail fetch on id/node change
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
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async log-stream fetch, AbortController-guarded
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
      <div className="flex items-center justify-between border-b border-border px-6 py-space-4 bg-surface">
        <div className="flex flex-col">
          <div className="flex items-center gap-space-3 text-text">
            <Box size={22} />
            <span className="font-semibold text-lg">{container.name}</span>
            {!container.hideMeta && (
              <span className="text-xs font-mono text-text-subtle">{container.id.slice(0, 12)}</span>
            )}
          </div>
          {container.status && (
            <p className="text-xs text-text-muted mt-1">{container.status}</p>
          )}
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={onClose}
          className="!h-auto !px-0 p-2 rounded-chip"
          aria-label="Close logs"
        >
          <X size={18} />
        </Button>
      </div>

      <div className="flex-1 flex flex-col lg:flex-row overflow-hidden">
        <div className="w-full lg:w-1/3 border-b lg:border-b-0 lg:border-r border-border bg-surface-muted p-space-4 overflow-y-auto">
          <SectionHeading as="h4" tone="muted" className="mb-space-3">Container Info</SectionHeading>
          <div className="space-y-space-3 text-sm text-text">
            <div>
              <span className="block text-xs text-text-muted">Image</span>
              <span className="break-all text-text">{container.image || 'Unknown'}</span>
            </div>
            <div>
              <span className="block text-xs text-text-muted">State</span>
              <Badge variant={container.state === 'running' ? 'ok' : 'neutral'} className="mt-1">
                {container.state || 'unknown'}
              </Badge>
            </div>
            <div>
              <span className="block text-xs text-text-muted">Created</span>
              <span>
                {container.created
                  ? new Date(container.created * 1000).toLocaleString()
                  : 'Unknown'}
              </span>
            </div>

            {/* Details such as env vars */}
            {filteredEnvEntries.length > 0 && (
              <div>
                <span className="block text-xs text-text-muted">Environment</span>
                <div className="space-y-1 mt-1">
                  {filteredEnvEntries.map((entry, index) => (
                    <div
                      key={`${entry}-${index}`}
                      className="font-mono text-xs bg-surface-2 px-space-2 py-1 rounded-card break-all"
                    >
                      {entry}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {container.ports && container.ports.length > 0 && (
              <div>
                <span className="block text-xs text-text-muted">Ports</span>
                <div className="space-y-1 mt-1">
                  {container.ports.map((port, index) => (
                    <div
                      key={`${port.containerPort}-${index}`}
                      className="font-mono text-xs bg-surface-2 px-space-2 py-1 rounded-card"
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
                <span className="block text-xs text-text-muted">Mounts</span>
                <div className="space-y-1 mt-1">
                  {container.mounts.map((mount, index) => (
                    <div
                      key={index}
                      className="text-xs bg-surface-2 px-space-2 py-1 rounded-card break-all"
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

        {/* Log body stays a monospace terminal console — a dark well, not a Card. */}
        <div className="flex-1 flex flex-col bg-gray-950 text-gray-200">
          <div className="flex items-center justify-between px-space-4 py-2 border-b border-gray-800 text-xs text-gray-400 uppercase tracking-wide">
            <span>Live Logs</span>
            <div className="flex items-center gap-space-2">
              {logs && (
                <button onClick={handleCopyLogs} className="flex items-center gap-1 px-space-2 py-1 rounded-card hover:bg-gray-800 transition-colors normal-case" title="Copy logs">
                  {copied ? <Check size={12} className="text-status-ok" /> : <Copy size={12} />}
                  <span className="text-[10px]">{copied ? 'Copied' : 'Copy'}</span>
                </button>
              )}
              {logsLoading && <RefreshCw size={14} className="animate-spin" />}
            </div>
          </div>
          <div className="flex-1 overflow-auto p-space-4 whitespace-pre-wrap font-mono text-xs">
            {logs ? logs : logsLoading ? 'Connecting to log stream...' : 'No logs available yet.'}
          </div>
        </div>
      </div>
    </div>
  );
}

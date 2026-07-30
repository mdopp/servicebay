'use client';

import { useState, useEffect } from 'react';
import { RefreshCw, Terminal, Activity, Box, ArrowLeft, FileJson, DatabaseBackup } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { logger } from '@servicebay/api-client';
import ContainerList from './ContainerList';
import { Button } from './ui/Button';
import { Select } from './ui/Select';
import type { EnrichedContainer } from '@servicebay/api-client';

interface ServiceMonitorProps {
    serviceName: string;
    initialNode?: string;
    onBack?: () => void;
    variant?: 'page' | 'embedded';
}

// Raw Podman API response shape (PascalCase)
interface PodmanContainerRaw {
    Id: string;
    Names: string[];
    Image: string;
    State: string;
    Status: string;
    Labels?: Record<string, string>;
    Ports?: { HostPort?: number; ContainerPort?: number; HostIp?: string; Protocol?: string; [key: string]: unknown }[];
    Created?: number;
    Pod?: string;
    PodName?: string;
    // Removed [key: string]: any to enforce strict typing
}

interface NetworkGraphNode {
    id: string;
    type: string;
    node: string;
    rawData?: {
        name?: string;
        [key: string]: unknown;
    };
}

export default function ServiceMonitor({ serviceName, initialNode, onBack, variant = 'page' }: ServiceMonitorProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
    const nodeParam = searchParams?.get('node');
    const node = initialNode ?? (nodeParam && nodeParam.length > 0 ? nodeParam : undefined);
  const [activeTab, setActiveTab] = useState<'status' | 'service' | 'container-logs' | 'network'>('status');
  
  const [logs, setLogs] = useState<{ serviceLogs: string; podmanPs: Partial<EnrichedContainer>[] } | null>(null);
  const [status, setStatus] = useState<string>('');
  const [containerLogs, setContainerLogs] = useState<string>('');
  const [selectedContainerId, setSelectedContainerId] = useState<string | null>(null);
  const [networkData, setNetworkData] = useState<NetworkGraphNode | null>(null);
  const [loading, setLoading] = useState(false);
  const [backingUp, setBackingUp] = useState(false);
  const [backupMsg, setBackupMsg] = useState<{ text: string; ok: boolean } | null>(null);

  const baseName = serviceName.replace(/\.(service|scope|socket|timer)$/, '');

  // On-demand "Back up config" to the FritzBox NAS (#1217). The backend rejects
  // services without a backup manifest with a curated message, which we surface.
  const handleBackupConfig = async () => {
    setBackingUp(true);
    setBackupMsg(null);
    try {
      const res = await fetch('/api/system/external-backup/backup-now', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ service: baseName }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.ok === false) {
        setBackupMsg({ text: data?.error || 'Backup failed', ok: false });
      } else {
        setBackupMsg({ text: 'Config backed up to NAS', ok: true });
      }
    } catch (e) {
      setBackupMsg({ text: e instanceof Error ? e.message : 'Backup failed', ok: false });
    } finally {
      setBackingUp(false);
    }
  };

    const fetchLogs = async () => {
    setLoading(true);
    try {
            const query = node ? `?node=${encodeURIComponent(node)}` : '';
      const [logsRes, statusRes, graphRes] = await Promise.all([
        fetch(`/api/services/${serviceName}/logs${query}`),
        fetch(`/api/services/${serviceName}/status${query}`),
        fetch(`/api/network/graph${query}`)
      ]);

      if (logsRes.ok) {
        const data = await logsRes.json();
        // Filter containers relevant to this service
        // We assume the service name is part of the container name or pod name
        // Quadlet usually names containers like "systemd-<service>" or just uses the name from .container
        // We'll try to match loosely
        const startName = serviceName.replace('.service', '');
        
        const filteredPs: PodmanContainerRaw[] = (data.podmanPs || []).filter((c: PodmanContainerRaw) => {
            const names = Array.isArray(c.Names) ? c.Names : [c.Names];
            return names.some((n: string) => n.includes(startName));
        });

        // Normalize for ContainerList (expects lowercase id, nodeName, etc.)
        const normalizedPs: Partial<EnrichedContainer>[] = filteredPs.map((c: PodmanContainerRaw) => ({
            ...c,
            id: c.Id,
            names: Array.isArray(c.Names) ? c.Names : [c.Names],
            image: c.Image,
            state: c.State,
            status: c.Status,
            nodeName: node || 'Local'
        }));
        
        setLogs({ ...data, podmanPs: normalizedPs });
        
        if (normalizedPs.length > 0 && !selectedContainerId) {
            setSelectedContainerId(normalizedPs[0].id || null);
        }
      }
      if (statusRes.ok) {
        const data = await statusRes.json();
        setStatus(data.status);
      }
      if (graphRes.ok) {
          const graph = await graphRes.json();
          // Find the node corresponding to this service
          // STRICT LOOKUP: Use rawData.name to match serviceName directly.
          // No fuzzy guessing, no hardcoded proxy checks.
          const cleanName = serviceName.replace('.service', '');

          const targetNode = graph.nodes.find((n: NetworkGraphNode) => {
               // Normal Service Match
               if (n.rawData && n.rawData.name === cleanName && (node ? n.node === node : true)) {
                   return true;
               }
               // Gateway Match (Special Case)
               if (cleanName === 'gateway' && n.type === 'gateway') {
                   return true;
               }
               return false;
          });

          if (targetNode) {
              setNetworkData(targetNode);
          } else {
              logger.warn('ServiceMonitor', `Node not found for service: ${cleanName}`);
          }
      }
    } catch (e) {
      logger.error('ServiceMonitor', 'Failed to fetch data', e);
    } finally {
      setLoading(false);
    }
  };

    const fetchContainerLogs = async (id: string) => {
    try {
                const query = node ? `?node=${encodeURIComponent(node)}` : '';
        const res = await fetch(`/api/containers/${id}/logs${query}`);
        if (res.ok) {
            const data = await res.json();
            setContainerLogs(data.logs);
        }
    } catch (e) {
        logger.error('ServiceMonitor', 'Failed to fetch container logs', e);
    }
  };

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async service-log fetch on service/node change
    fetchLogs();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [serviceName, node]);

    useEffect(() => {
        if (activeTab === 'container-logs' && selectedContainerId) {
                // eslint-disable-next-line react-hooks/set-state-in-effect -- async container-log fetch on tab/container change
                fetchContainerLogs(selectedContainerId);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeTab, selectedContainerId, node]);

    const handleBack = () => {
        if (onBack) {
                onBack();
        } else {
                router.back();
        }
    };

  return (
        <div className="h-full flex flex-col relative">
            {variant === 'page' && (
                <div className="flex justify-between items-center mb-6 p-4 border-b border-border bg-surface dark:bg-surface/50">
                    <div className="flex items-center gap-4">
                            <Button onClick={handleBack} variant="ghost" size="sm" className="rounded-full">
                                    <ArrowLeft size={24} className="text-muted dark:text-muted" />
                            </Button>
                            <h1 className="text-xl font-bold text-foreground dark:text-foreground">Monitor: {serviceName}</h1>
                    </div>
                    <div className="flex items-center gap-3">
                            {backupMsg && (
                                <span className={`text-sm ${backupMsg.ok ? 'text-status-ok dark:text-status-ok' : 'text-status-fail dark:text-status-fail'}`}>
                                    {backupMsg.text}
                                </span>
                            )}
                            <Button
                                    onClick={handleBackupConfig}
                                    disabled={backingUp}
                                    variant="secondary"
                                    size="sm"
                                    title="Back up this service's config to the FritzBox NAS"
                            >
                                    <DatabaseBackup size={18} className={backingUp ? 'animate-pulse' : ''} /> Back up config
                            </Button>
                            <Button
                                    onClick={fetchLogs}
                                    disabled={loading}
                                    variant="secondary"
                                    size="sm"
                                    title="Refresh"
                            >
                                    <RefreshCw size={20} className={loading ? 'animate-spin' : ''} />
                            </Button>
                    </div>
                </div>
            )}

            <div className={`flex-1 flex flex-col min-h-0 ${variant === 'embedded' ? 'p-0' : 'p-6'}`}>
      <div className="bg-surface dark:bg-surface rounded-lg border border-border dark:border-border shadow-sm overflow-hidden flex flex-col flex-1 min-h-0">
        <div className="flex border-b border-border dark:border-border bg-surface dark:bg-surface/50 shrink-0">
            {/* `!h-auto !px-6` forces out Button's default size="md" (h-10/px-space-4) so it
                can't win the cascade against this tab strip's own px-6/py-3 geometry — cn()
                has no Tailwind-merge dedup, same escape hatch as the EmailNotificationsSection
                fix (box-verify dbf73003 regression: tabs silently rendered 24px→16px padding
                and a clipped fixed height because no `size` override was passed here). */}
            <Button
            variant="ghost"
            className={`!h-auto !px-6 py-3 font-medium text-sm flex items-center gap-2 transition-colors ${activeTab === 'status' ? 'bg-surface dark:bg-surface text-accent dark:text-accent border-t-2 border-t-accent dark:border-t-accent' : 'text-subtle dark:text-subtle hover:text-muted dark:hover:text-muted'}`}
            onClick={() => setActiveTab('status')}
            >
            <Activity size={16} /> Status
            </Button>
            <Button
            variant="ghost"
            className={`!h-auto !px-6 py-3 font-medium text-sm flex items-center gap-2 transition-colors ${activeTab === 'service' ? 'bg-surface dark:bg-surface text-accent dark:text-accent border-t-2 border-t-accent dark:border-t-accent' : 'text-subtle dark:text-subtle hover:text-muted dark:hover:text-muted'}`}
            onClick={() => setActiveTab('service')}
            >
            <Terminal size={16} /> Service Logs
            </Button>
            <Button
            variant="ghost"
            className={`!h-auto !px-6 py-3 font-medium text-sm flex items-center gap-2 transition-colors ${activeTab === 'container-logs' ? 'bg-surface dark:bg-surface text-accent dark:text-accent border-t-2 border-t-accent dark:border-t-accent' : 'text-subtle dark:text-subtle hover:text-muted dark:hover:text-muted'}`}
            onClick={() => setActiveTab('container-logs')}
            >
            <Box size={16} /> Container Logs & Info
            </Button>
            <Button
            variant="ghost"
            className={`!h-auto !px-6 py-3 font-medium text-sm flex items-center gap-2 transition-colors ${activeTab === 'network' ? 'bg-surface dark:bg-surface text-accent dark:text-accent border-t-2 border-t-accent dark:border-t-accent' : 'text-subtle dark:text-subtle hover:text-muted dark:hover:text-muted'}`}
            onClick={() => setActiveTab('network')}
            >
            <FileJson size={16} /> Raw Data / Config
            </Button>
        </div>

        <div className="bg-surface-muted dark:bg-surface-muted p-4 flex-1 overflow-y-auto">
            {activeTab === 'status' && (
            <pre className="text-sm font-mono text-status-ok whitespace-pre-wrap">
                {status || 'Loading status...'}
            </pre>
            )}
            {activeTab === 'service' && (
            <pre className="text-sm font-mono text-muted whitespace-pre-wrap">
                {logs?.serviceLogs || (
                    <div className="text-subtle italic">
                        <p>No service logs available.</p>
                        <p className="text-xs mt-2">Checking journalctl for unit: {serviceName.match(/\.(service|scope|socket|timer)$/) ? serviceName : `${serviceName}.service`}</p>
                    </div>
                )}
            </pre>
            )}
            {activeTab === 'network' && (
                <div className="space-y-6">
                    {networkData ? (
                        <>
                            {/* Raw Data Only */}
                            <pre className="text-xs font-mono text-subtle whitespace-pre-wrap break-all bg-surface">
                                {JSON.stringify(networkData.rawData, null, 2)}
                            </pre>
                        </>
                    ) : (
                        <div className="text-subtle italic">
                            <p className="mb-2">No network data found for this service.</p>
                            <div className="text-xs text-muted border border-border p-2 rounded bg-surface-2">
                                <p>Troubleshooting:</p>
                                <ul className="list-disc ml-4 space-y-1 mt-1">
                                    <li>If the service is inactive, it will not appear in the network graph.</li>
                                    <li>Searched for node types: &apos;service&apos;, &apos;proxy&apos;, &apos;container&apos;</li>
                                    <li>Matched against label: &quot;{serviceName}&quot; or &quot;{serviceName.replace('.service', '')}&quot;</li>
                                </ul>
                            </div>
                        </div>
                    )}
                </div>
            )}
            {activeTab === 'container-logs' && (
                <div className="space-y-4">
                    {logs?.podmanPs && logs.podmanPs.length > 0 ? (
                        <>
                            <div className="mb-4">
                                <h4 className="text-subtle text-sm font-bold mb-2">Related Containers</h4>
                                <ContainerList containers={logs.podmanPs} />
                            </div>

                            <div>
                                <div className="flex items-center justify-between mb-2">
                                    <h4 className="text-subtle text-sm font-bold">Container Logs</h4>
                                    <Select
                                        className="bg-surface-2 text-foreground text-sm rounded border border-border p-1"
                                        value={selectedContainerId || ''}
                                        onChange={(e) => setSelectedContainerId(e.target.value)}
                                    >
                                        {logs.podmanPs.map((c) => (
                                            <option key={c.id} value={c.id}>
                                                {c.names?.[0]} ({c.id?.substring(0, 12)})
                                            </option>
                                        ))}
                                    </Select>
                                </div>
                                <pre className="text-sm font-mono text-muted whitespace-pre-wrap bg-surface p-4 rounded border border-border min-h-[300px]">
                                    {containerLogs || 'Select a container to view logs.'}
                                </pre>
                            </div>
                        </>
                    ) : (
                        <div className="text-subtle italic">
                             <p className="mb-2">No running containers found matching this service.</p>
                             <div className="text-xs text-muted border border-border p-2 rounded bg-surface-2">
                                <p>Possible reasons:</p>
                                <ul className="list-disc ml-4 space-y-1 mt-1">
                                    <li>The service has not started any containers yet.</li>
                                    <li>The containers have stopped or crashed.</li>
                                    <li>Container names do not contain the service name &quot;{serviceName.replace('.service', '')}&quot;.</li>
                                </ul>
                            </div>
                        </div>
                    )}
                </div>
            )}
        </div>
      </div>
      </div>
    </div>
  );
}


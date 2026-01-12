'use client';

import { useState, useEffect } from 'react';
import { RefreshCw, Terminal, Activity, Box, ArrowLeft, FileJson } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { logger } from '@/lib/logger';
import ContainerList from './ContainerList';
import { EnrichedContainer } from '@/lib/agent/types';

interface ServiceMonitorProps {
  serviceName: string;
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

export default function ServiceMonitor({ serviceName }: ServiceMonitorProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const node = searchParams?.get('node');
  const [activeTab, setActiveTab] = useState<'status' | 'service' | 'container-logs' | 'network'>('status');
  
  const [logs, setLogs] = useState<{ serviceLogs: string; podmanPs: Partial<EnrichedContainer>[] } | null>(null);
  const [status, setStatus] = useState<string>('');
  const [containerLogs, setContainerLogs] = useState<string>('');
  const [selectedContainerId, setSelectedContainerId] = useState<string | null>(null);
  const [networkData, setNetworkData] = useState<NetworkGraphNode | null>(null);
  const [loading, setLoading] = useState(false);

  const fetchLogs = async () => {
    setLoading(true);
    try {
      const query = node ? `?node=${node}` : '';
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
              console.warn(`[ServiceMonitor] Node not found for service: ${cleanName}`);
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
        const query = node ? `?node=${node}` : '';
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
    fetchLogs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serviceName]);

  useEffect(() => {
    if (activeTab === 'container-logs' && selectedContainerId) {
        fetchContainerLogs(selectedContainerId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, selectedContainerId]);

  return (
    <div className="h-full flex flex-col relative">
      <div className="flex justify-between items-center mb-6 p-4 border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/50">
        <div className="flex items-center gap-4">
            <button onClick={() => router.back()} className="p-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-full transition-colors">
                <ArrowLeft size={24} className="text-gray-600 dark:text-gray-300" />
            </button>
            <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100">Monitor: {serviceName}</h1>
        </div>
        <div className="flex gap-3">
            <button 
                onClick={fetchLogs} 
                disabled={loading}
                className="p-2 text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded hover:bg-gray-50 dark:hover:bg-gray-700 shadow-sm transition-colors" 
                title="Refresh"
            >
                <RefreshCw size={20} className={loading ? 'animate-spin' : ''} />
            </button>
        </div>
      </div>

      <div className="flex-1 flex flex-col min-h-0 p-6">
      <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 shadow-sm overflow-hidden flex flex-col flex-1 min-h-0">
        <div className="flex border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/50 shrink-0">
            <button
            className={`px-6 py-3 font-medium text-sm flex items-center gap-2 transition-colors ${activeTab === 'status' ? 'bg-white dark:bg-gray-900 text-blue-600 dark:text-blue-400 border-t-2 border-t-blue-600 dark:border-t-blue-400' : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'}`}
            onClick={() => setActiveTab('status')}
            >
            <Activity size={16} /> Status
            </button>
            <button
            className={`px-6 py-3 font-medium text-sm flex items-center gap-2 transition-colors ${activeTab === 'service' ? 'bg-white dark:bg-gray-900 text-blue-600 dark:text-blue-400 border-t-2 border-t-blue-600 dark:border-t-blue-400' : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'}`}
            onClick={() => setActiveTab('service')}
            >
            <Terminal size={16} /> Service Logs
            </button>
            <button
            className={`px-6 py-3 font-medium text-sm flex items-center gap-2 transition-colors ${activeTab === 'container-logs' ? 'bg-white dark:bg-gray-900 text-blue-600 dark:text-blue-400 border-t-2 border-t-blue-600 dark:border-t-blue-400' : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'}`}
            onClick={() => setActiveTab('container-logs')}
            >
            <Box size={16} /> Container Logs & Info
            </button>
            <button
            className={`px-6 py-3 font-medium text-sm flex items-center gap-2 transition-colors ${activeTab === 'network' ? 'bg-white dark:bg-gray-900 text-blue-600 dark:text-blue-400 border-t-2 border-t-blue-600 dark:border-t-blue-400' : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'}`}
            onClick={() => setActiveTab('network')}
            >
            <FileJson size={16} /> Raw Data / Config
            </button>
        </div>

        <div className="bg-[#2d2d2d] dark:bg-black p-4 flex-1 overflow-y-auto">
            {activeTab === 'status' && (
            <pre className="text-sm font-mono text-green-400 whitespace-pre-wrap">
                {status || 'Loading status...'}
            </pre>
            )}
            {activeTab === 'service' && (
            <pre className="text-sm font-mono text-gray-300 whitespace-pre-wrap">
                {logs?.serviceLogs || (
                    <div className="text-gray-400 italic">
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
                            <pre className="text-xs font-mono text-gray-400 whitespace-pre-wrap break-all bg-black">
                                {JSON.stringify(networkData.rawData, null, 2)}
                            </pre>
                        </>
                    ) : (
                        <div className="text-gray-400 italic">
                            <p className="mb-2">No network data found for this service.</p>
                            <div className="text-xs text-gray-500 border border-gray-700 p-2 rounded bg-black/50">
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
                                <h4 className="text-gray-400 text-sm font-bold mb-2">Related Containers</h4>
                                <ContainerList containers={logs.podmanPs} />
                            </div>
                            
                            <div>
                                <div className="flex items-center justify-between mb-2">
                                    <h4 className="text-gray-400 text-sm font-bold">Container Logs</h4>
                                    <select 
                                        className="bg-gray-700 text-white text-sm rounded border border-gray-600 p-1"
                                        value={selectedContainerId || ''}
                                        onChange={(e) => setSelectedContainerId(e.target.value)}
                                    >
                                        {logs.podmanPs.map((c) => (
                                            <option key={c.id} value={c.id}>
                                                {c.names?.[0]} ({c.id?.substring(0, 12)})
                                            </option>
                                        ))}
                                    </select>
                                </div>
                                <pre className="text-sm font-mono text-gray-300 whitespace-pre-wrap bg-black p-4 rounded border border-gray-700 min-h-[300px]">
                                    {containerLogs || 'Select a container to view logs.'}
                                </pre>
                            </div>
                        </>
                    ) : (
                        <div className="text-gray-400 italic">
                             <p className="mb-2">No running containers found matching this service.</p>
                             <div className="text-xs text-gray-500 border border-gray-700 p-2 rounded bg-black/50">
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


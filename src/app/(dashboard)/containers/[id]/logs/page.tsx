'use client';

import { useState, useEffect, use } from 'react';
import { useRouter } from 'next/navigation';
import { RefreshCw, Box, ArrowLeft } from 'lucide-react';

interface Container {
  Id: string;
  Names: string[];
  Image: string;
  State: string;
  Status: string;
  Created: number;
  Ports?: ({ IP?: string; PrivatePort: number; PublicPort?: number; Type: string } | { host_ip?: string; container_port: number; host_port?: number; protocol: string })[];
  Mounts?: (string | { Source: string; Destination: string; Type: string })[];
}

export default function ContainerLogsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const [container, setContainer] = useState<Container | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [details, setDetails] = useState<any>(null);
  const [logs, setLogs] = useState('');
  const [loading, setLoading] = useState(true);
  const [logsLoading, setLogsLoading] = useState(false);

  useEffect(() => {
    const fetchContainer = async () => {
      setLoading(true);
      try {
        // Fetch container info (using list endpoint for now as we don't have single container endpoint)
        const res = await fetch('/api/containers');
        if (res.ok) {
          const containers: Container[] = await res.json();
          const found = containers.find(c => c.Id.startsWith(id) || c.Id === id);
          if (found) {
            setContainer(found);
          } else {
            console.error('Container not found');
          }
        }

        // Fetch detailed info
        const detailRes = await fetch(`/api/containers/${id}`);
        if (detailRes.ok) {
            const data = await detailRes.json();
            setDetails(data);
        }
      } catch (error) {
        console.error('Failed to fetch data', error);
      } finally {
        setLoading(false);
      }
    };

    fetchContainer();
  }, [id]);

  useEffect(() => {
    if (!container) return;

    const abortController = new AbortController();
    setLogs('');
    setLogsLoading(true);

    const streamLogs = async () => {
        try {
            const response = await fetch(`/api/containers/${container.Id}/logs/stream`, {
                signal: abortController.signal
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
                setLogs(prev => prev + text);
            }
        } catch (e) {
            if (e instanceof Error && e.name !== 'AbortError') {
                console.error('Stream error', e);
                setLogs(prev => prev + '\n[Error: Connection lost]');
            }
        } finally {
            setLogsLoading(false);
        }
    };

    streamLogs();

    return () => {
        abortController.abort();
    };
  }, [container]);

  if (loading) {
    return <div className="flex items-center justify-center h-full text-gray-500">Loading...</div>;
  }

  if (!container) {
    return <div className="flex items-center justify-center h-full text-gray-500">Container not found</div>;
  }

  return (
    <div className="h-full flex flex-col bg-white dark:bg-gray-900">
        <div className="flex justify-between items-center p-4 border-b border-gray-200 dark:border-gray-800">
            <div className="flex items-center gap-4">
                <button onClick={() => router.back()} className="text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 flex items-center gap-1 text-sm font-medium">
                    <ArrowLeft size={18} />
                    Back
                </button>
                <h3 className="text-xl font-bold flex items-center gap-2">
                    <Box size={20} />
                    {container.Names[0].replace(/^\//, '')}
                    <span className="text-xs font-normal text-gray-500 font-mono ml-2">{container.Id.substring(0, 12)}</span>
                </h3>
            </div>
        </div>
        <div className="flex-1 overflow-hidden flex flex-col md:flex-row">
            {/* Info Sidebar */}
            <div className="w-full md:w-1/3 p-4 border-r border-gray-200 dark:border-gray-800 overflow-y-auto bg-gray-50 dark:bg-gray-900/50">
                <h4 className="font-semibold mb-3 text-sm uppercase text-gray-500">Container Info</h4>
                <div className="space-y-3 text-sm">
                    <div>
                        <span className="block text-gray-500 text-xs">Image</span>
                        <span className="break-all">{container.Image}</span>
                    </div>
                    <div>
                        <span className="block text-gray-500 text-xs">State</span>
                        <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium mt-1 ${
                            container.State === 'running' 
                            ? 'bg-green-100 dark:bg-green-900/30 text-green-800 dark:text-green-300' 
                            : 'bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-300'
                        }`}>
                            {container.State}
                        </span>
                    </div>
                    <div>
                        <span className="block text-gray-500 text-xs">Created</span>
                        <span>{new Date(container.Created * 1000).toLocaleString()}</span>
                    </div>
                    
                    {details?.Config?.Env && (
                        <div>
                            <span className="block text-gray-500 text-xs">Environment</span>
                            <div className="space-y-1 mt-1">
                                {details.Config.Env
                                    .filter((e: string) => ['POD', 'NODE_ENV', 'PORT'].some(key => e.startsWith(key + '=')))
                                    .map((e: string, i: number) => (
                                        <div key={i} className="font-mono text-xs bg-gray-100 dark:bg-gray-800 px-2 py-1 rounded break-all">
                                            {e}
                                        </div>
                                    ))
                                }
                            </div>
                        </div>
                    )}

                    {container.Ports && container.Ports.length > 0 && (
                        <div>
                            <span className="block text-gray-500 text-xs">Ports</span>
                            <div className="space-y-1 mt-1">
                                {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                                {container.Ports.map((p: any, i) => {
                                    const hostPort = p.PublicPort || p.host_port;
                                    const containerPort = p.PrivatePort || p.container_port;
                                    const protocol = p.Type || p.protocol;
                                    return (
                                        <div key={i} className="font-mono text-xs bg-gray-200 dark:bg-gray-800 px-2 py-1 rounded">
                                            {hostPort ? `${hostPort}:` : ''}{containerPort}/{protocol}
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    )}
                    {container.Mounts && container.Mounts.length > 0 && (
                        <div>
                            <span className="block text-gray-500 text-xs">Mounts</span>
                            <div className="space-y-1 mt-1">
                                {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                                {container.Mounts.map((m: any, i) => (
                                    <div key={i} className="text-xs bg-gray-200 dark:bg-gray-800 px-2 py-1 rounded break-all">
                                        {typeof m === 'string' ? (
                                            <span>{m}</span>
                                        ) : (
                                            <>
                                                <span className="text-gray-500">{m.Source}</span>
                                                <span className="mx-1">→</span>
                                                <span>{m.Destination}</span>
                                            </>
                                        )}
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                </div>
            </div>
            {/* Logs Area */}
            <div className="flex-1 flex flex-col bg-gray-900 text-gray-300 font-mono text-xs">
                <div className="p-2 bg-gray-800 text-gray-400 text-xs flex justify-between items-center">
                    <span>Live Logs</span>
                    {logsLoading && <RefreshCw size={12} className="animate-spin" />}
                </div>
                <div className="flex-1 overflow-auto p-4 whitespace-pre-wrap">
                    {logs || (logsLoading ? 'Connecting to log stream...' : 'No logs available.')}
                </div>
            </div>
        </div>
    </div>
  );
}

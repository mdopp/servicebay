'use client';

// V4 Update: Use Digital Twin data
import { useDigitalTwin } from '@/hooks/useDigitalTwin';
import { useEffect, useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { EnrichedContainer } from '@servicebay/api-client';

interface ContainerItem extends Partial<EnrichedContainer> {
  // Allow partial for legacy passed props, but prefer EnrichedContainer shape
  nodeName?: string;
}

interface ContainerListProps {
  containers?: ContainerItem[];
}

const CONNECT_TIMEOUT_MS = 15_000;

export default function ContainerList({ containers }: ContainerListProps = {}) {
  const { data: twin } = useDigitalTwin();
  const [slowConnect, setSlowConnect] = useState(false);

  useEffect(() => {
    if (containers || twin) return;
    const t = setTimeout(() => setSlowConnect(true), CONNECT_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [containers, twin]);

  const allContainers = useMemo((): ContainerItem[] => {
     if (containers) return containers;
     if (!twin) return [];
     const list: ContainerItem[] = [];
     Object.entries(twin.nodes).forEach(([nodeName, nodeData]) => {
         nodeData.containers.forEach(c => {
             list.push({ ...c, nodeName });
         });
     });
     return list;
  }, [twin, containers]);

  if (!allContainers || allContainers.length === 0) {
    const isLoading = !(containers || twin);
    return (
        <div className="p-4 bg-[#2d2d2d] rounded-md text-gray-500 italic flex items-center justify-between gap-4">
            <span>
              {!isLoading && "No running containers found."}
              {isLoading && !slowConnect && "Connecting to Digital Twin..."}
              {isLoading && slowConnect && "Still connecting to Digital Twin… check Settings → Nodes if this persists."}
            </span>
            {isLoading && slowConnect && (
                <button
                    type="button"
                    onClick={() => { if (typeof window !== 'undefined') window.location.reload(); }}
                    className="flex items-center gap-1 px-3 py-1.5 text-xs bg-gray-700 hover:bg-gray-600 text-white rounded transition-colors not-italic"
                >
                    <RefreshCw size={12} /> Refresh
                </button>
            )}
        </div>
    );
  }

  return (
    <div className="bg-[#2d2d2d] rounded-md overflow-hidden p-4 overflow-x-auto">
      <table className="w-full text-left min-w-[800px]">
        <thead>
          <tr className="border-b border-gray-600 text-gray-400">
            <th className="pb-2 pr-4">Node</th>
            <th className="pb-2 pr-4">ID</th>
            <th className="pb-2 pr-4">Image</th>
            <th className="pb-2 pr-4">State</th>
            <th className="pb-2 pr-4">Status</th>
            <th className="pb-2 pr-4">Domains</th>
            <th className="pb-2">Names</th>
          </tr>
        </thead>
        <tbody>
          {allContainers.map((container, index) => (
            <tr key={`${container.nodeName || 'local'}-${container.id || `fallback-${index}`}`} className="border-b border-gray-700 last:border-0 hover:bg-gray-800">
              <td className="py-2 pr-4 text-purple-400 font-bold">{container.nodeName}</td>
              <td className="py-2 pr-4 text-blue-400 font-mono" title={container.id}>{container.id?.substring(0, 12)}</td>
              <td className="py-2 pr-4 text-green-400 truncate max-w-[200px]" title={container.image}>{container.image}</td>
              <td className="py-2 pr-4 text-gray-300">{container.state}</td>
              <td className="py-2 pr-4 text-gray-300">{container.status}</td>
              <td className="py-2 pr-4">
                  {container.verifiedDomains && container.verifiedDomains.length > 0 ? (
                      <div className="flex flex-wrap gap-1">
                          {container.verifiedDomains.map((d: string) => (
                              <a 
                                  key={d} 
                                  href={`https://${d}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-xs text-blue-400 hover:text-blue-300 hover:underline px-1 bg-blue-900/20 rounded"
                              >
                                  {d}
                              </a>
                          ))}
                      </div>
                  ) : <span className="text-gray-600">-</span>}
              </td>
              <td
                className="py-2 text-yellow-400 truncate max-w-[200px]"
                title={Array.isArray(container.names) ? container.names.join(', ') : container.names}
              >
                {Array.isArray(container.names) ? container.names.join(', ') : container.names}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}


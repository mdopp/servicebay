'use client';

// V4 Update: Use Digital Twin data
import { useDigitalTwin } from '@/hooks/useDigitalTwin';
import { useMemo } from 'react';

interface ContainerListProps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  containers?: any[];
}

export default function ContainerList({ containers }: ContainerListProps = {}) {
  const { data: twin } = useDigitalTwin();

  const allContainers = useMemo(() => {
     if (containers) return containers;
     if (!twin) return [];
     const list: any[] = [];
     Object.entries(twin.nodes).forEach(([nodeName, nodeData]) => {
         nodeData.containers.forEach(c => {
             list.push({ ...c, nodeName });
         });
     });
     return list;
  }, [twin]);

  if (!allContainers || allContainers.length === 0) {
    return (
        <div className="p-4 bg-[#2d2d2d] rounded-md text-gray-500 italic">
            {(containers || twin) ? "No running containers found." : "Connecting to Digital Twin..."}
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
            <th className="pb-2">Names</th>
          </tr>
        </thead>
        <tbody>
          {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
          {allContainers.map((container: any) => (
            <tr key={`${container.nodeName}-${container.id}`} className="border-b border-gray-700 last:border-0 hover:bg-gray-800">
              <td className="py-2 pr-4 text-purple-400 font-bold">{container.nodeName}</td>
              <td className="py-2 pr-4 text-blue-400 font-mono" title={container.id}>{container.id?.substring(0, 12)}</td>
              <td className="py-2 pr-4 text-green-400 truncate max-w-[200px]" title={container.image}>{container.image}</td>
              <td className="py-2 pr-4 text-gray-300">{container.state}</td>
              <td className="py-2 pr-4 text-gray-300">{container.status}</td>
              <td className="py-2 text-yellow-400">
                {Array.isArray(container.names) ? container.names.join(', ') : container.names}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}


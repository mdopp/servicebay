'use client';

interface ContainerListProps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  containers: any[];
}

export default function ContainerList({ containers }: ContainerListProps) {
  if (!containers || containers.length === 0) {
    return <div className="text-gray-500 italic">No running containers found.</div>;
  }

  return (
    <div className="bg-[#2d2d2d] rounded-md overflow-hidden p-4 overflow-x-auto">
      <table className="w-full text-left min-w-[800px]">
        <thead>
          <tr className="border-b border-gray-600 text-gray-400">
            <th className="pb-2 pr-4">ID</th>
            <th className="pb-2 pr-4">Image</th>
            <th className="pb-2 pr-4">Command</th>
            <th className="pb-2 pr-4">Created</th>
            <th className="pb-2 pr-4">Status</th>
            <th className="pb-2">Names</th>
          </tr>
        </thead>
        <tbody>
          {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
          {containers.map((container: any) => (
            <tr key={container.Id} className="border-b border-gray-700 last:border-0 hover:bg-gray-800">
              <td className="py-2 pr-4 text-blue-400 font-mono" title={container.Id}>{container.Id?.substring(0, 12)}</td>
              <td className="py-2 pr-4 text-green-400">{container.Image}</td>
              <td className="py-2 pr-4 text-gray-400 truncate max-w-[150px]" title={Array.isArray(container.Command) ? container.Command.join(' ') : container.Command}>
                {Array.isArray(container.Command) ? container.Command.join(' ') : container.Command}
              </td>
              <td className="py-2 pr-4 text-gray-300">{container.CreatedAt}</td>
              <td className="py-2 pr-4 text-gray-300">{container.Status}</td>
              <td className="py-2 text-yellow-400">
                {Array.isArray(container.Names) ? container.Names.join(', ') : container.Names}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

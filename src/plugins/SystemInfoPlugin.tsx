'use client';

import { useState, useEffect } from 'react';
import { getSystemInfo, getDiskUsage, SystemInfo, DiskInfo } from '@/app/actions/system';
import { RefreshCw, Cpu, HardDrive, Network, Server } from 'lucide-react';

export default function SystemInfoPlugin() {
  const [sysInfo, setSysInfo] = useState<SystemInfo | null>(null);
  const [diskInfo, setDiskInfo] = useState<DiskInfo[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchData = async () => {
    setLoading(true);
    try {
      const [sys, disk] = await Promise.all([
        getSystemInfo(),
        getDiskUsage()
      ]);
      setSysInfo(sys);
      setDiskInfo(disk);
    } catch (error) {
      console.error('Failed to fetch system info', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  if (loading) return <div className="p-8 text-center text-gray-500">Loading system information...</div>;
  if (!sysInfo) return <div className="p-8 text-center text-red-500">Failed to load system information.</div>;

  return (
    <div className="h-full flex flex-col">
      <div className="flex justify-between items-center mb-6 p-4 border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/50">
        <h2 className="text-xl font-bold text-gray-900 dark:text-white">System Information</h2>
        <button onClick={fetchData} className="p-2 text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded hover:bg-gray-50 dark:hover:bg-gray-700 shadow-sm transition-colors" title="Refresh">
            <RefreshCw size={18} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-6">
        
        {/* OS & CPU */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-4">
                <h3 className="font-bold text-gray-700 dark:text-gray-300 mb-3 flex items-center gap-2">
                    <Server size={18} /> Operating System
                </h3>
                <div className="space-y-2 text-sm">
                    <div className="flex justify-between">
                        <span className="text-gray-500">Hostname:</span>
                        <span className="font-mono">{sysInfo.os.hostname}</span>
                    </div>
                    <div className="flex justify-between">
                        <span className="text-gray-500">Platform:</span>
                        <span>{sysInfo.os.platform} ({sysInfo.os.release})</span>
                    </div>
                    <div className="flex justify-between">
                        <span className="text-gray-500">Uptime:</span>
                        <span>{Math.floor(sysInfo.os.uptime / 3600)}h {Math.floor((sysInfo.os.uptime % 3600) / 60)}m</span>
                    </div>
                </div>
            </div>

            <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-4">
                <h3 className="font-bold text-gray-700 dark:text-gray-300 mb-3 flex items-center gap-2">
                    <Cpu size={18} /> CPU & Memory
                </h3>
                <div className="space-y-2 text-sm">
                    <div className="flex justify-between">
                        <span className="text-gray-500">Model:</span>
                        <span className="truncate max-w-[200px]" title={sysInfo.cpu.model}>{sysInfo.cpu.model}</span>
                    </div>
                    <div className="flex justify-between">
                        <span className="text-gray-500">Cores:</span>
                        <span>{sysInfo.cpu.cores}</span>
                    </div>
                    <div className="flex justify-between">
                        <span className="text-gray-500">Memory:</span>
                        <span>
                            {Math.round((sysInfo.memory.total - sysInfo.memory.free) / 1024 / 1024 / 1024 * 100) / 100} GB / 
                            {Math.round(sysInfo.memory.total / 1024 / 1024 / 1024 * 100) / 100} GB
                        </span>
                    </div>
                </div>
            </div>
        </div>

        {/* Disk Usage */}
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-4">
            <h3 className="font-bold text-gray-700 dark:text-gray-300 mb-3 flex items-center gap-2">
                <HardDrive size={18} /> Disk Usage
            </h3>
            <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                    <thead className="text-gray-500 border-b border-gray-200 dark:border-gray-800">
                        <tr>
                            <th className="pb-2">Mount</th>
                            <th className="pb-2">Size</th>
                            <th className="pb-2">Used</th>
                            <th className="pb-2">Avail</th>
                            <th className="pb-2">Use%</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                        {diskInfo.map((d, i) => (
                            <tr key={i}>
                                <td className="py-2 font-mono text-xs">{d.mount}</td>
                                <td className="py-2">{d.size}</td>
                                <td className="py-2">{d.used}</td>
                                <td className="py-2">{d.avail}</td>
                                <td className="py-2">
                                    <div className="flex items-center gap-2">
                                        <div className="w-16 h-2 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                                            <div 
                                                className={`h-full ${parseInt(d.use) > 90 ? 'bg-red-500' : parseInt(d.use) > 70 ? 'bg-yellow-500' : 'bg-green-500'}`} 
                                                style={{ width: d.use }}
                                            />
                                        </div>
                                        <span className="text-xs">{d.use}</span>
                                    </div>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>

        {/* Network */}
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-4">
            <h3 className="font-bold text-gray-700 dark:text-gray-300 mb-3 flex items-center gap-2">
                <Network size={18} /> Network Interfaces
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {Object.entries(sysInfo.network).map(([name, ifaces]) => (
                    <div key={name} className="p-3 bg-gray-50 dark:bg-gray-800 rounded border border-gray-200 dark:border-gray-700">
                        <div className="font-bold text-sm mb-1">{name}</div>
                        {ifaces?.map((iface, i) => (
                            <div key={i} className="text-xs font-mono text-gray-600 dark:text-gray-400">
                                {iface.family} {iface.address}
                            </div>
                        ))}
                    </div>
                ))}
            </div>
        </div>

      </div>
    </div>
  );
}

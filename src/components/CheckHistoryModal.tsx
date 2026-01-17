'use client';

import { X, Clock, AlertTriangle, CheckCircle, Activity } from 'lucide-react';
import { Check } from '@/lib/monitoring/types';

interface HistoryItem {
  status: 'ok' | 'fail';
  latency: number;
  timestamp: string;
  message?: string;
}

interface CheckHistoryModalProps {
  check: Check | null;
  data: HistoryItem[];
  isOpen: boolean;
  onClose: () => void;
}

export default function CheckHistoryModal({ check, data, isOpen, onClose }: CheckHistoryModalProps) {
  if (!isOpen || !check) return null;

  // Calculate stats
  const uptime = data.length > 0
    ? (data.filter(i => i.status === 'ok').length / data.length) * 100
    : 100;
  
  const avgLatency = data.length > 0
    ? Math.round(data.reduce((acc, curr) => acc + (curr.latency || 0), 0) / data.length)
    : 0;

  // Prepare graph data
  // We want to show the last N points (max 50 for the graph)
  const graphData = data.slice(0, 50).reverse(); // Oldest to newest for graph
  const maxLatency = Math.max(...graphData.map(d => d.latency || 0), 100); // Min scale 100ms
  const height = 150;
  const width = 600;
  const barWidth = width / (graphData.length || 1);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
      <div className="bg-white dark:bg-gray-900 rounded-xl shadow-xl w-full max-w-2xl overflow-hidden border border-gray-200 dark:border-gray-800 flex flex-col max-h-[90vh]">
        <div className="flex items-center justify-between p-4 border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/50">
          <div className="flex items-center gap-3">
             <div className={`p-2 rounded-lg ${check.status === 'ok' ? 'bg-green-100 text-green-600' : 'bg-red-100 text-red-600'}`}>
                <Activity size={20} />
             </div>
             <div>
                <h3 className="text-lg font-semibold text-gray-900 dark:text-white">Check History</h3>
                <p className="text-xs text-gray-500">{check.name} • {check.target}</p>
             </div>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-gray-200 dark:hover:bg-gray-800 rounded-full transition-colors">
            <X size={20} className="text-gray-500" />
          </button>
        </div>

        <div className="p-6 overflow-y-auto">
           {/* Stats Cards */}
           <div className="grid grid-cols-3 gap-4 mb-6">
              <div className="p-4 bg-gray-50 dark:bg-gray-800 rounded-lg border border-gray-100 dark:border-gray-700">
                 <div className="text-xs text-gray-500 mb-1 uppercase tracking-wider font-semibold">Uptime (24h)</div>
                 <div className={`text-2xl font-bold ${uptime > 99 ? 'text-green-600' : uptime > 90 ? 'text-yellow-600' : 'text-red-600'}`}>
                    {uptime.toFixed(1)}%
                 </div>
              </div>
              <div className="p-4 bg-gray-50 dark:bg-gray-800 rounded-lg border border-gray-100 dark:border-gray-700">
                 <div className="text-xs text-gray-500 mb-1 uppercase tracking-wider font-semibold">Avg Latency</div>
                 <div className="text-2xl font-bold text-gray-900 dark:text-white">
                    {avgLatency}ms
                 </div>
              </div>
              <div className="p-4 bg-gray-50 dark:bg-gray-800 rounded-lg border border-gray-100 dark:border-gray-700">
                 <div className="text-xs text-gray-500 mb-1 uppercase tracking-wider font-semibold">Data Points</div>
                 <div className="text-2xl font-bold text-gray-900 dark:text-white">
                    {data.length}
                 </div>
              </div>
           </div>

           {/* Latency Graph */}
           {graphData.length > 0 && (
             <div className="mb-6">
                <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-3 flex items-center gap-2">
                    <Activity size={16} /> Latency / Availability Trend
                </h4>
                <div className="h-[150px] w-full bg-gray-50 dark:bg-black/20 rounded-lg border border-gray-200 dark:border-gray-800 relative overflow-hidden">
                    <svg width="100%" height="100%" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
                        {/* Bars */}
                        {graphData.map((d, i) => {
                            const barHeight = (d.latency / maxLatency) * (height * 0.8); // Scale to 80% height
                            const x = i * barWidth;
                            const y = height - Math.max(barHeight, 4); // Min height 4px
                            
                            return (
                                <g key={i}>
                                    <rect
                                        x={x}
                                        y={d.status === 'ok' ? y : 0} // Full height line for error
                                        width={Math.max(barWidth - 2, 1)}
                                        height={d.status === 'ok' ? Math.max(barHeight, 4) : height}
                                        fill={d.status === 'ok' ? '#10b981' : '#ef4444'} // green-500 / red-500
                                        opacity={0.6}
                                        rx={2}
                                    >
                                        <title>{`Status: ${d.status}\nLatency: ${d.latency}ms\nTime: ${new Date(d.timestamp).toLocaleString()}`}</title>
                                    </rect>
                                </g>
                            );
                        })}
                    </svg>
                    {/* Axis Labels (Simple) */}
                    <div className="absolute top-1 right-2 text-[10px] text-gray-400 font-mono">{maxLatency}ms</div>
                    <div className="absolute bottom-1 right-2 text-[10px] text-gray-400 font-mono">Now</div>
                    <div className="absolute bottom-1 left-2 text-[10px] text-gray-400 font-mono">Past</div>
                </div>
             </div>
           )}

           {/* Recent Log Table */}
           <div>
              <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-3 flex items-center gap-2">
                  <Clock size={16} /> Recent Activity
              </h4>
              <div className="border border-gray-200 dark:border-gray-800 rounded-lg overflow-hidden">
                  <table className="w-full text-sm text-left">
                      <thead className="bg-gray-50 dark:bg-gray-800 text-gray-500 font-medium">
                          <tr>
                              <th className="px-4 py-2">Time</th>
                              <th className="px-4 py-2">Status</th>
                              <th className="px-4 py-2">Latency</th>
                              <th className="px-4 py-2">Message</th>
                          </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-200 dark:divide-gray-800">
                          {data.slice(0, 10).map((d, i) => (
                              <tr key={i} className="hover:bg-gray-50 dark:hover:bg-gray-800/50">
                                  <td className="px-4 py-2 whitespace-nowrap text-gray-600 dark:text-gray-400 text-xs">
                                      {new Date(d.timestamp).toLocaleString()}
                                  </td>
                                  <td className="px-4 py-2">
                                      {d.status === 'ok' ? (
                                          <span className="inline-flex items-center gap-1 text-green-600 dark:text-green-400 text-xs font-medium bg-green-50 dark:bg-green-900/20 px-2 py-0.5 rounded-full">
                                              <CheckCircle size={12} /> OK
                                          </span>
                                      ) : (
                                          <span className="inline-flex items-center gap-1 text-red-600 dark:text-red-400 text-xs font-medium bg-red-50 dark:bg-red-900/20 px-2 py-0.5 rounded-full">
                                              <AlertTriangle size={12} /> Fail
                                          </span>
                                      )}
                                  </td>
                                  <td className="px-4 py-2 font-mono text-xs text-gray-600 dark:text-gray-400">
                                      {d.latency}ms
                                  </td>
                                  <td className="px-4 py-2 text-xs text-gray-500 max-w-[200px] truncate" title={d.message}>
                                      {d.message || '-'}
                                  </td>
                              </tr>
                          ))}
                      </tbody>
                  </table>
              </div>
           </div>
        </div>
      </div>
    </div>
  );
}

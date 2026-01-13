'use client';

import { useState, useEffect } from 'react';
import { getSystemUpdates } from '@/app/actions/system';
import { logger } from '@/lib/logger';
import { RefreshCw, Cpu, HardDrive, Network, Server, Package, Copy, Check, Info } from 'lucide-react';
import { useToast } from '@/providers/ToastProvider';
import { useDigitalTwin } from '@/hooks/useDigitalTwin'; // Migrated from useCache
import { useSocket } from '@/hooks/useSocket';
import PluginLoading from '@/components/PluginLoading';
import PageHeader from '@/components/PageHeader';
import LogViewer from '@/components/LogViewer';
import AgentHealthMonitor from '@/components/AgentHealthMonitor';
import { getNodes } from '@/app/actions/nodes';
import { PodmanConnection } from '@/lib/nodes';

interface UpdateInfo {
    count: number;
    list: string[];
}

/**
 * SystemInfoPlugin
 * Displays system resources (CPU, RAM, Disk), Network interfaces, and pending OS updates.
 * Supports switching between Local and Remote nodes.
 */
export default function SystemInfoPlugin() {
  const [copied, setCopied] = useState(false);
  const [nodes, setNodes] = useState<PodmanConnection[]>([]);
  const [selectedNode, setSelectedNode] = useState<string>('Local');
  const [updates, setUpdates] = useState<UpdateInfo | null>(null);
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  const [activeTab, setActiveTab] = useState<'resources' | 'logs' | 'health'>('resources');
  const { addToast } = useToast();

  const { data: twin } = useDigitalTwin();
  const { socket } = useSocket();

  // High Frequency Monitoring Subscription
  useEffect(() => {
    if (!socket || !selectedNode) return;
    
    // Request High-Frequency Resource Mode from Agent
    socket.emit('monitor:resources:start', { node: selectedNode });
    
    return () => {
        socket.emit('monitor:resources:stop', { node: selectedNode });
    };
  }, [socket, selectedNode]);

  // Load available nodes
  useEffect(() => {
    getNodes().then(nodeList => {
        setNodes(nodeList);
        const saved = localStorage.getItem('podcli-selected-node');
        if (saved) {
            if (saved === 'Local' || nodeList.find(n => n.Name === saved)) {
                setSelectedNode(saved);
            } else {
                setSelectedNode('Local');
            }
        }
    }).catch(e => logger.error('SystemInfoPlugin', 'Failed to fetch nodes', e));
  }, []);

  // Fetch updates separately
  useEffect(() => {
      let mounted = true;
      const loadUpdates = async () => {
          setCheckingUpdates(true);
          try {
            const up = await getSystemUpdates(selectedNode);
            if (mounted) setUpdates(up);
          } catch (e) {
              logger.error('SystemInfoPlugin', 'Failed to check updates', e);
          } finally {
              if (mounted) setCheckingUpdates(false);
          }
      };
      loadUpdates();
      return () => { mounted = false; };
  }, [selectedNode]);

  const handleCopyCommand = () => {
    navigator.clipboard.writeText('sudo apt update && sudo apt upgrade -y');
    setCopied(true);
    addToast('success', 'Copied to clipboard', 'Update command copied.');
    setTimeout(() => setCopied(false), 2000);
  };

  // Get resources from Twin
  const resources = twin?.nodes?.[selectedNode]?.resources;
  
  if (!resources || !resources.os) {
      return (
        <div className="h-full flex flex-col">
            <PageHeader title="System Information" showBack={false} />
            <PluginLoading 
                message="Waiting for agent report..." 
                subMessage={selectedNode !== 'Local' ? `Waiting for data from ${selectedNode}` : undefined} 
            />
        </div>
      );
  }

  const { cpuUsage, memoryUsage, totalMemory, os, disks, network, cpu } = resources;
  
  const formatBytes = (bytes: number) => {
      if (bytes === 0) return '0 B';
      const k = 1024;
      const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
      const i = Math.floor(Math.log(bytes) / Math.log(k));
      return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  return (
    <div className="h-full flex flex-col overflow-y-auto">
      <PageHeader 
        title="System Information" 
        showBack={false} 
        helpId="system-info"
        actions={
            <div className="flex items-center gap-2">
                <div className="flex items-center gap-2 mr-2">
                    <Server size={16} className="text-gray-500" />
                    <select 
                        value={selectedNode} 
                        onChange={(e) => {
                            const val = e.target.value;
                            setSelectedNode(val);
                            localStorage.setItem('podcli-selected-node', val);
                        }}
                        className="bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded px-2 py-1 text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                    >
                        <option value="Local">Local (Default)</option>
                        {nodes.map(node => (
                            <option key={node.Name} value={node.Name}>{node.Name}</option>
                        ))}
                    </select>
                </div>
            </div>
        }
      />
      
      <div className="p-6 space-y-6">
        {/* OS Overview */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="bg-white dark:bg-gray-800 p-4 rounded-lg shadow-sm border border-gray-100 dark:border-gray-700">
                <div className="flex items-center gap-2 mb-2 text-gray-500">
                    <Server size={18} />
                    <span className="text-sm font-medium">Hostname</span>
                </div>
                <div className="text-lg font-semibold truncate" title={os.hostname}>{os.hostname}</div>
                <div className="text-xs text-gray-400">Node ID: {selectedNode}</div>
            </div>
            
            <div className="bg-white dark:bg-gray-800 p-4 rounded-lg shadow-sm border border-gray-100 dark:border-gray-700">
                <div className="flex items-center gap-2 mb-2 text-gray-500">
                    <Info size={18} />
                    <span className="text-sm font-medium">OS / Kernel</span>
                </div>
                <div className="text-lg font-semibold truncate" title={os.platform}>{os.platform}</div>
                <div className="text-xs text-gray-400">Arch: {os.arch}</div>
            </div>

            <div className="bg-white dark:bg-gray-800 p-4 rounded-lg shadow-sm border border-gray-100 dark:border-gray-700">
                <div className="flex items-center gap-2 mb-2 text-gray-500">
                    <RefreshCw size={18} />
                    <span className="text-sm font-medium">Uptime</span>
                </div>
                <div className="text-lg font-semibold">{(os.uptime / 3600).toFixed(1)} hrs</div>
                <div className="text-xs text-gray-400">Total running time</div>
            </div>

             <div className="bg-white dark:bg-gray-800 p-4 rounded-lg shadow-sm border border-gray-100 dark:border-gray-700">
                <div className="flex items-center gap-2 mb-2 text-gray-500">
                    <Package size={18} />
                    <span className="text-sm font-medium">Pending Updates</span>
                </div>
                <div className="flex items-center justify-between">
                    <div>
                        {checkingUpdates ? (
                            <div className="text-sm animate-pulse">Checking...</div>
                        ) : (
                            <div className={`text-lg font-semibold ${updates && updates.count > 0 ? 'text-yellow-600' : 'text-green-600'}`}>
                                {updates ? updates.count : 0}
                            </div>
                        )}
                        <div className="text-xs text-gray-400">System packages</div>
                    </div>
                     {updates && updates.count > 0 && (
                        <button 
                            onClick={handleCopyCommand}
                            className="p-1.5 hover:bg-gray-100 dark:hover:bg-gray-700 rounded transition"
                            title="Copy update command"
                        >
                            {copied ? <Check size={16} className="text-green-500"/> : <Copy size={16}/>}
                        </button>
                    )}
                </div>
            </div>
        </div>

        {/* Tab Navigation */}
        <div className="flex gap-2 border-b border-gray-200 dark:border-gray-700">
          <button
            onClick={() => setActiveTab('resources')}
            className={`px-4 py-2 font-medium text-sm transition-colors border-b-2 ${
              activeTab === 'resources'
                ? 'border-blue-600 text-blue-600 dark:text-blue-400'
                : 'border-transparent text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200'
            }`}
          >
            Resources
          </button>
          <button
            onClick={() => setActiveTab('health')}
            className={`px-4 py-2 font-medium text-sm transition-colors border-b-2 ${
              activeTab === 'health'
                ? 'border-blue-600 text-blue-600 dark:text-blue-400'
                : 'border-transparent text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200'
            }`}
          >
            Agent Health
          </button>
          <button
            onClick={() => setActiveTab('logs')}
            className={`px-4 py-2 font-medium text-sm transition-colors border-b-2 ${
              activeTab === 'logs'
                ? 'border-blue-600 text-blue-600 dark:text-blue-400'
                : 'border-transparent text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200'
            }`}
          >
            Logs
          </button>
        </div>

        {/* Resources Tab */}
        {activeTab === 'resources' && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* CPU & Memory */}
            <div className="bg-white dark:bg-gray-800 p-5 rounded-lg shadow-sm border border-gray-100 dark:border-gray-700">
                <h3 className="text-lg font-medium mb-4 flex items-center gap-2">
                    <Cpu size={20} /> Compute Resources
                </h3>
                
                <div className="space-y-6">
                    {cpu && (
                        <div className="p-3 bg-gray-50 dark:bg-gray-900 rounded text-sm space-y-2 border border-gray-200 dark:border-gray-700">
                             <div className="flex justify-between items-start gap-2">
                                <span className="text-gray-500 whitespace-nowrap">Model</span>
                                <span className="font-medium text-right break-words" title={cpu.model}>{cpu.model}</span>
                             </div>
                             <div className="flex justify-between">
                                <span className="text-gray-500">Cores</span>
                                <span className="font-medium">{cpu.cores}</span>
                             </div>
                        </div>
                    )}
                    <div>
                        <div className="flex justify-between mb-1 text-sm">
                            <span>CPU Usage</span>
                            <span className="font-medium">{cpuUsage}%</span>
                        </div>
                        <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2.5">
                            <div className="bg-blue-600 h-2.5 rounded-full transition-all duration-500" style={{ width: `${Math.min(cpuUsage, 100)}%` }}></div>
                        </div>
                    </div>

                    <div>
                        <div className="flex justify-between mb-1 text-sm">
                            <span>Memory Usage</span>
                            <span className="font-medium">{formatBytes(memoryUsage)} / {formatBytes(totalMemory)}</span>
                        </div>
                        <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2.5">
                            <div className="bg-purple-600 h-2.5 rounded-full transition-all duration-500" style={{ width: `${Math.min((memoryUsage / totalMemory) * 100, 100)}%` }}></div>
                        </div>
                    </div>
                </div>
            </div>

            {/* Disk Usage */}
            <div className="bg-white dark:bg-gray-800 p-5 rounded-lg shadow-sm border border-gray-100 dark:border-gray-700">
                <h3 className="text-lg font-medium mb-4 flex items-center gap-2">
                    <HardDrive size={20} /> Storage ({disks?.length || 0} mounts)
                </h3>
                
                <div className="space-y-4 max-h-60 overflow-y-auto pr-2">
                    {disks && disks.map((disk, i) => {
                        const percent = disk.total > 0 ? Math.round((disk.used / disk.total) * 100) : 0;
                        return (
                        <div key={i} className="text-sm">
                            <div className="flex justify-between mb-1">
                                <span className="font-medium truncate max-w-[150px]" title={disk.mountpoint}>{disk.mountpoint}</span>
                                <span className="text-xs text-gray-500">{disk.type}</span>
                            </div>
                            <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2 relative">
                                <div 
                                    className={`absolute left-0 h-2 rounded-full transition-all duration-500 ${percent > 90 ? 'bg-red-500' : 'bg-green-600'}`} 
                                    style={{ width: `${Math.min(percent, 100)}%` }}
                                ></div>
                            </div>
                            <div className="flex justify-between mt-1 text-xs text-gray-400">
                                <span>{formatBytes(disk.used)} used</span>
                                <span>{percent}% of {formatBytes(disk.total)}</span>
                            </div>
                        </div>
                    )})}
                    {(!disks || disks.length === 0) && (
                        <div className="text-center text-gray-400 py-4">No disk information available</div>
                    )}
                </div>
            </div>

            {/* Network Interfaces */}
            <div className="md:col-span-2 bg-white dark:bg-gray-800 p-5 rounded-lg shadow-sm border border-gray-100 dark:border-gray-700">
                <h3 className="text-lg font-medium mb-4 flex items-center gap-2">
                    <Network size={20} /> Network Interfaces
                </h3>
                
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {network && Object.entries(network).map(([ifaceName, addrs]) => (
                        <div key={ifaceName} className="border border-gray-200 dark:border-gray-700 rounded p-3">
                            <div className="font-medium text-sm mb-2 pb-1 border-b border-gray-100 dark:border-gray-800 flex justify-between items-center">
                                <span>{ifaceName}</span>
                                {addrs.some(a => !a.internal) ? 
                                    <span className="text-[10px] bg-blue-100 dark:bg-blue-900 text-blue-800 dark:text-blue-100 px-1.5 py-0.5 rounded">Public</span> : 
                                    <span className="text-[10px] bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 px-1.5 py-0.5 rounded">Local</span>
                                }
                            </div>
                            <div className="space-y-1">
                                {addrs.map((addr, idx) => (
                                    <div key={idx} className="text-xs font-mono break-all flex justify-between gap-2">
                                        <span className={addr.family === 'IPv6' ? 'text-purple-600 dark:text-purple-400' : 'text-emerald-600 dark:text-emerald-400'}>
                                            {addr.address}
                                        </span>
                                        <span className="text-gray-400 shrink-0">{addr.family}</span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    ))}
                    {(!network || Object.keys(network).length === 0) && (
                        <div className="col-span-full text-center text-gray-400 py-4">No network information available</div>
                    )}
                </div>
            </div>
        </div>
        )}

        {/* Health Tab */}
        {activeTab === 'health' && (
          <AgentHealthMonitor refreshInterval={10000} />
        )}

        {/* Logs Tab */}
        {activeTab === 'logs' && (
          <LogViewer />
        )}
      </div>
    </div>
  );
}

'use client';

import { useRef, useState, useEffect } from 'react';
import dynamic from 'next/dynamic';
import PageHeader from '@/components/PageHeader';
import { Eraser, RefreshCw, Server } from 'lucide-react';
import { TerminalRef } from '@/components/Terminal';
import { getNodes } from '@/app/actions/nodes';
import { PodmanConnection } from '@/lib/nodes';

const Terminal = dynamic(() => import('@/components/Terminal'), { 
  ssr: false,
  loading: () => <div className="h-full w-full bg-black animate-pulse" />
});

export default function TerminalPlugin() {
  const terminalRef = useRef<TerminalRef>(null);
  const [nodes, setNodes] = useState<PodmanConnection[]>([]);
  const [selectedNode, setSelectedNode] = useState<string>('host');

  useEffect(() => {
      getNodes().then(setNodes).catch(console.error);
  }, []);

  const handleNodeChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
      setSelectedNode(e.target.value);
      // Give the state a moment to update before reconnecting (though key change might force remount)
  };

  return (
    <div className="h-full flex flex-col">
      <PageHeader 
        title="Terminal" 
        showBack={false} 
        helpId="terminal"
        actions={
            <div className="flex gap-2 items-center">
                <div className="flex items-center gap-2 mr-2">
                    <Server size={16} className="text-gray-500" />
                    <select 
                        value={selectedNode} 
                        onChange={handleNodeChange}
                        className="bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded px-2 py-1 text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                    >
                        <option value="host">Local (Default)</option>
                        {nodes.map(node => (
                            <option key={node.Name} value={`node:${node.Name}`}>{node.Name}</option>
                        ))}
                    </select>
                </div>
                <button 
                    onClick={() => terminalRef.current?.clear()}
                    className="p-2 text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded hover:bg-gray-50 dark:hover:bg-gray-700 shadow-sm transition-colors" 
                    title="Clear Terminal"
                >
                    <Eraser size={18} />
                </button>
                <button 
                    onClick={() => terminalRef.current?.reconnect()}
                    className="p-2 text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded hover:bg-gray-50 dark:hover:bg-gray-700 shadow-sm transition-colors" 
                    title="Reconnect"
                >
                    <RefreshCw size={18} />
                </button>
            </div>
        }
      />
      <div className="flex-1 min-h-0">
        <Terminal 
            key={selectedNode} // Force remount on node change to ensure clean connection
            id={selectedNode} 
            ref={terminalRef} 
            showControls={false} 
        />
      </div>
    </div>
  );
}

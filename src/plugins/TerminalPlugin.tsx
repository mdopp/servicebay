'use client';

import { useRef, useState, useEffect } from 'react';
import dynamic from 'next/dynamic';
import PageHeader from '@/components/PageHeader';
import { Eraser, RefreshCw } from 'lucide-react';
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
     // Restore saved selection - this is intentional setState in effect for hydration
     const saved = localStorage.getItem('podcli-selected-node');
     if (saved) {
         if (saved === 'Local') {
             // eslint-disable-next-line react-hooks/set-state-in-effect
             setSelectedNode('host');
         } else {
              
             setSelectedNode(`node:${saved}`);
         }
     }
     
     getNodes().then(setNodes).catch(console.error);
  }, []);

  const handleNodeChange = (newVal: string) => {
      setSelectedNode(newVal);
      
      // Save selection
      const rawName = newVal === 'host' ? 'Local' : newVal.replace(/^node:/, '');
      localStorage.setItem('podcli-selected-node', rawName);
  };

  return (
    <div className="h-full flex flex-col">
      <PageHeader 
        title="Terminal" 
        showBack={false} 
        helpId="terminal"
        actions={
            <div className="flex gap-2 items-center">
                <div className="flex bg-gray-100 dark:bg-gray-800 p-1 rounded-lg mr-2">
                    <button
                        onClick={() => handleNodeChange('host')}
                        suppressHydrationWarning
                        className={`px-3 py-1 text-sm rounded-md transition-all ${
                            selectedNode === 'host'
                                ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 shadow-sm font-medium'
                                : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200'
                        }`}
                    >
                        Local
                    </button>
                    {nodes.map(node => (
                        <button
                            key={node.Name}
                            onClick={() => handleNodeChange(`node:${node.Name}`)}
                            className={`px-3 py-1 text-sm rounded-md transition-all ${
                                selectedNode === `node:${node.Name}`
                                    ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 shadow-sm font-medium'
                                    : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200'
                            }`}
                        >
                            {node.Name}
                        </button>
                    ))}
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

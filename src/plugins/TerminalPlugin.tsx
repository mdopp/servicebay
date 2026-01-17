'use client';

import { useRef, useState, useEffect, useMemo, useCallback, startTransition } from 'react';
import dynamic from 'next/dynamic';
import PageHeader from '@/components/PageHeader';
import { Eraser, RefreshCw, Server, Monitor } from 'lucide-react';
import { TerminalRef } from '@/components/Terminal';
import { getNodes } from '@/app/actions/nodes';
import { PodmanConnection } from '@/lib/nodes';
import { Select, SelectOption } from '@/components/Select';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

const Terminal = dynamic(() => import('@/components/Terminal'), { 
  ssr: false,
  loading: () => <div className="h-full w-full bg-black animate-pulse" />
});

export default function TerminalPlugin() {
  const terminalRef = useRef<TerminalRef>(null);
  const [nodes, setNodes] = useState<PodmanConnection[]>([]);
    const [selectedNode, setSelectedNode] = useState<string>('Local');
    const router = useRouter();
    const pathname = usePathname() || '';
    const searchParams = useSearchParams();
    const nodeParam = searchParams?.get('node') ?? null;
    const queryString = searchParams?.toString() ?? '';
    const storageHydrated = useRef(false);

    const updateNodeQuery = useCallback((nextNode: string) => {
        const normalized = nextNode === 'Local' ? null : nextNode;
        if ((normalized && normalized === nodeParam) || (!normalized && !nodeParam)) return;
        const params = new URLSearchParams(queryString);
        if (normalized) {
            params.set('node', normalized);
        } else {
            params.delete('node');
        }
        const qs = params.toString();
        const url = qs ? `${pathname}?${qs}` : pathname;
        router.replace(url, { scroll: false });
    }, [nodeParam, pathname, queryString, router]);

  useEffect(() => {
        getNodes().then(setNodes).catch(console.error);
    }, []);

    useEffect(() => {
        if (nodeParam) {
            if (nodeParam !== selectedNode) {
                startTransition(() => setSelectedNode(nodeParam));
                if (typeof window !== 'undefined') {
                    window.localStorage.setItem('podcli-selected-node', nodeParam);
                }
            }
            storageHydrated.current = true;
            return;
        }

        if (!storageHydrated.current) {
            storageHydrated.current = true;
            if (typeof window !== 'undefined') {
                const stored = window.localStorage.getItem('podcli-selected-node');
                if (stored) {
                    startTransition(() => setSelectedNode(stored));
                    window.localStorage.setItem('podcli-selected-node', stored);
                    updateNodeQuery(stored);
                    return;
                }
            }
            startTransition(() => setSelectedNode('Local'));
            return;
        }

        if (selectedNode !== 'Local') {
            startTransition(() => setSelectedNode('Local'));
            if (typeof window !== 'undefined') {
                window.localStorage.setItem('podcli-selected-node', 'Local');
            }
        }
    }, [nodeParam, selectedNode, updateNodeQuery]);

    const handleNodeChange = (value: string) => {
        setSelectedNode(value);
        if (typeof window !== 'undefined') {
            window.localStorage.setItem('podcli-selected-node', value);
        }
        updateNodeQuery(value);
    };

    const nodeOptions = useMemo<SelectOption[]>(() => {
        const remote = nodes.map(node => ({
            label: node.Name,
            value: node.Name,
            description: node.URI,
            icon: <Server size={16} className="text-blue-600 dark:text-blue-300" />
        }));
        return [
            {
                label: 'Local',
                value: 'Local',
                description: 'This ServiceBay host',
                icon: <Monitor size={16} className="text-indigo-600 dark:text-indigo-300" />
            },
            ...remote
        ];
    }, [nodes]);

    const terminalTarget = selectedNode === 'Local' ? 'host' : `node:${selectedNode}`;

  return (
    <div className="h-full flex flex-col">
      <PageHeader 
        title="Terminal" 
        showBack={false} 
        helpId="terminal"
                actions={
                    <div className="flex gap-2 items-center">
                        <Select
                            options={nodeOptions}
                            value={selectedNode}
                            onChange={handleNodeChange}
                            placeholder="Select node"
                            className="min-w-[240px]"
                        />
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
                        key={terminalTarget} // Force remount on node change to ensure clean connection
                        id={terminalTarget} 
            ref={terminalRef} 
            showControls={false} 
        />
      </div>
    </div>
  );
}

'use client';

import { useState, useEffect, useRef, use } from 'react';
import { useRouter } from 'next/navigation';
import dynamic from 'next/dynamic';
import { Terminal as TerminalIcon, ArrowLeft, Eraser, RefreshCw } from 'lucide-react';
import type { TerminalRef } from '@/components/Terminal';

const Terminal = dynamic(() => import('@/components/Terminal'), { 
  ssr: false,
  loading: () => <div className="h-full w-full bg-black flex items-center justify-center text-gray-500">Loading Terminal...</div>
});

interface Container {
  Id: string;
  Names: string[];
}

export default function ContainerTerminalPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const [container, setContainer] = useState<Container | null>(null);
  const [loading, setLoading] = useState(true);
  const terminalRef = useRef<TerminalRef>(null);

  useEffect(() => {
    const fetchContainer = async () => {
      setLoading(true);
      try {
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
      } catch (error) {
        console.error('Failed to fetch data', error);
      } finally {
        setLoading(false);
      }
    };

    fetchContainer();
  }, [id]);

  if (loading) {
    return <div className="flex items-center justify-center h-screen text-gray-500 bg-gray-900">Loading...</div>;
  }

  if (!container) {
    return <div className="flex items-center justify-center h-screen text-gray-500 bg-gray-900">Container not found</div>;
  }

  return (
    <div className="h-full flex flex-col bg-gray-900">
        <div className="flex justify-between items-center p-4 border-b border-gray-800 bg-gray-900">
            <div className="flex items-center gap-4">
                <button onClick={() => router.back()} className="text-gray-400 hover:text-white flex items-center gap-1 text-sm font-medium">
                    <ArrowLeft size={18} />
                    Back
                </button>
                <h3 className="text-xl font-bold flex items-center gap-2 text-white">
                    <TerminalIcon size={20} />
                    Terminal: {container.Names[0].replace(/^\//, '')}
                </h3>
            </div>
            <div className="flex items-center gap-2">
                <button 
                    onClick={() => terminalRef.current?.clear()}
                    className="p-1.5 text-gray-400 hover:text-white hover:bg-gray-800 rounded transition-colors" 
                    title="Clear Terminal"
                >
                    <Eraser size={18} />
                </button>
                <button 
                    onClick={() => terminalRef.current?.reconnect()}
                    className="p-1.5 text-gray-400 hover:text-white hover:bg-gray-800 rounded transition-colors" 
                    title="Reconnect"
                >
                    <RefreshCw size={18} />
                </button>
            </div>
        </div>
        <div className="flex-1 overflow-hidden bg-gray-900">
            <Terminal 
                ref={terminalRef}
                id={`container:${container.Id}`} 
                showControls={false} 
            />
        </div>
    </div>
  );
}

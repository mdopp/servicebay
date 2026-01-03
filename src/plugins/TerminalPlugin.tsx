'use client';

import { useRef } from 'react';
import dynamic from 'next/dynamic';
import PageHeader from '@/components/PageHeader';
import { Eraser, RefreshCw } from 'lucide-react';
import { TerminalRef } from '@/components/Terminal';

const Terminal = dynamic(() => import('@/components/Terminal'), { 
  ssr: false,
  loading: () => <div className="h-full w-full bg-black animate-pulse" />
});

export default function TerminalPlugin() {
  const terminalRef = useRef<TerminalRef>(null);

  return (
    <div className="h-full flex flex-col">
      <PageHeader 
        title="Terminal" 
        showBack={false} 
        helpId="terminal"
        actions={
            <div className="flex gap-2">
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
        <Terminal id="host" ref={terminalRef} showControls={false} />
      </div>
    </div>
  );
}

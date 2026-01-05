
import { useState, useEffect, useRef } from 'react';
import { X, Loader2 } from 'lucide-react';
import type { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';

interface ActionProgressModalProps {
  isOpen: boolean;
  onClose: () => void;
  serviceName: string;
  nodeName?: string;
  action: 'start' | 'stop' | 'restart';
  onComplete: () => void;
}

export default function ActionProgressModal({ isOpen, onClose, serviceName, nodeName, action, onComplete }: ActionProgressModalProps) {
  const [status, setStatus] = useState<'running' | 'completed' | 'error'>('running');
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (isOpen && terminalRef.current) {
      let term: Terminal | null = null;
      let handleResize: (() => void) | null = null;
      const controller = new AbortController();
      abortControllerRef.current = controller;

      const initTerminal = async () => {
          const { Terminal } = await import('@xterm/xterm');
          const { FitAddon } = await import('@xterm/addon-fit');

          term = new Terminal({
            cursorBlink: true,
            theme: {
              background: '#1e1e1e',
              foreground: '#f3f4f6',
            },
            fontFamily: 'Menlo, Monaco, "Courier New", monospace',
            fontSize: 12,
            convertEol: true, // Convert \n to \r\n
          });
          
          const fitAddon = new FitAddon();
          term.loadAddon(fitAddon);
          
          if (terminalRef.current) {
              term.open(terminalRef.current);
              fitAddon.fit();
              xtermRef.current = term;

              setStatus('running');
              startAction(controller.signal, term);
              
              handleResize = () => fitAddon.fit();
              window.addEventListener('resize', handleResize);
          }
      };

      initTerminal();

      return () => {
          controller.abort();
          if (handleResize) window.removeEventListener('resize', handleResize);
          if (term) term.dispose();
          xtermRef.current = null;
      };
    }
  }, [isOpen]);

  const startAction = async (signal: AbortSignal, term: Terminal) => {
    try {
      const query = nodeName && nodeName !== 'Local' ? `?node=${nodeName}` : '';
      const response = await fetch(`/api/services/${serviceName}/action-stream${query}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
        signal
      });

      if (!response.body) {
        throw new Error('No response body');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        const chunk = decoder.decode(value, { stream: true });
        term.write(chunk);
      }
      
      setStatus('completed');
      onComplete();

    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
          console.log('Action aborted');
          return;
      }
      console.error('Action failed', error);
      setStatus('error');
      term.write(`\r\n\x1b[31mError: ${error instanceof Error ? error.message : String(error)}\x1b[0m\r\n`);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-white dark:bg-gray-900 rounded-lg shadow-xl w-full max-w-3xl border border-gray-200 dark:border-gray-800 flex flex-col h-[600px]">
        <div className="flex justify-between items-center p-4 border-b border-gray-200 dark:border-gray-800">
          <h3 className="text-lg font-bold flex items-center gap-2">
            {status === 'running' && <Loader2 className="animate-spin text-blue-500" size={20} />}
            {status === 'completed' && <span className="text-green-500">✓</span>}
            {status === 'error' && <span className="text-red-500">✗</span>}
            {action === 'start' && 'Starting'}
            {action === 'stop' && 'Stopping'}
            {action === 'restart' && 'Restarting'} {serviceName}
          </h3>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-700 dark:hover:text-gray-300">
            <X size={20} />
          </button>
        </div>
        
        <div className="p-4 bg-[#1e1e1e] border-b border-gray-800">
          <div className="p-3 bg-blue-900/20 border border-blue-900/50 rounded text-blue-200 text-xs">
             <p>Note: This operation may take several minutes. Please do not close this window.</p>
          </div>
        </div>

        <div className="flex-1 bg-[#1e1e1e] p-4 overflow-hidden">
            <div ref={terminalRef} className="h-full w-full" />
        </div>

        {(status === 'completed' || status === 'error') && (
            <div className="p-4 border-t border-gray-200 dark:border-gray-800 flex justify-end bg-gray-50 dark:bg-gray-900/50">
                <button 
                    onClick={onClose}
                    className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-md font-medium transition-colors"
                >
                    Done
                </button>
            </div>
        )}
      </div>
    </div>
  );
}

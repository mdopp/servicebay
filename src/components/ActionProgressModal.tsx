
import { useState, useEffect, useRef, useCallback } from 'react';
import { X, Loader2, Minimize2 } from 'lucide-react';
import type { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useToast } from '@/providers/ToastProvider';
import { humanizeError } from '@/lib/util/humanizeError';

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
  const [elapsed, setElapsed] = useState(0);
  const [minimized, setMinimized] = useState(false);
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const onCompleteRef = useRef(onComplete);
  const { addToast, updateToast, removeToast } = useToast();
  const bgToastIdRef = useRef<string | null>(null);

  useEffect(() => {
    onCompleteRef.current = onComplete;
  }, [onComplete]);

  // When closed, reset minimized so reopening starts fresh.
  useEffect(() => {
    if (!isOpen) setMinimized(false);
  }, [isOpen]);

  // While minimized, surface a sticky background toast that swaps to
  // success/error when the action finishes.
  useEffect(() => {
    if (!minimized || !isOpen) return;
    if (status === 'running') {
      if (!bgToastIdRef.current) {
        bgToastIdRef.current = addToast(
          'loading',
          `${action === 'start' ? 'Starting' : action === 'stop' ? 'Stopping' : 'Restarting'} ${serviceName}`,
          'Running in background…',
          0,
        );
      }
    } else if (bgToastIdRef.current) {
      const verb = status === 'completed'
        ? (action === 'start' ? 'started' : action === 'stop' ? 'stopped' : 'restarted')
        : `${action} failed`;
      updateToast(
        bgToastIdRef.current,
        status === 'completed' ? 'success' : 'error',
        `${serviceName} ${verb}`,
        '',
        5000,
      );
      bgToastIdRef.current = null;
    }
  }, [minimized, isOpen, status, action, serviceName, addToast, updateToast]);

  // Clean up the background toast if the parent closes us with one still pending.
  useEffect(() => {
    return () => {
      if (bgToastIdRef.current) {
        removeToast(bgToastIdRef.current);
        bgToastIdRef.current = null;
      }
    };
  }, [removeToast]);

  useEffect(() => {
    if (!isOpen || status !== 'running') return;
    const start = Date.now();
    const interval = setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(interval);
  }, [isOpen, status]);

  const startAction = useCallback(async (signal: AbortSignal, term: Terminal) => {
    try {
      const query = nodeName && nodeName !== 'Local' ? `?node=${nodeName}` : '';
      const response = await fetch(`/api/services/${serviceName}/action-stream${query}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
        signal
      });

      if (!response.body) {
        term.writeln('\r\n\x1b[31;1mError: No response body\x1b[0m');
        setStatus('error');
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        term.write(decoder.decode(value));
      }
      
      term.writeln('\r\n\x1b[32;1mProcess exited.\x1b[0m');
      // If we got here, we assume success or at least completion of stream
      setStatus('completed');
      if (onCompleteRef.current) {
        // Slight delay so logs are readable before closing
        setTimeout(onCompleteRef.current, 1000);
      }
    } catch (err: unknown) {
       if (signal.aborted) {
           return;
       }
       const { detail } = humanizeError(err, 'Connection error');
       term.writeln(`\r\n\x1b[31;1mConnection Error: ${detail}\x1b[0m`);
       setStatus('error');
    }
  }, [action, nodeName, serviceName]);

  useEffect(() => {
    const terminalElement = terminalRef.current;
    if (isOpen && terminalElement) {
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
          
            if (terminalElement) {
              terminalElement.innerHTML = '';
              term.open(terminalElement);
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
          if (terminalElement) {
            terminalElement.innerHTML = '';
          }
          xtermRef.current = null;
      };
    }
  }, [isOpen, startAction]);

  if (!isOpen || minimized) return null;

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
            {status === 'running' && elapsed > 0 && (
                <span className="text-sm font-normal text-gray-400 ml-2">
                    {elapsed >= 60 ? `${Math.floor(elapsed / 60)}m ${elapsed % 60}s` : `${elapsed}s`}
                </span>
            )}
          </h3>
          <div className="flex items-center gap-1">
            {status === 'running' && (
              <button
                onClick={() => setMinimized(true)}
                className="text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 p-1 rounded transition-colors"
                title="Run in background"
                aria-label="Run in background"
              >
                <Minimize2 size={18} />
              </button>
            )}
            <button
              onClick={() => {
                // While the action is still running, treat the X like
                // "Run in background" — closing this modal aborts the
                // SSE stream and breaks completion notification, even
                // though the host-side systemctl operation keeps going
                // (#725). Surface the same toast affordance instead.
                if (status === 'running') {
                  setMinimized(true);
                } else {
                  onClose();
                }
              }}
              className="text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 p-1 rounded transition-colors"
              aria-label={status === 'running' ? 'Run in background' : 'Close'}
              title={status === 'running' ? 'Run in background' : 'Close'}
            >
              <X size={20} />
            </button>
          </div>
        </div>
        
        <div className="p-4 bg-[#1e1e1e] border-b border-gray-800">
          <div className="p-3 bg-blue-900/20 border border-blue-900/50 rounded text-blue-200 text-xs">
             <p>Operation in progress. You can safely minimize this window to keep working &mdash; we&apos;ll notify you when it finishes. Closing this modal keeps the task running in the background.</p>
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

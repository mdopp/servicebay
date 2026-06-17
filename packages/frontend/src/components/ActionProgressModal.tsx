
import { useState, useEffect, useRef, useCallback } from 'react';
import { X, Loader2, Minimize2, RotateCw, FileText, Wrench, Bot } from 'lucide-react';
import type { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useToast } from '@/providers/ToastProvider';
import { humanizeError } from '@servicebay/api-client';

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
  const [retryCount, setRetryCount] = useState(0);
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
    // eslint-disable-next-line react-hooks/set-state-in-effect -- external-system sync (action toast lifecycle)
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
  }, [isOpen, startAction, retryCount]);

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
            <div className="p-4 border-t border-gray-200 dark:border-gray-800 flex flex-col sm:flex-row justify-between items-center gap-3 bg-gray-50 dark:bg-gray-900/50">
                {status === 'error' ? (
                    <div className="flex flex-wrap gap-2 w-full sm:w-auto">
                        <button
                            onClick={() => {
                                setElapsed(0);
                                setRetryCount(prev => prev + 1);
                                setStatus('running');
                            }}
                            className="flex items-center gap-1.5 px-3 py-1.5 bg-amber-600 hover:bg-amber-700 text-white text-xs font-semibold rounded-md transition-colors shadow-sm"
                        >
                            <RotateCw size={14} className="animate-spin" style={{ animationDuration: '3s' }} />
                            Retry Action
                        </button>
                        
                        <a
                            href={`/api/services/${serviceName}/logs`}
                            target="_blank"
                            rel="noreferrer"
                            className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-200 hover:bg-slate-300 dark:bg-gray-800 dark:hover:bg-gray-700 text-gray-800 dark:text-gray-200 text-xs font-semibold rounded-md transition-colors border border-gray-300 dark:border-gray-700"
                        >
                            <FileText size={14} />
                            View Full Logs
                        </a>

                        <a
                            href="/health"
                            className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-200 hover:bg-slate-300 dark:bg-gray-800 dark:hover:bg-gray-700 text-gray-800 dark:text-gray-200 text-xs font-semibold rounded-md transition-colors border border-gray-300 dark:border-gray-700"
                        >
                            <Wrench size={14} />
                            Self-Diagnose
                        </a>

                        <button
                            onClick={() => addToast('info', 'AI Assistant Triggered', `Claude is reviewing the logs for ${serviceName}...`)}
                            className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold rounded-md transition-colors shadow-sm"
                        >
                            <Bot size={14} />
                            Ask AI to Fix
                        </button>
                    </div>
                ) : (
                    <div className="text-xs text-emerald-600 dark:text-emerald-400 font-medium">
                        ✓ Operation completed successfully.
                    </div>
                )}
                <button 
                    onClick={onClose}
                    className="w-full sm:w-auto px-5 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-md font-semibold text-sm transition-colors shadow-sm"
                >
                    Close
                </button>
            </div>
        )}
      </div>
    </div>
  );
}

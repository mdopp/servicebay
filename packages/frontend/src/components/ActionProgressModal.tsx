
import { useState, useEffect, useRef, useCallback } from 'react';
import { X, Loader2, Minimize2, RotateCw, FileText, Wrench, Bot } from 'lucide-react';
import type { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useToast } from '@/providers/ToastProvider';
import { humanizeError } from '@servicebay/api-client';
import { Button } from '@/components/ui';

// xterm terminal theme colors — dark background with light foreground for
// contrast and readability. Not mapped to semantic tokens as these define
// the terminal UI appearance (distinct from the modal's surface colors).
// eslint-disable-next-line sb/no-raw-color-literal -- terminal-specific colors required for xterm theme
const XTERM_THEME_BACKGROUND = '#1e1e1e';
// eslint-disable-next-line sb/no-raw-color-literal -- terminal-specific colors required for xterm theme
const XTERM_THEME_FOREGROUND = '#f3f4f6';

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
              background: XTERM_THEME_BACKGROUND,
              foreground: XTERM_THEME_FOREGROUND,
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
      <div className="bg-surface rounded-lg shadow-xl w-full max-w-3xl border border-border flex flex-col h-[600px]">
        <div className="flex justify-between items-center p-4 border-b border-border">
          <h3 className="text-lg font-bold flex items-center gap-2">
            {status === 'running' && <Loader2 className="animate-spin text-status-info" size={20} />}
            {status === 'completed' && <span className="text-status-ok">✓</span>}
            {status === 'error' && <span className="text-status-fail">✗</span>}
            {action === 'start' && 'Starting'}
            {action === 'stop' && 'Stopping'}
            {action === 'restart' && 'Restarting'} {serviceName}
            {status === 'running' && elapsed > 0 && (
                <span className="text-sm font-normal text-text-muted ml-2">
                    {elapsed >= 60 ? `${Math.floor(elapsed / 60)}m ${elapsed % 60}s` : `${elapsed}s`}
                </span>
            )}
          </h3>
          <div className="flex items-center gap-1">
            {status === 'running' && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setMinimized(true)}
                title="Run in background"
                aria-label="Run in background"
              >
                <Minimize2 size={18} />
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
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
              aria-label={status === 'running' ? 'Run in background' : 'Close'}
              title={status === 'running' ? 'Run in background' : 'Close'}
            >
              <X size={20} />
            </Button>
          </div>
        </div>
        
        {/* eslint-disable-next-line sb/no-raw-color-literal -- terminal background needs to match xterm theme */}
        <div className="p-4 bg-[#1e1e1e] border-b border-border">
          <div className="p-3 bg-status-info/10 border border-status-info/20 rounded text-status-info text-xs">
             <p>Operation in progress. You can safely minimize this window to keep working &mdash; we&apos;ll notify you when it finishes. Closing this modal keeps the task running in the background.</p>
          </div>
        </div>

        {/* eslint-disable-next-line sb/no-raw-color-literal -- terminal background needs to match xterm theme */}
        <div className="flex-1 bg-[#1e1e1e] p-4 overflow-hidden">
            <div ref={terminalRef} className="h-full w-full" />
        </div>

        {(status === 'completed' || status === 'error') && (
            <div className="p-4 border-t border-border flex flex-col sm:flex-row justify-between items-center gap-3 bg-surface">
                {status === 'error' ? (
                    <div className="flex flex-wrap gap-2 w-full sm:w-auto">
                        <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => {
                                setElapsed(0);
                                setRetryCount(prev => prev + 1);
                                setStatus('running');
                            }}
                            className="bg-status-warn hover:bg-status-warn/90 text-on-accent font-semibold shadow-sm"
                        >
                            <RotateCw size={14} className="animate-spin" style={{ animationDuration: '3s' }} />
                            Retry Action
                        </Button>
                        
                        <a
                            href={`/api/services/${serviceName}/logs`}
                            target="_blank"
                            rel="noreferrer"
                            className="flex items-center gap-1.5 px-3 py-1.5 bg-surface-2 hover:bg-surface-muted text-text text-xs font-semibold rounded-md transition-colors border border-border"
                        >
                            <FileText size={14} />
                            View Full Logs
                        </a>

                        <a
                            href="/status"
                            className="flex items-center gap-1.5 px-3 py-1.5 bg-surface-2 hover:bg-surface-muted text-text text-xs font-semibold rounded-md transition-colors border border-border"
                        >
                            <Wrench size={14} />
                            Self-Diagnose
                        </a>

                        <Button
                            size="sm"
                            variant="primary"
                            onClick={() => addToast('info', 'AI Assistant Triggered', `Claude is reviewing the logs for ${serviceName}...`)}
                            className="bg-status-info hover:bg-status-info/90 font-semibold shadow-sm"
                        >
                            <Bot size={14} />
                            Ask AI to Fix
                        </Button>
                    </div>
                ) : (
                    <div className="text-xs text-status-ok font-medium">
                        ✓ Operation completed successfully.
                    </div>
                )}
                <Button
                    size="md"
                    variant="primary"
                    onClick={onClose}
                    className="w-full sm:w-auto bg-status-info hover:bg-status-info/90 font-semibold shadow-sm"
                >
                    Close
                </Button>
            </div>
        )}
      </div>
    </div>
  );
}

'use client';

import { useEffect, useRef, forwardRef, useImperativeHandle } from 'react';
import { Terminal as XTerm } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import { io, Socket } from 'socket.io-client';
import { Eraser, RefreshCw } from 'lucide-react';
import 'xterm/css/xterm.css';

export interface TerminalRef {
    clear: () => void;
    reconnect: () => void;
}

interface TerminalProps {
    id?: string;
    showControls?: boolean;
}

const Terminal = forwardRef<TerminalRef, TerminalProps>(({ id = 'host', showControls = true }, ref) => {
  const terminalRef = useRef<HTMLDivElement>(null);
  const socketRef = useRef<Socket | null>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);

  const handleClear = () => {
    termRef.current?.clear();
  };

  const handleReconnect = () => {
    if (socketRef.current) {
        socketRef.current.disconnect();
        socketRef.current.connect();
    }
  };

  useImperativeHandle(ref, () => ({
    clear: handleClear,
    reconnect: handleReconnect
  }));

  useEffect(() => {
    // Initialize Socket.io
    const socket = io();
    socketRef.current = socket;

    // Initialize xterm
    const term = new XTerm({
      cursorBlink: true,
      theme: {
        background: '#111827', // gray-900
        foreground: '#f3f4f6', // gray-100
      },
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      fontSize: 14,
    });
    termRef.current = term;

    const fitAddon = new FitAddon();
    fitAddonRef.current = fitAddon;
    term.loadAddon(fitAddon);

    // Custom key handler for Copy (Ctrl+C)
    term.attachCustomKeyEventHandler((arg) => {
        if (arg.ctrlKey && arg.code === 'KeyC' && arg.type === 'keydown') {
            const selection = term.getSelection();
            if (selection) {
                navigator.clipboard.writeText(selection);
                return false; // Prevent default (sending SIGINT)
            }
        }
        return true;
    });

    let initObserver: ResizeObserver | null = null;

    if (terminalRef.current) {
      initObserver = new ResizeObserver((entries) => {
        for (const entry of entries) {
          if (entry.contentRect.width > 0 && entry.contentRect.height > 0) {
            initObserver?.disconnect();
            
            if (terminalRef.current && terminalRef.current.childElementCount === 0) {
              requestAnimationFrame(() => {
                if (!terminalRef.current) return;
                term.open(terminalRef.current);
                try {
                  fitAddon.fit();
                  // Join the specific terminal session
                  socket.emit('join', id);
                  socket.emit('resize', { id, cols: term.cols, rows: term.rows });
                } catch (e) {
                  console.error('Failed to fit terminal:', e);
                }
              });
            }
          }
        }
      });
      initObserver.observe(terminalRef.current);
    }

    // Handle socket events
    socket.on('connect', () => {
        // Re-join on reconnect
        if (termRef.current) {
            socket.emit('join', id);
        }
    });

    socket.on('history', (data: string) => {
        term.clear();
        term.write(data);
    });

    socket.on('output', (data: string) => {
      term.write(data);
    });

    socket.on('disconnect', () => {
      term.write('\r\n\x1b[31mDisconnected from server.\x1b[0m\r\n');
    });

    // Handle terminal input
    term.onData((data) => {
      socket.emit('input', { id, data });
    });

    // Handle resize
    const handleResize = () => {
      if (fitAddonRef.current && termRef.current && socketRef.current) {
        try {
          fitAddonRef.current.fit();
          socketRef.current.emit('resize', { 
            id,
            cols: termRef.current.cols, 
            rows: termRef.current.rows 
          });
        } catch (e) {
          console.error('Resize failed:', e);
        }
      }
    };

    window.addEventListener('resize', handleResize);
    
    const resizeObserver = new ResizeObserver(() => {
        setTimeout(handleResize, 100);
    });
    
    if (terminalRef.current) {
        resizeObserver.observe(terminalRef.current);
    }

    return () => {
      socket.disconnect();
      term.dispose();
      window.removeEventListener('resize', handleResize);
      resizeObserver.disconnect();
      initObserver?.disconnect();
    };
  }, [id]);

  return (
    <div className="h-full flex flex-col bg-gray-900">
      {showControls && (
        <div className="flex justify-between items-center p-4 border-b border-gray-800 bg-gray-900">
            <h2 className="text-xl font-bold text-gray-100 px-2">Terminal {id !== 'host' ? `(${id})` : ''}</h2>
            <div className="flex gap-2">
                <button 
                    onClick={handleClear}
                    className="p-2 text-gray-400 hover:text-white hover:bg-gray-800 rounded transition-colors" 
                    title="Clear Terminal"
                >
                    <Eraser size={20} />
                </button>
                <button 
                    onClick={handleReconnect}
                    className="p-2 text-gray-400 hover:text-white hover:bg-gray-800 rounded transition-colors" 
                    title="Reconnect"
                >
                    <RefreshCw size={20} />
                </button>
            </div>
        </div>
      )}
      <div className="flex-1 relative overflow-hidden p-2" ref={terminalRef} />
    </div>
  );
});

Terminal.displayName = 'Terminal';

export default Terminal;

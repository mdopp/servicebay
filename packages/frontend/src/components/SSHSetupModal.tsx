'use client';

import { useState, useEffect } from 'react';
import { X, Terminal, Loader2, CheckCircle2, AlertCircle } from 'lucide-react';
import { installSSHKey } from '@/app/actions/ssh';

interface SSHSetupModalProps {
  isOpen: boolean;
  onClose: () => void;
  initialHost?: string;
  initialPort?: number;
  initialUser?: string;
}

export default function SSHSetupModal({ isOpen, onClose, initialHost = '', initialPort = 22, initialUser = 'root' }: SSHSetupModalProps) {
  const [host, setHost] = useState(initialHost);
  const [port, setPort] = useState(initialPort);
  const [user, setUser] = useState(initialUser);
  const [password, setPassword] = useState('');
  const [status, setStatus] = useState<'idle' | 'running' | 'success' | 'error'>('idle');
  const [logs, setLogs] = useState<string[]>([]);
  
  // React to prop changes if modal re-opens with new defaults
  useEffect(() => {
    if (isOpen) {
        setHost(initialHost);
        setPort(initialPort);
        setUser(initialUser);
    }
  }, [isOpen, initialHost, initialPort, initialUser]);

  if (!isOpen) return null;

  const handleSetup = async () => {
    setStatus('running');
    setLogs(['Starting SSH key setup...']);
    
    try {
      const res = await installSSHKey(host, port, user, password);
      setLogs(prev => [...prev, ...(res.logs || [])]);
      
      if (res.success) {
        setStatus('success');
        setLogs(prev => [...prev, 'Success! You can now add this node.']);
      } else {
        setStatus('error');
        setLogs(prev => [...prev, 'Setup failed. Check logs above.']);
      }
    } catch (e) {
      setStatus('error');
      setLogs(prev => [...prev, `Error: ${e}`]);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-[60] flex items-center justify-center p-4">
      <div className="bg-surface rounded-xl shadow-2xl max-w-lg w-full border border-border overflow-hidden flex flex-col max-h-[90vh]">
        <div className="p-4 border-b border-border flex items-center justify-between bg-surface-2">
          <h3 className="font-bold text-text flex items-center gap-2">
            <Terminal size={18} />
            Setup SSH Keys
          </h3>
          <button onClick={onClose} className="text-text-muted hover:text-text">
            <X size={20} />
          </button>
        </div>

        <div className="p-6 space-y-4 overflow-y-auto">
          <p className="text-sm text-text-muted">
            This tool will copy the server&apos;s public SSH key to the remote host, enabling password-less authentication required by ServiceBay.
          </p>

          <div className="grid grid-cols-2 gap-4">
            <div className="col-span-2 md:col-span-1">
              <label className="block text-xs font-medium text-text-muted mb-1">Host</label>
              <input
                type="text"
                value={host}
                onChange={e => setHost(e.target.value)}
                className="w-full p-2 rounded border border-border bg-surface-2 text-sm text-text"
                placeholder="192.168.1.x"
                disabled={status === 'running'}
              />
            </div>
            <div className="col-span-2 md:col-span-1">
              <label className="block text-xs font-medium text-text-muted mb-1">Port</label>
              <input
                type="number"
                value={port}
                onChange={e => setPort(parseInt(e.target.value))}
                className="w-full p-2 rounded border border-border bg-surface-2 text-sm text-text"
                placeholder="22"
                disabled={status === 'running'}
              />
            </div>
            <div className="col-span-2 md:col-span-1">
              <label className="block text-xs font-medium text-text-muted mb-1">Username</label>
              <input
                type="text"
                value={user}
                onChange={e => setUser(e.target.value)}
                className="w-full p-2 rounded border border-border bg-surface-2 text-sm text-text"
                placeholder="root"
                disabled={status === 'running'}
              />
            </div>
            <div className="col-span-2 md:col-span-1">
              <label className="block text-xs font-medium text-text-muted mb-1">Password</label>
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                className="w-full p-2 rounded border border-border bg-surface-2 text-sm text-text"
                placeholder="••••••"
                disabled={status === 'running'}
              />
            </div>
          </div>

          {logs.length > 0 && (
            <div className="mt-4 bg-black rounded-lg p-3 font-mono text-xs text-status-ok h-32 overflow-y-auto whitespace-pre-wrap">
              {logs.map((log, i) => (
                <div key={i}>{log}</div>
              ))}
            </div>
          )}
        </div>

        <div className="p-4 border-t border-border bg-surface-2 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-text-muted hover:text-text"
            disabled={status === 'running'}
          >
            Close
          </button>
          <button
            onClick={handleSetup}
            disabled={status === 'running' || !host || !user || !password}
            className={`px-4 py-2 text-sm text-on-accent rounded flex items-center gap-2 transition-colors ${
                status === 'success' ? 'bg-status-ok hover:bg-status-ok/90' :
                status === 'error' ? 'bg-status-fail hover:bg-status-fail/90' :
                'bg-accent hover:bg-accent-strong'
            } disabled:opacity-50 disabled:cursor-not-allowed`}
          >
            {status === 'running' ? <Loader2 className="animate-spin" size={16} /> :
             status === 'success' ? <CheckCircle2 size={16} /> :
             status === 'error' ? <AlertCircle size={16} /> :
             <Terminal size={16} />}
            {status === 'running' ? 'Running...' :
             status === 'success' ? 'Done' :
             status === 'error' ? 'Retry' :
             'Run ssh-copy-id'}
          </button>
        </div>
      </div>
    </div>
  );
}

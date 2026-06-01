'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Download, Loader2, Shield, Upload, X, XCircle } from 'lucide-react';
import { useToast } from '@/providers/ToastProvider';

/**
 * Settings → Networking & Access → Nginx Configuration (#1427).
 *
 * Export / import the reverse-proxy server-block configs from the Nginx
 * Proxy Manager stack. This is reverse-proxy config — it used to live on
 * the Backups tab (an orphan), rehomed here as part of the concern-based
 * Settings IA. Renders only when an NPM stack is detected.
 */
export default function NginxConfigSection() {
  const { addToast } = useToast();
  const [nginxExporting, setNginxExporting] = useState(false);
  const [nginxImporting, setNginxImporting] = useState(false);
  const [nginxNode, setNginxNode] = useState<string | null>(null);
  const [nginxInstalled, setNginxInstalled] = useState(false);
  const nginxFileInputRef = useRef<HTMLInputElement>(null);
  const [nginxDiag, setNginxDiag] = useState<{ reason: string; debug: string[]; node?: string; confDir?: string } | null>(null);
  const [nginxDiagExpanded, setNginxDiagExpanded] = useState(false);

  const checkNginxStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/system/nginx/status');
      const data = await res.json();
      setNginxInstalled(data.installed ?? false);
      if (data.node) setNginxNode(data.node);
    } catch {
      setNginxInstalled(false);
    }
  }, []);

  useEffect(() => { void checkNginxStatus(); }, [checkNginxStatus]);

  const nginxNodeQuery = nginxNode && nginxNode !== 'Local' ? `?node=${encodeURIComponent(nginxNode)}` : '';

  const handleNginxExport = async () => {
    setNginxExporting(true);
    setNginxDiag(null);
    try {
      const res = await fetch(`/api/system/nginx/export${nginxNodeQuery}`);
      if (!res.ok) throw new Error('Export failed');
      const data = await res.json();
      if (!data.files || Object.keys(data.files).length === 0) {
        setNginxDiag({
          reason: data.reason || 'No config files found (unknown reason)',
          debug: data.debug || [],
          node: data.node,
          confDir: data.confDir,
        });
        setNginxDiagExpanded(false);
        return;
      }
      const blob = new Blob([JSON.stringify(data.files, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `nginx-config-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      addToast('success', `Exported ${Object.keys(data.files).length} config file(s)`);
    } catch {
      addToast('error', 'Failed to export nginx config');
    } finally {
      setNginxExporting(false);
    }
  };

  const handleNginxImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setNginxImporting(true);
    setNginxDiag(null);
    try {
      const isBackup = file.name.endsWith('.tar.gz') || file.name.endsWith('.tgz');
      let res: Response;

      if (isBackup) {
        const formData = new FormData();
        formData.append('file', file);
        res = await fetch(`/api/system/nginx/import${nginxNodeQuery}`, { method: 'POST', body: formData });
      } else {
        const text = await file.text();
        const files = JSON.parse(text);
        if (typeof files !== 'object' || Array.isArray(files)) {
          throw new Error('Invalid format');
        }
        res = await fetch(`/api/system/nginx/import${nginxNodeQuery}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ files }),
        });
      }

      const data = await res.json();
      if (!res.ok) {
        setNginxDiag({
          reason: data.error || 'Import failed (unknown error)',
          debug: data.debug || [],
          node: data.node,
        });
        setNginxDiagExpanded(false);
        return;
      }
      addToast('success', `Imported ${data.imported?.length || 0} config file(s)`);
    } catch {
      setNginxDiag({
        reason: 'Failed to parse the uploaded file. Expected a JSON export file ({ "name.conf": "content" }) or a full ServiceBay backup (.tar.gz).',
        debug: [],
      });
      setNginxDiagExpanded(false);
    } finally {
      setNginxImporting(false);
      if (nginxFileInputRef.current) nginxFileInputRef.current.value = '';
    }
  };

  if (!nginxInstalled) return null;

  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm overflow-hidden w-full">
      <div className="p-4 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 flex flex-col gap-3 md:flex-row md:items-center">
        <div className="flex items-center gap-3 flex-1">
          <div className="p-2 bg-green-100 dark:bg-green-900/30 rounded-lg text-green-600 dark:text-green-300">
            <Shield size={20} />
          </div>
          <div>
            <h3 className="font-bold text-gray-900 dark:text-white">Nginx Configuration</h3>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Export or import reverse proxy server block configs{nginxNode && nginxNode !== 'Local' ? ` (${nginxNode})` : ''}.
            </p>
          </div>
        </div>
        <div className="flex flex-col md:flex-row md:items-center gap-3">
          <button onClick={handleNginxExport} disabled={nginxExporting} className="inline-flex items-center justify-center gap-2 px-4 py-2 bg-white dark:bg-gray-900 text-gray-700 dark:text-gray-200 text-sm rounded-lg border border-gray-300 dark:border-gray-700 shadow-sm hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors disabled:opacity-50">
            {nginxExporting ? <Loader2 className="animate-spin" size={16} /> : <Download size={16} />} Export Config
          </button>
          <label className="inline-flex items-center justify-center gap-2 px-4 py-2 bg-white dark:bg-gray-900 text-gray-700 dark:text-gray-200 text-sm rounded-lg border border-gray-300 dark:border-gray-700 shadow-sm hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors cursor-pointer">
            {nginxImporting ? <Loader2 className="animate-spin" size={16} /> : <Upload size={16} />} Import Config
            <input ref={nginxFileInputRef} type="file" accept=".json,.tar.gz,.tgz" onChange={handleNginxImport} className="hidden" />
          </label>
        </div>
      </div>
      {nginxDiag && (
        <div className="p-4 border-t border-red-200 dark:border-red-800/50 bg-red-50 dark:bg-red-900/20">
          <div className="flex items-start gap-3">
            <XCircle className="w-5 h-5 text-red-500 dark:text-red-400 shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="text-sm text-red-800 dark:text-red-200">{nginxDiag.reason}</p>
              {(nginxDiag.node || nginxDiag.confDir) && (
                <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-red-600 dark:text-red-300">
                  {nginxDiag.node && <span>Node: <span className="font-mono">{nginxDiag.node}</span></span>}
                  {nginxDiag.confDir && <span>conf.d: <span className="font-mono">{nginxDiag.confDir}</span></span>}
                </div>
              )}
              {nginxDiag.debug.length > 0 && (
                <div className="mt-2">
                  <button onClick={() => setNginxDiagExpanded(prev => !prev)} className="inline-flex items-center gap-1 text-xs text-red-600 dark:text-red-300 hover:text-red-800 dark:hover:text-red-100 transition-colors">
                    {nginxDiagExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    Diagnostics ({nginxDiag.debug.length} steps)
                  </button>
                  {nginxDiagExpanded && (
                    <pre className="mt-1 p-2 rounded bg-red-100 dark:bg-red-900/40 text-[11px] font-mono text-red-700 dark:text-red-200 overflow-x-auto max-h-60 overflow-y-auto whitespace-pre-wrap break-words">
                      {nginxDiag.debug.join('\n')}
                    </pre>
                  )}
                </div>
              )}
            </div>
            <button onClick={() => setNginxDiag(null)} className="text-red-400 hover:text-red-600 dark:hover:text-red-200 transition-colors shrink-0">
              <X size={16} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

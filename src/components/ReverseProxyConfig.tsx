'use client';

import { useState, useEffect, useRef } from 'react';
import { Shield, Download, Upload, Server, Check, RefreshCw } from 'lucide-react';
import { logger } from '@/lib/logger';
import { useToast } from '@/providers/ToastProvider';

export default function ReverseProxyConfig() {
    const [loading, setLoading] = useState(false);
    const [installing, setInstalling] = useState(false);
    const [exporting, setExporting] = useState(false);
    const [importing, setImporting] = useState(false);
    const [status, setStatus] = useState<'installed' | 'not-installed' | 'unknown'>('unknown');
    const fileInputRef = useRef<HTMLInputElement>(null);
    const { addToast } = useToast();

    useEffect(() => {
        checkStatus();
    }, []);

    const checkStatus = async () => {
        setLoading(true);
        try {
            const res = await fetch('/api/system/nginx/status');
            const data = await res.json();
            setStatus(data.installed ? 'installed' : 'not-installed');
        } catch (error) {
            logger.error('ReverseProxy', 'Check status failed', error);
            setStatus('unknown');
        } finally {
            setLoading(false);
        }
    };

    const handleInstall = async () => {
        setInstalling(true);
        try {
            const res = await fetch('/api/system/nginx/install', { method: 'POST' });
            if (!res.ok) throw new Error('Installation failed');

            addToast('success', 'Nginx installed successfully');
            checkStatus();
        } catch {
            addToast('error', 'Failed to install Nginx');
        } finally {
            setInstalling(false);
        }
    };

    const handleExport = async () => {
        setExporting(true);
        try {
            const res = await fetch('/api/system/nginx/export');
            if (!res.ok) throw new Error('Export failed');
            const data = await res.json();

            if (!data.files || Object.keys(data.files).length === 0) {
                addToast('info', 'No nginx configuration files found to export');
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
            setExporting(false);
        }
    };

    const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        setImporting(true);
        try {
            const text = await file.text();
            const files = JSON.parse(text);

            if (typeof files !== 'object' || Array.isArray(files)) {
                throw new Error('Invalid format');
            }

            const res = await fetch('/api/system/nginx/import', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ files })
            });

            if (!res.ok) throw new Error('Import failed');
            const data = await res.json();
            addToast('success', `Imported ${data.imported?.length || 0} config file(s)`);
        } catch {
            addToast('error', 'Failed to import nginx config. Expected JSON with { "filename.conf": "content" } format.');
        } finally {
            setImporting(false);
            if (fileInputRef.current) fileInputRef.current.value = '';
        }
    };

    return (
        <div className="flex flex-col h-full">
            <div className="p-4 border-b border-gray-200 dark:border-gray-800 flex justify-between items-center bg-white dark:bg-gray-900">
                <h2 className="font-bold text-xl text-gray-900 dark:text-white flex items-center gap-2">
                    <Shield className="text-green-500" />
                    Reverse Proxy (Nginx)
                </h2>
                <button
                    onClick={checkStatus}
                    disabled={loading}
                    className="p-2 text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
                >
                    <RefreshCw size={20} className={loading ? 'animate-spin' : ''} />
                </button>
            </div>

            <div className="flex-1 p-6 overflow-y-auto bg-gray-50 dark:bg-gray-950">
                <div className="max-w-2xl mx-auto space-y-6">
                    {/* Status Card */}
                    <div className="bg-white dark:bg-gray-900 rounded-xl shadow-sm border border-gray-200 dark:border-gray-800 p-6">
                        <div className="flex items-center gap-4 mb-4">
                            <div className={`p-3 rounded-full ${status === 'installed' ? 'bg-green-100 text-green-600' : 'bg-yellow-100 text-yellow-600'}`}>
                                <Server size={24} />
                            </div>
                            <div>
                                <h3 className="font-semibold text-lg">System Status</h3>
                                <p className="text-gray-500 text-sm">
                                    {status === 'installed' ? 'Nginx is installed and managed by ServiceBay' : 'Nginx is not installed on this system'}
                                </p>
                            </div>
                        </div>

                        {status === 'not-installed' && (
                            <div className="mt-4 p-4 bg-blue-50 dark:bg-blue-900/20 rounded-lg border border-blue-100 dark:border-blue-800">
                                <h4 className="font-medium text-blue-900 dark:text-blue-100 mb-2">Installation Required</h4>
                                <p className="text-sm text-blue-700 dark:text-blue-300 mb-4">
                                    To use the reverse proxy features, Nginx needs to be installed and configured on the host system.
                                    ServiceBay can handle this automatically.
                                </p>
                                <button
                                    onClick={handleInstall}
                                    disabled={installing}
                                    className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors disabled:opacity-50"
                                >
                                    {installing ? (
                                        <>
                                            <RefreshCw size={16} className="animate-spin" />
                                            Installing...
                                        </>
                                    ) : (
                                        <>
                                            <Download size={16} />
                                            Install Nginx
                                        </>
                                    )}
                                </button>
                            </div>
                        )}

                        {status === 'installed' && (
                            <div className="mt-4 flex items-center gap-2 text-green-600 bg-green-50 dark:bg-green-900/20 p-3 rounded-lg border border-green-100 dark:border-green-800">
                                <Check size={20} />
                                <span className="font-medium">Ready to serve traffic</span>
                            </div>
                        )}
                    </div>

                    {/* Export / Import Card */}
                    {status === 'installed' && (
                        <div className="bg-white dark:bg-gray-900 rounded-xl shadow-sm border border-gray-200 dark:border-gray-800 p-6">
                            <h3 className="font-semibold text-lg mb-2">Configuration</h3>
                            <p className="text-gray-500 text-sm mb-4">
                                Export your nginx server configs to transfer to another system, or import a previously exported configuration.
                            </p>
                            <div className="flex gap-3">
                                <button
                                    onClick={handleExport}
                                    disabled={exporting}
                                    className="flex items-center gap-2 px-4 py-2 bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-lg transition-colors disabled:opacity-50"
                                >
                                    {exporting ? <RefreshCw size={16} className="animate-spin" /> : <Download size={16} />}
                                    Export Config
                                </button>
                                <label className="flex items-center gap-2 px-4 py-2 bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-lg transition-colors cursor-pointer">
                                    {importing ? <RefreshCw size={16} className="animate-spin" /> : <Upload size={16} />}
                                    Import Config
                                    <input
                                        ref={fileInputRef}
                                        type="file"
                                        accept=".json"
                                        onChange={handleImport}
                                        className="hidden"
                                    />
                                </label>
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}

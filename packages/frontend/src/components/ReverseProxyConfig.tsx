'use client';

import { useState, useEffect } from 'react';
import { Shield, Download, Server, Check, RefreshCw, ExternalLink } from 'lucide-react';
import { logger, fetchNginxStatus, installNginx } from '@servicebay/api-client';
import { useToast } from '@/providers/ToastProvider';

export default function ReverseProxyConfig() {
    const [loading, setLoading] = useState(false);
    const [installing, setInstalling] = useState(false);
    const [status, setStatus] = useState<'installed' | 'not-installed' | 'unknown'>('unknown');
    const [nginxNode, setNginxNode] = useState<string | null>(null);
    const [adminPort, setAdminPort] = useState<number>(8081);
    const { addToast } = useToast();

    const checkStatus = async () => {
        setLoading(true);
        try {
            const data = await fetchNginxStatus();
            setStatus(data.installed ? 'installed' : 'not-installed');
            if (data.node) setNginxNode(data.node);
            if (data.adminPort) setAdminPort(data.adminPort);
        } catch (error) {
            logger.error('ReverseProxy', 'Check status failed', error);
            setStatus('unknown');
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- async nginx-status check on mount
        checkStatus();
    }, []);

    const handleInstall = async () => {
        setInstalling(true);
        try {
            await installNginx();

            addToast('success', 'Nginx installed successfully');
            checkStatus();
        } catch {
            addToast('error', 'Failed to install Nginx');
        } finally {
            setInstalling(false);
        }
    };

    return (
        <div className="flex flex-col h-full">
            <div className="p-4 border-b border-border flex justify-between items-center bg-surface">
                <h2 className="font-bold text-xl text-text flex items-center gap-2">
                    <Shield className="text-status-ok" />
                    Reverse Proxy (Nginx Proxy Manager)
                </h2>
                <button
                    onClick={checkStatus}
                    disabled={loading}
                    className="p-2 text-text-muted hover:bg-surface-2 rounded-lg transition-colors"
                >
                    <RefreshCw size={20} className={loading ? 'animate-spin' : ''} />
                </button>
            </div>

            <div className="flex-1 p-6 overflow-y-auto bg-surface-2">
                <div className="max-w-2xl mx-auto space-y-6">
                    {/* Status Card */}
                    <div className="bg-surface rounded-xl shadow-sm border border-border p-6">
                        <div className="flex items-center gap-4 mb-4">
                            <div className={`p-3 rounded-full ${status === 'installed' ? 'bg-status-ok/10 text-status-ok' : 'bg-status-warn/10 text-status-warn'}`}>
                                <Server size={24} />
                            </div>
                            <div>
                                <h3 className="font-semibold text-lg">System Status</h3>
                                <p className="text-text-muted text-sm">
                                    {status === 'installed'
                                        ? `Nginx is installed and managed by ServiceBay${nginxNode && nginxNode !== 'Local' ? ` on ${nginxNode}` : ''}`
                                        : 'Nginx is not installed on this system'}
                                </p>
                            </div>
                        </div>

                        {status === 'not-installed' && (
                            <div className="mt-4 p-4 bg-status-info/10 rounded-lg border border-status-info/20">
                                <h4 className="font-medium text-status-info mb-2">Installation Required</h4>
                                <p className="text-sm text-status-info mb-4">
                                    Nginx Proxy Manager provides a web UI for managing reverse proxy hosts, SSL certificates, and redirections.
                                    ServiceBay can install it automatically.
                                </p>
                                <button
                                    onClick={handleInstall}
                                    disabled={installing}
                                    className="flex items-center gap-2 px-4 py-2 bg-accent hover:bg-accent-strong text-on-accent rounded-lg transition-colors disabled:opacity-50"
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
                            <div className="mt-4 space-y-3">
                                <div className="flex items-center gap-2 text-status-ok bg-status-ok/10 p-3 rounded-lg border border-status-ok/20">
                                    <Check size={20} />
                                    <span className="font-medium">Ready to serve traffic</span>
                                </div>
                                <a
                                    href={`${window.location.protocol}//${window.location.hostname}:${adminPort}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="inline-flex items-center gap-2 px-4 py-2 bg-accent hover:bg-accent-strong text-on-accent rounded-lg transition-colors text-sm font-medium"
                                >
                                    <ExternalLink size={16} />
                                    Open Admin UI
                                </a>
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}

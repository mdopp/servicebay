'use client';

import { useState, useEffect } from 'react';
import { useToast } from '@/providers/ToastProvider';
import { Globe, Save } from 'lucide-react';
import { Button } from '@/components/ui';

const labelCls = 'text-sm font-medium text-text-muted md:col-span-1';
const inputCls =
    'w-full px-space-3 py-space-2 rounded-card border border-border bg-surface-2 text-text ' +
    'placeholder:text-text-subtle focus:outline-none focus:ring-2 focus:ring-accent';

export default function GatewayConfig() {
    const { addToast } = useToast();
    const [gatewayForm, setGatewayForm] = useState({
        type: 'fritzbox',
        host: 'fritz.box',
        username: '',
        password: ''
    });
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        fetch('/api/settings')
            .then(res => res.json())
            .then(config => {
                if (config?.gateway) {
                    setGatewayForm({
                        type: config.gateway.type || 'fritzbox',
                        host: config.gateway.host || 'fritz.box',
                        username: config.gateway.username || '',
                        password: config.gateway.password || ''
                    });
                }
                setLoading(false);
            })
            .catch(() => {
                addToast('error', 'Failed to load gateway settings');
                setLoading(false);
            });
    }, [addToast]);

    const handleSaveGateway = async () => {
        setSaving(true);
        try {
            await fetch('/api/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    gateway: {
                        ...gatewayForm,
                        ssl: true // Default to true for now
                    }
                })
            });
            addToast('success', 'Internet Gateway configured');
        } catch {
            addToast('error', 'Failed to save gateway settings');
        } finally {
            setSaving(false);
        }
    };

    if (loading) return (
        <div className="bg-surface rounded-card border border-border p-8 flex justify-center text-text-subtle">
            Loading configuration...
        </div>
    );

    return (
        <div className="bg-surface rounded-card border border-border overflow-hidden w-full">
            <div className="p-space-4 border-b border-border bg-surface-2 flex items-center gap-space-3">
                <div className="p-space-2 bg-accent/10 rounded-card text-accent">
                    <Globe size={20} />
                </div>
                <div>
                    <h3 className="font-bold text-text">Internet Gateway</h3>
                    <p className="text-xs text-text-muted">Configure router integration</p>
                </div>
                <div className="ml-auto">
                    <Button size="sm" onClick={handleSaveGateway} disabled={saving} className="gap-space-2">
                        <Save size={16} /> {saving ? 'Saving...' : 'Save'}
                    </Button>
                </div>
            </div>

            <div className="p-6">
                <div className="mb-6 bg-status-info/10 text-status-info p-space-4 rounded-card text-sm border border-status-info/20">
                    Configure your internet gateway to enable automatic port forwarding and external access management.
                    Currently supports <strong>AVM Fritz!Box</strong> routers via TR-064 protocol.
                </div>

                <div className="space-y-6">
                    <div className="grid grid-cols-1 md:grid-cols-4 gap-space-4 items-center">
                        <label className={labelCls}>Router Type</label>
                        <div className="md:col-span-3">
                            <select
                                value={gatewayForm.type}
                                onChange={e => setGatewayForm({ ...gatewayForm, type: e.target.value })}
                                className={inputCls}
                            >
                                <option value="fritzbox">AVM Fritz!Box</option>
                            </select>
                        </div>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-4 gap-space-4 items-center">
                        <label className={labelCls}>Hostname / IP</label>
                        <div className="md:col-span-3">
                            <input
                                type="text"
                                value={gatewayForm.host}
                                onChange={e => setGatewayForm({ ...gatewayForm, host: e.target.value })}
                                className={inputCls}
                                placeholder="fritz.box"
                            />
                        </div>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-4 gap-space-4 items-center">
                        <label className={labelCls}>Username</label>
                        <div className="md:col-span-3">
                            <input
                                type="text"
                                value={gatewayForm.username}
                                onChange={e => setGatewayForm({ ...gatewayForm, username: e.target.value })}
                                className={inputCls}
                                placeholder="admin"
                            />
                        </div>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-4 gap-space-4 items-center">
                        <label className={labelCls}>Password</label>
                        <div className="md:col-span-3">
                            <input
                                type="password"
                                value={gatewayForm.password}
                                onChange={e => setGatewayForm({ ...gatewayForm, password: e.target.value })}
                                className={inputCls}
                                placeholder="••••••••"
                            />
                        </div>
                    </div>

                    <div className="bg-status-warn/10 border border-status-warn/20 rounded-card p-space-3 text-xs text-status-warn">
                        <p>Credentials allow fetching detailed port forwardings via TR-064. Without them, only basic UPnP status is available (not recommended).</p>
                    </div>
                </div>
            </div>
        </div>
    );
}

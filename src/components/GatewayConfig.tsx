'use client';

import { useState, useEffect } from 'react';
import { useToast } from '@/providers/ToastProvider';
import { Globe, Save } from 'lucide-react';

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
         <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm p-8 flex justify-center text-gray-400">
             Loading configuration...
         </div>
    );

    return (
        <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm overflow-hidden w-full">
            <div className="p-4 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 flex items-center gap-3">
                <div className="p-2 bg-amber-100 dark:bg-amber-900/30 rounded-lg text-amber-600 dark:text-amber-400">
                    <Globe size={20} />
                </div>
                <div>
                     <h3 className="font-bold text-gray-900 dark:text-white">Internet Gateway</h3>
                     <p className="text-xs text-gray-500 dark:text-gray-400">Configure router integration</p>
                </div>
                 <div className="ml-auto">
                    <button 
                        onClick={handleSaveGateway}
                        disabled={saving}
                        className="flex items-center gap-2 px-3 py-1.5 bg-blue-600 text-white text-sm rounded hover:bg-blue-700 transition-colors font-medium disabled:opacity-50"
                    >
                        <Save size={16} /> {saving ? 'Saving...' : 'Save'}
                    </button>
                </div>
            </div>

            <div className="p-6">
                <div className="mb-6 bg-blue-50 dark:bg-blue-900/20 text-blue-800 dark:text-blue-200 p-4 rounded-lg text-sm border border-blue-100 dark:border-blue-900">
                    Configure your internet gateway to enable automatic port forwarding and external access management.
                    Currently supports <strong>AVM Fritz!Box</strong> routers via TR-064 protocol.
                </div>

                <div className="space-y-6">
                    <div className="grid grid-cols-1 md:grid-cols-4 gap-4 items-center">
                        <label className="text-sm font-medium text-gray-700 dark:text-gray-300 md:col-span-1">Router Type</label>
                        <div className="md:col-span-3">
                            <select 
                                value={gatewayForm.type}
                                onChange={e => setGatewayForm({...gatewayForm, type: e.target.value})}
                                className="w-full p-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white focus:ring-2 focus:ring-amber-500 outline-none"
                            >
                                <option value="fritzbox">AVM Fritz!Box</option>
                            </select>
                        </div>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-4 gap-4 items-center">
                        <label className="text-sm font-medium text-gray-700 dark:text-gray-300 md:col-span-1">Hostname / IP</label>
                        <div className="md:col-span-3">
                            <input 
                                type="text" 
                                value={gatewayForm.host}
                                onChange={e => setGatewayForm({...gatewayForm, host: e.target.value})}
                                className="w-full p-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white focus:ring-2 focus:ring-amber-500 outline-none"
                                placeholder="fritz.box"
                            />
                        </div>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-4 gap-4 items-center">
                        <label className="text-sm font-medium text-gray-700 dark:text-gray-300 md:col-span-1">Username</label>
                        <div className="md:col-span-3">
                            <input 
                                type="text" 
                                value={gatewayForm.username}
                                onChange={e => setGatewayForm({...gatewayForm, username: e.target.value})}
                                className="w-full p-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white focus:ring-2 focus:ring-amber-500 outline-none"
                                placeholder="admin"
                            />
                        </div>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-4 gap-4 items-center">
                        <label className="text-sm font-medium text-gray-700 dark:text-gray-300 md:col-span-1">Password</label>
                        <div className="md:col-span-3">
                            <input 
                                type="password" 
                                value={gatewayForm.password}
                                onChange={e => setGatewayForm({...gatewayForm, password: e.target.value})}
                                className="w-full p-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white focus:ring-2 focus:ring-amber-500 outline-none"
                                placeholder="••••••••"
                            />
                        </div>
                    </div>

                    <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg p-3 text-xs text-amber-800 dark:text-amber-200">
                        <p>Credentials allow fetching detailed port forwardings via TR-064. Without them, only basic UPnP status is available (not recommended).</p>
                    </div>
                </div>
            </div>
        </div>
    );
}

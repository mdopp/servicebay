'use client';

import { useState, useEffect } from 'react';
import { useToast } from '@/providers/ToastProvider';
import { Globe, Save } from 'lucide-react';

export default function GatewayConfig() {
    const { addToast } = useToast();
    const [gatewayForm, setGatewayForm] = useState({
        enabled: true,
        type: 'fritzbox',
        host: 'fritz.box',
        username: '',
        password: ''
    });
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        fetch('/api/settings')
            .then(res => res.json())
            .then(config => {
                if (config?.gateway) {
                    setGatewayForm({
                        enabled: true,
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
        } catch (e) {
            addToast('error', 'Failed to save gateway settings');
        }
    };

    if (loading) return <div className="flex items-center justify-center h-full text-gray-400">Loading configuration...</div>;

    return (
        <div className="flex flex-col h-full">
            {/* Header */}
            <div className="p-4 border-b border-gray-200 dark:border-gray-800 flex justify-between items-center bg-white dark:bg-gray-900">
                <div className="flex flex-col">
                    <h2 className="font-bold text-xl text-gray-900 dark:text-white flex items-center gap-2">
                        <Globe className="text-amber-500" />
                        Internet Gateway
                    </h2>
                    <span className="text-sm text-gray-500 dark:text-gray-400 flex items-center gap-1">
                        Source: <span className="font-mono">System Integration</span>
                    </span>
                </div>
                <button 
                    onClick={handleSaveGateway}
                    className="flex items-center gap-2 bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 transition-colors shadow-sm font-medium"
                >
                    <Save size={18} /> Save Configuration
                </button>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto p-8">
                <div className="max-w-3xl">
                    <div className="mb-8 prose dark:prose-invert">
                        <p>
                            Configure your internet gateway to enable automatic port forwarding and external access management.
                            Currently supports AVM Fritz!Box routers via TR-064 protocol.
                        </p>
                    </div>

                    <div className="space-y-6 bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-6">
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-center">
                            <label className="text-sm font-medium text-gray-700 dark:text-gray-300">Router Type</label>
                            <div className="md:col-span-2">
                                <select 
                                    value={gatewayForm.type}
                                    onChange={e => setGatewayForm({...gatewayForm, type: e.target.value})}
                                    className="w-full p-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:ring-2 focus:ring-amber-500 outline-none"
                                >
                                    <option value="fritzbox">AVM Fritz!Box</option>
                                </select>
                            </div>
                        </div>

                        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-center">
                            <label className="text-sm font-medium text-gray-700 dark:text-gray-300">Hostname / IP</label>
                            <div className="md:col-span-2">
                                <input 
                                    type="text" 
                                    value={gatewayForm.host}
                                    onChange={e => setGatewayForm({...gatewayForm, host: e.target.value})}
                                    className="w-full p-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:ring-2 focus:ring-amber-500 outline-none"
                                    placeholder="fritz.box"
                                />
                            </div>
                        </div>

                        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-center">
                            <label className="text-sm font-medium text-gray-700 dark:text-gray-300">Username</label>
                            <div className="md:col-span-2">
                                <input 
                                    type="text" 
                                    value={gatewayForm.username}
                                    onChange={e => setGatewayForm({...gatewayForm, username: e.target.value})}
                                    className="w-full p-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:ring-2 focus:ring-amber-500 outline-none"
                                    placeholder="admin"
                                />
                            </div>
                        </div>

                        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-center">
                            <label className="text-sm font-medium text-gray-700 dark:text-gray-300">Password</label>
                            <div className="md:col-span-2">
                                <input 
                                    type="password" 
                                    value={gatewayForm.password}
                                    onChange={e => setGatewayForm({...gatewayForm, password: e.target.value})}
                                    className="w-full p-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:ring-2 focus:ring-amber-500 outline-none"
                                    placeholder="••••••••"
                                />
                            </div>
                        </div>

                        <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg p-4 text-sm text-amber-800 dark:text-amber-200">
                            <p>Credentials allow fetching detailed port forwardings via TR-064. Without them, only basic UPnP status is available.</p>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}

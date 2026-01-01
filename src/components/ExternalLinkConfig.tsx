'use client';

import { useState } from 'react';
import { useToast } from '@/providers/ToastProvider';
import { useRouter } from 'next/navigation';
import { Link as LinkIcon, Save } from 'lucide-react';

export default function ExternalLinkConfig() {
    const { addToast } = useToast();
    const router = useRouter();
    const [linkForm, setLinkForm] = useState({ name: '', url: '', description: '', monitor: false });

    const handleSaveLink = async () => {
        if (!linkForm.name || !linkForm.url) {
            addToast('error', 'Name and URL are required');
            return;
        }

        try {
            const res = await fetch('/api/services', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ...linkForm, type: 'link' })
            });

            if (!res.ok) throw new Error('Failed to save link');

            addToast('success', 'Link added successfully');
            setLinkForm({ name: '', url: '', description: '', monitor: false });
            router.push('/services'); // Redirect to services list
        } catch {
            addToast('error', 'Failed to save link');
        }
    };

    return (
        <div className="flex flex-col h-full">
            {/* Header */}
            <div className="p-4 border-b border-gray-200 dark:border-gray-800 flex justify-between items-center bg-white dark:bg-gray-900">
                <div className="flex flex-col">
                    <h2 className="font-bold text-xl text-gray-900 dark:text-white flex items-center gap-2">
                        <LinkIcon className="text-gray-500" />
                        External Link
                    </h2>
                    <span className="text-sm text-gray-500 dark:text-gray-400 flex items-center gap-1">
                        Source: <span className="font-mono">Manual Entry</span>
                    </span>
                </div>
                <button 
                    onClick={handleSaveLink}
                    className="flex items-center gap-2 bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 transition-colors shadow-sm font-medium"
                >
                    <Save size={18} /> Save Link
                </button>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto p-8">
                <div className="max-w-3xl">
                    <div className="mb-8 prose dark:prose-invert">
                        <p>
                            Add a shortcut to an external service or dashboard. This service will appear in your main list
                            and can be optionally monitored for uptime.
                        </p>
                    </div>

                    <div className="space-y-6 bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-6">
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-center">
                            <label className="text-sm font-medium text-gray-700 dark:text-gray-300">Name</label>
                            <div className="md:col-span-2">
                                <input 
                                    type="text" 
                                    value={linkForm.name}
                                    onChange={e => setLinkForm({...linkForm, name: e.target.value})}
                                    className="w-full p-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
                                    placeholder="e.g. Home Assistant"
                                />
                            </div>
                        </div>

                        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-center">
                            <label className="text-sm font-medium text-gray-700 dark:text-gray-300">URL</label>
                            <div className="md:col-span-2">
                                <input 
                                    type="url" 
                                    value={linkForm.url}
                                    onChange={e => setLinkForm({...linkForm, url: e.target.value})}
                                    className="w-full p-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
                                    placeholder="http://192.168.1.10:8123"
                                />
                            </div>
                        </div>

                        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-center">
                            <label className="text-sm font-medium text-gray-700 dark:text-gray-300">Description</label>
                            <div className="md:col-span-2">
                                <input 
                                    type="text" 
                                    value={linkForm.description}
                                    onChange={e => setLinkForm({...linkForm, description: e.target.value})}
                                    className="w-full p-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
                                    placeholder="Smart Home Control"
                                />
                            </div>
                        </div>

                        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-center">
                            <label className="text-sm font-medium text-gray-700 dark:text-gray-300">Monitoring</label>
                            <div className="md:col-span-2 flex items-center gap-2">
                                <input 
                                    type="checkbox" 
                                    id="monitor"
                                    checked={linkForm.monitor}
                                    onChange={e => setLinkForm({...linkForm, monitor: e.target.checked})}
                                    className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                                />
                                <label htmlFor="monitor" className="text-sm text-gray-700 dark:text-gray-300">
                                    Enable HTTP health checks
                                </label>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}

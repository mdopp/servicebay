'use client';

import { useState } from 'react';
import { useToast } from '@/providers/ToastProvider';
import { Server, Save } from 'lucide-react';

export default function ManualServiceForm() {
    const { addToast } = useToast();
    const [form, setForm] = useState({ name: '', image: '', ports: '', volumes: '' });

    const handleCreate = async () => {
        // Implementation for manual creation
        addToast('info', 'Manual creation not yet implemented');
    };

    return (
        <div className="flex flex-col h-full">
            {/* Header */}
            <div className="p-4 border-b border-gray-200 dark:border-gray-800 flex justify-between items-center bg-white dark:bg-gray-900">
                <div className="flex flex-col">
                    <h2 className="font-bold text-xl text-gray-900 dark:text-white flex items-center gap-2">
                        <Server className="text-blue-500" />
                        Manual Service
                    </h2>
                    <span className="text-sm text-gray-500 dark:text-gray-400 flex items-center gap-1">
                        Source: <span className="font-mono">Docker Image</span>
                    </span>
                </div>
                <button 
                    onClick={handleCreate}
                    className="flex items-center gap-2 bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 transition-colors shadow-sm font-medium"
                >
                    <Save size={18} /> Create Service
                </button>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto p-8">
                <div className="max-w-3xl">
                    <div className="mb-8 prose dark:prose-invert">
                        <p>
                            Manually create a service by specifying a Docker image and configuration.
                            This is useful for custom containers or testing.
                        </p>
                    </div>

                    <div className="space-y-6 bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-6">
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-center">
                            <label className="text-sm font-medium text-gray-700 dark:text-gray-300">Service Name</label>
                            <div className="md:col-span-2">
                                <input 
                                    type="text" 
                                    value={form.name}
                                    onChange={e => setForm({...form, name: e.target.value})}
                                    className="w-full p-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
                                    placeholder="my-service"
                                />
                            </div>
                        </div>

                        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-center">
                            <label className="text-sm font-medium text-gray-700 dark:text-gray-300">Docker Image</label>
                            <div className="md:col-span-2">
                                <input 
                                    type="text" 
                                    value={form.image}
                                    onChange={e => setForm({...form, image: e.target.value})}
                                    className="w-full p-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
                                    placeholder="nginx:latest"
                                />
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}

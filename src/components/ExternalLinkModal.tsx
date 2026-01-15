import React from 'react';
import { X } from 'lucide-react';

interface LinkForm {
    name: string;
    url: string;
    description: string;
    monitor: boolean;
    ipTargetsText?: string;
}

interface ExternalLinkModalProps {
    isOpen: boolean;
    onClose: () => void;
    onSave: () => void;
    isEditing: boolean;
    form: LinkForm;
    setForm: (form: LinkForm) => void;
}

export default function ExternalLinkModal({ isOpen, onClose, onSave, isEditing, form, setForm }: ExternalLinkModalProps) {
    if (!isOpen) return null;

    return (
        <div className="absolute inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
            <div className="bg-white dark:bg-gray-900 rounded-xl shadow-xl w-full max-w-md border border-gray-200 dark:border-gray-800">
                <div className="flex justify-between items-center p-4 border-b border-gray-200 dark:border-gray-800">
                    <h3 className="text-lg font-bold">{isEditing ? 'Edit External Link' : 'Add External Link'}</h3>
                    <button onClick={onClose} className="text-gray-500 hover:text-gray-700 dark:hover:text-gray-300">
                        <X size={20} />
                    </button>
                </div>
                <div className="p-4 space-y-4">
                    <div>
                        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Name</label>
                        <input 
                            type="text" 
                            value={form.name}
                            onChange={e => setForm({...form, name: e.target.value})}
                            className="w-full p-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
                            placeholder="e.g. Home Assistant"
                        />
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">URL</label>
                        <input 
                            type="url" 
                            value={form.url}
                            onChange={e => setForm({...form, url: e.target.value})}
                            className="w-full p-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
                            placeholder="http://192.168.1.10:8123"
                        />
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Description (Optional)</label>
                        <input 
                            type="text" 
                            value={form.description}
                            onChange={e => setForm({...form, description: e.target.value})}
                            className="w-full p-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
                            placeholder="Smart Home Control"
                        />
                    </div>
                    <div className="flex items-center gap-2">
                        <input 
                            type="checkbox" 
                            id="monitor"
                            checked={form.monitor}
                            onChange={e => setForm({...form, monitor: e.target.checked})}
                            className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                        />
                        <label htmlFor="monitor" className="text-sm text-gray-700 dark:text-gray-300">
                            Monitor this service (HTTP Check)
                        </label>
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Target IPs/Ports (Optional)</label>
                        <input 
                            type="text" 
                            value={form.ipTargetsText || ''}
                            onChange={e => setForm({...form, ipTargetsText: e.target.value})}
                            className="w-full p-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
                            placeholder="e.g. 192.168.1.10:8123, 10.0.0.5:80 (comma separated)"
                        />
                        <span className="text-xs text-gray-500">Allows Nginx Reverse Proxy to detect edges to this external service.</span>
                    </div>
                </div>
                <div className="flex justify-end gap-2 p-4 border-t border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/50 rounded-b-xl">
                    <button 
                        onClick={onClose}
                        className="px-4 py-2 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-800 rounded-lg transition-colors"
                    >
                        Cancel
                    </button>
                    <button 
                        onClick={onSave}
                        className="px-4 py-2 bg-blue-600 text-white hover:bg-blue-700 rounded-lg transition-colors font-medium"
                    >
                        {isEditing ? 'Save Changes' : 'Add Link'}
                    </button>
                </div>
            </div>
        </div>
    );
}

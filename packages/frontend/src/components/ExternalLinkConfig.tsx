'use client';

import { useState } from 'react';
import { useToast } from '@/providers/ToastProvider';
import { useRouter } from 'next/navigation';
import { Link as LinkIcon, Save } from 'lucide-react';
import { Card, Button, Field } from '@/components/ui';

const inputCls =
    'w-full px-space-3 py-space-2 rounded-card border border-border bg-surface-2 text-text ' +
    'placeholder:text-text-subtle focus:outline-none focus:ring-2 focus:ring-accent';

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
            <div className="p-space-4 border-b border-border flex justify-between items-center bg-surface">
                <div className="flex flex-col">
                    <h2 className="font-bold text-xl text-text flex items-center gap-space-2">
                        <LinkIcon className="text-text-muted" />
                        External Link
                    </h2>
                    <span className="text-sm text-text-muted flex items-center gap-space-1">
                        Source: <span className="font-mono">Manual Entry</span>
                    </span>
                </div>
                <Button onClick={handleSaveLink} className="gap-space-2">
                    <Save size={18} /> Save Link
                </Button>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto p-8">
                <div className="max-w-3xl">
                    <div className="mb-8 text-sm text-text-muted">
                        <p>
                            Add a shortcut to an external service or dashboard. This service will appear in your main list
                            and can be optionally monitored for uptime.
                        </p>
                    </div>

                    <Card padding="lg" className="space-y-6">
                        <Field label="Name">
                            {(props) => (
                                <input
                                    {...props}
                                    type="text"
                                    value={linkForm.name}
                                    onChange={e => setLinkForm({ ...linkForm, name: e.target.value })}
                                    className={inputCls}
                                    placeholder="e.g. Home Assistant"
                                />
                            )}
                        </Field>

                        <Field label="URL">
                            {(props) => (
                                <input
                                    {...props}
                                    type="url"
                                    value={linkForm.url}
                                    onChange={e => setLinkForm({ ...linkForm, url: e.target.value })}
                                    className={inputCls}
                                    placeholder="http://192.168.1.10:8123"
                                />
                            )}
                        </Field>

                        <Field label="Description">
                            {(props) => (
                                <input
                                    {...props}
                                    type="text"
                                    value={linkForm.description}
                                    onChange={e => setLinkForm({ ...linkForm, description: e.target.value })}
                                    className={inputCls}
                                    placeholder="Smart Home Control"
                                />
                            )}
                        </Field>

                        <label className="flex items-center gap-space-2 text-sm text-text-muted">
                            <input
                                type="checkbox"
                                checked={linkForm.monitor}
                                onChange={e => setLinkForm({ ...linkForm, monitor: e.target.checked })}
                                className="rounded border-border text-accent focus:ring-accent"
                            />
                            Enable HTTP health checks
                        </label>
                    </Card>
                </div>
            </div>
        </div>
    );
}

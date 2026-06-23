'use client';

import { useState } from 'react';
import { useToast } from '@/providers/ToastProvider';
import { Server, Save } from 'lucide-react';
import { Card, Button, Field } from '@/components/ui';

const inputCls =
    'w-full px-space-3 py-space-2 rounded-card border border-border bg-surface-2 text-text ' +
    'placeholder:text-text-subtle focus:outline-none focus:ring-2 focus:ring-accent';

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
            <div className="p-space-4 border-b border-border flex justify-between items-center bg-surface">
                <div className="flex flex-col">
                    <h2 className="font-bold text-xl text-text flex items-center gap-space-2">
                        <Server className="text-accent" />
                        Manual Service
                    </h2>
                    <span className="text-sm text-text-muted flex items-center gap-space-1">
                        Source: <span className="font-mono">Docker Image</span>
                    </span>
                </div>
                <Button onClick={handleCreate} className="gap-space-2">
                    <Save size={18} /> Create Service
                </Button>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto p-8">
                <div className="max-w-3xl">
                    <div className="mb-8 text-sm text-text-muted">
                        <p>
                            Manually create a service by specifying a Docker image and configuration.
                            This is useful for custom containers or testing.
                        </p>
                    </div>

                    <Card padding="lg" className="space-y-6">
                        <Field label="Service Name">
                            {(props) => (
                                <input
                                    {...props}
                                    type="text"
                                    value={form.name}
                                    onChange={e => setForm({ ...form, name: e.target.value })}
                                    className={inputCls}
                                    placeholder="my-service"
                                />
                            )}
                        </Field>

                        <Field label="Docker Image">
                            {(props) => (
                                <input
                                    {...props}
                                    type="text"
                                    value={form.image}
                                    onChange={e => setForm({ ...form, image: e.target.value })}
                                    className={inputCls}
                                    placeholder="nginx:latest"
                                />
                            )}
                        </Field>
                    </Card>
                </div>
            </div>
        </div>
    );
}

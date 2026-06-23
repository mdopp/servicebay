import { X, AlertCircle } from 'lucide-react';
import { Card, Button } from '@/components/ui';

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

function isValidHttpUrl(value: string): boolean {
    if (!value) return false;
    try {
        const u = new URL(value);
        return u.protocol === 'http:' || u.protocol === 'https:';
    } catch {
        return false;
    }
}

const labelCls = 'block text-xs font-medium text-text-muted mb-space-1';
const inputCls =
    'w-full px-space-3 py-space-2 rounded-card border border-border bg-surface-2 text-text ' +
    'placeholder:text-text-subtle focus:outline-none focus:ring-2 focus:ring-accent';

export default function ExternalLinkModal({ isOpen, onClose, onSave, isEditing, form, setForm }: ExternalLinkModalProps) {
    if (!isOpen) return null;
    const nameMissing = !form.name.trim();
    const urlInvalid = !isValidHttpUrl(form.url.trim());
    const canSave = !nameMissing && !urlInvalid;

    return (
        <div className="absolute inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-space-4">
            <Card padding="none" className="shadow-xl w-full max-w-md overflow-hidden">
                <div className="flex justify-between items-center p-space-4 border-b border-border">
                    <h3 className="text-lg font-bold text-text">{isEditing ? 'Edit External Link' : 'Add External Link'}</h3>
                    <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close">
                        <X size={20} />
                    </Button>
                </div>
                <div className="p-space-4 space-y-4">
                    <div>
                        <label className={labelCls}>Name</label>
                        <input
                            type="text"
                            value={form.name}
                            onChange={e => setForm({ ...form, name: e.target.value })}
                            className={inputCls}
                            placeholder="e.g. Home Assistant"
                        />
                    </div>
                    <div>
                        <label className={labelCls}>URL</label>
                        <input
                            type="url"
                            value={form.url}
                            onChange={e => setForm({ ...form, url: e.target.value })}
                            className={`w-full px-space-3 py-space-2 rounded-card border bg-surface-2 text-text placeholder:text-text-subtle focus:outline-none focus:ring-2 ${
                                form.url && urlInvalid
                                    ? 'border-status-fail focus:ring-status-fail'
                                    : 'border-border focus:ring-accent'
                            }`}
                            placeholder="http://192.168.1.10:8123"
                            aria-invalid={form.url ? urlInvalid : undefined}
                        />
                        {form.url && urlInvalid && (
                            <p className="mt-space-1 flex items-center gap-space-1 text-xs text-status-fail" role="alert">
                                <AlertCircle size={12} /> URL must start with http:// or https://
                            </p>
                        )}
                    </div>
                    <div>
                        <label className={labelCls}>Description (Optional)</label>
                        <input
                            type="text"
                            value={form.description}
                            onChange={e => setForm({ ...form, description: e.target.value })}
                            className={inputCls}
                            placeholder="Smart Home Control"
                        />
                    </div>
                    <label className="flex items-center gap-space-2 text-sm text-text-muted">
                        <input
                            type="checkbox"
                            checked={form.monitor}
                            onChange={e => setForm({ ...form, monitor: e.target.checked })}
                            className="rounded border-border text-accent focus:ring-accent"
                        />
                        Monitor this service (HTTP Check)
                    </label>
                    <div>
                        <label className={labelCls}>Target IPs/Ports (Optional)</label>
                        <input
                            type="text"
                            value={form.ipTargetsText || ''}
                            onChange={e => setForm({ ...form, ipTargetsText: e.target.value })}
                            className={inputCls}
                            placeholder="e.g. 192.168.1.10:8123, 10.0.0.5:80 (comma separated)"
                        />
                        <span className="text-xs text-text-subtle">Allows Nginx Reverse Proxy to detect edges to this external service.</span>
                    </div>
                </div>
                <div className="flex justify-end gap-space-2 p-space-4 border-t border-border bg-surface-2">
                    <Button variant="ghost" onClick={onClose}>
                        Cancel
                    </Button>
                    <Button onClick={onSave} disabled={!canSave}>
                        {isEditing ? 'Save Changes' : 'Add Link'}
                    </Button>
                </div>
            </Card>
        </div>
    );
}

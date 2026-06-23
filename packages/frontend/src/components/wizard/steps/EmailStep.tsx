import React, { useState } from 'react';
import { Mail, CheckCircle, AlertCircle, ShieldCheck, Loader2 } from 'lucide-react';
import { Input, Button } from '../WizardUI';
import { Card } from '@/components/ui';
import { saveEmailConfig } from '@/app/actions/onboarding';

interface EmailConfig {
    host: string;
    port: number;
    secure: boolean;
    user: string;
    pass: string;
    from: string;
    recipients: string;
}

interface EmailStepProps {
    emailConfig: EmailConfig;
    setEmailConfig: React.Dispatch<React.SetStateAction<EmailConfig>>;
}

export function EmailStep({ emailConfig, setEmailConfig }: EmailStepProps) {
    const [testing, setTesting] = useState(false);
    const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

    const handleTestEmail = async () => {
        setTesting(true);
        setTestResult(null);
        try {
            // 1. Save SMTP settings in the background
            await saveEmailConfig(emailConfig);

            // 2. Validate first recipient email address format
            const recipientsArray = emailConfig.recipients.split(',').map(s => s.trim()).filter(Boolean);
            const firstRecipient = recipientsArray[0];

            if (!firstRecipient) {
                setTestResult({ ok: false, message: 'Please specify at least one recipient email address.' });
                return;
            }

            // 3. Send test POST
            const res = await fetch('/api/system/notifications/email/test', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ to: firstRecipient }),
            });
            const data = await res.json().catch(() => ({}));
            
            if (res.ok && data.ok) {
                setTestResult({ ok: true, message: `Test email sent to ${firstRecipient}! Check your inbox.` });
            } else {
                setTestResult({
                    ok: false,
                    message: data.error || `SMTP error: HTTP ${res.status}`
                });
            }
        } catch (e) {
            setTestResult({
                ok: false,
                message: e instanceof Error ? e.message : 'Network error while testing SMTP connection.'
            });
        } finally {
            setTesting(false);
        }
    };

    const canTest = emailConfig.host.trim().length > 0 && emailConfig.user.trim().length > 0 && emailConfig.recipients.trim().length > 0;

    return (
        <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
            <div className="flex items-center gap-3">
                <div className="p-2.5 rounded-card bg-status-fail/10 border border-status-fail/20">
                    <Mail className="w-5 h-5 text-status-fail"/>
                </div>
                <div>
                    <h3 className="font-bold text-lg leading-none text-text">Email Notifications</h3>
                    <p className="text-xs text-text-muted mt-1">Configure SMTP settings for system alerts</p>
                </div>
            </div>

            <Card padding="lg" className="space-y-5">
                 <div className="grid grid-cols-3 gap-4">
                      <div className="col-span-2">
                        <Input label="SMTP Host" value={emailConfig.host} onChange={(v: string) => setEmailConfig(c => ({...c, host: v}))} placeholder="smtp.gmail.com" />
                      </div>
                      <Input label="Port" value={String(emailConfig.port)} onChange={(v: string) => setEmailConfig(c => ({...c, port: parseInt(v) || 587}))} placeholder="587" type="number" hint="587 TLS / 465 SSL" />
                 </div>
                 <div className="grid grid-cols-2 gap-4">
                      <Input label="Username" value={emailConfig.user} onChange={(v: string) => setEmailConfig(c => ({...c, user: v}))} placeholder="user@example.com" />
                      <Input label="Password" type="password" value={emailConfig.pass} onChange={(v: string) => setEmailConfig(c => ({...c, pass: v}))} />
                 </div>
                 <div className="grid grid-cols-2 gap-4 items-end">
                      <Input
                        label="From Address"
                        value={emailConfig.from}
                        onChange={(v: string) => setEmailConfig(c => ({...c, from: v}))}
                        placeholder="servicebay@example.com"
                        error={emailConfig.from && !emailConfig.from.match(/^[^\s@]+@[^\s@]+\.[^\s@]+$/) ? 'Invalid format' : undefined}
                      />
                      <div className="pb-1.5">
                        <label className="flex items-center gap-3 p-2.5 rounded-card border border-border hover:bg-surface-2 cursor-pointer transition-colors">
                            <input type="checkbox" checked={emailConfig.secure} onChange={e => setEmailConfig(c => ({...c, secure: e.target.checked}))} className="w-4 h-4 rounded border-border text-accent focus:ring-accent" />
                            <span className="text-sm font-medium text-text-muted">Use SSL/TLS</span>
                        </label>
                      </div>
                 </div>
                 <Input label="Recipients (comma separated)" value={emailConfig.recipients} onChange={(v: string) => setEmailConfig(c => ({...c, recipients: v}))} placeholder="admin@example.com" />

                 <div className="flex flex-wrap items-center gap-3 pt-2 border-t border-border">
                     <Button
                         type="button"
                         onClick={handleTestEmail}
                         disabled={!canTest || testing}
                         variant="outline"
                         className="!py-2 !px-4 !text-xs flex items-center gap-2"
                     >
                         {testing
                             ? <Loader2 className="w-4 h-4 animate-spin" />
                             : <ShieldCheck className="w-4 h-4" />}
                         Verify SMTP & Send Test Alert
                     </Button>
                     {testResult?.ok && (
                         <span className="flex items-center gap-2 text-xs font-medium text-status-ok bg-status-ok/10 px-3 py-1.5 rounded-card border border-status-ok/20">
                             <CheckCircle className="w-4 h-4" /> {testResult.message}
                         </span>
                     )}
                     {testResult && !testResult.ok && (
                         <span className="flex items-start gap-2 text-xs font-medium text-status-fail bg-status-fail/10 px-3 py-1.5 rounded-card border border-status-fail/20 max-w-lg">
                             <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                             <span>{testResult.message}</span>
                         </span>
                     )}
                 </div>
            </Card>
        </div>
    );
}

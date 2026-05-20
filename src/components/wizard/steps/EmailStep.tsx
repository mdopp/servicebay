'use client';

import React from 'react';
import { Mail } from 'lucide-react';
import { Input } from '../WizardUI';

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
    return (
        <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
            <div className="flex items-center gap-3">
                <div className="p-2.5 rounded-xl bg-red-500/10 border border-red-500/20">
                    <Mail className="w-5 h-5 text-red-500"/>
                </div>
                <div>
                    <h3 className="font-bold text-lg leading-none">Email Notifications</h3>
                    <p className="text-xs text-gray-500 mt-1">Configure SMTP settings for system alerts</p>
                </div>
            </div>

            <div className="p-5 rounded-2xl bg-gray-50/50 dark:bg-white/5 border border-gray-200 dark:border-white/5 space-y-5">
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
                        <label className="flex items-center gap-3 p-2.5 rounded-xl border border-gray-200 dark:border-white/10 hover:bg-white/5 cursor-pointer transition-colors">
                            <input type="checkbox" checked={emailConfig.secure} onChange={e => setEmailConfig(c => ({...c, secure: e.target.checked}))} className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500" />
                            <span className="text-sm font-medium text-gray-700 dark:text-gray-300">Use SSL/TLS</span>
                        </label>
                      </div>
                 </div>
                 <Input label="Recipients (comma separated)" value={emailConfig.recipients} onChange={(v: string) => setEmailConfig(c => ({...c, recipients: v}))} placeholder="admin@example.com" />
            </div>
        </div>
    );
}

'use client';


import { Globe, HardDrive, Layers, CheckCircle, AlertTriangle, Loader2, Monitor } from 'lucide-react';
import type { Template } from '@servicebay/api-client';
import { Input, Button } from '../WizardUI';

type WizardStep = 'welcome' | 'network' | 'email' | 'install-confirm' | 'stacks' | 'finish';

interface DetectedDrive {
    name: string;
    path: string;
    type: string;
    size: string;
    model?: string;
    rota?: boolean;
    mountpoint?: string | null;
}

interface DetectedRaid {
    device: string;
    label: string;
    fstype: string;
    size: string;
    mountpoint: string | null;
    degraded: boolean;
}

interface MachineStepProps {
    installMode: 'public' | 'lan';
    setInstallMode: (v: 'public' | 'lan') => void;
    publicDomain: string;
    setPublicDomain: (v: string) => void;
    operatorEmail: string;
    setOperatorEmail: (v: string) => void;
    isValidOperatorEmail: (v: string) => boolean;
    operatorEmailIssue: (v: string) => string;
    detectedRaid: DetectedRaid | undefined;
    availableStacks: Template[];
    navigateTo: (step: WizardStep) => void;
    detectedDrives: DetectedDrive[];
    stackLoadingDevices: boolean;
}

export function MachineStep({
    installMode,
    setInstallMode,
    publicDomain,
    setPublicDomain,
    operatorEmail,
    setOperatorEmail,
    isValidOperatorEmail,
    operatorEmailIssue,
    detectedRaid,
    availableStacks,
    navigateTo,
    detectedDrives,
    stackLoadingDevices,
}: MachineStepProps) {
    return (
        <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
            <div className="flex items-center gap-3">
                <div className="p-2.5 rounded-xl bg-accent/10 border border-accent/20">
                    <HardDrive className="w-5 h-5 text-accent"/>
                </div>
                <div className="flex-1">
                    <h3 className="font-bold text-lg leading-none">Machine & Review</h3>
                    <p className="text-xs text-text-muted mt-1">Finalize host configuration and storage</p>
                </div>
                <Button
                    variant="outline"
                    onClick={() => navigateTo('stacks')}
                    className="!py-1.5 !px-3 !text-xs"
                >
                    Pick stacks
                </Button>
            </div>

            <p className="text-sm text-text-muted leading-relaxed">
                We&apos;ll install the recommended stack with sensible defaults. Adjust the questions below, or click <em>Pick stacks</em> to choose individual services.
            </p>

            {!publicDomain.trim() && installMode === 'public' && (
                <div className="flex items-start gap-4 p-4 rounded-2xl border border-status-warn dark:border-status-warn/30 bg-surface-2 dark:bg-status-warn/10 shadow-sm">
                    <AlertTriangle className="w-6 h-6 text-status-warn shrink-0" />
                    <div className="flex-1 space-y-2">
                        <div className="text-sm font-bold text-status-warn dark:text-status-warn">Public domain not set</div>
                        <p className="text-xs text-status-warn dark:text-status-warn leading-relaxed">
                            A public domain is required for Let&apos;s Encrypt and external access.
                        </p>
                        <Button variant="outline" onClick={() => navigateTo('network')} className="!py-1.5 !px-3 !text-xs">
                            Return to Network
                        </Button>
                    </div>
                </div>
            )}

            <div className="space-y-4">
                {/* Reachability Card */}
                <div className="p-5 rounded-2xl soft-depth space-y-4">
                    <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-status-info">
                        <Globe className="w-4 h-4" /> Reachability
                    </div>
                    
                    <div role="radiogroup" aria-label="Install mode" className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <label
                            id="mode-public"
                            htmlFor="mode-public-input"
                            className={`flex flex-col gap-2 p-4 rounded-xl border cursor-pointer transition-all ${
                                installMode === 'public'
                                ? 'bg-surface dark:bg-accent/10 border-accent shadow-sm ring-1 ring-accent'
                                : 'bg-surface-2 dark:bg-surface border-border dark:border-border opacity-60'
                            }`}
                        >
                            <input
                                id="mode-public-input"
                                type="radio"
                                name="installMode"
                                value="public"
                                aria-label="Yes, public domain"
                                checked={installMode === 'public'}
                                onChange={() => setInstallMode('public')}
                                className="sr-only"
                            />
                            <div className="flex items-center justify-between">
                                <div className="text-sm font-bold">Public Domain</div>
                                {installMode === 'public' && <CheckCircle className="w-4 h-4 text-accent" />}
                            </div>
                            <p className="text-[10px] text-text-muted">HTTPS + Let&apos;s Encrypt</p>
                        </label>

                        <label
                            id="mode-lan"
                            htmlFor="mode-lan-input"
                            className={`flex flex-col gap-2 p-4 rounded-xl border cursor-pointer transition-all ${
                                installMode === 'lan'
                                ? 'bg-surface dark:bg-status-warn/10 border-status-warn shadow-sm ring-1 ring-status-warn'
                                : 'bg-surface-2 dark:bg-surface border-border dark:border-border opacity-60'
                            }`}
                        >
                            <input
                                id="mode-lan-input"
                                type="radio"
                                name="installMode"
                                value="lan"
                                aria-label="No, internal only"
                                checked={installMode === 'lan'}
                                onChange={() => setInstallMode('lan')}
                                className="sr-only"
                            />
                            <div className="flex items-center justify-between">
                                <div className="text-sm font-bold">Internal Only</div>
                                {installMode === 'lan' && <CheckCircle className="w-4 h-4 text-status-warn" />}
                            </div>
                            <p className="text-[10px] text-text-muted">LAN-only via AdGuard</p>
                        </label>
                    </div>

                    {installMode === 'public' && (
                        <div className="space-y-4 pt-2 animate-in fade-in duration-300">
                            <Input
                                label="Public Domain"
                                value={publicDomain}
                                onChange={v => setPublicDomain(v)}
                                placeholder="example.com"
                                hint="Required for Let's Encrypt and external access"
                            />
                            <Input
                                label="Operator Email"
                                value={operatorEmail}
                                onChange={v => setOperatorEmail(v)}
                                placeholder="you@example.com"
                                hint="Used for SSL certificates and admin alerts"
                                error={operatorEmail && !isValidOperatorEmail(operatorEmail) ? operatorEmailIssue(operatorEmail) : undefined}
                            />
                        </div>
                    )}
                </div>

                {/* Storage & Stacks Summary */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div className="p-4 rounded-2xl soft-depth space-y-3">
                        <div className="flex items-center gap-2 text-xs font-bold text-text-muted uppercase tracking-widest">
                            <HardDrive className="w-4 h-4 text-accent" /> Storage
                        </div>
                        <div className="text-sm font-medium">
                            {detectedRaid ? (
                                <span className="flex items-center gap-1.5">
                                    RAID Array <code className="bg-accent/10 text-accent px-1.5 py-0.5 rounded text-[10px]">{detectedRaid.device}</code>
                                </span>
                            ) : 'Local Storage'}
                        </div>
                        <p className="text-[10px] text-text-muted">
                            Mounting to <code className="bg-surface-2 dark:bg-surface px-1 rounded">/var/mnt/data</code>
                        </p>
                    </div>

                    <div className="p-4 rounded-2xl soft-depth space-y-3">
                        <div className="flex items-center gap-2 text-xs font-bold text-text-muted uppercase tracking-widest">
                            <Layers className="w-4 h-4 text-accent" /> Services
                        </div>
                        <div className="text-sm font-medium">
                            {availableStacks.length} Recommended Stacks
                        </div>
                        <p className="text-[10px] text-text-muted truncate">
                            {availableStacks.map(s => s.name).join(', ')}
                        </p>
                    </div>
                </div>

                {/* Detected Drives Panel */}
                <div className="p-5 rounded-2xl soft-depth space-y-4">
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2 text-xs font-bold text-text-muted uppercase tracking-widest">
                            <Monitor className="w-4 h-4 text-accent" /> Detected Drives
                        </div>
                        {stackLoadingDevices && <Loader2 className="w-3 h-3 animate-spin text-text-muted" />}
                    </div>
                    
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                        {detectedDrives.length === 0 ? (
                            <div className="col-span-full py-4 text-center text-xs text-text-muted italic">
                                {stackLoadingDevices ? 'Scanning hardware...' : 'No additional drives detected.'}
                            </div>
                        ) : (
                            detectedDrives.map(drive => (
                                <div key={drive.name} className="p-3 rounded-xl bg-surface dark:bg-surface border border-border dark:border-border flex items-center gap-3">
                                    <div className="p-2 rounded-lg bg-surface-2 dark:bg-surface text-text-muted">
                                        <HardDrive className="w-4 h-4" />
                                    </div>
                                    <div className="min-w-0">
                                        <div className="text-xs font-bold truncate">{drive.name}</div>
                                        <div className="text-[10px] text-text-muted">{drive.size} · {drive.model || 'Unknown Disk'}</div>
                                    </div>
                                </div>
                            ))
                        )}
                    </div>
                </div>

            </div>
        </div>
    );
}

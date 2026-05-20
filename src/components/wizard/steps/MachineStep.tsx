'use client';


import { Globe, HardDrive, Layers, CheckCircle, AlertTriangle, Loader2, Monitor } from 'lucide-react';
import type { Template } from '@/lib/registry';
import { Input, Button } from '../WizardUI';
import CleanInstallPanel from '../../CleanInstallPanel';

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
    cleanInstall: boolean;
    setCleanInstall: (v: boolean) => void;
    cleanInstallConfirm: string;
    setCleanInstallConfirm: (v: string) => void;
    preserve: string[] | undefined;
    setPreserve: (v: string[] | undefined) => void;
    stackSelectedNode: string | null;
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
    cleanInstall,
    setCleanInstall,
    cleanInstallConfirm,
    setCleanInstallConfirm,
    preserve,
    setPreserve,
    stackSelectedNode,
    navigateTo,
    detectedDrives,
    stackLoadingDevices,
}: MachineStepProps) {
    return (
        <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
            <div className="flex items-center gap-3">
                <div className="p-2.5 rounded-xl bg-indigo-500/10 border border-indigo-500/20">
                    <HardDrive className="w-5 h-5 text-indigo-500"/>
                </div>
                <div className="flex-1">
                    <h3 className="font-bold text-lg leading-none">Machine & Review</h3>
                    <p className="text-xs text-gray-500 mt-1">Finalize host configuration and storage</p>
                </div>
                <Button
                    variant="outline"
                    onClick={() => navigateTo('stacks')}
                    className="!py-1.5 !px-3 !text-xs"
                >
                    Pick stacks
                </Button>
            </div>

            <p className="text-sm text-gray-500 leading-relaxed">
                We&apos;ll install the recommended stack with sensible defaults. Adjust the questions below, or click <em>Pick stacks</em> to choose individual services.
            </p>

            {!publicDomain.trim() && installMode === 'public' && (
                <div className="flex items-start gap-4 p-4 rounded-2xl border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 shadow-sm">
                    <AlertTriangle className="w-6 h-6 text-amber-500 shrink-0" />
                    <div className="flex-1 space-y-2">
                        <div className="text-sm font-bold text-amber-900 dark:text-amber-200">Public domain not set</div>
                        <p className="text-xs text-amber-800 dark:text-amber-300/80 leading-relaxed">
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
                    <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-blue-500/80">
                        <Globe className="w-4 h-4" /> Reachability
                    </div>
                    
                    <div role="radiogroup" aria-label="Install mode" className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <label
                            id="mode-public"
                            htmlFor="mode-public-input"
                            className={`flex flex-col gap-2 p-4 rounded-xl border cursor-pointer transition-all ${
                                installMode === 'public'
                                ? 'bg-white dark:bg-blue-600/10 border-blue-400 shadow-sm ring-1 ring-blue-400'
                                : 'bg-gray-50 dark:bg-white/5 border-gray-200 dark:border-white/5 opacity-60'
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
                                {installMode === 'public' && <CheckCircle className="w-4 h-4 text-blue-500" />}
                            </div>
                            <p className="text-[10px] text-gray-500">HTTPS + Let&apos;s Encrypt</p>
                        </label>

                        <label
                            id="mode-lan"
                            htmlFor="mode-lan-input"
                            className={`flex flex-col gap-2 p-4 rounded-xl border cursor-pointer transition-all ${
                                installMode === 'lan'
                                ? 'bg-white dark:bg-amber-600/10 border-amber-400 shadow-sm ring-1 ring-amber-400'
                                : 'bg-gray-50 dark:bg-white/5 border-gray-200 dark:border-white/5 opacity-60'
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
                                {installMode === 'lan' && <CheckCircle className="w-4 h-4 text-amber-500" />}
                            </div>
                            <p className="text-[10px] text-gray-500">LAN-only via AdGuard</p>
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
                        <div className="flex items-center gap-2 text-xs font-bold text-gray-400 uppercase tracking-widest">
                            <HardDrive className="w-4 h-4 text-indigo-500" /> Storage
                        </div>
                        <div className="text-sm font-medium">
                            {detectedRaid ? (
                                <span className="flex items-center gap-1.5">
                                    RAID Array <code className="bg-blue-500/10 text-blue-500 px-1.5 py-0.5 rounded text-[10px]">{detectedRaid.device}</code>
                                </span>
                            ) : 'Local Storage'}
                        </div>
                        <p className="text-[10px] text-gray-500">
                            Mounting to <code className="bg-gray-100 dark:bg-white/10 px-1 rounded">/var/mnt/data</code>
                        </p>
                    </div>

                    <div className="p-4 rounded-2xl soft-depth space-y-3">
                        <div className="flex items-center gap-2 text-xs font-bold text-gray-400 uppercase tracking-widest">
                            <Layers className="w-4 h-4 text-indigo-500" /> Services
                        </div>
                        <div className="text-sm font-medium">
                            {availableStacks.length} Recommended Stacks
                        </div>
                        <p className="text-[10px] text-gray-500 truncate">
                            {availableStacks.map(s => s.name).join(', ')}
                        </p>
                    </div>
                </div>

                {/* Detected Drives Panel */}
                <div className="p-5 rounded-2xl soft-depth space-y-4">
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2 text-xs font-bold text-gray-400 uppercase tracking-widest">
                            <Monitor className="w-4 h-4 text-indigo-500" /> Detected Drives
                        </div>
                        {stackLoadingDevices && <Loader2 className="w-3 h-3 animate-spin text-gray-400" />}
                    </div>
                    
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                        {detectedDrives.length === 0 ? (
                            <div className="col-span-full py-4 text-center text-xs text-gray-500 italic">
                                {stackLoadingDevices ? 'Scanning hardware...' : 'No additional drives detected.'}
                            </div>
                        ) : (
                            detectedDrives.map(drive => (
                                <div key={drive.name} className="p-3 rounded-xl bg-white dark:bg-white/5 border border-gray-100 dark:border-white/5 flex items-center gap-3">
                                    <div className="p-2 rounded-lg bg-gray-50 dark:bg-white/5 text-gray-400">
                                        <HardDrive className="w-4 h-4" />
                                    </div>
                                    <div className="min-w-0">
                                        <div className="text-xs font-bold truncate">{drive.name}</div>
                                        <div className="text-[10px] text-gray-500">{drive.size} · {drive.model || 'Unknown Disk'}</div>
                                    </div>
                                </div>
                            ))
                        )}
                    </div>
                </div>

                <CleanInstallPanel
                    cleanInstall={cleanInstall}
                    setCleanInstall={setCleanInstall}
                    cleanInstallConfirm={cleanInstallConfirm}
                    setCleanInstallConfirm={setCleanInstallConfirm}
                    preserve={preserve}
                    setPreserve={setPreserve}
                    node={stackSelectedNode || undefined}
                />
            </div>
        </div>
    );
}

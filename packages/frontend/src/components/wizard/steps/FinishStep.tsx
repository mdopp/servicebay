'use client';


import { useEffect, useState } from 'react';
import { CheckCircle, ArrowRight, DatabaseBackup } from 'lucide-react';
import { Button } from '../WizardUI';

interface FinishStepProps {
    handleFinish: () => void;
}

interface OrphanBackup { service: string; tarName: string; size: number }

/**
 * #1218 entry point 2 — surface NAS config backups for services the operator
 * didn't (re)install, so they can set them up + re-seed config (entry-1 restore
 * runs on install). Silent when there are none / the NAS is unreachable.
 */
function OrphanBackupsHint() {
    const [orphans, setOrphans] = useState<OrphanBackup[]>([]);
    useEffect(() => {
        let alive = true;
        fetch('/api/system/external-backup/orphans', { credentials: 'include' })
            .then(r => (r.ok ? r.json() : { orphans: [] }))
            .then(d => { if (alive) setOrphans(Array.isArray(d.orphans) ? d.orphans : []); })
            .catch(() => { /* NAS unreachable — just don't show the hint */ });
        return () => { alive = false; };
    }, []);

    if (orphans.length === 0) return null;

    return (
        <div className="mx-auto max-w-md text-left rounded-2xl border border-blue-500/20 bg-blue-500/5 p-5">
            <div className="flex items-center gap-2 text-blue-600 dark:text-blue-400">
                <DatabaseBackup className="w-5 h-5 shrink-0" />
                <span className="font-semibold">
                    {orphans.length} service backup{orphans.length === 1 ? '' : 's'} on your FritzBox NAS
                </span>
            </div>
            <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
                Config for {orphans.map(o => o.service).join(', ')} is on the NAS but not installed here.
                Install {orphans.length === 1 ? 'it' : 'them'} and the saved config is restored automatically.
            </p>
            <a
                href="/services"
                className="mt-3 inline-flex items-center gap-1.5 text-sm font-medium text-blue-600 dark:text-blue-400 hover:underline"
            >
                Set them up <ArrowRight className="w-4 h-4" />
            </a>
        </div>
    );
}

export function FinishStep({ handleFinish }: FinishStepProps) {
    return (
        <div className="space-y-8 py-8 text-center animate-in fade-in zoom-in-95 duration-500">
            <div className="relative inline-block">
                <div className="absolute inset-0 bg-emerald-500/20 blur-3xl rounded-full"></div>
                <div className="relative p-6 rounded-3xl bg-emerald-500/10 border border-emerald-500/20">
                    <CheckCircle className="w-16 h-16 text-emerald-500" />
                </div>
            </div>

            <div className="space-y-3">
                <h3 className="text-3xl font-extrabold tracking-tight bg-clip-text text-transparent premium-gradient">
                    You&apos;re All Set!
                </h3>
                <p className="text-gray-600 dark:text-gray-400 max-w-md mx-auto leading-relaxed">
                    Your ServiceBay environment has been successfully configured. You can now access your dashboard and start managing your services.
                </p>
            </div>

            <OrphanBackupsHint />

            <div className="pt-4">
                <Button onClick={handleFinish} className="w-full sm:w-auto px-12 py-4 text-lg">
                    Go to Dashboard <ArrowRight className="w-5 h-5 ml-2" />
                </Button>
            </div>

            <p className="text-[10px] text-gray-400 uppercase tracking-widest font-bold">
                Setup Complete · Welcome Home
            </p>
        </div>
    );
}

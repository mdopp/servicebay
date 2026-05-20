'use client';

import { useState } from 'react';
import { Globe, Network, Key, CheckCircle, Loader2, AlertCircle, ShieldCheck } from 'lucide-react';
import { Input, Button } from '../WizardUI';
import { OnboardingStatus } from '@/app/actions/onboarding';

interface NetworkStepProps {
    selection: {
        gateway: boolean;
        ssh: boolean;
    };
    publicDomain: string;
    setPublicDomain: (v: string) => void;
    gwHost: string;
    setGwHost: (v: string) => void;
    gwUser: string;
    setGwUser: (v: string) => void;
    gwPass: string;
    setGwPass: (v: string) => void;
    status: OnboardingStatus | null;
    handleGenerateKey: () => Promise<void>;
    loading: boolean;
}

export function NetworkStep({
    selection,
    publicDomain,
    setPublicDomain,
    gwHost,
    setGwHost,
    gwUser,
    setGwUser,
    gwPass,
    setGwPass,
    status,
    handleGenerateKey,
    loading
}: NetworkStepProps) {
    return (
        <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
            <section className="space-y-4">
                <div className="flex items-center gap-3">
                    <div className="p-2.5 rounded-xl bg-blue-500/10 border border-blue-500/20">
                        <Globe className="w-5 h-5 text-blue-500"/>
                    </div>
                    <div>
                        <h3 className="font-bold text-lg leading-none">Public Domain</h3>
                        <p className="text-xs text-gray-500 mt-1">Configure your external access entry point</p>
                    </div>
                </div>
                <div className="p-5 rounded-2xl bg-gray-50/50 dark:bg-white/5 border border-gray-200 dark:border-white/5">
                    <Input label="Public Domain" value={publicDomain} onChange={setPublicDomain} placeholder="example.com" hint="Required for Let's Encrypt and external access" />
                </div>
            </section>

            {selection.gateway && (
                <GatewaySection
                    gwHost={gwHost}
                    setGwHost={setGwHost}
                    gwUser={gwUser}
                    setGwUser={setGwUser}
                    gwPass={gwPass}
                    setGwPass={setGwPass}
                />
            )}

            {selection.ssh && (
                <section className="space-y-4">
                    <div className="flex items-center gap-3">
                        <div className="p-2.5 rounded-xl bg-amber-500/10 border border-amber-500/20">
                            <Key className="w-5 h-5 text-amber-500"/>
                        </div>
                        <div>
                            <h3 className="font-bold text-lg leading-none">Remote Access (SSH)</h3>
                            <p className="text-xs text-gray-500 mt-1">Generate keys for multi-node management</p>
                        </div>
                     </div>

                    <div className="p-5 rounded-2xl bg-gray-50/50 dark:bg-white/5 border border-gray-200 dark:border-white/5 space-y-4">
                        <p className="text-sm text-gray-600 dark:text-gray-300 leading-relaxed">
                            {status?.hasSshKey
                              ? "An existing SSH key was detected. Your system is already prepared for remote node management."
                              : "No SSH key found. We recommend generating one now to enable management of remote nodes via SSH."}
                        </p>
                        {!status?.hasSshKey && (
                             <Button onClick={handleGenerateKey} disabled={loading} className="w-full py-3">
                                {loading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Key className="w-4 h-4 mr-2" />}
                                Generate New SSH Key
                             </Button>
                        )}
                        {status?.hasSshKey && (
                            <div className="flex items-center gap-2 text-xs font-medium text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 p-3 rounded-xl border border-emerald-500/20">
                                <CheckCircle className="w-4 h-4" /> SSH Infrastructure Ready
                            </div>
                        )}
                    </div>
                </section>
            )}
        </div>
    );
}

/**
 * Gateway (FRITZ!Box) setup block with an inline "Verify connection"
 * affordance (#726). Device discovery + port-forward management +
 * Wake-on-LAN all depend on the gateway being reachable; an
 * operator who can't connect here will hit confusing failures in
 * `domain_external_reachability` and the install runner's
 * port-forward provisioner later. The button hits the same
 * `/api/settings/gateway` endpoint with `test: true` that the
 * Settings → Gateway page uses, so the validation logic is shared.
 */
function GatewaySection({
    gwHost,
    setGwHost,
    gwUser,
    setGwUser,
    gwPass,
    setGwPass,
}: {
    gwHost: string;
    setGwHost: (v: string) => void;
    gwUser: string;
    setGwUser: (v: string) => void;
    gwPass: string;
    setGwPass: (v: string) => void;
}) {
    const [testing, setTesting] = useState(false);
    const [result, setResult] = useState<
        { kind: 'ok'; message: string } | { kind: 'fail'; message: string } | null
    >(null);

    const handleVerify = async () => {
        setTesting(true);
        setResult(null);
        try {
            const res = await fetch('/api/settings/gateway', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    host: gwHost.trim(),
                    username: gwUser.trim() || undefined,
                    password: gwPass || undefined,
                    test: true,
                }),
            });
            const data = await res.json().catch(() => ({}));
            if (res.ok) {
                setResult({ kind: 'ok', message: `Reached ${gwHost} successfully.` });
            } else if (data.error === 'connection_failed') {
                setResult({
                    kind: 'fail',
                    message: typeof data.message === 'string'
                        ? `Could not authenticate: ${data.message}`
                        : 'Could not authenticate to the gateway.',
                });
            } else {
                setResult({
                    kind: 'fail',
                    message: typeof data.error === 'string' ? data.error : `HTTP ${res.status}`,
                });
            }
        } catch (e) {
            setResult({
                kind: 'fail',
                message: e instanceof Error ? e.message : 'Network error while reaching the gateway.',
            });
        } finally {
            setTesting(false);
        }
    };

    const canVerify = gwHost.trim().length > 0;

    return (
        <section className="space-y-4">
            <div className="flex items-center gap-3">
                <div className="p-2.5 rounded-xl bg-purple-500/10 border border-purple-500/20">
                    <Network className="w-5 h-5 text-purple-500" />
                </div>
                <div>
                    <h3 className="font-bold text-lg leading-none">Internet Gateway</h3>
                    <p className="text-xs text-gray-500 mt-1">
                        FRITZ!Box powers device discovery, Wake-on-LAN and port-forward
                        management — verify the connection before continuing.
                    </p>
                </div>
            </div>

            <div className="grid gap-4 p-5 rounded-2xl bg-gray-50/50 dark:bg-white/5 border border-gray-200 dark:border-white/5">
                <Input
                    label="Hostname / IP"
                    value={gwHost}
                    onChange={setGwHost}
                    placeholder="fritz.box"
                    hint="Standard is fritz.box"
                />
                <div className="grid grid-cols-2 gap-4">
                    <Input label="Username" value={gwUser} onChange={setGwUser} placeholder="admin" />
                    <Input label="Password" type="password" value={gwPass} onChange={setGwPass} />
                </div>

                <div className="flex flex-wrap items-center gap-3 pt-1">
                    <Button
                        onClick={handleVerify}
                        disabled={!canVerify || testing}
                        variant="outline"
                        className="!py-2 !px-4 !text-sm flex items-center gap-2"
                    >
                        {testing
                            ? <Loader2 className="w-4 h-4 animate-spin" />
                            : <ShieldCheck className="w-4 h-4" />}
                        Verify Connection
                    </Button>
                    {result?.kind === 'ok' && (
                        <span className="flex items-center gap-2 text-xs font-medium text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 px-3 py-1.5 rounded-xl border border-emerald-500/20">
                            <CheckCircle className="w-4 h-4" /> {result.message}
                        </span>
                    )}
                    {result?.kind === 'fail' && (
                        <span className="flex items-center gap-2 text-xs font-medium text-red-600 dark:text-red-400 bg-red-500/10 px-3 py-1.5 rounded-xl border border-red-500/20">
                            <AlertCircle className="w-4 h-4" /> {result.message}
                        </span>
                    )}
                </div>
            </div>
        </section>
    );
}

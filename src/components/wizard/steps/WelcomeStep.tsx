'use client';

import React from 'react';
import { Network, Key, RefreshCw, Box, Layers, Mail } from 'lucide-react';
import { Toggle } from '../WizardUI';

interface WelcomeStepProps {
    selection: {
        gateway: boolean;
        ssh: boolean;
        updates: boolean;
        registries: boolean;
        email: boolean;
        stacks: boolean;
    };
    setSelection: React.Dispatch<React.SetStateAction<{
        gateway: boolean;
        ssh: boolean;
        updates: boolean;
        registries: boolean;
        email: boolean;
        stacks: boolean;
    }>>;
}

export function WelcomeStep({ selection, setSelection }: WelcomeStepProps) {
    return (
        <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
            <div>
                <h3 className="text-2xl font-extrabold tracking-tight bg-clip-text text-transparent premium-gradient">
                    Welcome to ServiceBay
                </h3>
                <p className="text-sm text-gray-600 dark:text-gray-400 mt-1 leading-relaxed">
                    Let&apos;s get your environment ready. You can skip any step and configure it later in Settings.
                </p>
            </div>
            
            <div className="space-y-3">
                {/*
                  Gateway sits in its own section above the rest of the
                  selection because device discovery + WoL + port-forward
                  management all rely on it (#726). The verify-connection
                  affordance lives in NetworkStep; this is the toggle that
                  decides whether NetworkStep renders the FRITZ!Box block
                  at all. Operator can still skip it, but the
                  "Prerequisites" framing makes the impact explicit
                  rather than hiding it among optional toggles.
                */}
                <p className="text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-widest ml-1">
                    Prerequisites
                </p>
                <Toggle
                    checked={selection.gateway}
                    onChange={(v: boolean) => setSelection(s => ({...s, gateway: v}))}
                    icon={Network}
                    color="text-purple-500"
                    title="FRITZ!Box gateway"
                    desc="Required for device discovery, Wake-on-LAN and port-forward management — you'll verify the connection on the next step."
                />

                <p className="pt-3 text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-widest ml-1">
                    Recommended Setup
                </p>
                <Toggle 
                    checked={selection.ssh} 
                    onChange={(v: boolean) => setSelection(s => ({...s, ssh: v}))}
                    icon={Key} 
                    color="text-amber-500"
                    title="Remote Access" 
                    desc="SSH keys for node management"
                />
                <Toggle 
                    checked={selection.updates} 
                    onChange={(v: boolean) => setSelection(s => ({...s, updates: v}))}
                    icon={RefreshCw} 
                    color="text-green-500"
                    title="Auto Updates" 
                    desc="Keep ServiceBay and containers updated"
                />
                 <Toggle
                    checked={selection.registries}
                    onChange={(v: boolean) => setSelection(s => ({...s, registries: v}))}
                    icon={Box}
                    color="text-blue-500"
                    title="Templates"
                    desc="Enable GitHub template registries"
                />
                <Toggle
                    checked={selection.stacks}
                    onChange={(v: boolean) => setSelection(s => ({...s, stacks: v}))}
                    icon={Layers}
                    color="text-indigo-500"
                    title="Install Stack"
                    desc="Deploy a pre-configured service bundle"
                />
                <Toggle
                    checked={selection.email}
                    onChange={(v: boolean) => setSelection(s => ({...s, email: v}))}
                    icon={Mail}
                    color="text-red-500"
                    title="Notifications"
                    desc="Email alerts for service health"
                />
            </div>
        </div>
    );
}

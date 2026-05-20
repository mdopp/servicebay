'use client';

import { useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { Layers, Package, Loader2, CheckCircle, Box, ArrowRight } from 'lucide-react';
import { Button } from '../WizardUI';
import type { Template } from '@/lib/registry';
import type { StackItem as BaseStackItem, StackVariable, useStackInstall } from '@/hooks/useStackInstall';
import type { TemplateTier } from '@/lib/templateTier';
import type { DiagnoseProbe } from '../../DiagnoseProbeList';

// Wizard-side StackItem extends the canonical hook type with the
// presentation fields the picker / configure / summary need (tier
// rollup, short description, subdomain list rendered into the
// DoneStepDnsCheck). OnboardingWizard.tsx populates these from the
// template manifest during loadStacks / handleSelectStack.
interface StackItem extends BaseStackItem {
    description?: string;
    tier?: TemplateTier;
    subdomains?: string[];
}

interface ServiceDeps {
    requires?: string[];
    recommendedWith?: string[];
    reason?: string;
}
import StackVariableField from '../../StackVariableField';
import { groupVariablesByTemplate } from '@/lib/stackInstall/groupVariables';
import { StackInstallProgress, StackInstallSummary } from '../../StackInstallFlow';
import DiagnoseProbeList from '../../DiagnoseProbeList';
import { DoneStepDnsCheck } from '../../DoneStepDnsCheck';
import SelectedStacksPanel from '../SelectedStacksPanel';

type InstallFlow = ReturnType<typeof useStackInstall>;

interface StacksStepProps {
    stackInstallStep: 'select' | 'services' | 'configure' | 'installing' | 'done';
    stacksLoading: boolean;
    availableStacks: Template[];
    pickerChecked: Set<string>;
    setPickerChecked: Dispatch<SetStateAction<Set<string>>>;
    stackItems: StackItem[];
    setStackItems: (items: StackItem[]) => void;
    stackVariables: StackVariable[];
    installFlow: InstallFlow;
    stackNodes: { Name: string; URI: string }[];
    stackSelectedNode: string | null;
    setStackSelectedNode: (node: string) => void;
    installingNow: string | null;
    diagnoseProbes: DiagnoseProbe[] | null;
    diagnoseRunning: boolean;
    /** "Install services later" affordance on the picker (#688). */
    handleStackSkip: () => void | Promise<void>;
    /** stacks-only mode: lets the stacks/done view render its own
     *  "Go to Dashboard" terminus since there's no subsequent
     *  FinishStep — installing from the sidebar entry skips the
     *  welcome→finish wizard. */
    stacksOnlyMode: boolean;
    handleFinish: () => void | Promise<void>;
    SERVICE_DEPS: Record<string, ServiceDeps>;
    stackDeviceOptions: Record<string, string[]>;
    stackLoadingDevices: boolean;
}

type ConfigureTab = 'subdomains' | 'settings' | 'ports';

export function StacksStep({
    stackInstallStep,
    stacksLoading,
    availableStacks,
    pickerChecked,
    setPickerChecked,
    stackItems,
    setStackItems,
    stackVariables,
    installFlow,
    stackNodes,
    stackSelectedNode,
    setStackSelectedNode,
    installingNow,
    diagnoseProbes,
    diagnoseRunning,
    handleStackSkip,
    stacksOnlyMode,
    handleFinish,
    SERVICE_DEPS,
    stackDeviceOptions,
    stackLoadingDevices,
}: StacksStepProps) {
    const [configureTab, setConfigureTab] = useState<ConfigureTab | null>(null);

    return (
        <div className="space-y-4 animate-in fade-in slide-in-from-bottom-4 duration-500">
            <div className="flex items-center gap-3">
                <div className="p-2.5 rounded-xl bg-indigo-500/10 border border-indigo-500/20">
                    <Layers className="w-5 h-5 text-indigo-500"/>
                </div>
                <div>
                    <h3 className="font-bold text-lg leading-none">Install services</h3>
                    <p className="text-xs text-gray-500 mt-1">Select and configure your service bundles</p>
                </div>
            </div>

            {stackInstallStep === 'select' && (
                <div className="space-y-4">
                    <p className="text-sm text-gray-500 leading-relaxed">
                        Pick the stacks to install. Defaults to all — uncheck what you don&apos;t need.
                    </p>
                    {stacksLoading ? (
                        <div className="flex items-center justify-center py-12 text-gray-400">
                            <Loader2 className="w-6 h-6 animate-spin mr-3" /> Loading available stacks...
                        </div>
                    ) : availableStacks.length === 0 ? (
                        <div className="text-sm text-gray-500 py-8 text-center soft-depth rounded-2xl">
                            No stacks available in your registries.
                        </div>
                    ) : (
                        <div className="grid grid-cols-1 gap-3">
                            {availableStacks.map(stack => {
                                const checked = pickerChecked.has(stack.name);
                                return (
                                    <label
                                        key={stack.name}
                                        id={`stack-pick-${stack.name.toLowerCase()}`}
                                        className={`flex items-start gap-4 p-4 rounded-2xl border cursor-pointer transition-all ${
                                            checked
                                                ? 'bg-white dark:bg-blue-600/10 border-blue-400 shadow-sm ring-1 ring-blue-400'
                                                : 'bg-gray-50 dark:bg-white/5 border-gray-200 dark:border-white/5 opacity-80 hover:opacity-100 hover:border-blue-300'
                                        }`}
                                    >
                                        <input
                                            type="checkbox"
                                            checked={checked}
                                            onChange={(e) => {
                                                setPickerChecked(prev => {
                                                    const next = new Set(prev);
                                                    if (e.target.checked) next.add(stack.name);
                                                    else next.delete(stack.name);
                                                    return next;
                                                });
                                            }}
                                            className="mt-1 w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                                        />
                                        <div className={`p-2 rounded-lg ${checked ? 'bg-blue-500/10 text-blue-500' : 'bg-gray-100 dark:bg-white/10 text-gray-400'}`}>
                                            {stack.type === 'stack' ? <Layers className="w-5 h-5" /> : <Package className="w-5 h-5" />}
                                        </div>
                                        <div className="flex-1">
                                            <div className="font-bold text-sm text-gray-900 dark:text-gray-100">{stack.name}</div>
                                            <div className="text-[10px] text-gray-500 font-medium uppercase tracking-wider">{stack.source}</div>
                                        </div>
                                    </label>
                                );
                            })}
                        </div>
                    )}

                    {/* #688: "Install services later" — closes the wizard
                        without installing anything. In stacks-only mode
                        this also marks setup as complete. */}
                    <div className="flex justify-start pt-2">
                        <button
                            type="button"
                            onClick={() => void handleStackSkip()}
                            className="px-4 py-2 text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 underline-offset-4 hover:underline"
                        >
                            Install services later
                        </button>
                    </div>
                </div>
            )}

            {stackInstallStep === 'services' && (
                <div className="space-y-4">
                    {stacksLoading ? (
                        <div className="flex items-center justify-center py-12 text-gray-400">
                            <Loader2 className="w-6 h-6 animate-spin mr-3" /> Fetching templates...
                        </div>
                    ) : (
                        <div className="space-y-4">
                            {stackItems.some(i => i.tier === 'infrastructure') && (
                                <div className="p-4 rounded-2xl border border-indigo-200 dark:border-indigo-800/60 bg-indigo-50 dark:bg-indigo-900/10 space-y-3">
                                    <div className="text-[10px] uppercase font-bold text-indigo-700 dark:text-indigo-300 tracking-widest">
                                        Platform · Built-in Core
                                    </div>
                                    <div className="flex flex-wrap gap-1.5">
                                        {stackItems.filter(i => i.tier === 'infrastructure').map(item => (
                                            <span
                                                key={item.name}
                                                className="text-[11px] font-semibold px-2 py-0.5 rounded-lg bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 border border-indigo-200 dark:border-indigo-800/60"
                                                title={item.description ?? ''}
                                            >
                                                {item.name}
                                            </span>
                                        ))}
                                    </div>
                                    <p className="text-[10px] text-indigo-700/70 dark:text-indigo-300/60 leading-relaxed">
                                        Foundational services like DNS and the Reverse Proxy are included automatically.
                                    </p>
                                </div>
                            )}
                            
                            <div className="space-y-2">
                                {stackItems.filter(i => i.tier !== 'infrastructure').map(item => {
                                    const i = stackItems.findIndex(x => x.name === item.name);
                                    return (
                                    <label 
                                        key={item.name} 
                                        id={`svc-pick-${item.name.toLowerCase()}`}
                                        className={`flex items-start gap-4 p-4 rounded-2xl border transition-all ${
                                        item.alreadyInstalled
                                            ? 'border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-900/10 opacity-60'
                                            : item.checked
                                                ? 'bg-white dark:bg-blue-600/10 border-blue-400 shadow-sm ring-1 ring-blue-400'
                                                : 'border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800 cursor-pointer'
                                    }`}>
                                        <input
                                            type="checkbox"
                                            checked={item.checked}
                                            disabled={item.alreadyInstalled}
                                            onChange={() => {
                                                if (item.alreadyInstalled) return;
                                                const turningOn = !stackItems[i].checked;
                                                const newItems = [...stackItems];

                                                if (turningOn) {
                                                    newItems[i].checked = true;
                                                    const required = [
                                                        ...(item.dependencies ?? []),
                                                        ...(SERVICE_DEPS[item.name]?.requires ?? []),
                                                    ];
                                                    for (const dep of new Set(required)) {
                                                        const j = newItems.findIndex(x => x.name === dep);
                                                        if (j >= 0 && !newItems[j].checked && !newItems[j].alreadyInstalled) {
                                                            newItems[j].checked = true;
                                                        }
                                                    }
                                                } else {
                                                    const dependents = newItems.filter(other =>
                                                        other.checked
                                                        && !other.alreadyInstalled
                                                        && other.name !== item.name
                                                        && (other.dependencies ?? []).includes(item.name),
                                                    );
                                                    if (dependents.length > 0) {
                                                        const ok = window.confirm(
                                                            `${dependents.map(d => d.name).join(', ')} require ${item.name}. `
                                                            + `Unchecking ${item.name} will also uncheck ${dependents.length === 1 ? 'that template' : 'those templates'}. Continue?`,
                                                        );
                                                        if (!ok) return;
                                                        for (const d of dependents) {
                                                            const j = newItems.findIndex(x => x.name === d.name);
                                                            if (j >= 0) newItems[j].checked = false;
                                                        }
                                                    }
                                                    newItems[i].checked = false;
                                                }
                                                setStackItems(newItems);
                                            }}
                                            className="w-4 h-4 mt-1 text-blue-600 rounded focus:ring-blue-500"
                                        />
                                        <div className="flex-1 min-w-0">
                                            <div className="flex items-center gap-2 flex-wrap">
                                                <span className={`font-bold text-sm ${item.alreadyInstalled ? 'text-gray-400' : 'text-gray-900 dark:text-gray-200'}`}>{item.name}</span>
                                                {item.alreadyInstalled && (
                                                    <span className="text-[10px] font-bold text-green-600 uppercase tracking-tighter">already installed</span>
                                                )}
                                                {item.name === 'nginx' && (
                                                    <span className="text-[9px] uppercase font-bold px-1.5 py-0.5 rounded bg-purple-50 dark:bg-purple-900/20 text-purple-700 dark:text-purple-300 border border-purple-200 dark:border-purple-800/60">
                                                        Gateway
                                                    </span>
                                                )}
                                            </div>
                                            {item.description && (
                                                <p className={`text-xs mt-0.5 leading-relaxed ${item.alreadyInstalled ? 'text-gray-400' : 'text-gray-500 dark:text-gray-400'}`}>
                                                    {item.description}
                                                </p>
                                            )}
                                        </div>
                                    </label>
                                    );
                                })}
                            </div>
                        </div>
                    )}
                </div>
            )}

            {stackInstallStep === 'configure' && (
                <div className="space-y-6">
                    {stackNodes.length > 1 && (
                        <div className="p-4 rounded-2xl soft-depth">
                            <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-2 ml-1">Target Node</label>
                            <select
                                value={stackSelectedNode || ''}
                                onChange={(e) => setStackSelectedNode(e.target.value)}
                                className="w-full px-4 py-2.5 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl focus:ring-2 focus:ring-blue-500 outline-none text-sm"
                            >
                                <option value="" disabled>Select a node</option>
                                {stackNodes.map(n => <option key={n.Name} value={n.Name}>{n.Name}</option>)}
                            </select>
                        </div>
                    )}

                    {stacksLoading ? (
                        <div className="flex items-center justify-center py-12 text-gray-400">
                            <Loader2 className="w-6 h-6 animate-spin mr-3" /> Preparing variables...
                        </div>
                    ) : groupVariablesByTemplate(stackVariables).filter(g => g.key !== '_global').length === 0 ? (
                        <div className="p-6 rounded-2xl bg-green-500/5 border border-green-500/10 text-center">
                            <CheckCircle className="w-8 h-8 text-green-500 mx-auto mb-2 opacity-50" />
                            <p className="text-sm font-medium text-green-700 dark:text-green-300">
                                No additional configuration required for these services.
                            </p>
                        </div>
                    ) : (
                        <div className="space-y-4">
                            {(() => {
                                const groups = groupVariablesByTemplate(stackVariables).filter(g => g.key !== '_global');
                                const isPortVar = (name: string) => /_PORT$/i.test(name);
                                const counts = { subdomains: 0, settings: 0, ports: 0 };
                                for (const g of groups) {
                                    for (const v of g.variables) {
                                        if (v.meta?.type === 'subdomain') counts.subdomains++;
                                        else if (isPortVar(v.name)) counts.ports++;
                                        else counts.settings++;
                                    }
                                }
                                const tabs = ([
                                    { id: 'subdomains' as ConfigureTab, label: 'Domains', count: counts.subdomains },
                                    { id: 'settings'   as ConfigureTab, label: 'Settings', count: counts.settings },
                                    { id: 'ports'      as ConfigureTab, label: 'Ports',    count: counts.ports },
                                ] as const).filter(t => t.count > 0);
                                const activeTab = configureTab ?? (tabs[0]?.id ?? 'settings');
                                return (
                                    <div className="flex gap-1 border-b border-gray-200 dark:border-gray-800">
                                        {tabs.map(t => (
                                            <button
                                                key={t.id}
                                                type="button"
                                                onClick={() => setConfigureTab(t.id)}
                                                className={`px-4 py-2 text-sm font-bold border-b-2 transition-all ${
                                                    activeTab === t.id
                                                        ? 'border-blue-500 text-blue-600 dark:text-blue-400'
                                                        : 'border-transparent text-gray-500 hover:text-gray-700'
                                                }`}
                                            >
                                                {t.label}
                                                <span className="ml-2 px-1.5 py-0.5 rounded-full bg-gray-100 dark:bg-white/10 text-[10px] opacity-70">{t.count}</span>
                                            </button>
                                        ))}
                                    </div>
                                );
                            })()}

                            <div className="space-y-6 max-h-[60vh] overflow-y-auto px-1 pr-3 scrollbar-thin">
                                {groupVariablesByTemplate(stackVariables).filter(g => g.key !== '_global').map(group => {
                                  const isPortVar = (name: string) => /_PORT$/i.test(name);
                                  const subdomainCountAll = groupVariablesByTemplate(stackVariables).filter(g => g.key !== '_global').reduce((acc, g) => acc + g.variables.filter(v => v.meta?.type === 'subdomain').length, 0);
                                  const tab = configureTab ?? (subdomainCountAll > 0 ? 'subdomains' : 'settings');
                                  const filtered = group.variables.filter(v => {
                                      if (tab === 'subdomains') return v.meta?.type === 'subdomain';
                                      if (tab === 'ports') return isPortVar(v.name);
                                      return v.meta?.type !== 'subdomain' && !isPortVar(v.name);
                                  });
                                  if (filtered.length === 0) return null;
                                  return (
                                  <div key={group.key} className="space-y-4 p-5 rounded-2xl soft-depth">
                                    <div className="flex items-center gap-2 border-b border-gray-200 dark:border-gray-800 pb-2 mb-2">
                                        <Box className="w-4 h-4 text-indigo-500" />
                                        <h4 className="text-xs font-bold text-gray-700 dark:text-gray-200 uppercase tracking-widest">{group.label}</h4>
                                    </div>
                                    <div className="space-y-5">
                                        {filtered.map((v) => {
                                            const groupPrefix = group.key.toUpperCase().replace(/-/g, '_') + '_';
                                            const stripped = v.name.startsWith(groupPrefix) ? v.name.slice(groupPrefix.length) : v.name;
                                            const KEEP_UPPER = new Set(['DB', 'URL', 'API', 'SSH', 'TLS', 'SSL', 'OIDC', 'DNS', 'IP', 'ID', 'JWT', 'SMTP', 'CSV', 'CSRF', 'NPM', 'LDAP']);
                                            const displayLabel = stripped.split('_').map((w, i) =>
                                                KEEP_UPPER.has(w) ? w : (i === 0 ? w[0] + w.slice(1).toLowerCase() : w.toLowerCase())
                                            ).join(' ');
                                            return (
                                            <div key={v.name} className="space-y-1.5">
                                                <div className="flex items-center justify-between gap-2">
                                                    <label className="text-[11px] font-bold text-gray-500 uppercase tracking-wide">
                                                        {displayLabel}
                                                    </label>
                                                    <span className="text-[9px] font-mono text-gray-400 opacity-40">{v.name}</span>
                                                </div>
                                                <StackVariableField
                                                    variable={v}
                                                    onChange={(value: string) => installFlow.setVariableValue(v.name, value)}
                                                    onExposureChange={(exposure: 'public' | 'internal' | 'lan') => installFlow.setVariableExposure(v.name, exposure)}
                                                    publicDomain={stackVariables.find(x => x.name === 'PUBLIC_DOMAIN')?.value}
                                                    inputClassName="w-full px-4 py-2 bg-white dark:bg-gray-900/60 border border-gray-200 dark:border-gray-800 rounded-xl focus:ring-2 focus:ring-blue-500 outline-none text-sm"
                                                    deviceContext={{
                                                        deviceOptions: stackDeviceOptions,
                                                        loadingDevices: stackLoadingDevices,
                                                        canRefresh: !!stackSelectedNode,
                                                        onRefresh: () => {}, // Handled by wizard's useEffect
                                                    }}
                                                />
                                            </div>
                                            );
                                        })}
                                    </div>
                                  </div>
                                  );
                                })}
                            </div>
                        </div>
                    )}
                </div>
            )}

            {(stackInstallStep === 'installing' || stackInstallStep === 'done') && (
                <div className="space-y-6 animate-in fade-in duration-700">
                    <SelectedStacksPanel
                        items={stackItems}
                        installingNow={installingNow}
                        deployedNames={installFlow.deployedNames}
                        phase={installFlow.phase}
                    />
                    <StackInstallProgress
                        controller={installFlow}
                        beforeLog={
                            <div className="flex items-center justify-between text-[10px] font-bold text-gray-500 uppercase tracking-widest px-1">
                                <div className="flex items-center gap-2">
                                    <div className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse" />
                                    {installingNow ?? 'Initializing pipeline'}
                                </div>
                                <div>Node: {stackSelectedNode || 'Local'}</div>
                            </div>
                        }
                    />
                    
                    {stackInstallStep === 'done' && (
                        <div className="space-y-6 pt-4 border-t border-gray-200 dark:border-gray-800">
                            {installFlow.credentialsManifest.length === 0 ? (
                                <div className="p-4 rounded-2xl bg-emerald-500/5 border border-emerald-500/10 flex items-center gap-3 text-emerald-600 dark:text-emerald-400">
                                    <CheckCircle size={20} />
                                    <div className="text-sm font-bold">Services deployed successfully</div>
                                </div>
                            ) : (
                                <StackInstallSummary controller={installFlow} />
                            )}

                            {(() => {
                                // Match the original (origin/main) selector: surface only
                                // public-exposure subdomains the operator just deployed,
                                // skip LAN-only / internal entries the AdGuard rewrite
                                // path handles separately.
                                const domain = stackVariables.find(v => v.name === 'PUBLIC_DOMAIN')?.value || '';
                                const publicSubs = stackVariables.filter(
                                    v => v.meta?.type === 'subdomain' && v.value && v.meta?.exposure === 'public',
                                );
                                if (!domain || publicSubs.length === 0) return null;
                                return (
                                    <DoneStepDnsCheck
                                        domain={domain}
                                        subdomains={publicSubs.map(sv => `${sv.value}.${domain}`)}
                                    />
                                );
                            })()}
                            
                            <div className="soft-depth rounded-2xl p-5 space-y-4">
                                {(() => {
                                    const diagCounts = (diagnoseProbes ?? []).reduce<Record<string, number>>((acc, p) => {
                                        acc[p.status] = (acc[p.status] || 0) + 1;
                                        return acc;
                                    }, { ok: 0, warn: 0, fail: 0, info: 0 });
                                    const overall = diagCounts.fail > 0 ? 'fail' : diagCounts.warn > 0 ? 'warn' : diagCounts.ok > 0 ? 'ok' : 'info';
                                    const styles = {
                                        ok: 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20',
                                        warn: 'bg-amber-500/10 text-amber-500 border-amber-500/20',
                                        fail: 'bg-red-500/10 text-red-500 border-red-500/20',
                                        info: 'bg-blue-500/10 text-blue-500 border-blue-500/20',
                                    };
                                    return (
                                        <div className={`p-4 rounded-xl border flex items-center justify-between ${styles[overall as keyof typeof styles]}`}>
                                            <div className="flex items-center gap-3">
                                                <div className="font-bold text-sm">
                                                    {overall === 'ok' ? 'System fully operational' : 'System check completed'}
                                                </div>
                                                <div className="flex gap-2 text-[10px] font-black uppercase opacity-80">
                                                    {diagCounts.ok > 0 && <span>{diagCounts.ok} ok</span>}
                                                    {diagCounts.warn > 0 && <span>{diagCounts.warn} warn</span>}
                                                    {diagCounts.fail > 0 && <span className="text-red-500">{diagCounts.fail} fail</span>}
                                                </div>
                                            </div>
                                            <div className="text-[10px] font-bold opacity-60">
                                                Re-run any time at Health → Self-Diagnose
                                            </div>
                                        </div>
                                    );
                                })()}

                                <div className="flex items-center justify-between">
                                    <h4 className="text-sm font-bold flex items-center gap-2">
                                        {diagnoseRunning ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4 text-emerald-500" />}
                                        Detailed Probe Results
                                    </h4>
                                    <span className="text-[10px] font-bold text-gray-400 uppercase">Post-Install Check</span>
                                </div>
                                
                                <DiagnoseProbeList
                                    probes={diagnoseProbes || []}
                                    node={stackSelectedNode || 'Local'}
                                    parentRunning={diagnoseRunning}
                                    compact
                                />
                            </div>

                            {/* Final affordance — in stacks-only mode the
                                wizard terminates here (no welcome→finish
                                chain), so the done sub-step needs its
                                own way out. In the verbose flow this
                                button is owned by the FinishStep. */}
                            {stacksOnlyMode && (
                                <div className="flex justify-end pt-2">
                                    <Button onClick={() => void handleFinish()} className="px-8">
                                        <CheckCircle className="w-4 h-4 mr-2" />
                                        Go to Dashboard
                                        <ArrowRight className="w-4 h-4 ml-2" />
                                    </Button>
                                </div>
                            )}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

'use client';

import { useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { Layers, Package, Loader2, CheckCircle, Box, ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Tabs } from '@/components/ui/Tabs';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import type { Template } from '@servicebay/api-client';
import type { StackItem as BaseStackItem, StackVariable, useStackInstall } from '@/hooks/useStackInstall';
import type { TemplateTier } from '@servicebay/api-client';
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
import { groupVariablesByTemplate } from '@servicebay/api-client';
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
    /** Desired-state editor (#1537): installed-stack classification from
     *  the box-side `/api/install/plan`. `'wipeable'` rows are pre-checked
     *  and uncheck = uninstall (confirmed); `'core'` rows are locked
     *  (atomic-wipe, Factory-Reset-only). Empty on a fresh box. */
    installedStacks: Map<string, 'wipeable' | 'core'>;
    /** Stack currently being torn down, or null. Disables its row. */
    uninstalling: string | null;
    /** Uncheck-to-uninstall handler. Owns the confirm + wipe call. */
    onUninstallStack: (stack: string) => void | Promise<void>;
    /** #2627 — every service in the chosen stack(s) is already installed, so
     *  no checkbox can be turned on. The footer swaps Continue for a way
     *  forward; the step says so instead of showing an inert list. */
    nothingLeftToInstall: boolean;
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
    installedStacks,
    uninstalling,
    onUninstallStack,
    nothingLeftToInstall,
}: StacksStepProps) {
    const [configureTab, setConfigureTab] = useState<ConfigureTab | null>(null);

    return (
        <div className="space-y-4 animate-in fade-in slide-in-from-bottom-4 duration-500">
            <div className="flex items-center gap-3">
                <div className="p-2.5 rounded-xl bg-accent/10 border border-accent/20">
                    <Layers className="w-5 h-5 text-accent"/>
                </div>
                <div>
                    <h3 className="font-bold text-lg leading-none">Install services</h3>
                    <p className="text-xs text-text-muted mt-1">Select and configure your service bundles</p>
                </div>
            </div>

            {stackInstallStep === 'select' && (
                <div className="space-y-4">
                    <p className="text-sm text-text-muted leading-relaxed">
                        Pick the stacks you want installed. Checked stacks get installed;
                        unchecking an already-installed stack uninstalls it. The core stack
                        (DNS, reverse proxy, identity) can only be removed via Factory Reset.
                    </p>
                    {stacksLoading ? (
                        <div className="flex items-center justify-center py-12 text-text-muted">
                            <Loader2 className="w-6 h-6 animate-spin mr-3" /> Loading available stacks...
                        </div>
                    ) : availableStacks.length === 0 ? (
                        <div className="text-sm text-text-muted py-8 text-center soft-depth rounded-2xl">
                            No stacks available in your registries.
                        </div>
                    ) : (
                        <div className="grid grid-cols-1 gap-3">
                            {availableStacks.map(stack => (
                                <StackPickerRow
                                    key={stack.name}
                                    stack={stack}
                                    checked={pickerChecked.has(stack.name)}
                                    installState={installedStacks.get(stack.name)}
                                    isUninstalling={uninstalling === stack.name}
                                    setPickerChecked={setPickerChecked}
                                    onUninstallStack={onUninstallStack}
                                />
                            ))}
                        </div>
                    )}

                    {/* #688: "Install services later" — closes the wizard
                        without installing anything. In stacks-only mode
                        this also marks setup as complete. */}
                    <div className="flex justify-start pt-2">
                        <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => void handleStackSkip()}
                            className="underline-offset-4 hover:underline"
                        >
                            Install services later
                        </Button>
                    </div>
                </div>
            )}

            {stackInstallStep === 'services' && (
                <div className="space-y-4">
                    {stacksLoading ? (
                        <div className="flex items-center justify-center py-12 text-text-muted">
                            <Loader2 className="w-6 h-6 animate-spin mr-3" /> Fetching templates...
                        </div>
                    ) : (
                        <div className="space-y-4">
                            {nothingLeftToInstall && (
                                <div role="status" className="p-4 rounded-2xl border border-status-ok/40 bg-status-ok/5 space-y-2">
                                    <div className="text-sm font-bold text-status-ok">Nothing left to install here</div>
                                    <p className="text-xs text-text-muted leading-relaxed">
                                        All {stackItems.length} of {stackItems.length} service{stackItems.length === 1 ? '' : 's'} in this
                                        selection {stackItems.length === 1 ? 'is' : 'are'} already installed on this box, so there is
                                        nothing to add and every checkbox below stays locked. Choose another stack, or close the wizard —
                                        to remove one of these, uncheck its stack on the previous step.
                                    </p>
                                </div>
                            )}

                            {stackItems.some(i => i.tier === 'infrastructure') && (
                                <div className="p-4 rounded-2xl border border-accent/30 bg-accent/5 space-y-3">
                                    <div className="text-[10px] uppercase font-bold text-accent tracking-widest">
                                        Platform · Built-in Core
                                    </div>
                                    <div className="flex flex-wrap gap-1.5">
                                        {stackItems.filter(i => i.tier === 'infrastructure').map(item => (
                                            <span
                                                key={item.name}
                                                className="text-[11px] font-semibold px-2 py-0.5 rounded-lg bg-surface text-text border border-accent/30"
                                                title={item.description ?? ''}
                                            >
                                                {item.name}
                                            </span>
                                        ))}
                                    </div>
                                    <p className="text-[10px] text-accent/70 leading-relaxed">
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
                                            ? 'border-status-ok/50 bg-status-ok/5 opacity-60'
                                            : item.checked
                                                ? 'bg-surface border-accent shadow-sm ring-1 ring-accent'
                                                : 'border-border hover:bg-surface-2 cursor-pointer'
                                    }`}>
                                        <Input
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
                                            className="w-4 h-4 mt-1 text-accent rounded focus:ring-accent"
                                        />
                                        <div className="flex-1 min-w-0">
                                            <div className="flex items-center gap-2 flex-wrap">
                                                <span className={`font-bold text-sm ${item.alreadyInstalled ? 'text-text-muted' : 'text-text'}`}>{item.name}</span>
                                                {item.alreadyInstalled && (
                                                    <span className="text-[10px] font-bold text-status-ok uppercase tracking-tighter">already installed</span>
                                                )}
                                                {item.name === 'nginx' && (
                                                    <span className="text-[9px] uppercase font-bold px-1.5 py-0.5 rounded bg-accent/10 text-accent border border-accent/30">
                                                        Gateway
                                                    </span>
                                                )}
                                            </div>
                                            {item.description && (
                                                <p className={`text-xs mt-0.5 leading-relaxed ${item.alreadyInstalled ? 'text-text-muted' : 'text-text-muted'}`}>
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
                            <label className="block text-[10px] font-bold text-text-muted uppercase tracking-widest mb-2 ml-1">Target Node</label>
                            <Select
                                value={stackSelectedNode || ''}
                                onChange={(e) => setStackSelectedNode(e.target.value)}
                                className="w-full px-4 py-2.5 bg-surface border border-border rounded-xl focus:ring-2 focus:ring-accent outline-none text-sm"
                            >
                                <option value="" disabled>Select a node</option>
                                {stackNodes.map(n => <option key={n.Name} value={n.Name}>{n.Name}</option>)}
                            </Select>
                        </div>
                    )}

                    {stacksLoading ? (
                        <div className="flex items-center justify-center py-12 text-text-muted">
                            <Loader2 className="w-6 h-6 animate-spin mr-3" /> Preparing variables...
                        </div>
                    ) : groupVariablesByTemplate(stackVariables).filter(g => g.key !== '_global').length === 0 ? (
                        <div className="p-6 rounded-2xl bg-status-ok/5 border border-status-ok/10 text-center">
                            <CheckCircle className="w-8 h-8 text-status-ok mx-auto mb-2 opacity-50" />
                            <p className="text-sm font-medium text-status-ok">
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
                                    // #2549: shared <Tabs> primitive.
                                    <Tabs
                                        label="Configuration groups"
                                        value={activeTab}
                                        onChange={setConfigureTab}
                                        items={tabs}
                                    />
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
                                    <div className="flex items-center gap-2 border-b border-border pb-2 mb-2">
                                        <Box className="w-4 h-4 text-accent" />
                                        <h4 className="text-xs font-bold text-text uppercase tracking-widest">{group.label}</h4>
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
                                                    <label className="text-[11px] font-bold text-text-muted uppercase tracking-wide">
                                                        {displayLabel}
                                                    </label>
                                                    <span className="text-[9px] font-mono text-text-subtle opacity-40">{v.name}</span>
                                                </div>
                                                <StackVariableField
                                                    variable={v}
                                                    onChange={(value: string) => installFlow.setVariableValue(v.name, value)}
                                                    onExposureChange={(exposure: 'public' | 'internal' | 'lan') => installFlow.setVariableExposure(v.name, exposure)}
                                                    publicDomain={stackVariables.find(x => x.name === 'PUBLIC_DOMAIN')?.value}
                                                    inputClassName="w-full px-4 py-2 bg-surface border border-border rounded-xl focus:ring-2 focus:ring-accent outline-none text-sm"
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
                            <div className="flex items-center justify-between text-[10px] font-bold text-text-muted uppercase tracking-widest px-1">
                                <div className="flex items-center gap-2">
                                    <div className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
                                    {installingNow ?? 'Initializing pipeline'}
                                </div>
                                <div>Node: {stackSelectedNode || 'Local'}</div>
                            </div>
                        }
                    />
                    
                    {stackInstallStep === 'done' && (
                        <div className="space-y-6 pt-4 border-t border-border">
                            {installFlow.credentialsManifest.length === 0 ? (
                                <div className="p-4 rounded-2xl bg-status-ok/5 border border-status-ok/10 flex items-center gap-3 text-status-ok">
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
                                        ok: 'bg-status-ok/10 text-status-ok border-status-ok/20',
                                        warn: 'bg-status-warn/10 text-status-warn border-status-warn/20',
                                        fail: 'bg-status-fail/10 text-status-fail border-status-fail/20',
                                        info: 'bg-status-info/10 text-status-info border-status-info/20',
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
                                                    {diagCounts.fail > 0 && <span className="text-status-fail">{diagCounts.fail} fail</span>}
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
                                        {diagnoseRunning ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4 text-status-ok" />}
                                        Detailed Probe Results
                                    </h4>
                                    <span className="text-[10px] font-bold text-text-muted uppercase">Post-Install Check</span>
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

interface StackPickerRowProps {
    stack: Template;
    checked: boolean;
    /** undefined = not installed; 'wipeable' = installed feature stack
     *  (uncheck → uninstall); 'core' = installed atomic-wipe (locked). */
    installState: 'wipeable' | 'core' | undefined;
    isUninstalling: boolean;
    setPickerChecked: Dispatch<SetStateAction<Set<string>>>;
    onUninstallStack: (stack: string) => void | Promise<void>;
}

/** One desired-state row in the stack picker (#1537). Checked = install;
 *  unchecking an installed wipeable stack hands off to the confirmed
 *  uninstall path; core/atomic-wipe rows are locked (Factory-Reset-only). */
function StackPickerRow({ stack, checked, installState, isUninstalling, setPickerChecked, onUninstallStack }: StackPickerRowProps) {
    const isInstalled = installState !== undefined;
    const isCore = installState === 'core';
    return (
        <label
            id={`stack-pick-${stack.name.toLowerCase()}`}
            className={`flex items-start gap-4 p-4 rounded-2xl border transition-all ${isCore ? 'cursor-not-allowed' : 'cursor-pointer'} ${
                checked
                    ? 'bg-surface border-accent shadow-sm ring-1 ring-accent'
                    : 'bg-surface-muted border-border opacity-80 hover:opacity-100 hover:border-accent/50'
            }`}
        >
            <Input
                type="checkbox"
                checked={checked}
                // Core/atomic-wipe stacks can't be unchecked here
                // (Factory-Reset-only); their box-side wipe is refused too.
                disabled={isCore || isUninstalling}
                onChange={(e) => {
                    // Unchecking an installed stack is an uninstall, not a
                    // mere de-select — hand off to the confirmed wipe path.
                    if (!e.target.checked && isInstalled) {
                        void onUninstallStack(stack.name);
                        return;
                    }
                    setPickerChecked(prev => {
                        const next = new Set(prev);
                        if (e.target.checked) next.add(stack.name);
                        else next.delete(stack.name);
                        return next;
                    });
                }}
                className="mt-1 w-4 h-4 rounded border-border text-accent focus:ring-accent disabled:opacity-50"
            />
            <div className={`p-2 rounded-lg ${checked ? 'bg-accent/10 text-accent' : 'bg-surface-2 text-text-muted'}`}>
                {stack.type === 'stack' ? <Layers className="w-5 h-5" /> : <Package className="w-5 h-5" />}
            </div>
            <div className="flex-1">
                <StackPickerBadges name={stack.name} isInstalled={isInstalled} isCore={isCore} isUninstalling={isUninstalling} />
                <div className="text-[10px] text-text-muted font-medium uppercase tracking-wider">{stack.source}</div>
                {isInstalled && !isCore && (
                    <p className="text-[10px] text-text-muted mt-0.5">Uncheck to uninstall.</p>
                )}
                {isCore && (
                    <p className="text-[10px] text-text-muted mt-0.5">Remove via Factory Reset only.</p>
                )}
            </div>
        </label>
    );
}

/** Name + state badges for a picker row. Split out so `StackPickerRow`
 *  stays under the per-function line budget. */
function StackPickerBadges({ name, isInstalled, isCore, isUninstalling }: {
    name: string; isInstalled: boolean; isCore: boolean; isUninstalling: boolean;
}) {
    return (
        <div className="flex items-center gap-2 flex-wrap">
            <span className="font-bold text-sm text-text">{name}</span>
            {isInstalled && (
                <span className="text-[9px] uppercase font-bold px-1.5 py-0.5 rounded bg-status-ok/10 text-status-ok border border-status-ok/30">
                    installed
                </span>
            )}
            {isCore && (
                <span className="text-[9px] uppercase font-bold px-1.5 py-0.5 rounded bg-accent/10 text-accent border border-accent/30">
                    core
                </span>
            )}
            {isUninstalling && (
                <span className="inline-flex items-center gap-1 text-[10px] font-bold text-status-warn">
                    <Loader2 className="w-3 h-3 animate-spin" /> uninstalling…
                </span>
            )}
        </div>
    );
}

'use client';

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import dynamic from 'next/dynamic';
import { useSearchParams } from 'next/navigation';
import { logger } from '@/lib/logger';
import { useDigitalTwin } from '@/hooks/useDigitalTwin'; // V4 Hook
import { useEscapeKey } from '@/hooks/useEscapeKey';
import PluginLoading from '@/components/PluginLoading';
import ConfirmModal from '@/components/ConfirmModal';
import { useToast } from '@/providers/ToastProvider';
import PageHeader from '@/components/PageHeader';
import ExternalLinkModal from '@/components/ExternalLinkModal';
import PluginHelp from '@/components/PluginHelp';
import FileViewerOverlay from '@/components/FileViewerOverlay';
import RegistryPlugin from '@/plugins/RegistryPlugin';
import { ServiceActionBar } from '@/components/ServiceActionBar';
import { AttachedContainerList } from '@/components/AttachedContainerList';
import { useServiceActions } from '@/hooks/useServiceActions';
import { useContainerActions } from '@/hooks/useContainerActions';
import { buildServiceViewModel } from '@/lib/services/serviceViewModel';
import { ServiceViewModel, ServicePort } from '@/types/serviceView';
import ContainerLogsPanel, { ContainerLogsPanelData } from '@/components/ContainerLogsPanel';
import type { TerminalRef } from '@/components/Terminal';
import { EnrichedContainer } from '@/lib/agent/types';
// We keep Service interface but recreate it or import from shared data if it matches?
// SharedData Service is a complex UI object. digital twin ServiceUnit is simple.
// WE NEED TO MAP TWIN -> UI SERVICE here.
import { Plus, RefreshCw, Activity, Trash2, Power, Box, Search, X, AlertCircle, FileCode, ArrowRight, ShieldCheck, Terminal as TerminalIcon, Eraser } from 'lucide-react';
import { ServiceBundle, BundleValidation, BundleStackArtifacts, BundlePortSummary, BundleContainerSummary, generateBundleStackArtifacts, sanitizeBundleName } from '@/lib/unmanaged/bundleShared';

interface MigrationPlan {
    filesToCreate: string[];
    filesToBackup: string[];
    servicesToStop: string[];
    targetName: string;
    backupDir: string;
    backupArchive?: string;
    stackPreview?: string;
    validations?: BundleValidation[];
    fileMappings?: Array<{ source: string; action: 'backup' | 'migrate'; target?: string }>;
}

type LinkFormState = {
    name: string;
    url: string;
    description: string;
    monitor: boolean;
    ipTargetsText?: string;
};

const bundleWizardSteps: Array<{ key: 'assets' | 'stack' | 'backup'; label: string; description: string; tooltip: string }> = [
    {
        key: 'assets',
        label: 'Assets',
        description: 'Review linked services, files, and containers',
        tooltip: 'Verify every unmanaged unit, container, and config before generating the managed stack. See the Merge Workflow guide for full context.'
    },
    {
        key: 'stack',
        label: 'Stack',
        description: 'Validate the generated pod stack',
        tooltip: 'Inspect the synthesized .kube unit, Pod YAML, and config references before dry-running the plan.'
    },
    {
        key: 'backup',
        label: 'Backup Plan',
        description: 'Confirm backups and execution plan',
        tooltip: 'Dry run podman kube play, review tar/gzip backups, and note rollback instructions prior to executing the merge.'
    }
];

const dedupeValidations = (entries: BundleValidation[]): BundleValidation[] => {
    const map = new Map<string, BundleValidation>();
    entries.forEach(entry => {
        const key = `${entry.level}-${entry.scope || 'global'}-${entry.message}`;
        if (!map.has(key)) {
            map.set(key, entry);
        }
    });
    return Array.from(map.values());
};

const bundleSeverityClasses: Record<ServiceBundle['severity'], string> = {
    critical: 'border-red-200 dark:border-red-800',
    warning: 'border-amber-200 dark:border-amber-800',
    info: 'border-gray-200 dark:border-gray-800'
};

const MERGE_HELP_ID = 'merge-wizard';

const DynamicTerminal = dynamic(() => import('@/components/Terminal'), { ssr: false });

type ApiLinkPayload = {
    id?: string;
    name: string;
    nodeName?: string;
    description?: string;
    active?: boolean;
    status?: string;
    activeState?: string;
    subState?: string;
    kubePath?: string;
    yamlPath?: string | null;
    type?: string;
    ports?: RawLinkPort[];
    volumes?: RawLinkVolume[];
    monitor?: boolean;
    url?: string;
    labels?: Record<string, string>;
    verifiedDomains?: string[];
    ipTargets?: string[];
};

type RawLinkPort = {
    host?: string | number;
    hostPort?: string | number;
    container?: string | number;
    containerPort?: string | number;
    hostIp?: string;
    protocol?: string;
    source?: string;
};

type RawLinkVolume = {
    host?: string;
    container?: string;
};

export default function ServicesPlugin() {
    const { data: twin, isConnected, lastUpdate } = useDigitalTwin();
    const { addToast, updateToast } = useToast();

    const [filteredServices, setFilteredServices] = useState<ServiceViewModel[]>([]);
    const [filteredBundles, setFilteredBundles] = useState<ServiceBundle[]>([]);
    const [searchQuery, setSearchQuery] = useState('');
    const [discoveryLoading, setDiscoveryLoading] = useState(false);
    const [externalLinks, setExternalLinks] = useState<ServiceViewModel[]>([]);
    const [serviceBundles, setServiceBundles] = useState<ServiceBundle[]>([]);
    const [selectedBundle, setSelectedBundle] = useState<ServiceBundle | null>(null);
    const [bundlePendingDelete, setBundlePendingDelete] = useState<ServiceBundle | null>(null);
    const [bundleWizardStep, setBundleWizardStep] = useState<'assets' | 'stack' | 'backup'>('assets');
    const [bundleTargetName, setBundleTargetName] = useState('');
    const [bundlePlan, setBundlePlan] = useState<MigrationPlan | null>(null);
    const [bundlePlanLoading, setBundlePlanLoading] = useState(false);
    const [bundleStackArtifacts, setBundleStackArtifacts] = useState<BundleStackArtifacts | null>(null);
    const [bundleValidations, setBundleValidations] = useState<BundleValidation[]>([]);
    const [bundleActionLoading, setBundleActionLoading] = useState(false);
    const [bundleDeleteLoading, setBundleDeleteLoading] = useState(false);
    const [showLinkModal, setShowLinkModal] = useState(false);
    const [isEditingLink, setIsEditingLink] = useState(false);
    const [editingLinkId, setEditingLinkId] = useState<string | null>(null);
    const [linkForm, setLinkForm] = useState<LinkFormState>({ name: '', url: '', description: '', monitor: false, ipTargetsText: '' });
    const [showRegistryOverlay, setShowRegistryOverlay] = useState(false);
    const [filePreview, setFilePreview] = useState<{ path: string; nodeName?: string } | null>(null);
    const [handledBundleQuery, setHandledBundleQuery] = useState<string | null>(null);
    const searchParams = useSearchParams();
    const bundleQueryParam = searchParams?.get('bundle') || null;
    const bundleNodeParam = searchParams?.get('bundleNode') || null;

    const wizardStepIndex = Math.max(0, bundleWizardSteps.findIndex(step => step.key === bundleWizardStep));

    const openFilePreview = useCallback((path: string, nodeName?: string) => {
        if (!path) return;
        setFilePreview({ path, nodeName });
    }, []);

    const closeFilePreview = useCallback(() => setFilePreview(null), []);

    const FileBadge = ({
        path,
        nodeName,
        label,
        variant = 'chip'
    }: {
        path: string;
        nodeName?: string;
        label?: string;
        variant?: 'chip' | 'list' | 'inline';
    }) => {
        if (!path) return null;
        const display = label || (variant === 'chip' ? path.split('/').pop() || path : path);
        const baseClasses =
            variant === 'inline'
                ? 'text-left text-xs font-mono text-blue-600 dark:text-blue-300 hover:underline px-1 py-0.5 rounded border border-transparent whitespace-normal break-all max-w-full'
                : variant === 'list'
                    ? 'w-full text-left px-2 py-1 bg-gray-50 dark:bg-gray-950 rounded border border-gray-200 dark:border-gray-800 text-xs font-mono transition-colors whitespace-normal break-all'
                    : 'text-left px-2 py-0.5 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded text-xs font-mono whitespace-normal break-all max-w-full transition-colors';

        return (
            <button
                type="button"
                onClick={() => openFilePreview(path, nodeName)}
                className={`${baseClasses} hover:border-blue-400 hover:text-blue-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500`}
                title={`Open ${path} on ${nodeName || 'Local'}`}
            >
                {display}
            </button>
        );
    };

    const filterBundleHints = useCallback((hints: string[]) => {
        return hints.filter(hint => {
            const normalized = hint.toLowerCase();
            return !normalized.startsWith('published ports') && !normalized.startsWith('joins pod');
        });
    }, []);

    const selectedBundleHints = selectedBundle ? filterBundleHints(selectedBundle.hints) : [];

    const containersById = useMemo(() => {
        if (!selectedBundle) return new Map<string, BundleContainerSummary>();
        const map = new Map<string, BundleContainerSummary>();
        selectedBundle.containers.forEach(container => {
            map.set(container.id, container);
        });
        return map;
    }, [selectedBundle]);

    const extraConfigAssets = useMemo(() => {
        if (!selectedBundle) return [] as ServiceBundle['assets'];
        const servicePaths = new Set(
            selectedBundle.services.flatMap(svc => {
                const entries: string[] = [];
                if (svc.sourcePath) entries.push(svc.sourcePath);
                if (svc.unitFile) entries.push(svc.unitFile);
                return entries;
            })
        );
        return selectedBundle.assets.filter(asset => !servicePaths.has(asset.path));
    }, [selectedBundle]);

    const loadExternalLinks = useCallback(async () => {
        try {
            const res = await fetch('/api/services?scope=links', { cache: 'no-store' });
            if (!res.ok) {
                throw new Error('Failed to load external links');
            }

            const payload = await res.json();
            const parsed: ServiceViewModel[] = Array.isArray(payload)
                ? payload.map((link: ApiLinkPayload) => {
                      const status = typeof link.status === 'string' ? link.status : link.active ? 'active' : 'inactive';
                      const activeState = typeof link.activeState === 'string' ? link.activeState : status;
                      const subState = typeof link.subState === 'string' ? link.subState : status;
                      const ipTargets = Array.isArray(link.ipTargets) ? link.ipTargets : [];
                      return {
                          id: link.id || link.name,
                          name: link.name,
                          nodeName: link.nodeName || 'Global',
                          description: link.description,
                          active: typeof link.active === 'boolean' ? link.active : true,
                          status,
                          activeState,
                          subState,
                          kubePath: link.kubePath || '',
                          yamlPath: link.yamlPath ?? null,
                          type: 'link',
                          ports: Array.isArray(link.ports)
                              ? link.ports.map((p: RawLinkPort) => ({
                                    host: p?.host !== undefined ? String(p.host) : p?.hostPort !== undefined ? String(p.hostPort) : undefined,
                                    container: p?.container !== undefined ? String(p.container) : p?.containerPort !== undefined ? String(p.containerPort) : '',
                                    hostIp: p?.hostIp,
                                    protocol: p?.protocol,
                                    source: p?.source
                                }))
                              : [],
                          volumes: Array.isArray(link.volumes)
                              ? link.volumes.map((v: RawLinkVolume) => ({
                                    host: v?.host ? String(v.host) : '',
                                    container: v?.container ? String(v.container) : '',
                                    mode: undefined
                                }))
                              : [],
                          monitor: Boolean(link.monitor),
                          url: link.url,
                          labels: link.labels || {},
                          verifiedDomains: link.verifiedDomains || [],
                          ipTargets,
                          containerIds: [],
                          attachedContainers: []
                      };
                  })
                : [];

            setExternalLinks(parsed);
        } catch (error) {
            logger.error('ServicesPlugin', 'Failed to load external links', error);
        }
    }, []);

    useEffect(() => {
        loadExternalLinks();
    }, [loadExternalLinks]);

    const fetchData = useCallback(() => {
        loadExternalLinks();
    }, [loadExternalLinks]);

    const {
        openMonitorDrawer,
        openEditDrawer,
        openActions,
        requestDelete,
        overlays: serviceActionOverlays,
        closeOverlays,
        hasOpenOverlay
    } = useServiceActions({ onRefresh: fetchData });

    const {
        openActions: openContainerActions,
        closeActions: closeContainerActions,
        overlay: containerActionsOverlay,
        isOpen: containerActionsOpen,
    } = useContainerActions({ onActionComplete: fetchData });

    const [containerDrawerMode, setContainerDrawerMode] = useState<'logs' | 'terminal' | null>(null);
    const [drawerContainer, setDrawerContainer] = useState<EnrichedContainer | null>(null);
    const terminalRef = useRef<TerminalRef>(null);

    const attachNodeContext = useCallback((container: EnrichedContainer, fallbackNode?: string | null) => {
        if (container.nodeName) {
            return container;
        }
        return {
            ...container,
            nodeName: fallbackNode || 'Local',
        };
    }, []);

    const closeContainerDrawer = useCallback(() => {
        setContainerDrawerMode(null);
        setDrawerContainer(null);
    }, []);

    const openContainerLogs = useCallback((container: EnrichedContainer) => {
        setDrawerContainer(container);
        setContainerDrawerMode('logs');
    }, []);

    const openContainerTerminal = useCallback((container: EnrichedContainer) => {
        setDrawerContainer(container);
        setContainerDrawerMode('terminal');
    }, []);

    const openAttachedContainerActions = useCallback((container: EnrichedContainer) => {
        openContainerActions({
            id: container.id,
            name: container.names?.[0]?.replace(/^\//, '') || container.id.slice(0, 12),
            nodeName: container.nodeName,
        });
    }, [openContainerActions]);

    const drawerNode = drawerContainer?.nodeName && drawerContainer.nodeName !== 'Local'
        ? drawerContainer.nodeName
        : drawerContainer
            ? 'Local'
            : null;

    const logsPanelData = useMemo<ContainerLogsPanelData | null>(() => {
        if (!drawerContainer) return null;
        return {
            id: drawerContainer.id,
            name: drawerContainer.names?.[0]?.replace(/^\//, '') || drawerContainer.id,
            image: drawerContainer.image,
            state: drawerContainer.state,
            status: drawerContainer.status,
            created: drawerContainer.created,
            ports: drawerContainer.ports?.map(port => ({
                hostIp: port.hostIp,
                containerPort: port.containerPort || 0,
                hostPort: port.hostPort,
                protocol: port.protocol,
            })),
            mounts: drawerContainer.mounts as ContainerLogsPanelData['mounts'],
            hideMeta: true,
        };
    }, [drawerContainer]);

    const services = useMemo<ServiceViewModel[]>(() => {
        if (!twin || !twin.nodes) {
            return externalLinks.length > 0 ? [...externalLinks] : [];
        }

        const servicesList: ServiceViewModel[] = [];

        Object.entries(twin.nodes).forEach(([nodeName, nodeState]) => {
            if (!Array.isArray(nodeState.services)) return;
            nodeState.services.forEach(unit => {
                const viewModel = buildServiceViewModel({
                    unit,
                    nodeName,
                    nodeState,
                    proxyRoutes: twin.proxy?.routes
                });
                if (viewModel) {
                    servicesList.push(viewModel);
                }
            });
        });

        const uniqueServices = new Map<string, ServiceViewModel>();
        servicesList.forEach(service => {
            const key = `${service.nodeName}:${service.name}`;
            const existing = uniqueServices.get(key);
            if (!existing) {
                uniqueServices.set(key, service);
                return;
            }

            const isNewManaged = service.type === 'kube';
            const isExistingManaged = existing.type === 'kube';

            if (isNewManaged && !isExistingManaged) {
                uniqueServices.set(key, service);
                return;
            }
            if (isExistingManaged && !isNewManaged) {
                return;
            }

            if (service.active && !existing.active) {
                uniqueServices.set(key, service);
                return;
            }

            if (service.yamlPath && !existing.yamlPath) {
                uniqueServices.set(key, service);
            }
        });

        const finalServices = Array.from(uniqueServices.values());

        if (twin.gateway) {
            finalServices.push({
                name: twin.gateway.provider === 'fritzbox' ? 'FritzBox Gateway' : 'Internet Gateway',
                id: 'gateway',
                nodeName: 'Global',
                description: 'Upstream Internet Connection',
                active: twin.gateway.upstreamStatus === 'up',
                status: twin.gateway.upstreamStatus === 'up' ? 'active' : 'inactive',
                activeState: twin.gateway.upstreamStatus === 'up' ? 'active' : 'inactive',
                subState: 'running',
                kubePath: '',
                yamlPath: null,
                type: 'gateway',
                ports: (twin.gateway.portMappings || []).map(p => ({
                    host: p.hostPort !== undefined ? String(p.hostPort) : undefined,
                    container: p.containerPort !== undefined ? String(p.containerPort) : ''
                })),
                volumes: [],
                monitor: true,
                externalIP: twin.gateway.publicIp,
                internalIP: twin.gateway.internalIp,
                dnsServers: twin.gateway.dnsServers,
                uptime: twin.gateway.uptime,
                labels: {},
                verifiedDomains: [],
                containerIds: [],
                attachedContainers: []
            });
        }

        if (externalLinks.length > 0) {
            finalServices.push(...externalLinks);
        }

        return finalServices;
    }, [twin, externalLinks]);

    const loading = !isConnected && services.length === 0;

    const collectBundlesFromTwin = useCallback((): ServiceBundle[] => {
        if (!twin || !twin.nodes) return [];
        const aggregates: ServiceBundle[] = [];
        Object.values(twin.nodes).forEach(node => {
            if (Array.isArray(node.unmanagedBundles)) {
                aggregates.push(...node.unmanagedBundles);
            }
        });
        return aggregates;
    }, [twin]);

    const discoverUnmanaged = useCallback(async () => {
        setDiscoveryLoading(true);
        await new Promise(r => setTimeout(r, 300));

        try {
            const bundles = collectBundlesFromTwin();
            setServiceBundles(bundles);
        } catch (error) {
            logger.error('ServicesPlugin', 'Failed to discover services', error);
            setServiceBundles([]);
        } finally {
            setDiscoveryLoading(false);
        }
    }, [collectBundlesFromTwin]);

    useEffect(() => {
        setServiceBundles(collectBundlesFromTwin());
    }, [collectBundlesFromTwin]);

    const openBundleWizard = useCallback((bundle: ServiceBundle) => {
        const initialName = sanitizeBundleName(bundle.displayName);
        setSelectedBundle(bundle);
        setBundleWizardStep('assets');
        setBundleTargetName(initialName);
        setBundleStackArtifacts(generateBundleStackArtifacts(bundle, initialName));
        setBundleValidations(bundle.validations);
        setBundlePlan(null);
    }, []);

      useEffect(() => {
          if (!bundleQueryParam) {
              setHandledBundleQuery(null);
              return;
          }

          if (handledBundleQuery === bundleQueryParam) {
              return;
          }

          if (!serviceBundles.length) {
              return;
          }

          const normalizedQuery = bundleQueryParam.trim().toLowerCase();
          const normalizedNode = bundleNodeParam?.trim().toLowerCase();

          const targetBundle = serviceBundles.find(bundle => {
              const candidates = [bundle.id, bundle.derivedName, sanitizeBundleName(bundle.displayName)]
                  .filter((value): value is string => Boolean(value))
                  .map(value => value.toLowerCase());

              if (!candidates.some(candidate => candidate === normalizedQuery)) {
                  return false;
              }

              if (!normalizedNode) {
                  return true;
              }

              return (bundle.nodeName || '').toLowerCase() === normalizedNode;
          });

          if (targetBundle) {
              openBundleWizard(targetBundle);
              setHandledBundleQuery(bundleQueryParam);
          }
      }, [bundleNodeParam, bundleQueryParam, handledBundleQuery, openBundleWizard, serviceBundles]);

    function handleEditLink(service: ServiceViewModel) {
        setLinkForm({
            name: service.name,
            url: service.url || '',
            description: service.description || '',
            monitor: service.monitor || false,
            ipTargetsText: service.ipTargets && service.ipTargets.length > 0 ? service.ipTargets.join(', ') : ''
        });
        setIsEditingLink(true);
        setEditingLinkId(service.id || service.name);
        setShowLinkModal(true);
    }

    const openRegistryOverlay = useCallback(() => {
        setShowRegistryOverlay(true);
    }, []);

    const closeRegistryOverlay = useCallback(() => {
        setShowRegistryOverlay(false);
    }, []);

    const ServiceCard = ({ service }: { service: ServiceViewModel }) => {
        const dedupedPorts = useMemo(() => {
            const uniquePortsMap = new Map<string, ServicePort>();
            service.ports.forEach(p => {
                const key = `${p.host || '_'}:${p.container}`;
                if (!uniquePortsMap.has(key)) {
                    uniquePortsMap.set(key, p);
                }
            });
            return Array.from(uniquePortsMap.values());
        }, [service.ports]);

        const ensureContainerContext = useCallback((container: EnrichedContainer) => attachNodeContext(container, service.nodeName), [attachNodeContext, service.nodeName]);

        return (
            <div className="group bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-4 hover:shadow-md transition-all duration-200 relative overflow-hidden flex flex-col h-full min-w-0">
                <div className="flex items-start gap-4 justify-between mb-4">
                    <div className="flex items-start gap-3 flex-1 min-w-0">
                        <div className={`mt-1.5 w-3 h-3 shrink-0 rounded-full ${service.active ? 'bg-green-500' : 'bg-red-500'}`} title={service.status} />
                        <div className="flex-1 min-w-0">
                            <div className="flex flex-wrap items-center gap-2 mb-1">
                                <h3
                                    className="font-bold text-lg text-gray-900 dark:text-gray-100 truncate"
                                    title={service.name}
                                    data-testid={`service-name-${service.name.replace('.service', '')}`}
                                >
                                    {service.name.replace('.service', '')}
                                </h3>
                                {service.nodeName && service.nodeName !== 'Local' && (
                                    <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-400 border border-amber-200 dark:border-amber-800 rounded">
                                        {service.nodeName}
                                    </span>
                                )}
                                {service.type === 'link' && (
                                    <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 bg-cyan-100 dark:bg-cyan-900/40 text-cyan-700 dark:text-cyan-400 border border-cyan-200 dark:border-cyan-800 rounded">
                                        External Link
                                    </span>
                                )}
                                {service.type === 'gateway' && (
                                    <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 bg-orange-100 dark:bg-orange-900/40 text-orange-700 dark:text-orange-400 border border-orange-200 dark:border-orange-800 rounded">
                                        Gateway
                                    </span>
                                )}
                                {service.labels && service.labels['servicebay.role'] === 'reverse-proxy' && (
                                    <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800 rounded">
                                        Reverse Proxy
                                    </span>
                                )}
                                {service.labels && service.labels['servicebay.role'] === 'system' && (
                                    <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 bg-indigo-100 dark:bg-indigo-900/40 text-indigo-700 dark:text-indigo-400 border border-indigo-200 dark:border-indigo-800 rounded">
                                        System
                                    </span>
                                )}
                                {service.externalIP && service.type !== 'gateway' && (
                                    <span className="text-[10px] font-mono font-bold text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 px-1.5 py-0.5 rounded">
                                        IP: {service.externalIP}
                                    </span>
                                )}
                            </div>
                        </div>
                    </div>
                    <ServiceActionBar
                        service={service}
                        onMonitor={openMonitorDrawer}
                        onEdit={openEditDrawer}
                        onActions={openActions}
                        onEditLink={handleEditLink}
                        onDelete={requestDelete}
                    />
                </div>

                <div className="grid grid-cols-2 gap-x-4 gap-y-2 mb-4 bg-gray-50/50 dark:bg-gray-800/20 rounded-md p-3 border border-gray-100 dark:border-gray-800/50 flex-1">
                    {service.type === 'gateway' ? (
                        <>
                            <div className="flex flex-col">
                                <span className="text-[10px] text-gray-500 uppercase tracking-wider font-semibold">Ext IP</span>
                                <span className="text-sm font-mono text-gray-900 dark:text-gray-100">{service.externalIP || 'N/A'}</span>
                            </div>
                            <div className="flex flex-col">
                                <span className="text-[10px] text-gray-500 uppercase tracking-wider font-semibold">Int IP</span>
                                <span className="text-sm font-mono text-gray-900 dark:text-gray-100">{service.internalIP || 'N/A'}</span>
                            </div>
                            <div className="flex flex-col">
                                <span className="text-[10px] text-gray-500 uppercase tracking-wider font-semibold">Uptime</span>
                                <span className="text-sm font-mono text-gray-900 dark:text-gray-100">{service.uptime ? `${Math.floor(service.uptime / 3600)}h` : 'N/A'}</span>
                            </div>
                            {service.dnsServers && (
                                <div className="flex flex-col col-span-2">
                                    <span className="text-[10px] text-gray-500 uppercase tracking-wider font-semibold">DNS Servers</span>
                                    <span className="text-sm font-mono text-gray-900 dark:text-gray-100">{service.dnsServers.join(', ')}</span>
                                </div>
                            )}
                        </>
                    ) : service.type === 'link' ? (
                        <div className="col-span-full">
                            <span className="text-[10px] text-gray-500 uppercase tracking-wider font-semibold block">Target URL</span>
                            <a href={service.url} target="_blank" rel="noopener noreferrer" className="text-sm font-medium text-blue-600 dark:text-blue-400 hover:underline break-all">
                                {service.url}
                            </a>
                            {service.ipTargets && service.ipTargets.length > 0 && (
                                <div className="mt-3">
                                    <span className="text-[10px] text-gray-500 uppercase tracking-wider font-semibold block">IP Targets</span>
                                    <div className="flex flex-wrap gap-1.5 mt-1">
                                        {service.ipTargets.map(target => (
                                            <span key={target} className="px-2 py-0.5 rounded text-xs font-mono border border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-800/50 text-gray-700 dark:text-gray-300">
                                                {target}
                                            </span>
                                        ))}
                                    </div>
                                </div>
                            )}
                        </div>
                    ) : (
                        <>
                            {service.verifiedDomains && service.verifiedDomains.length > 0 && (
                                <div className="flex flex-col col-span-2">
                                    <span className="text-[10px] text-gray-500 uppercase tracking-wider font-semibold">Domains</span>
                                    <div className="flex flex-wrap gap-1 mt-0.5">
                                        {service.verifiedDomains.map(d => (
                                            <a 
                                                key={d} 
                                                href={d.startsWith('http') ? d : `https://${d}`}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                className="text-xs font-mono text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/20 px-1.5 py-0.5 rounded hover:underline"
                                            >
                                                {d}
                                            </a>
                                        ))}
                                    </div>
                                </div>
                            )}
                        </>
                    )}
                </div>

                <div className="flex flex-wrap items-center gap-4 pt-3 border-t border-gray-100 dark:border-gray-800/50 mt-auto">
                    {dedupedPorts.length > 0 && (
                        <div className="flex gap-2 items-center text-sm">
                            <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">Ports:</span>
                            <div className="flex flex-wrap gap-1.5">
                                {dedupedPorts.map((p, i) => {
                                    const display = p.host ? `:${p.host}` : `${p.container}/tcp`;
                                    return (
                                        <a 
                                            key={`${display}-${i}`} 
                                            href={p.host ? `http://${typeof window !== 'undefined' ? window.location.hostname : 'localhost'}:${p.host}` : '#'}
                                            target={p.host ? '_blank' : undefined}
                                            rel="noopener noreferrer"
                                            className={`px-2 py-0.5 rounded text-xs font-mono border transition-colors ${
                                                p.host 
                                                    ? 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300 border-gray-200 dark:border-gray-700 hover:bg-gray-200 dark:hover:bg-gray-700 cursor-pointer' 
                                                    : 'bg-yellow-50 dark:bg-yellow-900/20 text-yellow-700 dark:text-yellow-400 border-yellow-200 dark:border-yellow-800/30 cursor-default'
                                            }`}
                                            title={p.container ? `Container Port: ${p.container}` : 'Host Port'}
                                            onClick={(e) => !p.host && e.preventDefault()}
                                        >
                                            {display}
                                        </a>
                                    );
                                })}
                            </div>
                        </div>
                    )}

                    {service.volumes && service.volumes.length > 0 && (
                        <div className="flex gap-2 items-center text-sm ml-auto">
                            <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">Volumes:</span>
                            <span className="text-xs bg-gray-100 dark:bg-gray-800 px-2 py-0.5 rounded text-gray-500 dark:text-gray-400 border border-gray-200 dark:border-gray-700" title={service.volumes.map(v => `${v.host} -> ${v.container}`).join('\n')}>
                                {service.volumes.length}
                            </span>
                        </div>
                    )}
                </div>
                <AttachedContainerList
                    containers={service.attachedContainers}
                    onLogs={service.attachedContainers && service.attachedContainers.length > 0 ? (container) => openContainerLogs(ensureContainerContext(container)) : undefined}
                    onTerminal={service.attachedContainers && service.attachedContainers.length > 0 ? (container) => openContainerTerminal(ensureContainerContext(container)) : undefined}
                    onActions={service.attachedContainers && service.attachedContainers.length > 0 ? (container) => openAttachedContainerActions(ensureContainerContext(container)) : undefined}
                />
            </div>
        );
    };

    const BundleCard = ({ bundle }: { bundle: ServiceBundle }) => {
        const bundlePorts = useMemo(() => {
            const sourcePorts = bundle.ports && bundle.ports.length > 0
                ? bundle.ports
                : bundle.containers.flatMap(container => container.ports || []);
            const seen = new Map<string, BundlePortSummary>();
            sourcePorts.forEach(port => {
                if (!port.hostPort && !port.containerPort) return;
                const protocol = (port.protocol || 'tcp').toLowerCase();
                const key = `${port.hostIp || '0.0.0.0'}:${port.hostPort ?? port.containerPort}/${protocol}`;
                if (!seen.has(key)) {
                    seen.set(key, { ...port, protocol });
                }
            });
            return Array.from(seen.values());
        }, [bundle.ports, bundle.containers]);

        const conflictingPortKeys = useMemo(() => {
            const counters = new Map<string, number>();
            bundle.containers.forEach(container => {
                container.ports.forEach(port => {
                    if (!port.hostPort) return;
                    const protocol = (port.protocol || 'tcp').toLowerCase();
                    const key = `${port.hostPort}/${protocol}`;
                    counters.set(key, (counters.get(key) || 0) + 1);
                });
            });
            return new Set(
                Array.from(counters.entries())
                    .filter(([, count]) => count > 1)
                    .map(([key]) => key)
            );
        }, [bundle.containers]);

        const filteredHints = filterBundleHints(bundle.hints);

        const filteredValidations = useMemo(
            () => bundle.validations.filter(validation => !validation.message.toLowerCase().startsWith('multiple containers publish host port')),
            [bundle.validations]
        );

        return (
            <div className={`bg-white dark:bg-gray-900 border rounded-lg p-4 flex flex-col h-full transition-all duration-200 ${bundleSeverityClasses[bundle.severity]}`}>
            <div className="flex justify-between items-start mb-3">
                <div className="flex flex-col gap-1">
                    <div className="flex items-center gap-2 flex-wrap">
                        <h3 className="font-bold text-lg break-all text-gray-900 dark:text-gray-100">{bundle.displayName}</h3>
                        {bundle.nodeName && (
                            <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-blue-100 dark:bg-blue-900 text-blue-800 dark:text-blue-200">
                                {bundle.nodeName}
                            </span>
                        )}
                        <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-orange-100 dark:bg-orange-900 text-orange-800 dark:text-orange-200">
                            Unmanaged Bundle
                        </span>
                    </div>
                    <div className="flex flex-wrap gap-2 text-xs text-gray-500 dark:text-gray-400">
                        <span>{bundle.containers.length} containers</span>
                        <span>• {bundle.assets.length} files</span>
                    </div>
                </div>
                <div className="flex items-center gap-1 shrink-0 ml-auto bg-gray-50 dark:bg-gray-800/50 p-1 rounded-lg border border-gray-100 dark:border-gray-800">
                    <button
                        onClick={() => openBundleWizard(bundle)}
                        className="p-1.5 text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 hover:bg-gray-200 dark:hover:bg-gray-700 rounded transition-colors"
                        title="Migrate bundle"
                        aria-label={`Migrate ${bundle.displayName}`}
                    >
                        <ArrowRight size={16} />
                        <span className="sr-only">Migrate bundle</span>
                    </button>
                    <button
                        onClick={() => setBundlePendingDelete(bundle)}
                        className="p-1.5 text-gray-500 dark:text-gray-400 hover:text-red-600 dark:hover:text-red-400 hover:bg-red-100 dark:hover:bg-red-900/30 rounded transition-colors"
                        title="Delete bundle from node"
                        aria-label={`Delete ${bundle.displayName}`}
                    >
                        <Trash2 size={15} />
                        <span className="sr-only">Delete bundle</span>
                    </button>
                </div>
            </div>

            <div className="space-y-2 text-sm text-gray-600 dark:text-gray-400 bg-gray-50 dark:bg-gray-800/50 p-3 rounded-lg flex-1">
                <div className="flex gap-2">
                    <FileCode size={16} className="shrink-0 mt-0.5" />
                    <div className="flex flex-wrap gap-1">
                        {bundle.assets.slice(0, 4).map(asset => (
                            <FileBadge key={asset.path} path={asset.path} nodeName={bundle.nodeName} />
                        ))}
                        {bundle.assets.length > 4 && (
                            <span className="text-xs text-gray-500">+{bundle.assets.length - 4} more</span>
                        )}
                    </div>
                </div>
                {filteredHints.length > 0 && (
                    <div className="flex gap-2">
                        <AlertCircle size={16} className="shrink-0 mt-0.5 text-orange-500" />
                        <ul className="space-y-0.5 text-xs">
                            {filteredHints.slice(0, 3).map((hint, idx) => (
                                <li key={idx} className="leading-snug">{hint}</li>
                            ))}
                            {filteredHints.length > 3 && (
                                <li className="text-[10px] text-gray-500">+{filteredHints.length - 3} more hints</li>
                            )}
                        </ul>
                    </div>
                )}
                {filteredValidations.length > 0 && (
                    <div className="flex flex-col gap-1">
                        {filteredValidations.map((validation, idx) => (
                            <div key={idx} className={`text-xs px-2 py-1 rounded border ${validation.level === 'error' ? 'border-red-200 text-red-700 bg-red-50 dark:border-red-900/50 dark:text-red-300 dark:bg-red-900/20' : validation.level === 'warning' ? 'border-amber-200 text-amber-700 bg-amber-50 dark:border-amber-900/50 dark:text-amber-300 dark:bg-amber-900/20' : 'border-green-200 text-green-700 bg-green-50 dark:border-green-900/50 dark:text-green-300 dark:bg-green-900/20'}`}>
                                {validation.message}
                            </div>
                        ))}
                    </div>
                )}
            </div>
            {bundlePorts.length > 0 && (
                <div className="flex flex-wrap items-center gap-4 pt-3 border-t border-gray-100 dark:border-gray-800/50 mt-3">
                    <div className="flex gap-2 items-center text-sm">
                        <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">Ports:</span>
                        <div className="flex flex-wrap gap-1.5">
                            {bundlePorts.map((port, idx) => {
                                const hostValue = typeof port.hostPort !== 'undefined' && port.hostPort !== null ? String(port.hostPort) : undefined;
                                const containerValue = typeof port.containerPort !== 'undefined' && port.containerPort !== null ? String(port.containerPort) : undefined;
                                const protocol = (port.protocol || 'tcp').toLowerCase();
                                const display = hostValue ? `:${hostValue}` : `${containerValue || '—'}/${protocol}`;
                                const conflictKey = hostValue ? `${hostValue}/${protocol}` : null;
                                const hasConflict = conflictKey ? conflictingPortKeys.has(conflictKey) : false;
                                const baseClasses = hostValue
                                    ? hasConflict
                                        ? 'bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300 border-red-200 dark:border-red-800 hover:bg-red-100 dark:hover:bg-red-900/30'
                                        : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300 border-gray-200 dark:border-gray-700 hover:bg-gray-200 dark:hover:bg-gray-700 cursor-pointer'
                                    : 'bg-yellow-50 dark:bg-yellow-900/20 text-yellow-700 dark:text-yellow-400 border-yellow-200 dark:border-yellow-800/30 cursor-default';
                                const title = hostValue
                                    ? hasConflict
                                        ? `Host port ${hostValue}/${protocol} is published by multiple containers`
                                        : containerValue
                                            ? `Host ${hostValue} → Container ${containerValue}/${protocol}`
                                            : `Host port ${hostValue}/${protocol}`
                                    : `Container port ${containerValue || 'unknown'}/${protocol}`;
                                const href = hostValue ? `http://${typeof window !== 'undefined' ? window.location.hostname : 'localhost'}:${hostValue}` : '#';
                                return (
                                    <a
                                        key={`${display}-${idx}`}
                                        href={href}
                                        target={hostValue ? '_blank' : undefined}
                                        rel={hostValue ? 'noopener noreferrer' : undefined}
                                        className={`px-2 py-0.5 rounded text-xs font-mono border transition-colors ${baseClasses}`}
                                        title={title}
                                        onClick={event => {
                                            if (!hostValue) {
                                                event.preventDefault();
                                            }
                                        }}
                                    >
                                        {display}
                                    </a>
                                );
                            })}
                        </div>
                    </div>
                </div>
            )}
            </div>
        );
    };

    const renderServiceContent = () => {
        if (loading) {
            return (
                <PluginLoading message="Loading services..." subMessage="Waiting for agent synchronization..." />
            );
        }

        const totalResults = filteredServices.length + filteredBundles.length;
        const totalInventory = services.length + serviceBundles.length;
        const hasSearch = searchQuery.trim().length > 0;
        const hasBundles = serviceBundles.length > 0;

        if (totalResults === 0) {
            return (
                <div className="flex flex-col items-center justify-center p-12 text-center">
                    <div className="bg-slate-50 dark:bg-slate-900 rounded-full p-6 mb-4">
                        <Box size={48} className="text-slate-300 dark:text-slate-600" />
                    </div>
                    <h3 className="text-lg font-medium text-slate-900 dark:text-slate-100 mb-2">
                        {hasSearch ? 'No Results' : 'No Services or Bundles Found'}
                    </h3>
                    <p className="text-sm text-slate-500 dark:text-slate-400 max-w-sm mb-6">
                        {hasSearch
                            ? `Nothing matching "${searchQuery}" exists across managed services or unmanaged bundles.`
                            : "ServiceBay couldn't find any Quadlet-managed services or discovery bundles on your nodes yet."}
                    </p>

                    {!hasSearch && totalInventory === 0 && (
                        <div className="text-left text-xs text-slate-400 bg-slate-100 dark:bg-slate-950 p-4 rounded-lg border border-slate-200 dark:border-slate-800 font-mono w-full max-w-md overflow-x-auto">
                            <p className="font-bold mb-2">Debug Information:</p>
                            <ul className="space-y-1">
                                <li>Twin Status: {isConnected ? 'Connected' : 'Disconnected'}</li>
                                <li>Last Update: {new Date(lastUpdate).toLocaleTimeString()}</li>
                                {Object.entries(twin?.nodes || {}).map(([name, state]) => (
                                    <li key={name} className="mt-2 pt-2 border-t border-slate-200 dark:border-slate-800">
                                        <strong>Node: {name}</strong><br />
                                        - Raw Services: {state.services.length}<br />
                                        - Files: {Object.keys(state.files).length}<br />
                                        - Containers: {state.containers.length}<br />
                                        - Bundles: {(state.unmanagedBundles || []).length}
                                    </li>
                                ))}
                            </ul>
                            <p className="mt-2 italic opacity-75">
                                Note: Managed services come from Quadlet definitions; unmanaged bundles surface from discovery scans.
                            </p>
                        </div>
                    )}
                </div>
            );
        }

        const combinedItems = [
            ...filteredServices.map(service => ({ type: 'service' as const, id: `svc-${service.nodeName || 'local'}-${service.name}`, service })),
            ...filteredBundles.map(bundle => ({ type: 'bundle' as const, id: `bundle-${bundle.id}`, bundle }))
        ];

        return (
            <div className="space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/40 px-4 py-3">
                    <div>
                        <p className="text-xs uppercase tracking-widest text-orange-500 dark:text-orange-300">Unmanaged Bundles</p>
                        <p className="text-sm text-gray-600 dark:text-gray-400">
                            {hasBundles
                                ? `${serviceBundles.length} bundle${serviceBundles.length === 1 ? '' : 's'} awaiting migration.`
                                : 'Scan for unmanaged services and container groups ready for migration.'}
                        </p>
                    </div>
                    <button 
                        onClick={discoverUnmanaged}
                        disabled={discoveryLoading}
                        className="px-4 py-2 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 text-sm rounded-lg flex items-center gap-2 transition-colors disabled:opacity-60"
                    >
                        {discoveryLoading ? <RefreshCw size={16} className="animate-spin" /> : <RefreshCw size={16} />}
                        {discoveryLoading ? 'Scanning...' : hasBundles ? 'Refresh Bundles' : 'Discover Bundles'}
                    </button>
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-2 2xl:grid-cols-3 gap-6 auto-rows-fr">
                    {combinedItems.map(entry => (
                        entry.type === 'service'
                            ? <ServiceCard key={entry.id} service={entry.service} />
                            : <BundleCard key={entry.id} bundle={entry.bundle} />
                    ))}
                </div>
            </div>
        );
    };

  const closeBundleWizard = useCallback(() => {
      setSelectedBundle(null);
      setBundlePlan(null);
      setBundleTargetName('');
      setBundleStackArtifacts(null);
      setBundleWizardStep('assets');
      setBundlePlanLoading(false);
  }, []);

  const handleDismissBundle = useCallback(async () => {
      if (!bundlePendingDelete) return;
      const targetBundle = bundlePendingDelete;
      setBundleDeleteLoading(true);
      const toastId = addToast('loading', 'Deleting bundle', targetBundle.displayName, 0);
      try {
          const res = await fetch('/api/system/discovery/dismiss', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ bundleId: targetBundle.id, nodeName: targetBundle.nodeName })
          });
          const payload = await res.json().catch(() => ({}));
          if (!res.ok) {
              throw new Error(payload.error || 'Failed to delete bundle');
          }
          setServiceBundles(prev => prev.filter(bundle => bundle.id !== targetBundle.id));
          setBundlePendingDelete(null);
          await discoverUnmanaged();
          const stoppedCount = Array.isArray(payload.stoppedUnits) ? payload.stoppedUnits.length : 0;
          const removedFilesCount = Array.isArray(payload.removedFiles) ? payload.removedFiles.length : 0;
          const summary = `${stoppedCount} service${stoppedCount === 1 ? '' : 's'} stopped · ${removedFilesCount} file${removedFilesCount === 1 ? '' : 's'} removed`;
          updateToast(toastId, 'success', 'Unmanaged bundle deleted', summary);
      } catch (error) {
          const message = error instanceof Error ? error.message : 'Failed to delete bundle';
          updateToast(toastId, 'error', 'Deletion failed', message);
      } finally {
          setBundleDeleteLoading(false);
      }
  }, [bundlePendingDelete, addToast, updateToast, discoverUnmanaged]);

  const handleEscape = useCallback(() => {
      if (containerDrawerMode) {
          closeContainerDrawer();
          return;
      }
      if (containerActionsOpen) {
          closeContainerActions();
          return;
      }
      if (hasOpenOverlay) {
          closeOverlays();
          return;
      }
      if (selectedBundle) {
          closeBundleWizard();
          return;
      }
      if (showRegistryOverlay) {
          closeRegistryOverlay();
          return;
      }
      if (showLinkModal) {
          setShowLinkModal(false);
      }
  }, [closeBundleWizard, closeContainerActions, closeContainerDrawer, closeOverlays, closeRegistryOverlay, containerActionsOpen, containerDrawerMode, hasOpenOverlay, selectedBundle, showRegistryOverlay, showLinkModal]);

  useEscapeKey(handleEscape, Boolean(containerDrawerMode || containerActionsOpen || hasOpenOverlay || selectedBundle || showRegistryOverlay || showLinkModal), true);
  useEscapeKey(closeContainerDrawer, Boolean(containerDrawerMode), true);

  const fetchBundlePlanForBundle = useCallback(async (bundle: ServiceBundle, target: string, dryRun = true) => {
      if (!target) return;
      const nodeParam = bundle.nodeName && bundle.nodeName !== 'Local' ? `?node=${bundle.nodeName}` : '';
      const isMerge = bundle.services.length > 1;
      const endpoint = isMerge ? '/api/system/discovery/merge' : '/api/system/discovery/migrate';
      const body = isMerge
          ? { services: bundle.services, newName: target, dryRun }
          : { service: bundle.services[0], customName: target, dryRun };

      setBundlePlanLoading(true);
      try {
          const res = await fetch(`${endpoint}${nodeParam}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body)
          });
          if (!res.ok) {
              const data = await res.json().catch(() => ({}));
              throw new Error(data.error || 'Unable to build merge plan');
          }
          const payload = await res.json();
          const plan: MigrationPlan | null = payload.plan ?? null;
          setBundlePlan(plan);
          if (plan?.validations) {
              const merged = dedupeValidations([...bundle.validations, ...plan.validations]);
              setBundleValidations(merged);
          } else {
              setBundleValidations(bundle.validations);
          }
      } catch (error: unknown) {
          const message = error instanceof Error ? error.message : 'Failed to build merge plan';
          addToast('error', message);
          setBundlePlan(null);
          setBundleValidations(bundle.validations);
      } finally {
          setBundlePlanLoading(false);
      }
  }, [addToast]);

  useEffect(() => {
      if (!selectedBundle) return;
      const artifacts = generateBundleStackArtifacts(selectedBundle, bundleTargetName || selectedBundle.derivedName);
      setBundleStackArtifacts(artifacts);
      if (!bundlePlan || bundleWizardStep !== 'backup') {
          setBundleValidations(selectedBundle.validations);
      }
  }, [selectedBundle, bundleTargetName, bundlePlan, bundleWizardStep]);

  useEffect(() => {
      if (selectedBundle && bundleWizardStep === 'backup' && bundleTargetName) {
          fetchBundlePlanForBundle(selectedBundle, bundleTargetName, true);
      }
      if (bundleWizardStep !== 'backup') {
          setBundlePlan(null);
      }
  }, [selectedBundle, bundleWizardStep, bundleTargetName, fetchBundlePlanForBundle]);

  const executeBundleMerge = async () => {
      if (!selectedBundle) return;
      if (!bundleTargetName) {
          addToast('error', 'Provide a target service name');
          return;
      }

      const nodeParam = selectedBundle.nodeName && selectedBundle.nodeName !== 'Local' ? `?node=${selectedBundle.nodeName}` : '';
      const isMerge = selectedBundle.services.length > 1;
      const endpoint = isMerge ? '/api/system/discovery/merge' : '/api/system/discovery/migrate';
      const body = isMerge
          ? { services: selectedBundle.services, newName: bundleTargetName }
          : { service: selectedBundle.services[0], customName: bundleTargetName };

      setBundleActionLoading(true);
      const toastId = addToast('loading', 'Applying bundle merge...', `Creating ${bundleTargetName}`, 0);
      try {
          const res = await fetch(`${endpoint}${nodeParam}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body)
          });
          if (!res.ok) {
              const data = await res.json().catch(() => ({}));
              throw new Error(data.error || 'Merge failed');
          }

          updateToast(toastId, 'success', 'Bundle merged', `Created ${bundleTargetName}`);
          closeBundleWizard();
          await discoverUnmanaged();
          fetchData();
      } catch (error: unknown) {
          const message = error instanceof Error ? error.message : 'Failed to merge bundle';
          updateToast(toastId, 'error', 'Merge failed', message);
      } finally {
          setBundleActionLoading(false);
      }
  };

  useEffect(() => {
      const q = searchQuery.trim().toLowerCase();

      const filtered = q
          ? services.filter(s =>
                s.name.toLowerCase().includes(q) ||
                (s.description && s.description.toLowerCase().includes(q)) ||
                (s.nodeName && s.nodeName.toLowerCase().includes(q))
            )
          : services;
      setFilteredServices(filtered);

      const filteredBundleList = q
          ? serviceBundles.filter(bundle => {
                if (bundle.displayName?.toLowerCase().includes(q)) return true;
                if (bundle.nodeName?.toLowerCase().includes(q)) return true;
                if (bundle.derivedName?.toLowerCase().includes(q)) return true;
                const serviceHit = bundle.services.some(svc => svc.serviceName.toLowerCase().includes(q));
                if (serviceHit) return true;
                const hintHit = bundle.hints.some(hint => hint.toLowerCase().includes(q));
                if (hintHit) return true;
                return bundle.containers.some(container => container.name.toLowerCase().includes(q));
            })
          : serviceBundles;
      setFilteredBundles(filteredBundleList);
  }, [services, serviceBundles, searchQuery]);



  // SSE Effect removed - Twin handles updates.
  /*
  useEffect(() => {
    // Setup SSE for real-time updates
    const eventSource = new EventSource('/api/stream');
    
    eventSource.onmessage = (event) => {
      // ...
    };

    return () => {
      eventSource.close();
    };
  }, []);
  */

  async function handleSaveLink() {
    if (!linkForm.name || !linkForm.url) {
        addToast('error', 'Name and URL are required');
        return;
    }

    try {
        const method = isEditingLink ? 'PUT' : 'POST';
        const url = isEditingLink ? `/api/services/${editingLinkId}` : '/api/services';

        const ipTargets = linkForm.ipTargetsText
            ? linkForm.ipTargetsText.split(',').map(s => s.trim()).filter(Boolean)
            : [];

        const res = await fetch(url, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: linkForm.name,
                url: linkForm.url,
                description: linkForm.description,
                monitor: linkForm.monitor,
                ipTargets,
                type: 'link'
            })
        });

        if (!res.ok) throw new Error('Failed to save link');

        addToast('success', isEditingLink ? 'Link updated successfully' : 'Link added successfully');
        setShowLinkModal(false);
        setLinkForm({ name: '', url: '', description: '', monitor: false, ipTargetsText: '' });
        setIsEditingLink(false);
        setEditingLinkId(null);
        fetchData();
    } catch {
        addToast('error', 'Failed to save link');
    }
  }

  // filteredServices is already computed in useEffect

    return (
        <div className="h-full flex flex-col relative">
            {serviceActionOverlays}
            {containerActionsOverlay}
            {containerDrawerMode && drawerContainer && (
                <div className="fixed inset-0 z-[60] flex justify-end bg-gray-950/70 backdrop-blur-sm">
                    <div className="w-full max-w-5xl h-full bg-white dark:bg-gray-950 border-l border-gray-200 dark:border-gray-800 shadow-2xl">
                        {containerDrawerMode === 'logs' && logsPanelData ? (
                            <ContainerLogsPanel
                                container={logsPanelData}
                                nodeName={drawerNode ?? undefined}
                                onClose={closeContainerDrawer}
                            />
                        ) : (
                            <div className="h-full flex flex-col bg-gray-950">
                                <div className="flex items-start justify-between px-6 py-4 border-b border-gray-800 bg-gray-900">
                                    <div>
                                        <p className="text-xs uppercase tracking-wider text-gray-500">Terminal</p>
                                        <div className="flex items-center gap-3 text-white text-lg font-semibold">
                                            <TerminalIcon size={18} />
                                            <span>{drawerContainer.names?.[0]?.replace(/^\//, '') || drawerContainer.id}</span>
                                        </div>
                                        {drawerNode && (
                                            <div className="mt-2 inline-flex items-center gap-2 text-xs text-gray-400">
                                                <span className="uppercase tracking-wide">Node</span>
                                                <span className="px-2 py-0.5 rounded-full bg-gray-800 text-gray-200 border border-gray-700">{drawerNode}</span>
                                            </div>
                                        )}
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <button
                                            onClick={() => terminalRef.current?.clear()}
                                            className="p-2 rounded-full text-gray-400 hover:text-white hover:bg-gray-800"
                                            title="Clear terminal"
                                        >
                                            <Eraser size={18} />
                                        </button>
                                        <button
                                            onClick={() => terminalRef.current?.reconnect()}
                                            className="p-2 rounded-full text-gray-400 hover:text-white hover:bg-gray-800"
                                            title="Reconnect"
                                        >
                                            <RefreshCw size={18} />
                                        </button>
                                        <button
                                            onClick={closeContainerDrawer}
                                            className="p-2 rounded-full text-gray-400 hover:text-white hover:bg-gray-800"
                                            title="Close"
                                        >
                                            <X size={18} />
                                        </button>
                                    </div>
                                </div>
                                <div className="flex-1 overflow-hidden">
                                    <DynamicTerminal
                                        ref={terminalRef}
                                        id={`container:${(drawerNode && drawerNode !== 'Local' ? drawerNode : 'local')}:${drawerContainer.id}`}
                                        showControls={false}
                                    />
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            )}
                        <ConfirmModal
                isOpen={!!bundlePendingDelete}
                title="Delete Unmanaged Bundle"
                message={`Stop every unmanaged unit in "${bundlePendingDelete?.displayName ?? ''}" and delete its Quadlet files on ${bundlePendingDelete?.nodeName ?? 'Local'}? This cannot be undone.`}
                confirmText={bundleDeleteLoading ? 'Deleting...' : 'Delete from Node'}
                confirmDisabled={bundleDeleteLoading}
                isDestructive
                onConfirm={handleDismissBundle}
                onCancel={() => {
                        if (bundleDeleteLoading) return;
                        setBundlePendingDelete(null);
                }}
            />

      <PageHeader 
        title="Services" 
        showBack={false} 
        helpId="services"
        actions={
            <>
                <button 
                    onClick={openRegistryOverlay}
                    className="flex items-center gap-2 bg-blue-600 text-white p-2 rounded hover:bg-blue-700 shadow-sm transition-colors text-sm font-medium"
                    title="New Service"
                >
                    <Plus size={18} />
                </button>
            </>
        }
      >
        <div className="relative flex-1 max-w-md min-w-[100px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input 
                type="text" 
                placeholder="Search services or bundles..." 
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-9 pr-4 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none text-sm"
            />
        </div>
      </PageHeader>

      <div className="flex-1 overflow-y-auto px-4 md:px-6 py-6">
          {renderServiceContent()}
      </div>

            {filePreview && (
                <FileViewerOverlay
                        isOpen={Boolean(filePreview)}
                        path={filePreview.path}
                        nodeName={filePreview.nodeName}
                        onClose={closeFilePreview}
                />
            )}

      {/* Bundle Wizard */}
      {selectedBundle && (
        <div className="fixed inset-0 z-50 flex justify-end bg-gray-950/60 backdrop-blur-sm">
            <div className="w-full sm:max-w-5xl h-full border-l border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 shadow-2xl flex flex-col animate-in slide-in-from-right-10">
                <div className="flex-1 overflow-y-auto">
                    <div className="px-6 py-5 border-b border-gray-200 dark:border-gray-800 flex flex-col gap-4">
                        <div className="flex items-start justify-between">
                            <div>
                                <p className="text-xs uppercase tracking-widest text-gray-500 dark:text-gray-400">Merge Wizard</p>
                                <h3 className="text-2xl font-semibold text-gray-900 dark:text-white">{selectedBundle.displayName}</h3>
                                <p className="text-sm text-gray-500 dark:text-gray-400">{selectedBundle.nodeName}</p>
                            </div>
                            <button onClick={closeBundleWizard} className="text-gray-500 hover:text-gray-800 dark:hover:text-gray-200">
                                <X size={20} />
                            </button>
                        </div>
                        <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3">
                            {bundleWizardSteps.map((step, index) => {
                                const isActive = bundleWizardStep === step.key;
                                const isComplete = wizardStepIndex > index;
                                return (
                                    <div
                                        key={step.key}
                                        className={`rounded-2xl border px-4 py-4 shadow-sm bg-white dark:bg-gray-900 min-h-[120px] ${
                                            isActive
                                                ? 'border-blue-500'
                                                : isComplete
                                                    ? 'border-emerald-500'
                                                    : 'border-gray-200 dark:border-gray-800'
                                        }`}
                                        title={step.tooltip}
                                    >
                                        <div className="flex items-start gap-3">
                                            <div
                                                className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full border text-sm font-semibold ${
                                                    isActive
                                                        ? 'border-blue-500 text-blue-600 bg-blue-50 dark:border-blue-400 dark:text-blue-200 dark:bg-blue-950/30'
                                                        : isComplete
                                                            ? 'border-emerald-500 text-emerald-600 bg-emerald-50 dark:border-emerald-400 dark:text-emerald-200 dark:bg-emerald-950/30'
                                                            : 'border-gray-300 text-gray-500 dark:border-gray-700 dark:text-gray-400 bg-gray-50 dark:bg-gray-900/40'
                                                }`}
                                            >
                                                {index + 1}
                                            </div>
                                            <div className="flex-1 min-w-0">
                                                <p className={`text-xs uppercase tracking-wide font-semibold ${
                                                    isActive
                                                        ? 'text-blue-600 dark:text-blue-300'
                                                        : isComplete
                                                            ? 'text-emerald-600 dark:text-emerald-300'
                                                            : 'text-gray-500 dark:text-gray-400'
                                                }`}>
                                                    {step.label}
                                                </p>
                                                <p className="mt-1 text-xs leading-snug text-gray-500 dark:text-gray-400">
                                                    {step.description}
                                                </p>
                                            </div>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                        <div className="flex flex-col gap-3 rounded-xl border border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/40 px-4 py-3">
                            <div className="flex items-start gap-3 text-sm text-gray-700 dark:text-gray-200">
                                <ShieldCheck size={18} className="text-blue-600 dark:text-blue-300 mt-0.5" />
                                <p className="leading-snug">
                                    Every merge snapshots legacy files, runs <code className="font-mono text-xs">podman kube play --dry-run</code>, and records rollback metadata before enabling the managed Quadlet. Keep this in mind when reviewing plan details.
                                </p>
                            </div>
                            <div className="flex flex-wrap items-center gap-2 text-sm text-gray-600 dark:text-gray-300">
                                <PluginHelp helpId={MERGE_HELP_ID} label="Merge Workflow guide" />
                                <span className="text-xs">Opens the full checklist if you need a refresher mid-migration.</span>
                            </div>
                        </div>
                        <div className="flex flex-col gap-2">
                            <label className="text-xs font-semibold text-gray-600 dark:text-gray-300">Target Service Name</label>
                            <input
                                value={bundleTargetName}
                                onChange={(e) => setBundleTargetName(sanitizeBundleName(e.target.value))}
                                placeholder="my-app-stack"
                                className="px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 text-sm"
                            />
                            <p className="text-[11px] text-gray-500">This becomes the Quadlet unit and Pod name.</p>
                        </div>
                    </div>
                    <div className="p-6 space-y-6">
                    {bundleWizardStep === 'assets' && selectedBundle && (
                        <div className="space-y-5">
                            <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                                {[
                                    { label: 'Systemd Units', value: selectedBundle.services.length, caption: 'Unit files detected in this bundle', Icon: Box, accent: 'bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-200' },
                                    { label: 'Containers', value: selectedBundle.containers.length, caption: 'Runtime containers behind these units', Icon: Activity, accent: 'bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-200' },
                                    { label: 'Config Files', value: selectedBundle.assets.length, caption: 'Files that will be migrated', Icon: FileCode, accent: 'bg-purple-50 dark:bg-purple-900/20 text-purple-700 dark:text-purple-200' },
                                    { label: 'Hints & Warnings', value: selectedBundleHints.length + bundleValidations.length, caption: 'Signals to review before migrating', Icon: AlertCircle, accent: 'bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-200' }
                                ].map(stat => {
                                    const Icon = stat.Icon;
                                    return (
                                        <div key={stat.label} className="border border-gray-200 dark:border-gray-800 rounded-xl p-3 bg-white dark:bg-gray-900 flex items-center gap-3">
                                            <div className={`p-2 rounded-lg ${stat.accent}`}>
                                                <Icon size={18} />
                                            </div>
                                            <div>
                                                <p className="text-xl font-semibold text-gray-900 dark:text-gray-100 leading-none">{stat.value}</p>
                                                <p className="text-xs uppercase tracking-wider text-gray-500 dark:text-gray-400">{stat.label}</p>
                                                <p className="text-[11px] text-gray-400 dark:text-gray-500 leading-tight">{stat.caption}</p>
                                            </div>
                                        </div>
                                    );
                                })}
                            </section>

                            <section className="grid gap-4">
                                <div className="border border-gray-200 dark:border-gray-800 rounded-lg p-4 bg-gray-50 dark:bg-gray-900/40">
                                    <h4 className="text-sm font-semibold text-gray-700 dark:text-gray-200 mb-3">Systemd Units, Containers & Files</h4>
                                    <ul className="space-y-2 text-sm text-gray-600 dark:text-gray-400">
                                        {selectedBundle.services.map(service => {
                                            const path = service.sourcePath || service.unitFile || '';
                                            const attachedContainers = (service.containerIds || [])
                                                .map(containerId => containersById.get(containerId))
                                                .filter((container): container is BundleContainerSummary => Boolean(container));
                                            const podShortId = service.podId ? service.podId.substring(0, 12) : null;
                                            return (
                                                <li key={service.serviceName} className="border border-gray-200 dark:border-gray-800 rounded-lg px-3 py-2 bg-white dark:bg-gray-950/40">
                                                    <div className="flex flex-col gap-1">
                                                        <div className="flex flex-wrap items-center justify-between gap-2">
                                                            <p className="font-medium text-gray-900 dark:text-gray-100" data-testid="service-name">{service.serviceName}</p>
                                                        </div>
                                                        <div className="flex flex-col gap-0.5">
                                                            <span className="text-[11px] font-semibold tracking-wide uppercase text-gray-400 dark:text-gray-500">Config File:</span>
                                                            {path ? (
                                                                <FileBadge path={path} nodeName={selectedBundle.nodeName} variant="inline" />
                                                            ) : (
                                                                <span className="text-xs text-gray-500 dark:text-gray-400">Unknown source</span>
                                                            )}
                                                        </div>
                                                        {attachedContainers.length > 0 && (
                                                            <div className="mt-2 space-y-2">
                                                                {attachedContainers.map((container, containerIndex) => (
                                                                    <div key={container.id} className="space-y-2">
                                                                        <div className="flex flex-col gap-0.5">
                                                                            <span className="text-[11px] font-semibold tracking-wide uppercase text-gray-400 dark:text-gray-500">Container Image:</span>
                                                                            <span className="text-xs font-mono text-gray-700 dark:text-gray-200 block whitespace-normal break-all" title={container.image}>
                                                                                {container.image}
                                                                            </span>
                                                                        </div>
                                                                        {(container.ports.length > 0 || (containerIndex === 0 && podShortId)) && (
                                                                            <div className="flex flex-wrap items-center gap-1.5">
                                                                                {container.ports.map((port, portIdx) => {
                                                                                    const protocol = (port.protocol || 'tcp').toLowerCase();
                                                                                    const hostValue = typeof port.hostPort !== 'undefined' && port.hostPort !== null ? String(port.hostPort) : undefined;
                                                                                    const containerValue = typeof port.containerPort !== 'undefined' && port.containerPort !== null ? String(port.containerPort) : undefined;
                                                                                    const display = hostValue ? `:${hostValue}` : `${containerValue || '—'}/${protocol}`;
                                                                                    const href = hostValue ? `http://${typeof window !== 'undefined' ? window.location.hostname : 'localhost'}:${hostValue}` : '#';
                                                                                    const title = hostValue
                                                                                        ? containerValue
                                                                                            ? `Host ${hostValue} → Container ${containerValue}/${protocol}`
                                                                                            : `Host port ${hostValue}/${protocol}`
                                                                                        : `Container port ${containerValue || 'unknown'}/${protocol}`;
                                                                                    return (
                                                                                        <a
                                                                                            key={`${container.id}-${display}-${portIdx}`}
                                                                                            href={href}
                                                                                            target={hostValue ? '_blank' : undefined}
                                                                                            rel={hostValue ? 'noopener noreferrer' : undefined}
                                                                                            className={`px-2 py-0.5 rounded text-[11px] font-mono border transition-colors ${
                                                                                                hostValue
                                                                                                    ? 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300 border-gray-200 dark:border-gray-700 hover:bg-gray-200 dark:hover:bg-gray-700'
                                                                                                    : 'bg-yellow-50 dark:bg-yellow-900/20 text-yellow-700 dark:text-yellow-400 border-yellow-200 dark:border-yellow-800/30'
                                                                                            }`}
                                                                                            title={title}
                                                                                            onClick={event => {
                                                                                                if (!hostValue) {
                                                                                                    event.preventDefault();
                                                                                                }
                                                                                            }}
                                                                                        >
                                                                                            {display}
                                                                                        </a>
                                                                                    );
                                                                                })}
                                                                                {containerIndex === 0 && podShortId && (
                                                                                    <span className="px-2 py-0.5 rounded text-[11px] font-mono border border-indigo-200 dark:border-indigo-800 bg-indigo-50 dark:bg-indigo-900/20 text-indigo-700 dark:text-indigo-300">
                                                                                        Pod {podShortId}
                                                                                    </span>
                                                                                )}
                                                                            </div>
                                                                        )}
                                                                    </div>
                                                                ))}
                                                            </div>
                                                        )}
                                                        {attachedContainers.length === 0 && podShortId && (
                                                            <div className="mt-2">
                                                                <span className="px-2 py-0.5 rounded text-[11px] font-mono border border-indigo-200 dark:border-indigo-800 bg-indigo-50 dark:bg-indigo-900/20 text-indigo-700 dark:text-indigo-300">
                                                                    Pod {podShortId}
                                                                </span>
                                                            </div>
                                                        )}
                                                    </div>
                                                </li>
                                            );
                                        })}
                                    </ul>
                                </div>
                            </section>

                            <section className="grid md:grid-cols-2 gap-4">
                                {extraConfigAssets.length > 0 && (
                                    <div className="border border-gray-200 dark:border-gray-800 rounded-lg p-4 bg-white dark:bg-gray-900">
                                        <h4 className="text-sm font-semibold text-gray-700 dark:text-gray-200 mb-2">Additional Config Files</h4>
                                        <ul className="space-y-1 text-xs font-mono text-gray-600 dark:text-gray-400 max-h-40 overflow-y-auto">
                                            {extraConfigAssets.map(asset => (
                                                <li key={asset.path}>
                                                    <FileBadge path={asset.path} nodeName={selectedBundle.nodeName} variant="list" />
                                                </li>
                                            ))}
                                        </ul>
                                    </div>
                                )}
                                <div className="border border-gray-200 dark:border-gray-800 rounded-lg p-4 bg-white dark:bg-gray-900">
                                    <h4 className="text-sm font-semibold text-gray-700 dark:text-gray-200 mb-2">Merge Hints</h4>
                                    {selectedBundleHints.length === 0 ? (
                                        <p className="text-sm text-gray-500">No additional hints from discovery.</p>
                                    ) : (
                                        <ul className="space-y-1 text-sm text-gray-600 dark:text-gray-400">
                                            {selectedBundleHints.map((hint, idx) => (
                                                <li key={idx} className="flex items-start gap-2">
                                                    <AlertCircle size={14} className="text-amber-500 mt-0.5" />
                                                    <span>{hint}</span>
                                                </li>
                                            ))}
                                        </ul>
                                    )}
                                </div>
                            </section>

                            <section className="border border-gray-200 dark:border-gray-800 rounded-lg p-4 bg-gray-50 dark:bg-gray-900/40">
                                <h4 className="text-sm font-semibold text-gray-700 dark:text-gray-200 mb-2">Dependency Relationships</h4>
                                {selectedBundle.graph.length === 0 ? (
                                    <p className="text-sm text-gray-500">No dependency hints detected.</p>
                                ) : (
                                    <ul className="space-y-1 text-sm text-gray-600 dark:text-gray-400">
                                        {selectedBundle.graph.slice(0, 6).map(edge => (
                                            <li key={`${edge.from}-${edge.to}-${edge.reason}`} className="flex items-center gap-2">
                                                <span className="font-mono text-xs bg-white dark:bg-gray-950 px-2 py-0.5 rounded border border-gray-200 dark:border-gray-800">{edge.from}</span>
                                                <ArrowRight size={14} className="text-gray-400" />
                                                <span className="font-mono text-xs bg-white dark:bg-gray-950 px-2 py-0.5 rounded border border-gray-200 dark:border-gray-800">{edge.to}</span>
                                                <span className="text-[10px] uppercase tracking-wide text-gray-400">{edge.reason}</span>
                                            </li>
                                        ))}
                                        {selectedBundle.graph.length > 6 && (
                                            <li className="text-[11px] text-gray-500">+{selectedBundle.graph.length - 6} additional relationships</li>
                                        )}
                                    </ul>
                                )}
                            </section>

                            <section className="border border-gray-200 dark:border-gray-800 rounded-lg p-4 bg-white dark:bg-gray-900">
                                <h4 className="text-sm font-semibold text-gray-700 dark:text-gray-200 mb-3">Pre-flight Validations</h4>
                                {bundleValidations.length === 0 ? (
                                    <p className="text-sm text-gray-500">No warnings detected.</p>
                                ) : (
                                    <ul className="space-y-2 text-sm">
                                        {bundleValidations.map((validation, idx) => (
                                            <li key={`${validation.level}-${idx}`} className={`px-3 py-2 rounded border ${validation.level === 'error' ? 'border-red-200 text-red-700 bg-red-50 dark:border-red-900/40 dark:text-red-300 dark:bg-red-950/40' : validation.level === 'warning' ? 'border-amber-200 text-amber-700 bg-amber-50 dark:border-amber-900/40 dark:text-amber-300 dark:bg-amber-950/40' : 'border-green-200 text-green-700 bg-green-50 dark:border-green-900/40 dark:text-green-300 dark:bg-green-950/40'}`}>
                                                {validation.message}
                                            </li>
                                        ))}
                                    </ul>
                                )}
                            </section>
                        </div>
                    )}
                    {bundleWizardStep === 'stack' && (
                        <div className="space-y-4">
                            {bundleStackArtifacts && (
                                <>
                                    <section className="border border-gray-200 dark:border-gray-800 rounded-lg p-4 bg-gray-50 dark:bg-gray-900/40">
                                        <div className="flex justify-between items-center mb-2">
                                            <h4 className="text-sm font-semibold text-gray-700 dark:text-gray-200">Quadlet (.kube) Unit</h4>
                                            <button
                                                onClick={() => {
                                                    if (typeof navigator !== 'undefined' && navigator.clipboard) {
                                                        navigator.clipboard.writeText(bundleStackArtifacts.kubeUnit);
                                                        addToast('success', '.kube unit copied');
                                                    } else {
                                                        addToast('error', 'Clipboard API unavailable');
                                                    }
                                                }}
                                                className="text-xs text-blue-600 hover:underline"
                                            >
                                                Copy Unit
                                            </button>
                                        </div>
                                        <pre className="bg-gray-900 text-gray-100 text-xs rounded-lg p-4 overflow-x-auto max-h-80">
{bundleStackArtifacts.kubeUnit}
                                        </pre>
                                    </section>
                                    <section className="border border-gray-200 dark:border-gray-800 rounded-lg p-4 bg-gray-50 dark:bg-gray-900/40">
                                        <div className="flex justify-between items-center mb-2">
                                            <h4 className="text-sm font-semibold text-gray-700 dark:text-gray-200">Pod Specification</h4>
                                            <button
                                                onClick={() => {
                                                    if (typeof navigator !== 'undefined' && navigator.clipboard) {
                                                        navigator.clipboard.writeText(bundleStackArtifacts.podYaml);
                                                        addToast('success', 'Pod YAML copied');
                                                    } else {
                                                        addToast('error', 'Clipboard API unavailable');
                                                    }
                                                }}
                                                className="text-xs text-blue-600 hover:underline"
                                            >
                                                Copy YAML
                                            </button>
                                        </div>
                                        <pre className="bg-gray-900 text-gray-100 text-xs rounded-lg p-4 overflow-x-auto max-h-80">
{bundleStackArtifacts.podYaml}
                                        </pre>
                                    </section>
                                    {bundleStackArtifacts.configPaths.length > 0 && (
                                        <section className="border border-gray-200 dark:border-gray-800 rounded-lg p-4 bg-white dark:bg-gray-900">
                                            <h4 className="text-sm font-semibold text-gray-700 dark:text-gray-200 mb-2">Referenced Config Files</h4>
                                            <ul className="text-xs font-mono text-gray-600 dark:text-gray-400 space-y-1">
                                                {bundleStackArtifacts.configPaths.map(path => (
                                                    <li key={path}>
                                                        <FileBadge path={path} nodeName={selectedBundle?.nodeName} variant="list" />
                                                    </li>
                                                ))}
                                            </ul>
                                        </section>
                                    )}
                                </>
                            )}
                            {!bundleStackArtifacts && (
                                <p className="text-sm text-gray-500">Unable to generate stack artifacts. Provide a target name to continue.</p>
                            )}
                        </div>
                    )}
                    {bundleWizardStep === 'backup' && (
                        <div className="space-y-4">
                            {bundlePlanLoading ? (
                                <div className="flex flex-col items-center justify-center py-10 text-gray-500">
                                    <RefreshCw className="animate-spin mb-2" />
                                    Building plan...
                                </div>
                            ) : bundlePlan ? (
                                <>
                                    <section className="border border-gray-200 dark:border-gray-800 rounded-lg p-4 bg-gray-50 dark:bg-gray-900/40">
                                        <h4 className="text-sm font-semibold text-gray-700 dark:text-gray-200 mb-2">Backup Directory</h4>
                                        <code className="text-xs bg-white dark:bg-gray-950 px-2 py-1 rounded border border-gray-200 dark:border-gray-800">{bundlePlan.backupDir}</code>
                                    </section>
                                    {bundlePlan.backupArchive && (
                                        <section className="border border-gray-200 dark:border-gray-800 rounded-lg p-4 bg-white dark:bg-gray-900">
                                            <h4 className="text-sm font-semibold text-gray-700 dark:text-gray-200 mb-2">Archive Pattern</h4>
                                            <p className="text-xs text-gray-600 dark:text-gray-400 mb-2">Each execution produces a timestamped archive using this pattern.</p>
                                            <code className="text-xs bg-gray-50 dark:bg-gray-950 px-2 py-1 rounded border border-gray-200 dark:border-gray-800">{bundlePlan.backupArchive}</code>
                                        </section>
                                    )}
                                    <section className="grid md:grid-cols-2 gap-4">
                                        <div className="border border-gray-200 dark:border-gray-800 rounded-lg p-4 bg-white dark:bg-gray-900">
                                            <h5 className="text-sm font-semibold text-gray-700 dark:text-gray-200 mb-2">Files To Create</h5>
                                            <ul className="text-xs font-mono space-y-1">
                                                {bundlePlan.filesToCreate.map(file => (
                                                    <li key={file}>
                                                        <FileBadge path={file} nodeName={selectedBundle?.nodeName} variant="list" />
                                                    </li>
                                                ))}
                                            </ul>
                                        </div>
                                        <div className="border border-gray-200 dark:border-gray-800 rounded-lg p-4 bg-white dark:bg-gray-900">
                                            <h5 className="text-sm font-semibold text-gray-700 dark:text-gray-200 mb-2">Files To Backup</h5>
                                            <ul className="text-xs font-mono space-y-1">
                                                {bundlePlan.filesToBackup.length === 0 ? (
                                                    <li className="text-gray-500">No overwrites expected.</li>
                                                ) : (
                                                    bundlePlan.filesToBackup.map(file => (
                                                        <li key={file}>
                                                            <FileBadge path={file} nodeName={selectedBundle?.nodeName} variant="list" />
                                                        </li>
                                                    ))
                                                )}
                                            </ul>
                                        </div>
                                    </section>
                                    {bundlePlan.fileMappings && bundlePlan.fileMappings.length > 0 && (
                                        <section className="border border-gray-200 dark:border-gray-800 rounded-lg p-4 bg-gray-50 dark:bg-gray-900/40">
                                            <h5 className="text-sm font-semibold text-gray-700 dark:text-gray-200 mb-2">File Mapping</h5>
                                            <table className="w-full text-xs">
                                                <thead>
                                                    <tr className="text-left text-gray-500">
                                                        <th className="py-1">Source</th>
                                                        <th className="py-1">Action</th>
                                                        <th className="py-1">Target</th>
                                                    </tr>
                                                </thead>
                                                <tbody>
                                                    {bundlePlan.fileMappings.map((mapping, idx) => (
                                                        <tr key={`${mapping.source}-${idx}`} className="border-t border-gray-200 dark:border-gray-800">
                                                            <td className="py-1 pr-2">
                                                                <FileBadge path={mapping.source} nodeName={selectedBundle?.nodeName} variant="inline" />
                                                            </td>
                                                            <td className="py-1 capitalize">{mapping.action}</td>
                                                            <td className="py-1">
                                                                {mapping.target ? (
                                                                    <FileBadge path={mapping.target} nodeName={selectedBundle?.nodeName} variant="inline" />
                                                                ) : (
                                                                    <span className="text-gray-500">—</span>
                                                                )}
                                                            </td>
                                                        </tr>
                                                    ))}
                                                </tbody>
                                            </table>
                                        </section>
                                    )}
                                    {bundlePlan.servicesToStop.length > 0 && (
                                        <section className="border border-gray-200 dark:border-gray-800 rounded-lg p-4 bg-white dark:bg-gray-900">
                                            <h5 className="text-sm font-semibold text-gray-700 dark:text-gray-200 mb-2">Services To Stop</h5>
                                            <ul className="text-sm text-red-600 dark:text-red-400 space-y-1">
                                                {bundlePlan.servicesToStop.map(service => (
                                                    <li key={service} className="flex items-center gap-2"><Power size={14} /> {service}</li>
                                                ))}
                                            </ul>
                                        </section>
                                    )}
                                </>
                            ) : (
                                <p className="text-sm text-gray-500">No plan available. Adjust the target name or try again.</p>
                            )}
                        </div>
                    )}
                </div>
                </div>
                <div className="px-6 py-4 border-t border-gray-200 dark:border-gray-800 flex items-center justify-between">
                    <div className="text-xs text-gray-500 dark:text-gray-400">Step {wizardStepIndex + 1} of {bundleWizardSteps.length}</div>
                    <div className="flex gap-3">
                        <button
                            onClick={() => {
                                if (bundleWizardStep === 'assets') {
                                    closeBundleWizard();
                                } else if (bundleWizardStep === 'stack') {
                                    setBundleWizardStep('assets');
                                } else {
                                    setBundleWizardStep('stack');
                                }
                            }}
                            className="px-4 py-2 text-sm rounded-lg border border-gray-200 dark:border-gray-700"
                        >
                            {bundleWizardStep === 'assets' ? 'Cancel' : 'Back'}
                        </button>
                        {bundleWizardStep !== 'backup' ? (
                            <button
                                onClick={() => setBundleWizardStep(bundleWizardStep === 'assets' ? 'stack' : 'backup')}
                                disabled={!bundleTargetName || (bundleWizardStep === 'stack' && bundleValidations.some(v => v.level === 'error'))}
                                className="px-4 py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white"
                            >
                                Next
                            </button>
                        ) : (
                            <button
                                onClick={executeBundleMerge}
                                disabled={bundleActionLoading || !bundlePlan}
                                className="px-4 py-2 text-sm rounded-lg bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white flex items-center gap-2"
                            >
                                {bundleActionLoading ? <RefreshCw className="animate-spin" size={16} /> : <ArrowRight size={16} />}
                                Execute Merge
                            </button>
                        )}
                    </div>
                </div>
            </div>
        </div>
      )}

      {/* Link Modal */}
      <ExternalLinkModal 
        isOpen={showLinkModal}
        onClose={() => setShowLinkModal(false)}
        onSave={handleSaveLink}
        isEditing={isEditingLink}
        form={linkForm}
        setForm={setLinkForm}
      />

      {showRegistryOverlay && (
        <div className="fixed inset-0 z-50 flex justify-end bg-gray-950/70 backdrop-blur-sm">
            <div className="w-full max-w-6xl h-full bg-white dark:bg-gray-950 border-l border-gray-200 dark:border-gray-800 shadow-2xl flex flex-col">
                <div className="flex items-start justify-between px-6 py-4 border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/60">
                    <div>
                        <p className="text-xs uppercase tracking-[0.2em] text-gray-500 dark:text-gray-400">Service Registry</p>
                        <h3 className="text-2xl font-semibold text-gray-900 dark:text-gray-100 mt-1 flex items-center gap-2">
                            Install Managed Templates
                        </h3>
                        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1 max-w-2xl">
                            Browse curated Quadlet stacks, sync registries, and install new services without leaving the dashboard.
                        </p>
                    </div>
                    <button
                        type="button"
                        onClick={closeRegistryOverlay}
                        className="p-2 rounded-full text-gray-500 hover:text-gray-900 dark:hover:text-gray-100 hover:bg-gray-200 dark:hover:bg-gray-800"
                        aria-label="Close registry drawer"
                    >
                        <X size={20} />
                    </button>
                </div>
                <div className="flex-1 min-h-0">
                    <RegistryPlugin variant="embedded" />
                </div>
            </div>
        </div>
      )}

    </div>
  );
}

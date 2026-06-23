'use client';

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import dynamic from 'next/dynamic';
import { useRouter, useSearchParams } from 'next/navigation';
import { logger } from '@servicebay/api-client';
import { useDigitalTwin } from '@/hooks/useDigitalTwin'; // V4 Hook
import { useEscapeKey } from '@/hooks/useEscapeKey';
import { useImageUpdates, type ServiceImageUpdate } from '@/hooks/useImageUpdates';
import DashboardHydrationGate, { type HydrationPhase } from '@/components/DashboardHydrationGate';
import ConfirmModal from '@/components/ConfirmModal';
import { useToast } from '@/providers/ToastProvider';
import PageHeader from '@/components/PageHeader';
import InstallProgressCard from '@/components/InstallProgressCard';
import TemplateUpgradesPendingBanner from '@/components/TemplateUpgradesPendingBanner';
import ImageUpdatesPendingBanner from '@/components/ImageUpdatesPendingBanner';
import ExternalLinkModal from '@/components/ExternalLinkModal';
import FileViewerOverlay from '@/components/FileViewerOverlay';
import RegistryDashboard from '@/dashboards/RegistryDashboard';
import ServiceCard from '@/components/ServiceCard';
import ServiceRow from '@/components/ServiceRow';
import StackGroupHeader from '@/components/StackGroupHeader';
import { SectionHeading } from '@/components/ui';
import { useServiceActions } from '@/hooks/useServiceActions';
import { useContainerActions } from '@/hooks/useContainerActions';
import { buildServiceViewModel } from '@servicebay/api-client';
import { ServiceViewModel, sortServicesByDisplayName } from '@servicebay/api-client';
import ContainerLogsPanel, { ContainerLogsPanelData } from '@/components/ContainerLogsPanel';
import type { TerminalRef } from '@/components/Terminal';
import type { EnrichedContainer } from '@servicebay/api-client';
// We keep Service interface but recreate it or import from shared data if it matches?
// SharedData Service is a complex UI object. digital twin ServiceUnit is simple.
// WE NEED TO MAP TWIN -> UI SERVICE here.
import { Plus, RefreshCw, Trash2, Box, Search, X, AlertCircle, FileCode, Terminal as TerminalIcon, Eraser } from 'lucide-react';
import { ServiceBundle, BundlePortSummary } from '@servicebay/api-client';
import {
    bundleSeverityClasses,
    groupServicesByStack,
    UNGROUPED_STACK_ID,
    type ApiLinkPayload,
    type LinkFormState,
    type RawLinkPort,
    type RawLinkVolume,
    type StackSummaryLite,
} from './_lib/servicesDashboard';

const DynamicTerminal = dynamic(() => import('@/components/Terminal'), { ssr: false });

export default function ServicesDashboard() {
    const { data: twin, isConnected, lastUpdate, isNodeSynced } = useDigitalTwin();
    const { addToast, updateToast } = useToast();
    const { available: imageUpdates, availableServices: imageUpdateServices, refresh: refreshImageUpdates } = useImageUpdates();

    const [filteredServices, setFilteredServices] = useState<ServiceViewModel[]>([]);
    const [filteredBundles, setFilteredBundles] = useState<ServiceBundle[]>([]);
    const [searchQuery, setSearchQuery] = useState('');
    // Services are always sorted by name
    const [externalLinks, setExternalLinks] = useState<ServiceViewModel[]>([]);
    const [stackSummaries, setStackSummaries] = useState<StackSummaryLite[]>([]);
    const [serviceBundles, setServiceBundles] = useState<ServiceBundle[]>([]);
    const [bundlePendingDelete, setBundlePendingDelete] = useState<ServiceBundle | null>(null);
    const [bundleDeleteLoading, setBundleDeleteLoading] = useState(false);
    const [showLinkModal, setShowLinkModal] = useState(false);
    const [isEditingLink, setIsEditingLink] = useState(false);
    const [editingLinkId, setEditingLinkId] = useState<string | null>(null);
    const [linkForm, setLinkForm] = useState<LinkFormState>({ name: '', url: '', description: '', monitor: false, ipTargetsText: '' });
    const [showRegistryOverlay, setShowRegistryOverlay] = useState(false);
    const [filePreview, setFilePreview] = useState<{ path: string; nodeName?: string } | null>(null);
    const [handledQueryContainer, setHandledQueryContainer] = useState<string | null>(null);
    const searchParams = useSearchParams();
    const containerIdParam = searchParams?.get('containerId') || null;
    const drawerParam = searchParams?.get('drawer') || null;

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
                          displayName: link.name,
                          yamlBasename: link.yamlPath ? (link.yamlPath.split('/').pop() ?? null) : null,
                          kubeBasename: link.kubePath ? (link.kubePath.split('/').pop() ?? null) : null,
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
            logger.error('ServicesDashboard', 'Failed to load external links', error);
        }
    }, []);

    // Stack membership for the /services grouping (#2081). The manifest list's
    // `templates` arrays tell us which stack owns each service; we don't need
    // health here, just the name→templates map. Failures are non-fatal — the
    // overview falls back to a single "Ungrouped" bucket.
    const loadStacks = useCallback(async () => {
        try {
            const res = await fetch('/api/system/stacks', { cache: 'no-store' });
            if (!res.ok) throw new Error('Failed to load stacks');
            const payload = await res.json();
            const stacks: StackSummaryLite[] = Array.isArray(payload?.stacks)
                ? payload.stacks.map((s: StackSummaryLite) => ({ name: s.name, manifest: s.manifest ?? null }))
                : [];
            setStackSummaries(stacks);
        } catch (error) {
            logger.error('ServicesDashboard', 'Failed to load stacks', error);
        }
    }, []);

    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- async external-links + stacks load on mount
        loadExternalLinks();
        loadStacks();
    }, [loadExternalLinks, loadStacks]);

    const fetchData = useCallback(() => {
        loadExternalLinks();
        loadStacks();
    }, [loadExternalLinks, loadStacks]);

    const {
        openMonitorDrawer,
        openEditDrawer,
        openActions,
        triggerRestart,
        updateServiceImage,
        requestDelete,
        overlays: serviceActionOverlays,
        closeOverlays,
        hasOpenOverlay
    } = useServiceActions({ onRefresh: fetchData });

    const router = useRouter();

    // IA slice 1 (#2029): a tile is a service is one page — opening/monitoring a
    // managed service navigates to its per-service Operate page (status + health
    // + settings + containers + actions) instead of a logs drawer. Gateway/link
    // "services" have no Operate page, so they keep the monitor drawer.
    const openServiceDetail = useCallback((service: ServiceViewModel) => {
        if (service.type === 'gateway' || service.type === 'link') {
            openMonitorDrawer(service);
            return;
        }
        router.push(`/services/${encodeURIComponent(service.id || service.name)}`);
    }, [router, openMonitorDrawer]);

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
                    proxyRoutes: twin.proxyState?.routes,
                    installedTemplates: twin.installedTemplates
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
            const gatewayDisplayName = twin.gateway.provider === 'fritzbox' ? 'FritzBox Gateway' : 'Internet Gateway';
            finalServices.push({
                name: gatewayDisplayName,
                displayName: gatewayDisplayName,
                yamlBasename: null,
                kubeBasename: null,
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

    const allContainers = useMemo(() => {
        return services.flatMap(s => s.attachedContainers || []);
    }, [services]);

    // Image-update actions (#1860): re-deploy a service to pull its newest image.
    // `updateServiceImage` POSTs the `update` action (= the actions menu's
    // "Update & Restart"), which pulls each image in the service YAML then
    // restarts the unit. We resolve the bare service name from the image-update
    // report back to its live ServiceViewModel so the action can target the
    // right node. After the run we re-poll the report so the cleared badge/banner
    // disappears.
    const resolveServiceByName = useCallback((name: string): ServiceViewModel | undefined => {
        return services.find(s => s.name.replace(/\.service$/, '') === name.replace(/\.service$/, ''));
    }, [services]);

    const handleUpdateService = useCallback(async (service: ServiceViewModel) => {
        await updateServiceImage(service);
        await refreshImageUpdates();
    }, [updateServiceImage, refreshImageUpdates]);

    // Banner "Update now": re-deploy every listed service sequentially (no
    // single "update all" endpoint exists), then refresh the report once.
    // Failures surface their own error toast per service and don't abort the
    // remaining updates.
    const handleUpdateAll = useCallback(async (updates: ServiceImageUpdate[]) => {
        for (const update of updates) {
            const service = resolveServiceByName(update.service);
            if (service) {
                await updateServiceImage(service);
            }
        }
        await refreshImageUpdates();
    }, [resolveServiceByName, updateServiceImage, refreshImageUpdates]);

    useEffect(() => {
        if (!containerIdParam || !allContainers.length) return;
        if (handledQueryContainer === containerIdParam) return;

        const found = allContainers.find(c => c.id === containerIdParam || c.id.startsWith(containerIdParam));
        if (found) {
            // eslint-disable-next-line react-hooks/set-state-in-effect -- opens drawer from URL ?container param; controlled URL→state sync, one-shot guarded
            setDrawerContainer(attachNodeContext(found));
            setContainerDrawerMode(drawerParam === 'terminal' ? 'terminal' : 'logs');
            setHandledQueryContainer(containerIdParam);
        }
    }, [containerIdParam, drawerParam, allContainers, handledQueryContainer, attachNodeContext]);

    const loading = !isConnected && services.length === 0;
    const waitingForSync = isConnected && !isNodeSynced() && services.length === 0;

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

    const refreshBundles = useCallback(() => {
        try {
            setServiceBundles(collectBundlesFromTwin());
        } catch (error) {
            logger.error('ServicesDashboard', 'Failed to refresh bundles', error);
            setServiceBundles([]);
        }
    }, [collectBundlesFromTwin]);

    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- recomputes service bundles from the live twin; external-system sync
        setServiceBundles(collectBundlesFromTwin());
    }, [collectBundlesFromTwin]);

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

    // Domains the reverse proxy actually serves over HTTPS. LAN-only
    // routes (NPM access-list locked, no LE cert provisioned) only
    // listen on port 80; linking them via https:// gives the operator
    // a TLS error on first click. Cross-reference each verifiedDomain
    // against the proxy's per-server `listen` array — a "443 ssl" entry
    // means the domain has an active TLS listener.
    const httpsDomains = useMemo(() => {
        const out = new Set<string>();
        type ProxyServer = { server_name?: string[]; listen?: string[] };
        const proxyService = services.find(s =>
            (s as ServiceViewModel & { proxyConfiguration?: { servers?: ProxyServer[] } }).proxyConfiguration?.servers,
        ) as (ServiceViewModel & { proxyConfiguration?: { servers?: ProxyServer[] } }) | undefined;
        const proxyServers = proxyService?.proxyConfiguration?.servers ?? [];
        for (const srv of proxyServers) {
            const hasTls = (srv.listen ?? []).some(l => /\b443\b.*\bssl\b|\bssl\b.*\b443\b|^443\s+ssl$/.test(l));
            if (!hasTls) continue;
            for (const name of srv.server_name ?? []) out.add(name.toLowerCase());
        }
        return out;
    }, [services]);

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
        if (loading || waitingForSync) {
            return (
                <DashboardHydrationGate
                    phase={(loading ? 'socket' : 'sync') as HydrationPhase}
                />
            );
        }

        const totalResults = filteredServices.length + filteredBundles.length;
        const totalInventory = services.length + serviceBundles.length;
        const hasSearch = searchQuery.trim().length > 0;

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

        // Group services under their owning stack (#2081). Each group renders a
        // SectionHeading + per-stack wipe action above its rows. Unmanaged
        // bundles aren't stack-owned, so they trail the grouped services in
        // their own labelled "Discovered bundles" section.
        const stackGroups = groupServicesByStack(filteredServices, stackSummaries);

        return (
            <div className="space-y-8" data-testid="services-stack-groups">
                {stackGroups.map(group => (
                    <section key={group.id} className="space-y-3" data-testid={`stack-group-${group.id}`}>
                        <StackGroupHeader group={group} onWiped={fetchData} />

                        {/* Desktop (md+): a dense list — one tight row per service, so
                            the overview reads as a table with columns (status · name ·
                            address · actions), not a sparse card grid (#2067 operator
                            feedback). */}
                        <div className="hidden md:block rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 divide-y divide-gray-100 dark:divide-gray-800 overflow-hidden">
                            {group.services.map(service => (
                                <ServiceRow
                                    key={`svc-${service.nodeName || 'local'}-${service.name}`}
                                    service={service}
                                    httpsDomains={httpsDomains}
                                    imageUpdateAvailable={imageUpdateServices.has(service.name.replace(/\.service$/, ''))}
                                    onUpdate={handleUpdateService}
                                    onMonitor={openServiceDetail}
                                    onEdit={openEditDrawer}
                                    onActions={openActions}
                                    onEditLink={handleEditLink}
                                    onDelete={requestDelete}
                                    onRestart={triggerRestart}
                                />
                            ))}
                        </div>

                        {/* Mobile (below md): the existing single-column card stack. */}
                        <div className="md:hidden grid grid-cols-1 gap-6">
                            {group.services.map(service => (
                                <ServiceCard
                                    key={`svc-${service.nodeName || 'local'}-${service.name}`}
                                    service={service}
                                    attachNodeContext={attachNodeContext}
                                    httpsDomains={httpsDomains}
                                    imageUpdateAvailable={imageUpdateServices.has(service.name.replace(/\.service$/, ''))}
                                    onUpdate={handleUpdateService}
                                    onMonitor={openServiceDetail}
                                    onEdit={openEditDrawer}
                                    onActions={openActions}
                                    onEditLink={handleEditLink}
                                    onDelete={requestDelete}
                                    onRestart={triggerRestart}
                                    onContainerLogs={openContainerLogs}
                                    onContainerTerminal={openContainerTerminal}
                                    onContainerActions={openAttachedContainerActions}
                                />
                            ))}
                        </div>
                    </section>
                ))}

                {filteredBundles.length > 0 && (
                    <section className="space-y-3" data-testid={`stack-group-${UNGROUPED_STACK_ID}-bundles`}>
                        <SectionHeading
                            tone="muted"
                            description={`${filteredBundles.length} discovered`}
                        >
                            Discovered bundles
                        </SectionHeading>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            {filteredBundles.map(bundle => (
                                <BundleCard key={`bundle-${bundle.id}`} bundle={bundle} />
                            ))}
                        </div>
                    </section>
                )}
            </div>
        );
    };

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
          refreshBundles();
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
  }, [bundlePendingDelete, addToast, updateToast, refreshBundles]);

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
      if (showRegistryOverlay) {
          closeRegistryOverlay();
          return;
      }
      if (showLinkModal) {
          setShowLinkModal(false);
      }
  }, [closeContainerActions, closeContainerDrawer, closeOverlays, closeRegistryOverlay, containerActionsOpen, containerDrawerMode, hasOpenOverlay, showRegistryOverlay, showLinkModal]);

  useEscapeKey(handleEscape, Boolean(containerDrawerMode || containerActionsOpen || hasOpenOverlay || showRegistryOverlay || showLinkModal), true);
  useEscapeKey(closeContainerDrawer, Boolean(containerDrawerMode), true);

  useEffect(() => {
      const q = searchQuery.trim().toLowerCase();

      const filtered = q
          ? services.filter(s =>
                s.name.toLowerCase().includes(q) ||
                (s.description && s.description.toLowerCase().includes(q)) ||
                (s.nodeName && s.nodeName.toLowerCase().includes(q))
            )
          : services;
      const sorted = sortServicesByDisplayName(filtered);
      // eslint-disable-next-line react-hooks/set-state-in-effect -- filters/sorts services on search change; mirrors a non-render-derivable list with bundle filtering
      setFilteredServices(sorted);

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

      <TemplateUpgradesPendingBanner />
      <ImageUpdatesPendingBanner updates={imageUpdates} onUpdate={handleUpdateAll} />
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
          {/* Live install monitor — folded in from the retired Home hub (IA
              slice 2): Services is now the landing page, so the install
              progress that every web client should see surfaces here. Renders
              nothing unless an install is actually running. */}
          <InstallProgressCard />
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
                    <RegistryDashboard variant="embedded" />
                </div>
            </div>
        </div>
      )}

    </div>
  );
}

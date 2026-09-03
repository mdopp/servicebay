/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Node construction for one host: the proxy node, the managed systemd
 * services, and the unmanaged (compose/quadlet-less) bundles.
 *
 * Extracted verbatim from `service.ts` (#2740). Each builder pushes onto the
 * caller's `nodes` array in the original order, so node identity and array
 * position are unchanged.
 */
import yaml from 'js-yaml';
import type { NetworkNode, PortMapping as GraphPortMapping } from './types';
import type { ServiceUnit, WatchedFile } from '../agent/types';
import type { NodeTwin } from '../store/twin';
import type { EnrichedContainer } from '../agent/types';
import type { NginxConfig } from './proxyResolution';
import { NodeFactory } from './factory';
import { logger } from '../logger';
import watcher from '../watcher';
import type { KubePodSpec } from './topologyTypes';

/** 1. Nginx Node (Per Server) — only when we found the container or the service. */
export function buildProxyNode(params: {
    nodes: NetworkNode[];
    nginxId: string;
    nodeName: string;
    nodeHost: string;
    nodeIPs: string[];
    proxyService: ServiceUnit | undefined;
    proxyServiceName: string;
    nginxContainer: EnrichedContainer | undefined;
    nginxConfig: NginxConfig;
    verifiedDomains: string[];
}): void {
    const { nodes, nginxId, nodeName, nodeHost, nodeIPs, proxyService, proxyServiceName, nginxContainer, nginxConfig, verifiedDomains } = params;

    if (!(nginxContainer || proxyService)) return;

    // STRICT: Use NodeFactory & Single Source of Truth
    let proxyRawData: Record<string, unknown>;

    if (proxyService) {
        // 1. Preferred: Use Digital Twin Service Object directly
        // We strictly trust the Twin's 'ports', 'active', and 'proxyConfiguration'
        proxyRawData = {
            ...proxyService,
            verifiedDomains,
            type: 'gateway' // Visual Override
        };
    } else {
        // 2. Fallback: Unmanaged/Legacy Container (No Service Twin)
        proxyRawData = {
            ...nginxConfig, // Spreads { servers: ... }
            verifiedDomains,
            ports: nginxContainer?.ports || [], // Discovery: Use container ports (no hardcoding)
            type: 'gateway',
            name: proxyServiceName,
            active: nginxContainer ? (nginxContainer.state === 'running') : true
        };
    }

    const proxyMeta = {
        link: null,
        verifiedDomains,
        nodeHost,
        nodeIPs
    };

    nodes.push(NodeFactory.createProxyNode(nginxId, proxyRawData, nodeName, proxyMeta));
}

/**
 * 2. Managed Services. The proxy service folds its details into the already
 * created nginx node instead of getting a node of its own.
 */
export function buildManagedServiceNodes(params: {
    nodes: NetworkNode[];
    nginxId: string;
    nodeName: string;
    nodeHost: string;
    nodeIPs: string[];
    prefix: (id: string) => string;
    services: ServiceUnit[];
    containers: EnrichedContainer[];
    proxyService: ServiceUnit | undefined;
    twinNode: NodeTwin;
}): void {
    const { nodes, nginxId, nodeName, nodeHost, nodeIPs, prefix, services, containers, proxyService, twinNode } = params;

    watcher.emit('change', { type: 'network-scan-progress', message: `Scanning ${nodeName}: Processing services & ports...`, node: nodeName });

    for (const service of services) {
        const isProxy = service === proxyService;

        if (isProxy) {
            const nginxNode = nodes.find(n => n.id === nginxId);
            if (nginxNode) {
                foldProxyServiceIntoNode(nginxNode, service);
                continue;
            }
        }

        const serviceGroupId = prefix(`service-${service.name}`);

        // Prepare ports for service node (USE TWIN SOURCE OF TRUTH)
        const effectiveHostNetwork = service.effectiveHostNetwork || (service as { hostNetwork?: boolean }).hostNetwork || false;

        let servicePorts: GraphPortMapping[] = [];

        if (service.ports && service.ports.length > 0) {
            servicePorts = service.ports.map(p => ({
                host: p.hostPort || 0,
                container: p.containerPort || 0,
                hostIp: p.hostIp || '0.0.0.0', // Standardize
                protocol: p.protocol || 'tcp'
            }));
        }

        // Fallback: Parse Quadlet File for Ports if service is inactive/missing ports
        // This ensures the graph shows the intended architecture even if the service is down.
        if (servicePorts.length === 0 && twinNode.files) {
            servicePorts.push(...parseDefinitionPorts(service.name, twinNode.files));
        }

        // NEW: Get Linked Containers from Twin Store Property (Single Source of Truth)
        // STRICT: No fallbacks to heuristics. We rely solely on the Digital Twin.
        const linkedContainerIds: string[] = service.associatedContainerIds || [];
        const linkedContainers = containers.filter((c) => linkedContainerIds.includes(c.id));

        // Create Service Node (Merged Group & Node)
        // STRICT: Use NodeFactory to enforce RawData derivation
        const serviceRawData = {
            ...service,
            // Inject full digital twin context
            containers: linkedContainers, // New: Multi-container support
            ports: servicePorts, // STRICT: Ensure RawData reflects the actual calculated/runtime ports
            type: 'service',
            hostNetwork: effectiveHostNetwork
        };

        const serviceMetadata = {
            source: 'Systemd/Podman',
            description: service.description,
            link: null,
            nodeHost,
            nodeIPs
        };

        nodes.push(NodeFactory.createServiceNode(serviceGroupId, serviceRawData, nodeName, serviceMetadata));
    }
}

function foldProxyServiceIntoNode(nginxNode: NetworkNode, service: ServiceUnit): void {
    nginxNode.status = service.active ? 'up' : 'down';
    if (nginxNode.metadata) {
        nginxNode.metadata.serviceDescription = service.description;
    }

    // Inject full service details into rawData (Flattened)
    if (nginxNode.rawData) {
        // Start with the existing Raw Data (Gateway properties)
        const existingData = { ...nginxNode.rawData };

        // Flatten: Merge service properties onto top level, but preserve Gateway-specifics
        // We prioritize existingData (servers, type=gateway) over service props
        nginxNode.rawData = { ...service, ...existingData };

        // Explicitly cleanup if service object was somehow spread weirdly
        if ('service' in nginxNode.rawData) {
            delete (nginxNode.rawData as any).service;
        }

        // Cleanup redundant 'servers' legacy field if we have the modern 'proxyConfiguration'
        // This reduces noise in the Raw Data view
        if ((nginxNode.rawData as any).proxyConfiguration && (nginxNode.rawData as any).servers) {
            delete (nginxNode.rawData as any).servers;
        }
    }

    // Determine Ports: Use Single Source of Truth (TwinStore Enrichment)
    let finalPorts: GraphPortMapping[] = [];

    if (service.ports && service.ports.length > 0) {
        finalPorts = service.ports.map(p => ({
            host: p.hostPort || 0,
            container: p.containerPort || 0,
            hostIp: p.hostIp,
            protocol: p.protocol || 'tcp'
        }));
    }

    if (finalPorts.length > 0) {
        if (nginxNode.rawData) {
            nginxNode.rawData.ports = finalPorts;
        }
    }
}

/**
 * Static port discovery from the unit definition — a service that is down
 * publishes nothing at runtime, but the quadlet still says what it intends.
 */
function parseDefinitionPorts(serviceName: string, files: Record<string, WatchedFile>): GraphPortMapping[] {
    const servicePorts: GraphPortMapping[] = [];

    // Heuristic: Look for definitions matching the service name
    const candidates = Object.values(files).filter((f: WatchedFile) =>
        f.path.includes(`/${serviceName}.yml`) || // Kube YAML
        f.path.includes(`/${serviceName}.container`) // Container Unit
    );

    for (const file of candidates) {
        if (file.path.endsWith('.yml') || file.path.endsWith('.yaml')) {
            try {
                const content = yaml.load(file.content) as KubePodSpec;
                // Kube Pod Spec
                const kubeContainers = content.spec?.containers || [];
                kubeContainers.forEach((c) => {
                    if (c.ports) {
                        c.ports.forEach((kp) => {
                            // Kube: hostPort, containerPort
                            if (kp.hostPort) {
                                servicePorts.push({
                                    host: kp.hostPort,
                                    container: kp.containerPort || 0,
                                    hostIp: '0.0.0.0', // Definition implies all interfaces usually
                                    protocol: kp.protocol?.toLowerCase() || 'tcp',
                                    source: 'definition' // Flag as static definition
                                });
                            }
                        });
                    }
                });
            } catch (err) {
                logger.warn('NetworkService', `Failed to parse Quadlet YAML for ${serviceName}: ${err}`);
            }
        } else if (file.path.endsWith('.container')) {
            // Simple INI Parsing for [Container] PublishPort=...
            const lines = file.content.split('\n');
            lines.forEach((line: string) => {
                const match = line.match(/^PublishPort=(?:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):)?(\d+):(\d+)(?:\/(udp|tcp))?/);
                if (match) {
                    // [1]=IP(opt), [2]=Host, [3]=Container, [4]=Proto(opt)
                    servicePorts.push({
                        host: parseInt(match[2], 10),
                        container: parseInt(match[3], 10),
                        hostIp: match[1] || '0.0.0.0',
                        protocol: match[4] || 'tcp',
                        source: 'definition'
                    });
                }
                // Systemd supports multiple formats; the implicit "PublishPort=8080"
                // shape is deliberately not inferred.
            });
        }
    }

    return servicePorts;
}

/** 2b. Unmanaged Service Bundles (Standalone). */
export function buildUnmanagedBundleNodes(params: {
    nodes: NetworkNode[];
    nodeName: string;
    nodeHost: string;
    nodeIPs: string[];
    prefix: (id: string) => string;
    unmanagedBundles: NodeTwin['unmanagedBundles'];
    containerUrlMapping: Map<string, Set<string>>;
    bundleContainerOwners: Map<string, string>;
    bundleServiceOwners: Map<string, string>;
}): void {
    const { nodes, nodeName, nodeHost, nodeIPs, prefix, unmanagedBundles, containerUrlMapping, bundleContainerOwners, bundleServiceOwners } = params;

    for (const bundle of unmanagedBundles) {
        const bundleId = prefix(`bundle-${bundle.id}`);
        const normalizedPorts: GraphPortMapping[] = (bundle.ports || []).map(port => {
            const hostPort = typeof port.hostPort === 'number' ? port.hostPort : (typeof port.containerPort === 'number' ? port.containerPort : 0);
            const containerPort = typeof port.containerPort === 'number' ? port.containerPort : hostPort;
            return {
                host: hostPort,
                container: containerPort,
                hostIp: port.hostIp || '0.0.0.0',
                protocol: port.protocol || 'tcp'
            };
        });

        const bundleRawData = {
            ...bundle,
            name: bundle.displayName,
            type: 'unmanaged-service',
            isRunning: bundle.containers?.some(c => (c.state || '').toLowerCase() === 'running') ?? false,
            ports: normalizedPorts
        };

        const bundleMetadata: {
            source: string;
            severity: 'info' | 'warning' | 'critical';
            hints: string[];
            nodeHost: string;
            nodeIPs: string[];
            bundleId: string;
            validations: number;
            verifiedDomains?: string[];
        } = {
            source: 'Unmanaged Discovery',
            severity: bundle.severity,
            hints: bundle.hints,
            nodeHost,
            nodeIPs,
            bundleId: bundle.id,
            validations: bundle.validations?.length || 0
        };

        const bundleDomainUrls = new Set<string>();
        (bundle.containers || []).forEach(containerSummary => {
            if (!containerSummary?.id) return;
            const containerNodeId = prefix(containerSummary.id);
            const urlSet = containerUrlMapping.get(containerNodeId);
            if (!urlSet) return;
            urlSet.forEach(url => bundleDomainUrls.add(url));
        });

        if (bundleDomainUrls.size > 0) {
            bundleMetadata.verifiedDomains = Array.from(bundleDomainUrls);
        }

        const bundleNode = NodeFactory.createUnmanagedBundleNode(bundleId, bundleRawData, nodeName, bundleMetadata);

        nodes.push(bundleNode);

        if (Array.isArray(bundle.containers)) {
            bundle.containers.forEach(containerSummary => {
                if (containerSummary.id) {
                    bundleContainerOwners.set(containerSummary.id, bundleId);
                }
            });
        }

        if (Array.isArray(bundle.services)) {
            bundle.services.forEach(serviceRef => {
                if (!serviceRef?.serviceName) return;
                const variants = new Set<string>();
                const rawName = serviceRef.serviceName;
                variants.add(prefix(`service-${rawName}`));
                const trimmed = rawName.replace(/\.(service|container|pod)$/i, '');
                if (trimmed && trimmed !== rawName) {
                    variants.add(prefix(`service-${trimmed}`));
                }
                variants.forEach(serviceId => bundleServiceOwners.set(serviceId, bundleId));
            });
        }
    }

    if (bundleServiceOwners.size > 0) {
        nodes.forEach(node => {
            if (node.type !== 'service') return;
            const parentBundleId = bundleServiceOwners.get(node.id);
            if (!parentBundleId) return;
            node.parentNode = parentBundleId;
            node.extent = 'parent';
            node.metadata = {
                ...(node.metadata || {}),
                source: 'Unmanaged Bundle'
            };
        });
    }
}

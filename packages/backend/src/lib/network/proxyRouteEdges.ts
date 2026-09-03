/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Nginx → upstream edges. For every server block the proxy serves, work out
 * what the `proxy_pass` target actually *is* on this host — a managed service,
 * an unmanaged bundle, a container, a pod, a configured external link — and
 * draw the edge. When nothing resolves, synthesise the virtual node that makes
 * the dangling route visible instead of silently dropping it.
 *
 * Also records domain → target attribution in `containerUrlMapping`, which
 * later passes use to stamp verified domains onto nodes.
 *
 * Extracted verbatim from `service.ts` (#2740).
 */
import type { NetworkNode, NetworkEdge } from './types';
import type { EnrichedContainer, ServiceUnit } from '../agent/types';
import type { NodeTwin } from '../store/twin';
import type { NginxConfig } from './proxyResolution';
import { NodeFactory } from './factory';
import {
    getExternalLinkNodeId,
    normalizeExternalTargets,
    parseTargetHostPort,
} from './externalLinks';

export function appendProxyRouteEdges(params: {
    nodes: NetworkNode[];
    edges: NetworkEdge[];
    nodeName: string;
    nodeHost: string;
    nodeIPs: string[];
    prefix: (id: string) => string;
    nginxId: string;
    nginxContainer: EnrichedContainer | undefined;
    nginxConfig: NginxConfig;
    verifiedDomains: string[];
    services: ServiceUnit[];
    containers: EnrichedContainer[];
    proxyService: ServiceUnit | undefined;
    inspectMap: Map<string, any>;
    containerServiceOwners: Map<string, string>;
    unmanagedBundles: NodeTwin['unmanagedBundles'];
    containerUrlMapping: Map<string, Set<string>>;
    config: any;
}): void {
    const {
        nodes, edges, nodeName, nodeHost, nodeIPs, prefix, nginxId,
        nginxContainer, nginxConfig, verifiedDomains, services, containers,
        proxyService, inspectMap, containerServiceOwners, unmanagedBundles,
        containerUrlMapping, config,
    } = params;

    // 4. Nginx -> Containers (Only if Nginx is on this node)
    if (!nginxContainer) return;

    const unmanagedBundleContainerIndex = new Map<string, string>();
    unmanagedBundles.forEach(bundle => {
        const bundleNodeId = prefix(`bundle-${bundle.id}`);
        (bundle.containers || []).forEach(containerSummary => {
            if (!containerSummary?.id) return;
            unmanagedBundleContainerIndex.set(containerSummary.id, bundleNodeId);
        });
    });

    const isLocalTargetHost = (host?: string): boolean => {
        if (!host) return false;
        const normalized = host.trim();
        if (!normalized) return false;
        const loopbacks = ['localhost', '127.0.0.1', '::1', '0.0.0.0'];
        return loopbacks.includes(normalized) || nodeIPs.includes(normalized);
    };

    const findServiceByHostPort = (host: string | undefined, port: number): ServiceUnit | undefined => {
        if (!Number.isFinite(port) || port <= 0) return undefined;
        const hostIsLocal = isLocalTargetHost(host);

        return services.find(svc => {
            if (svc === proxyService) return false;
            if (!svc.ports || svc.ports.length === 0) return false;
            return svc.ports.some(p => {
                if (!p.hostPort) return false;
                if (p.hostPort !== port) return false;

                if (!host) return true;

                if (!p.hostIp || p.hostIp === '0.0.0.0' || p.hostIp === '::' || p.hostIp === '::0') {
                    return hostIsLocal;
                }

                return p.hostIp === host;
            });
        });
    };

    const findServiceByDomain = (domains: string[]): ServiceUnit | undefined => {
        if (!domains || domains.length === 0) return undefined;
        const domainSet = new Set(domains);
        return services.find(svc => {
            if (svc === proxyService) return false;
            if (!svc.verifiedDomains || svc.verifiedDomains.length === 0) return false;
            return svc.verifiedDomains.some(domain => domainSet.has(domain));
        });
    };

    for (const server of nginxConfig.servers) {
        // Find verified domains for this server block; fall back to configured domains if verification skipped
        const serverDomains = server.server_name.filter((name: string) => {
            if (!Array.isArray(verifiedDomains) || verifiedDomains.length === 0) {
                return true;
            }
            return verifiedDomains.includes(name);
        });

        for (const loc of server.locations) {
            // Prioritize explicit structured data from Twin Store
            let targetHost: string | undefined;
            let targetPort = 80;
            let isDirect = false;

            // Support both casing styles (TwinStore vs raw Agent)
            const vFields = server.variable_fields || server.variableFields;

            if (vFields) {
                targetHost = vFields.targetHost || vFields.variable_target_host;
                targetPort = vFields.targetPort || vFields.variable_target_port || 80;
                isDirect = true;
            }

            if (!isDirect) {
                let proxyPass = loc.proxy_pass;

                // Fallback: Use variables if proxy_pass is missing but variables exist (Nginx Proxy Manager style)
                if (!proxyPass && server.variables?.['$server'] && server.variables?.['$port']) {
                    const scheme = server.variables['$forward_scheme'] || 'http';
                    const host = server.variables['$server'];
                    const port = server.variables['$port'];
                    proxyPass = `${scheme}://${host}:${port}`;
                }

                if (proxyPass) {
                    // Extract target from proxy_pass (e.g. http://127.0.0.1:8080)
                    // We need to handle full URLs to detect external targets
                    const urlMatch = proxyPass.match(/^(https?:\/\/)?([^:/]+)(?::(\d+))?/);

                    if (urlMatch) {
                        targetHost = urlMatch[2];
                        targetPort = urlMatch[3] ? parseInt(urlMatch[3], 10) : (urlMatch[1] === 'https://' ? 443 : 80);
                    }
                }
            }

            if (!targetHost) continue;

            let internalPort = 0;
            let podId: string | undefined;
            let podName: string | undefined;
            let targetContainer = null;
            let containerWithMapping: any = null;

            // 0. Check if targetHost is a container IP, Name, or Service Name
            const containerByIPOrName = containers.find((c) => {
                // A) IP Check — EnrichedContainer carries network *names*, not
                // addresses, so an IP match is not possible here; we match on
                // name/label below instead.
                if (c.networks && c.networks.length > 0) {
                    return false;
                }
                // B) Name Check (Docker internal DNS)
                // Clean names (remove /)
                const names = (c.names || []).map((n) => n.replace(/^\//, ''));
                if (names.some((n) => n === targetHost || n.includes(targetHost as string))) return true;

                // C) Service Name / Label Check
                if (c.labels) {
                    if (c.labels['com.docker.compose.service'] === targetHost) return true;
                    if (c.labels['io.kubernetes.pod.name'] === targetHost) return true;
                    if (c.labels['app'] === targetHost) return true;
                }

                return false;
            });

            if (containerByIPOrName) {
                targetContainer = containerByIPOrName;
                // If we matched by Name/Service, the port in proxy_pass matches the internal Container Port (usually)
                // or the service port. So usually internalPort = targetPort.
                internalPort = targetPort;

                podId = containerByIPOrName.podId;
                podName = containerByIPOrName.podName || containerByIPOrName.labels?.['io.podman.pod.name'] || containerByIPOrName.labels?.['io.kubernetes.pod.name'];
            } else {
                // 1. Find via Host Port Mapping (if target is Host IP/Localhost)
                // Only valid if targetHost implies "This Node"
                const isSelf = ['localhost', '127.0.0.1', '::1', '0.0.0.0'].includes(targetHost) || nodeIPs.includes(targetHost);

                if (isSelf) {
                    containerWithMapping = containers.find((c) => {
                        // Check Runtime Ports or Config Ports
                        const ports = c.ports || [];
                        return ports.some((p: any) => parseInt(p.hostPort, 10) === targetPort);
                    });

                    if (containerWithMapping) {
                        // Resolve internal port from mapping
                        const ports = containerWithMapping.ports || [];
                        const mapping = ports.find((p: any) => parseInt(p.hostPort, 10) === targetPort);

                        if (mapping) {
                            internalPort = parseInt(mapping.containerPort || '0', 10);
                        } else {
                            internalPort = targetPort; // Fallback
                        }

                        podId = containerWithMapping.podId;
                        podName = containerWithMapping.podName || containerWithMapping.labels?.['io.podman.pod.name'] || containerWithMapping.labels?.['io.kubernetes.pod.name'];
                    }
                }
            }

            if (!targetContainer && containerWithMapping) {
                targetContainer = containerWithMapping;
            }

            if (internalPort > 0 && !targetContainer) {
                // 2. Find the container that exposes this internal port. The
                // runtime port list on EnrichedContainer only covers *mapped*
                // ports, so the exposed-port answer has to come out of the
                // synthesised inspection record.
                targetContainer = containers.find((c) => {
                    if (podId && c.podId !== podId) return false;
                    if (!podId && c.id !== containerWithMapping?.id) return false;

                    const inspect = inspectMap.get(c.id);
                    if (inspect?.Config?.ExposedPorts) {
                        const exposed = Object.keys(inspect.Config.ExposedPorts);
                        if (exposed.some(p => parseInt(p.split('/')[0], 10) === internalPort)) return true;
                    }
                    return false;
                });
            }

            // 3. Check for Host Network Containers (if target is local and no container found yet)
            if (!targetContainer) {
                const isLocalTarget = ['localhost', '127.0.0.1', '::1'].includes(targetHost) || nodeIPs.includes(targetHost);

                if (isLocalTarget) {
                    targetContainer = containers.find((c) => {
                        const inspect = inspectMap.get(c.id);

                        // Check for Host Network: Enriched Property + Inspection fallback
                        let isHost = c.isHostNetwork || (c.networks && c.networks.includes('host'));
                        if (!isHost && inspect) {
                            isHost = inspect.HostConfig?.NetworkMode === 'host' || !!inspect.NetworkSettings?.Networks?.['host'];
                        }

                        if (!isHost) return false;

                        // Check Exposed Ports (Dynamic & Static)
                        const portsToCheck = new Set<string>();
                        if (inspect?.Config?.ExposedPorts) Object.keys(inspect.Config.ExposedPorts).forEach(p => portsToCheck.add(p));

                        // NEW: Check dynamic/runtime ports from Agent V4
                        if (c.ports) {
                            c.ports.forEach((p: any) => {
                                if (p.hostPort) portsToCheck.add(`${p.hostPort}/tcp`);
                            });
                        }

                        return Array.from(portsToCheck).some(p => parseInt(p.split('/')[0], 10) === targetPort);
                    });
                }
            }

            const containerNodeId = targetContainer ? prefix(targetContainer.id) : null;
            const parentBundleId = targetContainer ? unmanagedBundleContainerIndex.get(targetContainer.id) || null : null;
            const parentServiceId = targetContainer ? containerServiceOwners.get(targetContainer.id) || null : null;
            let targetId = parentServiceId || parentBundleId || containerNodeId;

            if (!parentBundleId && targetHost) {
                const serviceMatch = findServiceByHostPort(targetHost, targetPort);
                if (serviceMatch) {
                    targetId = prefix(`service-${serviceMatch.name}`);
                }
                // Check if target is the proxy service itself (e.g. NPM admin UI route)
                if (!targetId && proxyService?.ports?.some(p => p.hostPort === targetPort)) {
                    targetId = prefix(`service-${proxyService.name}`);
                }
                // NPM's own nginx config has server blocks that proxy_pass to
                // 127.0.0.1:<internal-port> for the admin UI backend (port 3000
                // by default). The internal port isn't published on the host, so
                // the previous check above never matches. Since these locations
                // are *inside* nginx's own config — `proxyService` IS the
                // emitter — attribute the edge back to nginx rather than
                // inventing a virtual "Local Service :3000" ghost node.
                if (!targetId && proxyService) {
                    const isLoopback = ['localhost', '127.0.0.1', '::1'].includes(targetHost);
                    if (isLoopback) {
                        targetId = prefix(`service-${proxyService.name}`);
                    }
                }
            }

            // Fallback to Pod if no container found but we have a pod
            if (!targetId && podName) {
                targetId = prefix(`pod-${podName}`);
            }

            if (!targetId && serverDomains.length > 0) {
                const domainMatch = findServiceByDomain(serverDomains);
                if (domainMatch) {
                    targetId = prefix(`service-${domainMatch.name}`);
                }
            }

            // 4. Check External Links (IP Targets)
            if (!targetId && config.externalLinks) {
                const normalizedHost = targetHost?.toLowerCase();
                const matchedLink = config.externalLinks.find((l: any) => {
                    const targets = normalizeExternalTargets(l.ipTargets || []);
                    if (targets.length === 0 || !normalizedHost) return false;
                    return targets.some(entry => {
                        const parsed = parseTargetHostPort(entry);
                        if (!parsed.host) return false;
                        if (parsed.host.toLowerCase() !== normalizedHost) return false;
                        if (parsed.port && targetPort && parsed.port !== targetPort) return false;
                        if (parsed.port && !targetPort) return false;
                        return true;
                    });
                });
                if (matchedLink) {
                    targetId = getExternalLinkNodeId(matchedLink);
                }
            }

            // Fallback to Virtual Node if no Container/Pod found.
            // Treat localhost as a real node on the current machine, not a
            // self-reference back to nginx.
            if (!targetId && targetHost) {
                const isLoopback = ['localhost', '127.0.0.1', '::1'].includes(targetHost);
                const isLocalIP = nodeIPs.includes(targetHost);

                if (isLoopback || isLocalIP) {
                    // It IS a local service, just not found in containers.
                    // Create a "Local Service" node visually inside the Node
                    targetId = prefix(`local-svc-${targetHost}-${targetPort}`);

                    if (!nodes.find(n => n.id === targetId)) {
                        // Create Virtual Node
                        const missingNode: NetworkNode = {
                            id: targetId,
                            type: 'service', // Use service shape to look integrated
                            label: `:${targetPort}`,
                            subLabel: 'Internal Service',
                            status: 'down', // Warning state (unmanaged or hidden)
                            node: nodeName, // Important: Belong to this Node group
                            metadata: {
                                source: 'Nginx Proxy',
                                description: `Nginx forwards to ${targetHost}:${targetPort}, but no managed container was found.`,
                                verifiedDomains: serverDomains, // Inherit domains so we see what routes here
                                targetUrl: `http://${targetHost}:${targetPort}`,
                                // Actionable: Flag as potentially needing configuration
                                isMissingService: true
                            },
                            rawData: {
                                type: 'virtual-service',
                                name: `Local Service ${targetPort}`,
                                active: false,
                                ports: [{ host: targetPort, protocol: 'tcp' }]
                            }
                        };
                        nodes.push(missingNode);
                    }
                } else {
                    // External
                    const type = 'external';
                    targetId = prefix(`${type}-${targetHost}-${targetPort}`);

                    if (!nodes.find(n => n.id === targetId)) {
                        // STRICT: Use NodeFactory
                        const deviceRaw = {
                            type: 'device',
                            name: targetHost,
                            ip: targetHost,
                            ports: [targetPort],
                            isVirtual: true,
                            // Specific visual props injected into raw
                            subLabel: `External (${targetPort})`,
                            active: true
                        };

                        const deviceMeta = {
                            source: 'Nginx Proxy',
                            description: `External Service detected via Nginx configuration.`,
                            link: `http://${targetHost}:${targetPort}`,
                            nodeHost,
                            verifiedDomains: serverDomains || [], // Include domains routed here
                            expectedTarget: `Host: ${targetHost}, Port: ${targetPort} (External)`,
                            // Actionable: Allow creating external link
                            isExternalMissing: true,
                            externalTargetIp: targetHost,
                            externalTargetPort: targetPort
                        };

                        nodes.push(NodeFactory.createDeviceNode(targetId, deviceRaw, nodeName, deviceMeta));
                    }
                }
            }

            if (!targetId) continue;

            // Add edge
            const edgeId = `edge-nginx-${targetId}-${targetPort}`;
            if (!edges.find(e => e.id === edgeId)) {
                edges.push({
                    id: edgeId,
                    source: nginxId,
                    target: targetId,
                    label: `:${targetPort}`,
                    protocol: 'http',
                    port: targetPort,
                    state: 'active'
                });
            }

            const mappingTargets = new Set<string>();
            mappingTargets.add(targetId);
            if (containerNodeId) mappingTargets.add(containerNodeId);
            if (parentBundleId) mappingTargets.add(parentBundleId);
            if (parentServiceId) mappingTargets.add(parentServiceId);

            mappingTargets.forEach(recipientId => {
                if (!recipientId) return;
                if (!containerUrlMapping.has(recipientId)) {
                    containerUrlMapping.set(recipientId, new Set());
                }
                const urlSet = containerUrlMapping.get(recipientId)!;

                for (const domain of serverDomains) {
                    const cleanedDomain = domain.replace(/^https?:\/\//i, '').split('/')[0];
                    if (!cleanedDomain) continue;
                    urlSet.add(cleanedDomain);
                }
            });
        }
    }
}

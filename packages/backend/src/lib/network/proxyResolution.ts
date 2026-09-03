/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Reverse-proxy discovery for one node: which service is the primary proxy,
 * which container runs it, what route table it actually serves, and which of
 * those domains resolve back to this node.
 *
 * Extracted verbatim from `service.ts` (#2740). The twin is the source of
 * truth (`isPrimaryProxy` + `proxyConfiguration`); the agent-route branch is
 * the legacy fallback that predates twin enrichment.
 */
import type { EnrichedContainer, ServiceUnit } from '../agent/types';
import type { NodeTwin } from '../store/twin';
import { checkDomains } from './dns';
import { logger } from '../logger';
import watcher from '../watcher';

export interface NginxConfig {
    servers: any[];
}

export interface ProxyResolution {
    proxyService: ServiceUnit | undefined;
    proxyServiceName: string;
    nginxContainer: EnrichedContainer | undefined;
    nginxConfig: NginxConfig;
    verifiedDomains: string[];
}

export async function resolveProxy(params: {
    nodeName: string;
    twinNode: NodeTwin;
    services: ServiceUnit[];
    containers: EnrichedContainer[];
    nodeIPs: string[];
    fbStatus: any;
}): Promise<ProxyResolution> {
    const { nodeName, twinNode, services, containers, nodeIPs, fbStatus } = params;

    // Find the Reverse Proxy Service
    watcher.emit('change', { type: 'network-scan-progress', message: `Scanning ${nodeName}: Analyzing services...`, node: nodeName });

    // Improved Selection Logic: Use the Authoritative Flag from TwinStore
    // The DigitalTwinStore already performs the logic to identify the primary proxy (isPrimaryProxy).
    // It also links associated containers to services.
    const proxyService = services.find(s => s.isPrimaryProxy);

    // If we found a proxy, its name is THE Truth.
    const proxyServiceName = proxyService?.name || 'nginx';

    // Nginx Config (Only relevant if Nginx is running on this node)
    watcher.emit('change', { type: 'network-scan-progress', message: `Scanning ${nodeName}: Checking Nginx config...`, node: nodeName });

    // Use associated containers from the authoritative proxy service
    let nginxContainer: EnrichedContainer | undefined;

    if (proxyService && proxyService.associatedContainerIds && proxyService.associatedContainerIds.length > 0) {
        // Find the first container that exists in our current list
        nginxContainer = containers.find(c => proxyService.associatedContainerIds?.includes(c.id));
    } else {
        // Fallback checks for unmanaged setups or missed associations
        nginxContainer = containers.find(c => {
            const labels = c.labels || {};
            // 1. Check for explicit role label
            if (labels['servicebay.role'] === 'reverse-proxy') return true;

            return false;
        });
    }

    let nginxConfig: NginxConfig = { servers: [] };
    let verifiedDomains: string[] = [];

    // V4.1: Prioritize Twin Data Enrichment (Single Source of Truth)
    // The DigitalTwinStore now constructs the 'proxyConfiguration' directly on the service object.
    const agentProxyRoutes = twinNode.proxyRoutes; // Keep for legacy check

    // Check if we have an authoritative proxy service with Enriched Config
    if (proxyService && proxyService.proxyConfiguration) {
        nginxConfig = proxyService.proxyConfiguration as typeof nginxConfig;

        // Verify Domains
        try {
            const domainStatuses = await checkDomains(nginxConfig, fbStatus, nodeIPs);
            verifiedDomains = domainStatuses.filter(d => d.matches).map(d => d.domain);
        } catch (e) {
            logger.warn('NetworkService', `Failed to check domains via Enriched Twin data`, e);
        }
    } else if (agentProxyRoutes && agentProxyRoutes.length > 0) {
        // Fallback: Manually construct if not enriched (should not happen with new TwinStore)
        nginxConfig = {
            servers: agentProxyRoutes.map((r) => {
                let targetService = typeof r.targetService === 'string' && r.targetService.startsWith('http') ? r.targetService : `http://${r.targetService}`;
                // Fixed: Ensure port is included (Same fix as TwinStore)
                if (r.targetPort && !targetService.includes(`:${r.targetPort}`)) {
                    if (!/:\d+(\/|$)/.test(targetService)) {
                        targetService = `${targetService}:${r.targetPort}`;
                    }
                }

                return {
                    server_name: [r.host],
                    listen: r.ssl ? ['443 ssl', '80'] : ['80'],
                    locations: [{
                        path: '/',
                        proxy_pass: targetService
                    }],
                    _agent_data: true,
                    _ssl: r.ssl,
                    _targetPort: r.targetPort || 80
                };
            })
        };

        try {
            const domainStatuses = await checkDomains(nginxConfig, fbStatus, nodeIPs);
            verifiedDomains = domainStatuses.filter(d => d.matches).map(d => d.domain);
        } catch { /* ignore */ }
    } else if (nginxContainer) {
        logger.warn('NetworkService', `Nginx container found on ${nodeName} but no Agent proxy data available. Skipping legacy SSH introspection.`);
    }

    return { proxyService, proxyServiceName, nginxContainer, nginxConfig, verifiedDomains };
}

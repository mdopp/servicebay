/**
 * Verified-domain attribution: which node the UI shows a hostname on.
 *
 * Extracted verbatim from `service.ts` (#2740) — section 6.5 stamps each node
 * with the domains routed to it (its own, plus its children's), 6.6 then strips
 * from the nginx node the domains that really belong to something it proxies.
 */
import type { NetworkNode } from './types';
import type { EnrichedContainer, ServiceUnit } from '../agent/types';

/**
 * 6.5 Update All Nodes with Verified Domains (Virtual, Container, and Service Groups).
 * Simple child lookup is enough: the hierarchy is at most Service → Container.
 */
export function propagateVerifiedDomains(
    nodes: NetworkNode[],
    containerUrlMapping: Map<string, Set<string>>,
): void {
    for (const node of nodes) {
        if (!node.metadata) node.metadata = {};

        // 1. Direct mapping (Virtual or Container Nodes)
        const directUrls = containerUrlMapping.get(node.id);
        const linkedUrls = new Set(directUrls || []);

        // V4.1: Inject Verified Domains from TwinStore (Source of Truth)
        if (node.rawData) {
            // Check ServiceUnit or EnrichedContainer
            const typedRaw = node.rawData as { verifiedDomains?: string[] };
            if (typedRaw.verifiedDomains && Array.isArray(typedRaw.verifiedDomains)) {
                (typedRaw.verifiedDomains as string[]).forEach(d => linkedUrls.add(d));
            }
        }

        // 2. Child aggregation (Service Nodes containing Containers)
        const children = nodes.filter(n => n.parentNode === node.id);

        children.forEach(child => {
            // 2a. Direct Child (Container)
            const childUrls = containerUrlMapping.get(child.id);
            if (childUrls) childUrls.forEach(u => linkedUrls.add(u));

            // 2b. If the child also carries metadata.verifiedDomains (set by the
            // container pass above), fold that in too.
            if (child.metadata?.verifiedDomains) {
                (child.metadata.verifiedDomains as string[]).forEach(d => linkedUrls.add(d));
            }
        });

        if (linkedUrls.size > 0) {
            node.metadata.verifiedDomains = Array.from(linkedUrls);
        }
    }
}

/**
 * 6.6 Filter Nginx Proxy Node Verified Domains.
 * We only want to show domains that are naturally handled by Nginx itself
 * (e.g. static sites) and NOT domains that are proxied to other
 * containers/services, to avoid duplication.
 */
export function filterProxyNodeDomains(params: {
    nodes: NetworkNode[];
    nginxId: string;
    prefix: (id: string) => string;
    proxyService: ServiceUnit | undefined;
    nginxContainer: EnrichedContainer | undefined;
    containerUrlMapping: Map<string, Set<string>>;
}): void {
    const { nodes, nginxId, prefix, proxyService, nginxContainer, containerUrlMapping } = params;

    const nginxNode = nodes.find(n => n.id === nginxId);
    if (!nginxNode || !nginxNode.metadata || !nginxNode.metadata.verifiedDomains) return;

    // Store full list of domains for Router/Gateway
    nginxNode.metadata.allVerifiedDomains = [...(nginxNode.metadata.verifiedDomains as string[])];

    // The loopback fallback in the proxy-route pass attributes proxy_pass
    // http://127.0.0.1:<port> entries (NPM admin UI, nginx's own subdomain) to
    // nginx itself. Those land in containerUrlMapping under the service /
    // container id — not under `nginxId` (which is the visual `group-nginx`
    // node) — so we have to recognise every shape of "this is nginx" before
    // deciding a domain is mapped elsewhere.
    const nginxAliasIds = new Set<string>([nginxId]);
    if (proxyService) nginxAliasIds.add(prefix(`service-${proxyService.name}`));
    if (nginxContainer?.id) nginxAliasIds.add(prefix(nginxContainer.id));

    // Values in containerUrlMapping are *bare hostnames* (see `cleanedDomain`
    // in proxyRouteEdges.ts), not full URLs. The previous implementation called
    // `new URL(url)` on each entry, which threw on every iteration and silently
    // produced an empty set — leaving every working domain attributed to nginx
    // as well as to its real target. Compare strings.
    const domainsMappedToOthers = new Set<string>();
    for (const [targetId, urls] of containerUrlMapping.entries()) {
        if (nginxAliasIds.has(targetId)) continue;
        for (const domain of urls) {
            if (domain) domainsMappedToOthers.add(domain);
        }
    }

    nginxNode.metadata.verifiedDomains = (nginxNode.metadata.verifiedDomains as string[])
        .filter(d => !domainsMappedToOthers.has(d));
}

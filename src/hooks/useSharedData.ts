import { useCallback } from 'react';
import { useCache } from '@/providers/CacheProvider';
import { NetworkGraph } from '@/lib/network/types';
import { getNodes } from '@/app/actions/nodes';
import { PodmanConnection } from '@/lib/nodes';
import { useToast } from '@/providers/ToastProvider';

export interface Service {
  name: string;
  id?: string; // Systemd service name or container ID
  active: boolean;
  status: string;
  kubePath: string;
  yamlPath: string | null;
  ports: { host?: string; container: string }[];
  volumes: { host: string; container: string }[];
  type?: 'container' | 'link' | 'gateway';
  url?: string;
  description?: string;
  monitor?: boolean;
  labels?: Record<string, string>;
  verifiedDomains?: string[];
  hostNetwork?: boolean;
  nodeName?: string;
  // Gateway/Router specific
  uptime?: number;
  externalIP?: string;
  internalIP?: string;
  dnsServers?: string[];
  load?: string;
}

/**
 * Hook to access the shared Network Graph data.
 * This data is used by the NetworkMap plugin to visualize connections.
 * 
 * Features:
 * - Caches result in 'network-graph-raw'
 * - Shows global toast notification on refresh
 */
export function useNetworkGraph() {
    const { addToast, updateToast } = useToast();

    const fetcher = useCallback(async () => {
        const toastId = addToast('loading', 'Refreshing Network', 'Fetching latest graph data...', 0);
        try {
            const res = await fetch('/api/network/graph');
            if (!res.ok) throw new Error('Failed to fetch graph');
            const data = await res.json() as NetworkGraph;
            updateToast(toastId, 'success', 'Network Updated', 'Graph data refreshed', 500);
            return data;
        } catch (e) {
            updateToast(toastId, 'error', 'Refresh Failed', String(e));
            throw e;
        }
    }, [addToast, updateToast]);

    // Use default revalidation (always refresh graph on mount to get latest status)
    return useCache<NetworkGraph>('network-graph-raw', fetcher);
}

/**
 * Hook to access the unified Service List from all nodes.
 * 
 * Features:
 * - Aggregates services from Local and all configured Remote nodes
 * - Updates toast notification with detailed progress (e.g., "Pending: Node1, Node2")
 * - Caches result in 'services-list-raw'
 * - Filters out duplicate "Reverse Proxy" entries if a real one is found
 * - SKIP REVALIDATION ON MOUNT if cache exists (relies on Network Graph updates for status)
 */
export function useServicesList() {
    const { addToast, updateToast } = useToast();

    const fetcher = useCallback(async () => {
        const toastId = addToast('loading', 'Refreshing Services', 'Initializing...', 0);
        
        try {
            const nodeListPromise = getNodes();
            
            // Start processing Local immediately/in-parallel if possible, or just wait for list
            const nodeList = await nodeListPromise;
            
            // Only fetch from configured nodes.
            // Implicit 'Local' fetching is disabled to prevent duplicates.
            const targets = nodeList.map(n => n.Name);
            const pending = new Set(targets);
            
            if (targets.length === 0) {
                 updateToast(toastId, 'success', 'Services Updated', 'No nodes configured', 500);
                 return { services: [], nodes: nodeList };
            }
            
            updateToast(toastId, 'loading', 'Refreshing Services', `Pending: ${Array.from(pending).join(', ')}`);

            const fetchNode = async (node: string) => {
                try {
                    const query = (node === 'Local') ? '' : `?node=${node}`;
                    const servicesRes = await fetch(`/api/services${query}`);
                    
                    if (!servicesRes.ok) return [];
                    
                    const servicesData = await servicesRes.json();
                    return servicesData.map((s: Service) => ({ ...s, nodeName: node }));
                } catch (e) {
                    console.error(`Failed to fetch services for node ${node}`, e);
                    return [];
                } finally {
                    pending.delete(node);
                    if (pending.size > 0) {
                        updateToast(toastId, 'loading', 'Refreshing Services', `Pending: ${Array.from(pending).join(', ')}`);
                    }
                }
            };

            const results = await Promise.all(targets.map(fetchNode));
            let allServices = results.flat();
            
            // Filter out "Reverse Proxy (Not Installed)" if a real "Reverse Proxy" exists
            const hasRealProxy = allServices.some(s => s.name === 'Reverse Proxy' && s.status !== 'not-installed');
            if (hasRealProxy) {
                allServices = allServices.filter(s => !(s.name === 'Reverse Proxy' && s.status === 'not-installed'));
            }

            updateToast(toastId, 'success', 'Services Updated', 'All nodes refreshed', 500);
            return { services: allServices, nodes: nodeList };
        } catch (e) {
            updateToast(toastId, 'error', 'Failed to fetch services', String(e));
            throw e;
        }
    }, [addToast, updateToast]);

    return useCache<{ services: Service[]; nodes: PodmanConnection[] }>('services-list-raw', fetcher, [], { revalidateOnMount: false });
}

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

export function useNetworkGraph() {
    const { addToast, updateToast } = useToast();

    const fetcher = useCallback(async () => {
        const toastId = addToast('loading', 'Refreshing Network', 'Fetching latest graph data...', 0);
        try {
            const res = await fetch('/api/network/graph');
            if (!res.ok) throw new Error('Failed to fetch graph');
            const data = await res.json() as NetworkGraph;
            updateToast(toastId, 'success', 'Network Updated', 'Graph data refreshed');
            return data;
        } catch (e) {
            updateToast(toastId, 'error', 'Refresh Failed', String(e));
            throw e;
        }
    }, [addToast, updateToast]);

    return useCache<NetworkGraph>('network-graph-raw', fetcher);
}

export function useServicesList() {
    const { addToast, updateToast } = useToast();

    const fetcher = useCallback(async () => {
        const toastId = addToast('loading', 'Refreshing Services', 'Initializing...', 0);
        
        try {
            const nodeListPromise = getNodes();
            
            // Start processing Local immediately/in-parallel if possible, or just wait for list
            const nodeList = await nodeListPromise;
            const targets = ['Local', ...nodeList.map(n => n.Name)];
            const pending = new Set(targets);
            
            updateToast(toastId, 'loading', 'Refreshing Services', `Pending: ${Array.from(pending).join(', ')}`);

            const fetchNode = async (node: string) => {
                try {
                    const query = node === 'Local' ? '' : `?node=${node}`;
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

            updateToast(toastId, 'success', 'Services Updated', 'All nodes refreshed');
            return { services: allServices, nodes: nodeList };
        } catch (e) {
            updateToast(toastId, 'error', 'Failed to fetch services', String(e));
            throw e;
        }
    }, [addToast, updateToast]);

    return useCache<{ services: Service[], nodes: PodmanConnection[] }>('services-list', fetcher);
}

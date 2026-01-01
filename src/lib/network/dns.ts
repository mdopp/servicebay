import * as dns from 'dns/promises';
import { NginxConfig } from '../nginx/types';
import { FritzBoxStatus } from '../fritzbox/types';

export interface DomainStatus {
    domain: string;
    resolvesTo: string | null;
    matches: boolean;
    error?: string;
}

export async function checkDomains(nginxConfig: NginxConfig, fbStatus: FritzBoxStatus | null): Promise<DomainStatus[]> {
    if (!fbStatus || !fbStatus.externalIP) {
        return [];
    }

    const domains = new Set<string>();
    
    // Collect all server_names
    for (const server of nginxConfig.servers) {
        for (const name of server.server_name) {
            // Filter out localhost, IP addresses, and wildcards
            if (name !== 'localhost' && !name.match(/^\d+\.\d+\.\d+\.\d+$/) && !name.includes('*')) {
                domains.add(name);
            }
        }
    }

    const results: DomainStatus[] = [];

    for (const domain of domains) {
        try {
            const addresses = await dns.resolve4(domain);
            // Check if any of the resolved IPs match the external IP
            const match = addresses.includes(fbStatus.externalIP);
            results.push({
                domain,
                resolvesTo: addresses[0], // Just take the first one for display
                matches: match
            });
        } catch (e) {
            results.push({
                domain,
                resolvesTo: null,
                matches: false,
                error: e instanceof Error ? e.message : 'Resolution failed'
            });
        }
    }

    return results;
}

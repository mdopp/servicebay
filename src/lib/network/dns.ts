import { NginxConfig } from '../nginx/types';
import { FritzBoxStatus } from '../fritzbox/types';
import { logger } from '@/lib/logger';

export interface DomainStatus {
    domain: string;
    resolvesTo: string | null;
    matches: boolean;
    error?: string;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function checkDomains(nginxConfig: NginxConfig, fbStatus: FritzBoxStatus | null, _validIPs: string[] = []): Promise<DomainStatus[]> {
    if (!fbStatus || !fbStatus.externalIP) {
        return [];
    }

    const domains = new Set<string>();
    // const allowedIPs = new Set([fbStatus.externalIP, ...validIPs]);
    
    // Collect all server_names
    for (const server of nginxConfig.servers) {
        for (const name of server.server_name) {
            // Filter out localhost, IP addresses, and wildcards
            // Also filter out default "_" server name
            if (name !== 'localhost' && name !== '_' && !name.match(/^\d+\.\d+\.\d+\.\d+$/) && !name.includes('*')) {
                domains.add(name);
            }
        }
    }

    logger.info('DNS', `Extracting domains (verification disabled): ${Array.from(domains).join(', ')}`);

    const results: DomainStatus[] = [];

    for (const domain of domains) {
        // Skip DNS resolution as requested
        results.push({
            domain,
            resolvesTo: 'skipped', 
            matches: true
        });
    }

    return results;
}

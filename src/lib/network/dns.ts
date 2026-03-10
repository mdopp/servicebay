import dns from 'dns/promises';
import { NginxConfig } from '../nginx/types';
import { FritzBoxStatus } from '../fritzbox/types';
import { logger } from '@/lib/logger';

export interface DomainStatus {
    domain: string;
    resolvesTo: string | null;
    matches: boolean;
    error?: string;
}

export async function checkDomains(nginxConfig: NginxConfig, fbStatus: FritzBoxStatus | null, validIPs: string[] = []): Promise<DomainStatus[]> {
    if (!fbStatus || !fbStatus.externalIP) {
        return [];
    }

    const domains = new Set<string>();
    const allowedIPs = new Set([fbStatus.externalIP, ...validIPs]);

    for (const server of nginxConfig.servers) {
        for (const name of server.server_name) {
            if (name !== 'localhost' && name !== '_' && !name.match(/^\d+\.\d+\.\d+\.\d+$/) && !name.includes('*') && name.includes('.')) {
                domains.add(name);
            }
        }
    }

    logger.info('DNS', `Checking domains: ${Array.from(domains).join(', ')}`);

    const results = await Promise.all(
        Array.from(domains).map(async (domain): Promise<DomainStatus> => {
            try {
                const addresses = await dns.resolve4(domain);
                const resolved = addresses[0] || null;
                return {
                    domain,
                    resolvesTo: resolved,
                    matches: resolved ? allowedIPs.has(resolved) : false,
                };
            } catch (e) {
                return {
                    domain,
                    resolvesTo: null,
                    matches: false,
                    error: e instanceof Error ? e.message : String(e),
                };
            }
        })
    );

    return results;
}

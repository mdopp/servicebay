import { NextResponse } from 'next/server';
import { ServiceManager } from '@/lib/services/ServiceManager';
import { DigitalTwinStore } from '@/lib/store/twin';

export const dynamic = 'force-dynamic';

export async function GET() {
    try {
        // Check all known nodes for nginx, not just Local
        const twinStore = DigitalTwinStore.getInstance();
        const nodeNames = Object.keys(twinStore.nodes);
        if (nodeNames.length === 0) nodeNames.push('Local');

        for (const nodeName of nodeNames) {
            const services = await ServiceManager.listServices(nodeName);
            const nginxService = services.find(s =>
                s.name === 'nginx-web' ||
                (s.name.includes('nginx') && !s.name.startsWith('install-')) ||
                (s.description?.toLowerCase().includes('nginx') && !s.name.startsWith('install-'))
            );
            if (nginxService) {
                // Find the admin port (highest port, typically 8081)
                const ports = (nginxService.ports || [])
                    .map((p: { host?: string | number }) => parseInt(String(p.host), 10))
                    .filter((p: number) => !isNaN(p))
                    .sort((a: number, b: number) => a - b);
                // Admin port is neither 80 nor 443 — pick the first non-standard port
                const adminPort = ports.find((p: number) => p !== 80 && p !== 443) || 8081;

                return NextResponse.json({
                    installed: true,
                    active: nginxService.active || false,
                    name: nginxService.name,
                    node: nodeName,
                    adminPort,
                });
            }
        }

        return NextResponse.json({ installed: false, active: false });
    } catch (error) {
        console.error('Failed to check nginx status:', error);
        return NextResponse.json({ installed: false, error: String(error) });
    }
}

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
                s.name.includes('nginx') ||
                s.description?.toLowerCase().includes('nginx')
            );
            if (nginxService) {
                return NextResponse.json({
                    installed: true,
                    active: nginxService.active || false,
                    name: nginxService.name,
                    node: nodeName
                });
            }
        }

        return NextResponse.json({ installed: false, active: false });
    } catch (error) {
        console.error('Failed to check nginx status:', error);
        return NextResponse.json({ installed: false, error: String(error) });
    }
}

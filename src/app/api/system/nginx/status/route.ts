import { NextResponse } from 'next/server';
import { listServices } from '@/lib/manager';

export const dynamic = 'force-dynamic';

export async function GET() {
    try {
        const services = await listServices();
        const nginxService = services.find(s => s.name === 'nginx-web');
        
        return NextResponse.json({ 
            installed: !!nginxService,
            active: nginxService?.active || false
        });
    } catch (error) {
        console.error('Failed to check nginx status:', error);
        return NextResponse.json({ installed: false, error: String(error) });
    }
}
